# SiteOps production audit

An investigation into "after logging in, the user is not redirected to the dashboard", and a check
of whether the rest of the deployed product actually works.

Everything below was measured against the live deployment with a real browser, not inferred from
reading the source. Where something is still broken it says so.

---

## Deployment

| Part      | Platform | URL                                   | Status                                                |
| --------- | -------- | ------------------------------------- | ----------------------------------------------------- |
| Dashboard | Vercel   | `https://siteops-client.vercel.app`   | Healthy, fix deployed                                 |
| API       | Render   | `https://siteops-server.onrender.com` | Healthy, fix deployed, **one env change outstanding** |
| Worker    | Render   | no inbound traffic                    | **Not running** — see "Remaining issues"              |
| Database  | Atlas    | private                               | Healthy (`/health/ready` reports `database: ok`)      |

---

## Root cause

### What was broken

Sign-in worked. Sessions were created. Nobody stayed signed in.

`POST /api/auth/sign-in/email` answered `200` with a real, verified user and a `Set-Cookie`. The
browser read that header and discarded it. Every request after it was anonymous, so `middleware.ts`
saw no session cookie and sent the visitor from `/dashboard` straight back to `/login`.

The measured evidence, before any change:

```text
POST /api/auth/sign-in/email          -> 200
Set-Cookie: siteops.session_token=…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax
Cookie jar, siteops-client.vercel.app -> []      (empty)
Cookie jar, siteops-server.onrender.com -> []    (empty)
Landing URL after sign-in             -> /login?next=%2Fdashboard
```

An empty jar on _both_ origins is the whole bug in one line: the cookie was never stored anywhere.

### Why it was broken

One cause, in three layers. The product is written for a same-site deployment and was deployed
cross-site — `vercel.app` and `onrender.com` are both on the Public Suffix List, so those are two
different _sites_, not two hosts of one site.

1. **`NODE_ENV` was not set on Render.** It defaulted to `development`, and that single value decides
   `useSecureCookies` and the cookie's `secure` attribute in `src/config/auth.ts`. Session cookies
   went out over https with neither `Secure` nor the `__Secure-` prefix. Detectable from outside
   because `src/app.ts` also ties HSTS to it, and the API served no `Strict-Transport-Security`
   header.

2. **The cookie is `SameSite=Lax`, and the response was cross-site.** A browser will not _store_ a
   `Lax` cookie that arrives on a cross-site response. This is the layer that actually threw the
   session away.

3. **Even stored, it would have been the wrong origin.** The cookie belongs to the host that set it.
   `middleware.ts` reads `request.cookies` and `app/dashboard/layout.tsx` reads
   `headers().get('cookie')` — both on the _dashboard's_ origin. Neither could ever have seen a
   cookie scoped to the API's host.

Layer 3 is why `SameSite=None` would not have been a fix. It would have let the browser keep the
cookie and left the dashboard just as unable to read it.

### Why no test caught it

`playwright.config.ts` serves the dashboard on `localhost:3100` and the API on `localhost:4100`.
Cookies ignore the port, so those two are one site: the cookie is stored, the middleware reads it,
and all 32 end-to-end tests pass. The defect cannot exist until the two halves are served from
different registrable domains, which happens for the first time in production.

### What changed

**`siteOps-client`** — the browser now reaches the API through the dashboard's own origin.

- `next.config.ts` rewrites `/api/:path*` onto `NEXT_PUBLIC_API_URL`, keeping the prefix.
- `src/lib/api-base.ts` returns `''` in the browser (same-origin) and the absolute API origin during
  server rendering, which has no origin to be relative to.
- `src/lib/api-client.ts` and `src/lib/reports.ts` use it.

**`siteOps-server`** — a startup guard for the configuration that caused it.

- `src/config/env.schema.ts` refuses to start when `APP_URL` is a remote `https` origin and
  `NODE_ENV` is not `production`, because that combination has no working outcome and no visible
  symptom until somebody cannot sign in.

### Why the fix works

Every request the browser makes is now same-origin. The cookie is set by, scoped to, and returned to
the dashboard's host, so `middleware.ts` reads it and server components forward it — exactly as the
code was always written to expect. `SameSite=Lax` stays correct, and is the safer setting than the
`None` the cross-origin arrangement would have forced.

CSRF protection is unaffected: Better Auth validates `Origin`/`Referer` against `APP_URL` on
state-changing auth routes, and the rewrite forwards both headers. This was verified rather than
assumed — a forged origin through the proxy is still refused:

```text
POST /api/auth/sign-in/email  Origin: https://evil.example  -> 403
```

