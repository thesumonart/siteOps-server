# Render deployment audit

Why the Render service stopped starting, what was actually wrong, and what still has to be set.

Companion documents: [PRODUCTION-ENV.md](./PRODUCTION-ENV.md) is the standing environment reference;
[SITEOPS-PRODUCTION-AUDIT.md](./SITEOPS-PRODUCTION-AUDIT.md) covers the earlier sign-in redirect
incident, whose fix is the reason the proxy arrangement described below exists.

---

## Root cause

The service failed startup with:

```text
Error: Invalid SiteOps environment configuration:
```

**`NODE_ENV` is not set on the Render service.** It defaults to `development`, and the environment
schema now refuses that combination when `APP_URL` is a remote `https` origin.

That refusal is deliberate and was added in the previous incident. `NODE_ENV` alone decides
`useSecureCookies` and the cookie's `secure` attribute in `src/config/auth.ts`, plus HSTS in
`src/app.ts`. Running in development mode on a public https host issues session cookies without
`Secure` — which is how the product previously shipped, and how nobody could stay signed in. The
guard turns a silent misconfiguration into a loud one.

So the deploy is not failing because something is broken. It is failing because a configuration that
was always wrong is no longer tolerated, and the one variable that fixes it was never set.

**The live service was never down.** Render keeps the previous instance serving when a new deploy
fails its health check, so `https://siteops-server.onrender.com` stayed up on the pre-fix process
throughout — confirmed by a continuously rising `uptimeSeconds` and the continued absence of an HSTS
header.

### Why the message looked empty

The formatting code was not at fault. Reproduced against the compiled schema, every failure mode
produced detail lines correctly.

The problem was the shape of the message. A thrown `Error` puts its first line in `Error: …` and
everything else on continuation lines, where a platform log viewer shows only the first, splits the
rest into separate entries, or interleaves them with the stack trace. The first line was a bare
`Invalid SiteOps environment configuration:` — a header that named nothing at all. The detail was
there and easy to miss entirely.

The header now names every offending variable, so one line is enough:

```text
Invalid SiteOps environment configuration — 1 problem with: NODE_ENV
  - NODE_ENV: NODE_ENV must be "production" when APP_URL is a remote https origin (…).
```

Formatting moved into `describeEnvIssues` in `src/config/env.schema.ts`, which is side-effect free
and directly testable — `env.ts` only reads the environment. Four tests cover it, including one
asserting the output never echoes the offending value, because that value is very often the secret.

---

## Environment fix

Nothing in the schema was weakened. One variable was missing, and a second becomes required as soon
as the first is set.

| Variable             | State           | Action                                                               |
| -------------------- | --------------- | -------------------------------------------------------------------- |
| `NODE_ENV`           | **missing**     | Set to `production`. This is the blocker.                            |
| `RESEND_API_KEY`     | present locally | Confirm it is set on Render — required once in production.           |
| `TRUST_PROXY`        | `false`         | Set to `true`; Render terminates TLS at its edge.                    |
| `MONGODB_AUTO_INDEX` | `true` locally  | Set `false` in production; run `pnpm indexes:sync` as a deploy step. |
| `COOKIE_DOMAIN`      | unset           | Keep unset — the dashboard proxies `/api/*`.                         |
| `PORT`               | unset           | Keep unset — Render supplies it.                                     |

The full inventory is in [PRODUCTION-ENV.md](./PRODUCTION-ENV.md): 37 variables, four required
unconditionally, derived by introspecting the compiled schema rather than reading it by eye.

### Verified, not assumed

`siteOps-server/.env.prod` was validated against the real schema and then used to boot both
processes locally:

```text
.env.prod -> VALID — the server will start
  NODE_ENV: production   TRUST_PROXY: true   AUTO_INDEX: false   COOKIE_DOMAIN: (unset)

API    /health        {"status":"ok"}
API    /health/ready  {"status":"ready","checks":{"database":"ok"}}
API    response header  Strict-Transport-Security: max-age=31536000  ← production mode confirmed
Worker /health        {"status":"ok"}
```

