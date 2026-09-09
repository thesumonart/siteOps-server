# Deployment

Two processes and a database, in the default arrangement. Both build from this repository and share
one `.env`.

There is a second arrangement for hosting that offers only one long-running service — see
[Single-service deployments](#single-service-deployments). Read that section before deploying to a
free tier of anything: the default arrangement silently runs **no monitoring at all** there, which
is not a hypothetical. It is what SiteOps shipped, and websites went unchecked for eighteen hours
behind a completely green set of health probes.

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

### Monitoring runtime

| Variable             | Default    | Notes                                                                         |
| -------------------- | ---------- | ----------------------------------------------------------------------------- |
| `MONITORING_RUNTIME` | `separate` | `separate` = dedicated worker process. `inline` = the API runs the loops too. |
| `INTERNAL_API_KEY`   | —          | Bearer token for `/api/internal`. Unset means those endpoints are refused.    |

Set exactly one host for the loops. Two would not corrupt anything — every claim is an atomic lease
— but it doubles the connection pool and the outbound socket budget for no extra throughput.

---

## Single-service deployments

Render's Background Workers, Fly's non-HTTP processes and their equivalents are paid features. On a
plan that gives you one web service, `node dist/worker.js` has nowhere to run, and the default
configuration answers every health check while checking no websites.

Two things are needed, and neither is optional.

### 1. Run the loops inside the API

```bash
MONITORING_RUNTIME=inline
```

The API process now starts the same three scheduler loops the worker would have. The queues, the
leases, the jobs and the incident rules are identical; only the event loop they share differs.

### 2. Give it an external clock

A suspended process runs no timers. A platform that sleeps an idle service will happily sleep one
whose only remaining work is a `setTimeout`, and an in-process loop cannot wake itself — so
`inline` on its own gets you monitoring that stops the moment traffic does.

`cloudflare/` is a Cloudflare Worker that fixes this. Once a minute a cron trigger makes one
authenticated request to `POST /api/internal/monitoring/tick`, which both wakes the instance and
runs a sweep immediately rather than letting it return a 200 and fall asleep before its own next
tick.

```bash
cd cloudflare
npx wrangler secret put INTERNAL_API_KEY   # the same value the API has
npx wrangler deploy
```

Set `SITEOPS_API_URL` in `cloudflare/wrangler.toml` to the API origin. Cloudflare's cron triggers
are free on the Workers free plan, and one request a minute is 43,200 a month against a 100,000/day
allowance.

**The Worker does not perform monitoring, and cannot.** Inspecting a certificate needs a raw TLS
handshake with the peer certificate read back off the socket (`node:tls`), the SSRF guard needs to
resolve a hostname and classify the address before connecting (`node:dns`), and results go to
MongoDB over a TCP driver connection. None of the three exist in the Workers runtime. Moving the
checks there would mean deleting certificate inspection and the SSRF guard, so the checks stay on
Node and Cloudflare is only the clock.

### Render's free plan, concretely

`render.yaml` in the repository root is this arrangement as a Blueprint. Applying it (New →
Blueprint) creates the service with the build and start commands, the health check and every
non-secret value already set; the six secrets are prompted for once. Configuring a service by hand
works equally well — the file is then the reference for what to type.

```text
Cloudflare Worker (free)          Render web service (free)         MongoDB Atlas (M0)
  cron "* * * * *"                  one Node process                  one replica set
        │                           MONITORING_RUNTIME=inline               ▲
        └── POST /api/internal/monitoring/tick ──▶ Express API ─────────────┘
            Authorization: Bearer INTERNAL_API_KEY   + the three scheduler loops
```

| Setting           | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| Runtime           | Node, version from `.nvmrc` (24.15.0)                                         |
| Build command     | `npm install -g pnpm@11.20.0 && pnpm install --frozen-lockfile && pnpm build` |
| Start command     | `node --enable-source-maps dist/server.js`                                    |
| Health check path | `/health`                                                                     |
| Instance          | Free — 0.1 CPU, 512 MB, single instance                                       |

pnpm is installed explicitly rather than taken from the build image: the lockfile is v9 and the
repository pins `packageManager: pnpm@11.20.0`, and `--frozen-lockfile` exists so a deploy installs
what was tested rather than whatever an older pnpm resolves.

The start command runs `node` rather than `pnpm start`. Both run the same file, but a package manager
between Render's `SIGTERM` and the process that handles it is a process that might not forward it —
and handling it is what drains the checks already in flight. `pnpm start` also adds
`--env-file-if-exists=.env`, which does nothing here.

**Never set `PORT`.** Render injects it, the server binds `env.PORT` on `0.0.0.0`, and overriding it
means Render routes traffic to a port nothing is listening on.

#### The six values Render must hold

Set these as environment variables on the service — Render encrypts them at rest and they are never
in the repository.

| Variable           | Notes                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `APP_URL`          | The dashboard's https origin. CORS, cookies and every link in an email.  |
| `API_URL`          | This service's https origin, e.g. `https://siteops-server.onrender.com`. |
| `MONGODB_URI`      | The Atlas connection string, including the database name.                |
| `AUTH_SECRET`      | `openssl rand -base64 32`.                                               |
| `INTERNAL_API_KEY` | `openssl rand -base64 48`. The Cloudflare Worker needs the same value.   |
| `RESEND_API_KEY`   | Required in production, or nobody is told about an outage.               |

`NODE_ENV=production` is not optional and not cosmetic: it is what issues session cookies with
`Secure` and the `__Secure-` prefix. Startup refuses a remote https `APP_URL` without it, because
otherwise everything looks fine and nobody stays signed in.

`EMAIL_FROM` and the `STRIPE_*` variables are deliberately not in `render.yaml`. All are optional and
absence is a supported state, but a Blueprint prompts for every `sync: false` entry — and a blank or
placeholder `STRIPE_SECRET_KEY` is worse than no Stripe at all, since a secret key without a real
webhook secret is refused at startup by design. Add them in the dashboard when this deployment
actually sells something.

#### Atlas from Render

M0 is a replica set, which is what the organization-creation transaction needs. Nothing about the
free tier is special beyond its size.

Render has no per-service static outbound IP on any plan; traffic leaves through published
per-region CIDR ranges, listed in the dashboard under **Connect → Outbound**. Allowlist those ranges
in Atlas's network access list rather than `0.0.0.0/0` — it is the same amount of work and it does
not leave the cluster open to the internet.

`MONGODB_MAX_POOL_SIZE=5` is right here because one process now holds the only pool rather than
sharing the budget with a worker. It is sized for the 512 MB instance, not for Atlas: M0's connection
limit is nowhere near the binding constraint.

#### Indexes, with no shell to run them from

Render's free plan has no SSH and no one-off jobs, so `pnpm indexes:sync` cannot run _on_ Render. Run
it against Atlas from a machine that has the connection string — the shell value wins over whatever
is in a local `.env`:

```bash
MONGODB_URI="mongodb+srv://…/siteops" pnpm indexes:sync
MONGODB_URI="mongodb+srv://…/siteops" pnpm indexes:verify   # exits non-zero if anything is missing
```

Do this before the first deploy and after any deploy that changed a model. `MONGODB_AUTO_INDEX` stays
`false`: an index build issued by a booting process can stall a live cluster, and on a 0.1-CPU
instance it also competes with the request that triggered the boot.

#### The Cloudflare Worker

Already written and already correct; the only deployment change is pointing it at the real service.

```bash
cd cloudflare
# SITEOPS_API_URL in wrangler.toml must be this service's origin.
npx wrangler secret put INTERNAL_API_KEY   # the same value Render holds
npx wrangler deploy
```

`INTERNAL_API_KEY` is a secret, never a `[vars]` entry — putting it there commits it. One request a
minute is 43,200 a month against the free plan's 100,000 a day.

#### Verifying the deployment

```bash
curl -s https://<service>.onrender.com/health                  # {"success":true,...,"status":"ok"}
curl -s https://<service>.onrender.com/health/ready            # 503 until Atlas is reachable

curl -s -X POST https://<service>.onrender.com/api/internal/monitoring/tick
# 401 — the operator endpoints are never open

curl -s -X POST -H "Authorization: Bearer $INTERNAL_API_KEY" \
  https://<service>.onrender.com/api/internal/monitoring/tick
# {"hosted":true,"ran":["uptime","monitors","reports"],"failed":[]}
```

`"hosted": true` is the whole point of the exercise. `false` means `MONITORING_RUNTIME` is not
`inline` and this deployment is checking nothing. Then confirm the clock runs on its own:
`wrangler tail` should show a `tick.ok` line every minute, and `/api/internal/monitoring/health`
should report `status: running` with a heartbeat a few seconds old.

### What the free plan does and does not buy

It genuinely runs. The constraints below are the ones that decide whether it is _enough_, and none of
them are hypothetical.

| Constraint                           | Consequence                                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spins down after 15 idle minutes     | Covered — the Worker knocks every minute. Covered _only while the Worker runs_: if it stops, the service sleeps and monitoring stops with it.                                                 |
| ~1 minute cold start                 | Every restart and every deploy is a monitoring gap of about a minute.                                                                                                                         |
| 750 instance hours per **workspace** | A service kept awake all month uses ~744 of them in a 31-day month. A second free web service in the same workspace exhausts the budget and suspends both until the month rolls over.         |
| 0.1 CPU, 512 MB, one instance        | Measured on this build: ~137 MB resident with the loops running and the queue empty; a hundred-website PDF renders in ~17 ms and 9 kB. It fits, with CPU as the tight constraint, not memory. |
| No shell, no one-off jobs            | Index synchronization runs from a laptop, not from the platform.                                                                                                                              |
| No persistent disk                   | Costs nothing here — reports are built in memory and emailed, and nothing else writes to disk.                                                                                                |
| Outbound SMTP ports blocked          | Costs nothing here — Resend is an HTTPS API.                                                                                                                                                  |

**$0 hosting is not the same as 24/7 production reliability.** What this arrangement gives you is a
real, honest deployment that checks real websites and sends real alerts, for nothing. What it does
not give you is an SLA, a second instance, a shell to diagnose from, or any margin in the monthly
hour budget — and the cadence depends on a cron in a different vendor's account, so an outage there
is an outage in the only thing keeping this awake.

The first paid step worth taking is Render's cheapest paid instance for this service. It removes the
spin-down and the instance-hour ceiling, at which point the in-process timers run continuously and
the Cloudflare Worker becomes a watchdog rather than the heartbeat itself — a materially different
reliability story for one small monthly cost. A VPS is only necessary if you want the worker back in
its own process, which is the better architecture but not one a free plan can host.

### Verifying it works

```bash
curl -s -H "Authorization: Bearer $INTERNAL_API_KEY"   https://your-api/api/internal/monitoring/health
```

```json
{
  "status": "running",
  "heartbeatAgeSeconds": 23,
  "host": "api",
  "pendingChecks": 0,
  "overdueChecks": 0,
  "failedChecksLast24h": 3,
  "lastCheckRecordedAt": "..."
}
```

`status` is derived from the newest heartbeat, not self-reported by the process answering:

| Status          | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `running`       | A heartbeat within the last two minutes.                       |
| `degraded`      | Two to ten minutes. A slow database, or a restart in progress. |
| `stopped`       | Over ten minutes. Nothing is checking anything.                |
| `never_started` | No runtime has ever written a heartbeat on this deployment.    |

`overdueChecks` is the number that matters most: websites due for more than five minutes with
nothing claiming them. A non-zero value that stays non-zero means the loops are not draining the
queue, whatever the process says about itself.

Customers see a plainer version of the same fact — the dashboard raises a banner when the newest
check across their websites is older than three times their shortest configured interval. That
banner names nothing about the infrastructure; it just refuses to present stale figures as current.

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
