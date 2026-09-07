# Deployment

Two processes and a database. Both processes build from this repository and share one `.env`.

```text
       siteOps-client (Vercel, Netlify, …)
                    │ HTTPS
                    ▼
  ┌─────────────────────────────────┐        ┌──────────────────┐
  │  API      node dist/server.js   │───────▶│  MongoDB Atlas   │
  │           PORT, public          │        │                  │
  └─────────────────────────────────┘        └──────────────────┘
                                                      ▲
  ┌─────────────────────────────────┐                 │
  │  Worker   node dist/worker.js   │─────────────────┘
  │           WORKER_PORT, private  │
  └─────────────────────────────────┘
                    │
                    ▼
          the monitored websites
```

The worker needs no inbound traffic; its port exists only because most platforms treat a process
with no listening socket as crashed.

## Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

Output is `dist/`. Start the API with `pnpm start` and the worker with `pnpm start:worker`, or call
`node dist/server.js` / `node dist/worker.js` directly.

Node 24 is required and pinned in `.nvmrc`.

## Environment

Every variable is validated at startup; a missing or malformed required value stops the process
rather than letting it run misconfigured. `.env.example` is the full list with commentary.

### Required

| Variable         | Notes                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `NODE_ENV`       | `production`                                                                                     |
| `APP_URL`        | Public origin of the dashboard. Must be `https` in production — session cookies are Secure-only. |
| `API_URL`        | Public origin of this API. Used to build absolute callback URLs.                                 |
| `MONGODB_URI`    | Atlas connection string.                                                                         |
| `AUTH_SECRET`    | ≥ 32 characters. `openssl rand -base64 32`.                                                      |
| `RESEND_API_KEY` | Required in production. Without it, alerts are logged instead of sent — which is not monitoring. |

### Worth setting

| Variable                     | Default                | Notes                                                                                                        |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                       | 4000                   | API. Most platforms inject this.                                                                             |
| `WORKER_PORT`                | 4001                   | Worker probes.                                                                                               |
| `LOG_LEVEL`                  | `info`                 |                                                                                                              |
| `EMAIL_FROM`                 | Resend's shared sender | Set a verified domain sender.                                                                                |
| `MONGODB_MAX_POOL_SIZE`      | 10                     | **Per process.** The API and the worker each hold their own pool; the sum must stay under the cluster limit. |
| `MONGODB_AUTO_INDEX`         | false                  | Leave false. See below.                                                                                      |
| `TRUST_PROXY`                | false                  | Enable **only** behind a proxy that sets `X-Forwarded-For`.                                                  |
| `COOKIE_DOMAIN`              | —                      | Only when the API and dashboard are on different hosts under one registrable domain.                         |
| `ADDITIONAL_TRUSTED_ORIGINS` | —                      | Extra browser origins for CORS, comma-separated.                                                             |
| `CHECK_RETENTION_DAYS`       | 90                     | Changing it needs an index sync to take effect.                                                              |

`MONITOR_ALLOW_PRIVATE_ADDRESSES` must never be set in production. The schema refuses to start if
it is.

## Database

Use a MongoDB Atlas cluster, or any deployment that is a **replica set** — creating an organization
together with its first membership is a transaction, and MongoDB supports those only on a replica
set.

### Indexes are an explicit deployment step

```bash
pnpm indexes:sync     # after every deploy that changed a model
pnpm indexes:verify   # exits non-zero if anything is missing
```

`MONGODB_AUTO_INDEX` stays false in production: an index build issued by a booting process can
stall a live cluster.

**Do not skip this.** A database with no unique indexes does not look broken — every query returns
rows, every page renders. The only symptom is that the guarantees the product relies on quietly
stop holding: a website monitored twice, two incidents for one outage, the same alert email again.
`indexes:verify` is worth wiring into the deploy as a gate.

## Order of operations

1. Deploy the database changes: `pnpm indexes:sync`.
2. Deploy the API. It refuses to bind if MongoDB is unreachable, so the platform never routes
   traffic to an API that cannot serve it.
3. Deploy the worker.
4. Confirm with `indexes:verify` and the probes below.

The API and worker can be deployed in either order — they share no protocol.

## Health probes

| Path                      | Process | Behaviour                                                                               |
| ------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `/health`, `/health/live` | both    | Liveness. No dependency I/O, so a slow database cannot cause a restart loop.            |
| `/health/ready`, `/ready` | both    | Readiness. Pings MongoDB; `503` when unreachable. The worker also reports `lastTickAt`. |