The worker was booted against a scratch database so production monitoring data was not touched; the
scratch database was dropped afterwards.

---

## Client production environment

Two variables, both public, both inlined into the bundle at build time.

```text
NEXT_PUBLIC_API_URL=https://siteops-server.onrender.com
NEXT_PUBLIC_APP_URL=https://siteops-client.vercel.app
```

There is no server-only configuration in the dashboard and nothing secret may be added: an ESLint
rule confines `process.env` to `src/lib/env.ts`, which validates both values at import time.

## Server production environment

Required: `NODE_ENV`, `APP_URL`, `API_URL`, `MONGODB_URI`, `AUTH_SECRET`, and `RESEND_API_KEY` in
production. Recommended: `TRUST_PROXY=true`, `MONGODB_AUTO_INDEX=false`, `LOG_LEVEL=info`. Everything
else has a working default. See [PRODUCTION-ENV.md](./PRODUCTION-ENV.md).

---

## Render setup

Two services from this repository, sharing one environment.

| Setting     | API                                            | Worker                         |
| ----------- | ---------------------------------------------- | ------------------------------ |
| Type        | Web Service                                    | Background Worker              |
| Build       | `pnpm install --frozen-lockfile && pnpm build` | same                           |
| Start       | `node dist/server.js`                          | `node dist/worker.js`          |
| Health path | `/health`                                      | probe only, no inbound traffic |

Set the same environment on both. Do not set `PORT`.

## Vercel setup

Root directory is the `siteOps-client` repository; Next.js is detected by default. Set both
`NEXT_PUBLIC_*` values for the **Production** environment specifically — a variable configured only
for Preview or Development is absent from the production build, and because these are inlined at
build time, changing one requires a redeploy.

## Authentication across Vercel and Render

`vercel.app` and `onrender.com` are different registrable domains, so the browser treats them as
different sites and will not store the `SameSite=Lax` session cookie from a cross-site response. The
dashboard therefore rewrites `/api/*` onto the API, making every browser request same-origin.

`APP_URL` must be the dashboard's exact origin: Better Auth validates `Origin`/`Referer` against it
on state-changing auth routes and the rewrite forwards both headers, so CSRF protection survives the
proxy while a mismatch would refuse sign-out with a bare `403`. `COOKIE_DOMAIN` must stay unset.

---

## Git cleanup

Nothing needed removing. The audit found no junk to delete, which is worth stating plainly rather
than inventing work:

```text
tracked files: 172 (client), 288 (server)
generated/temporary/OS/IDE files tracked: none
env files tracked: .env.example only, in both repositories
env files ever committed, across all history: .env.example only
```

One real defect was found and fixed. `siteOps-client/.gitignore` enumerated env files by name —
`.env`, `.env.local`, `.env.*.local`, `.env.development`, `.env.production`, `.env.test` — so a file
named anything else was tracked by default. `siteOps-client/.env.prod` would have been committed.
It now matches `.env.*` with `!.env.example`, the same fail-closed pattern the server already used.

```text
before:  git check-ignore -v siteOps-client/.env.prod  ->  NOT IGNORED
after:   .gitignore:27:.env.*    .env.prod
         .env.example correctly NOT ignored
```

Temporary scripts written during this audit were removed as they were used; both working trees are
clean apart from the intended changes.

## Security

- **No secret has ever been committed.** All history in both repositories was checked: the only env
  file ever added is `.env.example`. No rotation is required.
- `.env.prod` exists locally in both repositories and is ignored by both `.gitignore` files,
  confirmed with `git check-ignore`.
- The validation error names variables and messages, never values. A test asserts it.
- No secret reaches the browser: the dashboard has exactly two `NEXT_PUBLIC_*` values, both origins.
- CORS is an explicit allowlist, never a reflected origin, never wildcard with credentials.
- Session cookies are `HttpOnly` and `SameSite=Lax`, and become `Secure` the moment `NODE_ENV` is
  set — which is the outstanding action.