---

## Browser verification

Driven with Playwright against the live deployment. Steps 1–18 are the flow that was requested.

| #   | Step                          | Result                                                        |
| --- | ----------------------------- | ------------------------------------------------------------- |
| 1   | Landing page                  | 200, renders, no console errors                               |
| 2   | Navigate to sign-in           | 200                                                           |
| 3   | Sign in with the test account | `200`                                                         |
| 4   | Sign-in request               | `POST /api/auth/sign-in/email` → `200`, same-origin           |
| 5   | Session created               | Cookie issued, `HttpOnly`, `SameSite=Lax`, `Path=/`           |
| 6   | Cookie persisted              | Stored on `siteops-client.vercel.app` — **was empty before**  |
| 7   | **Redirect**                  | **→ `/dashboard`** — the reported bug, fixed                  |
| 8   | Dashboard loads               | Real data: 2 websites, 100.00% uptime, 500 ms, 0 incidents    |
| 9   | Refresh                       | Stays on `/dashboard`                                         |
| 10  | Another protected page        | `/dashboard/websites` loads                                   |
| 11  | Back to dashboard             | Loads                                                         |
| 12  | Account menu                  | Profile, Notifications, Billing & subscription, Sign out      |
| 13  | Settings                      | Renders real per-organization notification preferences        |
| 14  | Billing                       | Renders plan, real usage (2 of 3 websites, 1 of 2 members)    |
| 15  | Sign out                      | → `/login`, session cookie removed                            |
| 16  | Dashboard after sign out      | → `/login?next=%2Fdashboard`; `/api/session` → `{user: null}` |
| 17  | Sign in again                 | `200`                                                         |
| 18  | Dashboard again               | → `/dashboard/websites`, honouring `next`                     |

Additional checks:

| Check                           | Result                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| New tab                         | `/dashboard` loads; session shared                                          |
| Direct dashboard URL            | Loads when signed in, redirects when not                                    |
| Mobile viewport (390 px)        | Billing renders, no horizontal overflow                                     |
| Wrong password                  | `That email address and password do not match an account.` — no enumeration |
| Unauthenticated protected route | All 12 tested → `307` to `/login` with `next` preserved                     |
| Public routes                   | All 9 tested → `200`; none accidentally protected                           |
| Console                         | No application errors; API calls all `200`                                  |
| Rate limiting                   | `429` with `RateLimit-*` headers when the sign-in budget is spent           |

Protected routes verified: dashboard, websites, website detail, incidents, members, clients,
reports, notifications, settings, profile, billing, audit logs, and a non-existent dashboard route.

Public routes verified: landing, pricing, login, register, forgot-password, reset-password,
verify-email, verify-email/confirmed, invitations/accept.

---

## Tests

| Command             | Where            | Result                                        |
| ------------------- | ---------------- | --------------------------------------------- |
| `pnpm lint`         | both             | Pass                                          |
| `pnpm typecheck`    | both             | Pass                                          |
| `pnpm format:check` | both             | Pass                                          |
| `pnpm test`         | `siteOps-server` | **820 passed**, 48 files                      |
| `pnpm test`         | `siteOps-client` | **203 passed**, 11 files                      |
| `pnpm test:e2e`     | `siteOps-client` | **32 passed** — full stack, through the proxy |
| `pnpm build`        | both             | Pass                                          |

The server integration tests need a MongoDB replica set; one transaction creates an organization
together with its first membership. Against a standalone `mongod` they fail with `500`s on
`createOrganization`. This was confirmed to be an environment issue and not a regression by running
them on a pristine checkout, where they fail identically.

The production client bundle was checked for leaked development configuration: no `localhost`, no
`127.0.0.1`, and `https://siteops-server.onrender.com` as the only API origin.

### Regression coverage

Both new tests fail on the pre-fix code and pass after it — verified by reverting each change and
re-running.

- `siteOps-client/src/lib/api-base.test.ts` — asserts the browser base URL is same-origin and that
  `next.config.ts` rewrites `/api/*` to an env-derived origin. Before the fix: 2 failures.
- `siteOps-server/src/config/env.schema.test.ts` — asserts a remote https `APP_URL` outside
  production mode is refused, and that local development is unaffected. Before the fix: 1 failure.

---

## Frontend

- **API URL** — `NEXT_PUBLIC_API_URL`, correct in the production bundle. The browser reaches it
  through the same-origin rewrite; server components call it directly.
- **Environment** — two `NEXT_PUBLIC_*` values, validated at import time. No secrets; there is no
  server-only configuration in this project.
