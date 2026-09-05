import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../config/env.js';
import { ApiError } from '../errors/ApiError.js';
import { RateLimiter, type RateLimitRule } from '../utils/rate-limiter.js';

/**
 * Rate limiting, applied globally and tightened per route.
 *
 * Requests are keyed by client address *and* scope, so hammering the sign-in
 * form cannot exhaust an attacker's budget for reading the dashboard, and one
 * abusive client cannot lock everyone else out of an endpoint.
 *
 * One limiter instance is shared across every scope: the key carries the scope,
 * so separate instances would only fragment the sweep.
 */
const limiter = new RateLimiter();

export interface RateLimitOptions {
  readonly limit: number;
  readonly windowSeconds: number;
  /**
   * Groups several routes under one budget. Sign-in and sign-up share a scope
   * on purpose, so alternating between them does not double the allowance.
   */
  readonly scope: string;
}

/**
 * Express reports a forwarded client address only when `trust proxy` is on,
 * which the configuration ties to actually running behind one. That is what
 * stops a client from choosing its own identity with an `X-Forwarded-For`
 * header and getting a fresh budget per request.
 */
function clientKey(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

function applyHeaders(response: Response, verdict: ReturnType<RateLimiter['consume']>): void {
  response.setHeader('RateLimit-Limit', verdict.limit);
  response.setHeader('RateLimit-Remaining', verdict.remaining);
  response.setHeader('RateLimit-Reset', Math.ceil((verdict.resetAt - Date.now()) / 1000));
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const rule: RateLimitRule = {
    windowMs: options.windowSeconds * 1000,
    limit: options.limit,
  };

  return (request: Request, response: Response, next: NextFunction): void => {
    const verdict = limiter.consume(`${options.scope}|${clientKey(request)}`, rule);
    applyHeaders(response, verdict);

    if (!verdict.allowed) {
      response.setHeader('Retry-After', verdict.retryAfterSeconds);
      next(ApiError.rateLimited());
      return;
    }

    next();
  };
}

/**
 * The allowance every request consumes, on top of any stricter per-route rule.
 *
 * Applied first in the chain so a flood is rejected before it reaches session
 * lookup or the database.
 */
export function defaultRateLimit(): RequestHandler {
  return rateLimit({
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    scope: 'global',
  });
}

/** Test-only reset, so limiter state does not leak between cases. */
export function resetRateLimiter(): void {
  limiter.reset();
}
