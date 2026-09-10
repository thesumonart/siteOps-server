/**
 * SiteOps monitoring clock and keep-alive.
 *
 * A cron-triggered Cloudflare Worker with two jobs, in this order:
 *
 *  1. An unauthenticated `GET /health` against the API on every single tick.
 *     This is what resets Render's 15-minute inactivity timer, and it runs
 *     unconditionally — a suspended service runs no timers, so losing the
 *     probe means losing monitoring entirely.
 *  2. An authenticated `POST /api/internal/monitoring/tick`, when the operator
 *     secret is configured, which runs a monitoring sweep immediately rather
 *     than letting the instance return a 200 and fall asleep again before its
 *     own next timer fires.
 *
 * The two are deliberately independent. An earlier version returned early when
 * the secret was missing and therefore made no request at all, which left the
 * service to sleep and stopped monitoring on a deployment that looked healthy.
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
   *
   * Optional by type as well as in practice: when it is absent the keep-alive
   * probe still runs, so the service stays awake even while the sweep cannot
   * be authorized.
   */
  readonly CRON_SECRET?: string;
}

/**
 * Liveness probe. Chosen over `/` and over `/health/ready` on purpose: it is
 * registered in src/app.ts ahead of the rate limiter, so a request a minute
 * consumes none of the deployment's budget, and it performs no dependency I/O,
 * so a database blip cannot make the keep-alive itself look like a failure.
 */
const PROBE_PATH = '/health';

/** Path of the operator endpoint that runs one sweep. */
const TICK_PATH = '/api/internal/monitoring/tick';

/**
 * Upper bound on a single request.
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

/** Joins the configured origin to a path, tolerating a trailing slash. */
function apiUrl(env: Env, path: string): string {
  return `${env.SITEOPS_API_URL.replace(/\/+$/, '')}${path}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Wakes the service, or keeps it awake.
 *
 * Any completed HTTP request resets the inactivity timer, so even a non-2xx
 * answer counts as success for keep-alive purposes — it still proves the
 * instance was reached. Only a rejected fetch means nothing arrived.
 */
async function keepAwake(env: Env): Promise<void> {
  const url = apiUrl(env, PROBE_PATH);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'siteops-cron-worker' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      // The instance answered, so it is awake and the keep-alive did its job;
      // the status is still worth surfacing, because a healthy API returns 200.
      console.error('keepalive.unhealthy', { url, status: response.status, durationMs });
      return;
    }

    console.log('keepalive.ok', { durationMs });
  } catch (error) {
    // Nothing arrived: DNS, TLS, a network failure, or the timeout above. The
    // inactivity timer was not reset, so this is the line that explains a
    // service which went to sleep despite the cron firing.
    console.error('keepalive.failed', {
      url,
      durationMs: Date.now() - startedAt,
      error: describeError(error),
    });
  }
}

/** Runs one monitoring sweep on the API. */
async function runTick(env: Env, secret: string): Promise<void> {
  const url = apiUrl(env, TICK_PATH);
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
        authorization: `Bearer ${secret}`,
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
      error: describeError(error),
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

/**
 * One cron tick: keep the service awake, then sweep if we are able to.
 *
 * The probe runs first and is awaited, so a suspended instance has finished
 * waking before the sweep is attempted and the sweep then runs against a warm
 * process instead of paying the cold start a second time. Neither step can
 * prevent the other being attempted — each handles its own failures.
 */
async function handleTick(env: Env): Promise<void> {
  await keepAwake(env);

  const secret = env.CRON_SECRET;
  if (!secret) {
    console.error('tick.skipped', {
      reason: 'CRON_SECRET is not set; the service was kept awake but no sweep ran.',
      hint: 'Run: wrangler secret put CRON_SECRET',
    });
    return;
  }

  await runTick(env, secret);
}

export default {
  /**
   * Cron handler.
   *
   * The work is handed to `waitUntil` so the invocation stays alive until both
   * requests settle; returning before they resolve would cancel them, and
   * neither the keep-alive nor the sweep would happen.
   */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleTick(env));
  },
};
