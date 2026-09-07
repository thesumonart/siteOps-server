/**
 * The clock for SiteOps monitoring.
 *
 * ## Why this exists
 *
 * Monitoring stopped running in production and nothing said so. The API was
 * healthy, the database was reachable, every probe was green, and no website
 * had been checked for eighteen hours — because the process that checks them
 * was not running at all.
 *
 * Two things cause that, and this Worker addresses both:
 *
 *  1. **A single-service deployment has nowhere to put a background worker.**
 *     The API can host the monitoring loops itself (`MONITORING_RUNTIME=inline`),
 *     which solves the "no worker" half.
 *  2. **A suspended instance runs no timers.** Hosting plans that sleep an idle
 *     service will happily sleep one whose only remaining job is a `setTimeout`.
 *     An in-process loop cannot wake itself; something outside has to knock.
 *
 * This is the knock. Once a minute it makes one authenticated request that both
 * wakes the instance and tells it to run a sweep immediately, rather than
 * returning a 200 and falling asleep before its own next tick.
 *
 * ## What this deliberately does not do
 *
 * It does not perform monitoring. It cannot: checking a certificate needs a raw
 * TLS handshake with the peer certificate read back off the socket (`node:tls`),
 * the SSRF guard needs to resolve a hostname and inspect the address before
 * connecting (`node:dns`), and results go to MongoDB over a TCP driver
 * connection. None of the three exist in the Workers runtime. Moving the checks
 * here would mean deleting certificate inspection and the SSRF guard, so the
 * checks stay on Node and this stays a clock.
 *
 * ## Failure behaviour
 *
 * A failed tick is logged and swallowed. Retrying inside the invocation would
 * risk overlapping the next cron fire, and there is nothing to recover: the
 * next minute's trigger is the retry, and the queue is durable — a website that
 * was due stays due.
 */

/** Bounds one invocation. Well under Cloudflare's CPU and wall-clock limits. */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Runs one tick against the API.
 *
 * Returns a plain object rather than throwing, so both entry points can report
 * the same shape and neither has to duplicate the error handling.
 */
async function triggerTick(env) {
  const base = (env.SITEOPS_API_URL ?? '').replace(/\/$/, '');

  if (!base) {
    return { ok: false, error: 'SITEOPS_API_URL is not configured.' };
  }
  if (!env.INTERNAL_API_KEY) {
    // Refused rather than attempted. An unauthenticated request would be
    // rejected by the API anyway, and saying so here names the actual fix.
    return { ok: false, error: 'INTERNAL_API_KEY secret is not set on this Worker.' };
  }

  const started = Date.now();

  try {
    const response = await fetch(`${base}/api/internal/monitoring/tick`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.INTERNAL_API_KEY}`,
        'content-type': 'application/json',
        'user-agent': 'SiteOpsScheduler/1.0 (+https://siteops.app)',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const durationMs = Date.now() - started;

    if (!response.ok) {
      // The body is read and truncated rather than dropped: a 401 here means
      // the two halves disagree about the key, and that is only diagnosable if
      // the reason survives into the log.
      const body = (await response.text()).slice(0, 500);
      return { ok: false, status: response.status, durationMs, error: body };
    }

    const payload = await response.json();
    return { ok: true, status: response.status, durationMs, payload };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'The tick request failed.',
    };
  }
}

export default {
  /**
   * The cron entry point.
   *
   * `waitUntil` is what keeps the invocation alive until the request settles;
   * without it the Worker can be torn down the moment this function returns and
   * the fetch is cancelled mid-flight.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      triggerTick(env).then((result) => {
        if (result.ok) {
          console.log(JSON.stringify({ event: 'tick.ok', cron: event.cron, ...summarize(result) }));
        } else {
          console.error(
            JSON.stringify({ event: 'tick.failed', cron: event.cron, ...summarize(result) }),
          );
        }
      }),
    );
  },

  /**
   * A manual trigger, for confirming the wiring without waiting a minute.
   *
   * Guarded by the same key as the cron path, because it does the same thing:
   * an open endpoint that forces work on the API is a way to amplify load.
   * Anything else answers 404 rather than describing the Worker — there is no
   * reason for a passer-by to learn what this is.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/tick' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const presented = request.headers.get('authorization') ?? '';
    if (!env.INTERNAL_API_KEY || presented !== `Bearer ${env.INTERNAL_API_KEY}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    const result = await triggerTick(env);

    return Response.json(summarize(result), { status: result.ok ? 200 : 502 });
  },
};

/**
 * The parts of a result worth recording.
 *
 * Deliberately narrow. The API's response echoes its own runtime snapshot, and
 * copying all of it into a log line that Cloudflare retains adds nothing an
 * operator reads — while making it easier for something sensitive to end up
 * somewhere it was never meant to be.
 */
function summarize(result) {
  return {
    ok: result.ok,
    status: result.status ?? null,
    durationMs: result.durationMs ?? null,
    hosted: result.payload?.data?.hosted ?? null,
    ran: result.payload?.data?.ran ?? null,
    failed: result.payload?.data?.failed?.length ?? null,
    error: result.error ?? null,
  };
}
