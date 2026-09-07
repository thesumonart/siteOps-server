import { timingSafeEqual } from 'node:crypto';

import { Router, type NextFunction, type Request, type Response } from 'express';

import { env } from '../config/env.js';
import { ApiError } from '../errors/ApiError.js';
import type { MonitoringRuntime } from '../jobs/monitoring-runtime.js';
import { ApiResponse } from '../responses/ApiResponse.js';
import { MonitoringHealthService } from '../services/monitoring-health.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('internal-routes');

/**
 * Operator endpoints, mounted at `/api/internal`.
 *
 * Not part of the product's API surface and deliberately not reachable with a
 * session: no customer, no plan and no organization is involved. Access is a
 * single bearer token from `INTERNAL_API_KEY`, held by whoever operates the
 * deployment and by the external scheduler.
 *
 * Two endpoints, for the two failure modes that made this necessary:
 *
 *  - `POST /monitoring/tick` runs a monitoring sweep on demand. It exists for
 *    hosting that suspends an idle instance, where the in-process timers never
 *    fire because the process is not running. The request that wakes it has to
 *    be able to say "do the work now", because otherwise the instance returns
 *    a 200 and goes back to sleep before its own next tick.
 *
 *  - `GET /monitoring/health` answers "is monitoring actually running", which
 *    nothing could answer before. A dead worker looked exactly like a healthy
 *    one from outside: the API was up, the database was reachable, and the
 *    dashboard cheerfully reported 100% uptime from data eighteen hours old.
 */

/**
 * Rejects anything without the operator token.
 *
 * Compared in constant time. The comparison is against a fixed secret an
 * attacker can submit repeatedly, which is exactly the shape a timing oracle
 * needs, and `===` on strings leaks the length of the common prefix.
 */
function requireInternalKey(request: Request, _response: Response, next: NextFunction): void {
  const configured = env.INTERNAL_API_KEY;

  if (!configured) {
    /*
     * Refused rather than open. An unauthenticated endpoint that forces work is
     * a denial-of-service amplifier, and one that reports queue depth is
     * reconnaissance — neither is an acceptable default for a deployment that
     * simply has not set the variable yet.
     */
    next(
      new ApiError(
        503,
        'Operator endpoints are not enabled on this deployment.',
        'SERVICE_UNAVAILABLE',
      ),
    );
    return;
  }

  const header = request.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  const expected = Buffer.from(configured, 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  // `timingSafeEqual` throws on a length mismatch, which would itself be an
  // oracle; the lengths are compared first and both branches answer the same.
  const authorized = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!authorized) {
    next(ApiError.unauthenticated('A valid operator key is required.'));
    return;
  }

  next();
}

export interface InternalRouteDependencies {
  /**
   * The monitoring runtime, when this process hosts it.
   *
   * Null in the default deployment, where monitoring runs in its own process
   * and the API has no loops to tick. The tick endpoint says so plainly rather
   * than pretending to have done something.
   */
  readonly monitoringRuntime: MonitoringRuntime | null;
}

export function internalRoutes(dependencies: InternalRouteDependencies): Router {
  const router = Router();
  const health = new MonitoringHealthService();

  router.use('/internal', requireInternalKey);

  router.post(
    '/internal/monitoring/tick',
    asyncHandler(async (_request: Request, response: Response) => {
      const runtime = dependencies.monitoringRuntime;

      if (!runtime) {
        /*
         * A 200 with `hosted: false` rather than an error. The caller is a
         * cron job: telling it "you are pointed at the wrong service" is
         * useful, but failing its invocation would fill an alerting channel
         * with noise about a deployment that is working correctly.
         */
        return ApiResponse.ok(response, {
          hosted: false,
          ran: [],
          failed: [],
          message: 'Monitoring runs in a separate process on this deployment.',
        });
      }

      const started = Date.now();
      const outcome = await runtime.runOnce();

      logger.info(
        { ran: outcome.ran, failed: outcome.failed.length, durationMs: Date.now() - started },
        'internal.tick_completed',
      );

      return ApiResponse.ok(response, {
        hosted: true,
        ran: outcome.ran,
        failed: outcome.failed,
        durationMs: Date.now() - started,
        runtime: runtime.snapshot(),
      });
    }),
  );

  router.get(
    '/internal/monitoring/health',
    asyncHandler(async (_request: Request, response: Response) => {
      const report = await health.report();
      return ApiResponse.ok(response, {
        ...report,
        // What this process itself is doing, which the heartbeat cannot say
        // about the instance answering the request.
        thisInstance: dependencies.monitoringRuntime?.snapshot() ?? null,
      });
    }),
  );

  return router;
}