- **Middleware** — unchanged, and now works as written: `/dashboard/*` requires a session cookie,
  `/login`, `/register` and `/forgot-password` bounce a signed-in visitor to the dashboard.
- **Routes** — every protected route redirects when signed out; every public route stays public.
- **Error handling** — API failures surface as typed `ApiError` codes and render as messages. A
  wrong password does not reveal whether the account exists.

## Backend

- **CORS** — explicit allowlist, never a reflected origin, `Vary: Origin` always sent. Correct, and
  now off the browser's path entirely since requests are same-origin.
- **Auth** — Better Auth 1.7, unchanged. Origin/Referer validated against `APP_URL` on
  state-changing routes; verified that a forged origin is refused through the proxy.
- **Sessions** — 30-day expiry, 1-day refresh, `HttpOnly`, `SameSite=Lax`. Sign-out revokes.
- **Database** — Atlas, `/health/ready` reports `database: ok`.
- **Worker** — **not running.** See below.
- **Errors** — no stack traces, driver errors or internal paths in any response observed. An unknown
  route returns the documented envelope.

---

## Remaining issues

These are real and still open. Nothing here is claimed to be fixed.

### 1. The monitoring worker is not running — highest priority

This is the product's core function, and it has stopped.

```text
Configured check interval   every 5 minutes
Last check, both websites   11 hours ago
Checks in the last 24h      38   (a 5-minute interval would give ~288)
```

The dashboard is not lying about this — it says "11 hours ago" plainly — but it reports
"Operational, 100.00% uptime, 0 open incidents" from data that stopped arriving overnight. An outage
right now would not be detected and no alert would be sent. It is also why the dashboard's checks
panel shows "Domain expiry: 0 of 2 passing": that monitor has never produced a result.

The worker is a second process (`pnpm start:worker` → `node dist/worker.js`) and needs its own
Render service. The most likely cause is Render's free tier: a free service is spun down when idle,
and the worker takes no inbound traffic, so it sleeps almost immediately after each deploy and stays
down. Its `WORKER_PORT` probe exists to stop platforms treating it as crashed, but it does not stop
a free instance from idling out.

To resolve: confirm a worker service exists on Render, that its start command is
`node dist/worker.js`, that it shares the API's environment, and that it is on a plan that does not
idle. Its logs will show whether it is crashing or simply asleep.

### 2. `NODE_ENV=production` is still not set on Render — outstanding

At the time of writing the API still serves no `Strict-Transport-Security` header, and the session
cookie is still issued without `Secure`:

```text
siteops.session_token   HttpOnly: true   Secure: false   SameSite: Lax
```

Sign-in works regardless, because a cookie without `Secure` is still storable over https — the
same-origin fix is what made it work. But until this is set:

- the session cookie would be sent over plain http if anything ever reached the app that way,
- there is no HSTS,
- and mail is not guaranteed to be configured, since the schema only requires `RESEND_API_KEY` in
  production.

Setting it also makes the process refuse to start if it is ever removed again, which is the guard
this audit added.

### 3. Rate limiting attributes every request to one address

`TRUST_PROXY` is `false`, so Express falls back to the socket address, which is the platform's. The
whole deployment therefore shares one budget — observable directly:

```text
ratelimit-limit: 10   ratelimit-remaining: 0   ratelimit-reset: 17
```

That is the sign-in budget for _everyone_, and it was exhausted during this audit by one person.
With more than a handful of users, ordinary sign-ins will start returning `429`.

Setting `TRUST_PROXY=true` is a clear improvement. Note that with the dashboard proxying, requests
now arrive from Vercel's edge, so correct attribution depends on `X-Forwarded-For` surviving Vercel,
Cloudflare and Render's own proxy, and on `trust proxy` being set to the right hop count
(`src/app.ts` uses `1`). That chain could not be measured from outside and should be verified with
real traffic before the limits are relied on for abuse prevention.

### 4. Billing is not configured

`STRIPE_SECRET_KEY` is unset, so the billing page says "Billing is not configured on this
deployment" and checkout is unavailable. This is a supported, deliberate state rather than a defect —
the plan catalogue and real usage still render — but no one can subscribe. Listed because
"billing works" would be the wrong thing to conclude from the page loading.

---

## What is not in doubt

The reported bug is fixed and verified in production: signing in lands on the dashboard, the session
survives refresh, new tabs and direct URLs, sign-out revokes it, and signing in again works. The
authentication and routing layers are sound. The open items above are deployment configuration and
one stopped process, not defects in the code that was audited.