- SSRF protection is intact; `MONITOR_ALLOW_PRIVATE_ADDRESSES` is refused in production.

One finding worth acting on: **the local development `.env` points at the production database.**
Confirmed by connecting to it — database `_site_ops`, the live organization and its two websites.
`pnpm docker:up` exists to provide a local replica set for exactly this reason.

---

## Testing

| Command             | Where            | Result                                      |
| ------------------- | ---------------- | ------------------------------------------- |
| `pnpm format:check` | both             | Pass                                        |
| `pnpm lint`         | both             | Pass                                        |
| `pnpm typecheck`    | both             | Pass                                        |
| `pnpm test`         | `siteOps-server` | **824 passed**, 48 files                    |
| `pnpm test`         | `siteOps-client` | **203 passed**, 11 files                    |
| `pnpm test:e2e`     | `siteOps-client` | **32 passed**, full stack through the proxy |
| `pnpm build`        | both             | Pass                                        |

Production startup was tested directly, not just compilation: both processes were booted with
`.env.prod` and answered their health probes, with HSTS proving production mode.

Server integration tests need a MongoDB replica set for the one transaction that creates an
organization with its first membership; they were run against one.

### Browser verification against the live deployment

| Step                                    | Result                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| Landing page                            | 200, renders                                                                       |
| Login page                              | 200                                                                                |
| Sign in                                 | `POST /api/auth/sign-in/email` → `200`, same-origin                                |
| Cookie stored                           | `siteops.session_token` on `siteops-client.vercel.app`, `HttpOnly`, `SameSite=Lax` |
| Redirect                                | → `/dashboard`                                                                     |
| Dashboard                               | Real data: 2 websites, 502 ms, 0 open incidents                                    |
| Refresh                                 | Stays signed in                                                                    |
| Websites / profile / settings / billing | All load                                                                           |
| Sign out                                | → `/login`, session cookie removed                                                 |
| Dashboard when signed out               | → `/login?next=%2Fdashboard`                                                       |
| Re-login                                | → `/dashboard`                                                                     |

---

## Final status

| Area                   | Status                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Render                 | **BLOCKED** — live service healthy on the pre-fix process; the new deploy will not start until `NODE_ENV=production` is set |
| Vercel                 | PASS                                                                                                                        |
| Environment validation | PASS — `.env.prod` validated and booted locally; error message fixed                                                        |
| MongoDB                | PASS — `/health/ready` reports `database: ok`                                                                               |
| Authentication         | PASS                                                                                                                        |
| Login                  | PASS                                                                                                                        |
| Dashboard              | PASS                                                                                                                        |
| Worker                 | **FAIL** — not running in production; boots correctly from this configuration                                               |
| Monitoring             | **FAIL** — no checks recorded for 12.5 hours; consequence of the worker                                                     |
| Notifications          | **UNVERIFIED** — mail provider configured, but no incident has occurred to send one, and none can while the worker is down  |
| Git hygiene            | PASS — one real ignore gap found and fixed, no secrets in history                                                           |
| Build                  | PASS                                                                                                                        |
| Tests                  | PASS — 824 server, 203 client, 32 end-to-end                                                                                |

### Outstanding actions

1. **Set `NODE_ENV=production` on Render.** This unblocks the deploy. Confirm `RESEND_API_KEY` is
   also set, because it becomes required at the same moment.
2. **Set `TRUST_PROXY=true`.** Without it every request is attributed to the platform's address and
   the whole deployment shares one rate-limit budget — `ratelimit-limit: 10` for all users combined.
3. **Get the monitoring worker running.** Measured directly against the database: the most recent
   check is `2026-09-06T19:30:22Z`, twelve and a half hours before this audit, on websites configured
   for five-minute checks. The dashboard reports "100.00% uptime, 0 open incidents" from data that
   stopped arriving overnight — an outage now would not be detected and no alert would be sent. The
   likely cause is Render's free tier idling a service that takes no inbound traffic.
4. **Point local development at a local database.** `pnpm docker:up` provides the replica set.