Point the platform's **liveness** probe at `/health` and its **readiness** probe at
`/health/ready`. Pointing liveness at readiness turns a brief database blip into a restart storm.

`lastTickAt` is the useful worker signal: a worker whose last tick is far older than
`MONITOR_POLL_INTERVAL_SECONDS` is alive but not working.

## Shutdown

Both processes handle `SIGTERM` and `SIGINT`:

- The API stops accepting connections, lets in-flight requests finish, drains the pool.
- The worker stops claiming work, waits for checks already running, then drains.

Neither calls `process.exit()` on the happy path — once no handles remain, Node exits on its own,
which guarantees pending writes finish first. A 25-second watchdog forces an exit if a handle fails
to release, comfortably inside the 30 seconds most platforms allow, so it is our own log line that
records why rather than a silent SIGKILL.

Allow at least 30 seconds of termination grace.

## Scaling

**The API** is stateless and scales horizontally. One caveat: rate-limit counters are per-process,
so `N` instances mean an effective limit of `limit × N`. Acceptable for a small deployment; the
limiter's interface is one `consume` call and can be re-implemented over a shared store.

**The worker** scales horizontally too, and safely: work is claimed by an atomic lease, so two
workers never check the same website at the same time. Raise `MONITOR_CONCURRENCY` before adding
instances — it is a single-process bound on outbound sockets, and one process handles a lot of
mostly-idle HTTP.

Watch the connection pool as you scale: `MONGODB_MAX_POOL_SIZE × (api + worker instances)` must
stay under the cluster limit. That limit is what usually bites first on a small Atlas tier.

## Monitoring the monitor

Log lines worth alerting on:

| Event                                                 | Meaning                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `api.bootstrap_failed`, `worker.bootstrap_failed`     | Failed to start. Usually configuration or an unreachable database.                    |
| `scheduler.tick_failed`                               | A tick could not claim work. Occasional is fine; sustained is not.                    |
| `notification.delivery_failed`                        | An alert did not reach someone.                                                       |
| `email.not_configured`                                | Emails are being logged, not sent. Should never appear in production.                 |
| `api.shutdown_timed_out`, `worker.shutdown_timed_out` | A handle failed to release.                                                           |
| `incident.open_race_detected`                         | Two claims raced. The index handled it; frequent occurrences suggest a lease problem. |

Logs are newline-delimited JSON in production. Every request carries `requestId`, echoed to the
client as `X-Request-Id`, so a user-reported failure traces to an exact line.

## Backups

Enable Atlas continuous backups. What actually needs restoring is `organizations`,
`organization_members`, `websites`, `incidents` and the auth collections — `website_checks` is
high-volume telemetry that expires on its own, and losing it costs history, not function.

## CORS and cookies across hosts

The dashboard sends `credentials: 'include'`, so:

- `APP_URL` must exactly match the dashboard's origin — scheme, host and port. It is an allowlist,
  never a reflected origin.
- Both must be `https` in production; the session cookie is `Secure`.
- Different hosts under one registrable domain (`app.siteops.app` and `api.siteops.app`) need
  `COOKIE_DOMAIN=.siteops.app`.
- Genuinely different sites cannot share a `SameSite=Lax` cookie. Serve both from one registrable
  domain, or put the API behind the dashboard's own origin.

### When the two are on different sites

A Vercel dashboard calling a Render API is two registrable domains, and no cookie setting rescues
it. `SameSite=None` would let the browser store the cookie, but it would still be scoped to the API's
host, so the dashboard's routing middleware and its server components — both of which read the
cookie on their own origin — would never see it.

The arrangement SiteOps uses instead is a proxy in the dashboard: `siteOps-client` rewrites `/api/*`
onto `API_URL`, so the browser only ever talks to the dashboard's origin. The cookie is then set by,
scoped to, and returned to that host, and `SameSite=Lax` is both correct and the safer setting.

Two things still have to line up for that to work:

- `APP_URL` must be the dashboard's public origin. Better Auth validates `Origin`/`Referer` against
  it on state-changing auth routes, and the proxy forwards both — so a forged cross-site request is
  still refused, and a mismatch here refuses sign-out with a bare `403`.
- `COOKIE_DOMAIN` must stay **unset**. Left unset the cookie carries no `Domain` attribute and the
  browser scopes it to the dashboard's host, which is the only host that will ever send it back.
  Setting it to the API's domain makes the browser reject the cookie outright.
