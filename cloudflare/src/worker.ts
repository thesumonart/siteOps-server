/**
 * SiteOps monitoring clock.
 *
 * A cron-triggered Cloudflare Worker whose entire job is to make one
 * authenticated request a minute to the API's operator tick endpoint. It does
 * two things at once: it wakes an instance that a free plan has suspended, and
 * it runs a monitoring sweep immediately rather than letting the instance
 * return a 200 and fall asleep again before its own next timer fires.
 *
 * This Worker performs no monitoring itself, and cannot. Inspecting a
 * certificate needs a raw TLS handshake with the peer certificate read back off
 * the socket (`node:tls`), the SSRF guard needs to resolve a hostname and
 * classify the address before connecting (`node:dns`), and results go to
 * MongoDB over a TCP driver connection. None of the three exist in the Workers
 * runtime, so the checks stay on Node and this is only the clock.
 */

/**
 * Minimal shapes from the Workers runtime.
 *
 * Declared locally rather than pulled from `@cloudflare/workers-types` because
 * this directory deliberately carries no package.json — it is deployed by
 * `npx wrangler` and is excluded from the repository's tsconfig and ESLint
 * config, which target Node. Add that dependency if you want the full ambient
 * definitions.
 */
interface ScheduledEvent {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  /** Origin of the Render service, without a trailing slash. From [vars]. */
  readonly SITEOPS_API_URL: string;
  /**
   * The operator bearer token. Its value must equal the API's
   * `INTERNAL_API_KEY` — that is the variable the API compares against.
   * Set with `wrangler secret put CRON_SECRET`.
   */
  readonly CRON_SECRET: string;
}

/** Path of the operator endpoint that runs one sweep. */
const TICK_PATH = '/api/internal/monitoring/tick';

/**
 * Upper bound on a single tick request.
 *
 * A cold start on a suspended free instance can take the better part of a
 * minute, so this is generous — but it must still be bounded, or a hung fetch
 * would hold the invocation open until the runtime kills it with no log line.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** The shape the tick endpoint answers with. Only what is logged is described. */
interface TickResponse {
  readonly success?: boolean;
  readonly data?: {
    readonly hosted?: boolean;
    readonly ran?: readonly string[];
    readonly failed?: readonly unknown[];
    readonly durationMs?: number;
  };
}

async function runTick(env: Env): Promise<void> {
  if (!env.CRON_SECRET) {
    // Refuse rather than send an unauthenticated request the API will reject.
    // A missing secret is a deployment mistake, and it should say so plainly.
    console.error('tick.misconfigured', { reason: 'CRON_SECRET is not set' });
    return;
  }

  const url = `${env.SITEOPS_API_URL.replace(/\/+$/, '')}${TICK_PATH}`;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        /*
         * Bearer, not a custom header. The API reads exactly one thing —
         * `Authorization: Bearer <INTERNAL_API_KEY>` in
         * src/routes/internal.routes.ts — and compares it with
         * `timingSafeEqual`. An `x-cron-secret` header would be ignored and the
         * request answered 401.
         */
        authorization: `Bearer ${env.CRON_SECRET}`,
        'content-type': 'application/json',
        'user-agent': 'siteops-cron-worker',
      },
      // The endpoint takes no body; sending one only invites a parser to differ.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A network failure or a timeout. The next trigger is a minute away and the
    // tick is idempotent, so there is nothing to retry here.
    console.error('tick.request_failed', {
      url,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    /*
     * 401 means CRON_SECRET and INTERNAL_API_KEY disagree; 503 means the API
     * has no INTERNAL_API_KEY set at all and is refusing operator endpoints
     * outright. Both are silent failures of monitoring, so both are logged as
     * errors rather than swallowed.
     */
    console.error('tick.failed', { url, status: response.status, durationMs });
    return;
  }

  const body = (await response.json().catch(() => null)) as TickResponse | null;
  const data = body?.data;

  if (data?.hosted === false) {
    /*
     * The API answered, but it is not hosting the loops — MONITORING_RUNTIME is
     * not `inline` on that service. It returns 200 so a cron job is not filled
     * with noise, which means this is the only place the mistake becomes
     * visible. Nothing is being checked.
     */
    console.error('tick.not_hosted', {
      url,
      durationMs,
      hint: 'Set MONITORING_RUNTIME=inline on the API service.',
    });
    return;
  }

  console.log('tick.ok', {
    durationMs,
    ran: data?.ran ?? [],
    failed: data?.failed?.length ?? 0,
  });
}

export default {
  /**
   * Cron handler.
   *
   * The work is handed to `waitUntil` so the invocation stays alive until the
   * request settles; returning before it resolves would cancel the fetch and
   * the sweep would never run.
   */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runTick(env));
  },
};
