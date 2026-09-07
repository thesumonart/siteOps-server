# Production environment

The complete environment reference for the deployed product: what to set, where, and which values
are secret. Covers both halves — the API and worker in this repository, and the dashboard in
`siteOps-client`.

Derived from `src/config/env.schema.ts` by introspecting the compiled schema, not by reading it by
eye. Thirty-seven variables, four of them required unconditionally.

**No secret value appears in this file.** Names, shapes and reasons only.

---

## Deployments

| Part      | Platform | Origin                                | Notes                                          |
| --------- | -------- | ------------------------------------- | ---------------------------------------------- |
| Dashboard | Vercel   | `https://siteops-client.vercel.app`   | Proxies `/api/*` to the API                    |
| API       | Render   | `https://siteops-server.onrender.com` | Web service                                    |
| Worker    | Render   | no inbound traffic                    | Separate service, `node dist/worker.js`        |
| Database  | Atlas    | private                               | Replica set required (one transaction uses it) |

---

## Local production files

Two git-ignored files hold the real values, as the reference for what to paste into each platform:

```text
siteOps-client/.env.prod
siteOps-server/.env.prod
```

They are matched by `.env.*` in both `.gitignore` files and are never committed. Verify at any time:

```bash
git check-ignore -v .env.prod     # must print a matching rule
git check-ignore -v .env.example  # must print nothing
```

`siteOps-server/.env.prod` contains real credentials. Treat it like any other secret: it is not
backed up by Git, so if it is lost the values must come from Render.

---

## Dashboard — Vercel

Everything here is inlined into the JavaScript bundle at build time and served to every visitor.
There is no such thing as a private value in this project; anything secret belongs to the API. An
ESLint rule confines `process.env` to `src/lib/env.ts`, and both values are validated at import time,
so a missing one fails the build rather than shipping a bundle that cannot reach the API.

| Variable              | Required | Secret | Purpose                                                              |
| --------------------- | -------- | ------ | -------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | Yes      | No     | Origin `/api/*` is proxied to. `https://siteops-server.onrender.com` |
| `NEXT_PUBLIC_APP_URL` | Yes      | No     | This app's own origin. `https://siteops-client.vercel.app`           |

**Set both for the Production environment specifically.** A variable configured only for Preview or
Development is absent from the production build. Because these are inlined at build time, changing
one in the Vercel dashboard does nothing until the project is redeployed.

`NEXT_PUBLIC_API_URL` has two readers and both matter: `next.config.ts` uses it as the rewrite
destination, and `src/lib/api-base.ts` uses it as the base URL for server-rendered requests.

---

## API and worker — Render

Both processes read one schema. Set the same values on **both** services: the worker ignores the
HTTP settings and the API ignores the monitor settings, but a value that disagrees between them is a
bug waiting to happen.

### Required — the process refuses to start without these

| Variable         | Secret  | Purpose                                                                    |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `APP_URL`        | No      | Dashboard origin. CORS allowlist, Better Auth trusted origin, email links. |
| `API_URL`        | No      | This API's origin. Absolute callback URLs, including verification.         |
| `MONGODB_URI`    | **Yes** | Atlas connection string. Needs a replica set.                              |
| `AUTH_SECRET`    | **Yes** | Signs sessions and email tokens. ≥ 32 characters.                          |
| `NODE_ENV`       | No      | Must be `production` — see below. Defaults to `development`.               |
| `RESEND_API_KEY` | **Yes** | Required **in production only**; refused at startup without it.            |

`NODE_ENV` and `RESEND_API_KEY` are conditionally required: the schema has no default that works for
a real deployment, and both are enforced together the moment `APP_URL` is a remote `https` origin.

### `NODE_ENV` — what broke the Render deploy

`NODE_ENV=production` is what turns on `useSecureCookies` and the cookie's `secure` attribute in
`src/config/auth.ts`, plus HSTS in `src/app.ts`. Without it the service runs in development mode on
a public https host and issues session cookies no browser should keep.

Since the guard was added, that configuration no longer starts at all. It reports:

```text
Invalid SiteOps environment configuration — 1 problem with: NODE_ENV
  - NODE_ENV: NODE_ENV must be "production" when APP_URL is a remote https origin (…).
```

Setting it then makes `RESEND_API_KEY` required, which is the correct order of events: a production
deployment that cannot send a verification email cannot onboard anyone.

### Recommended

| Variable                          | Value           | Secret | Purpose                                                                                                                                                       |
| --------------------------------- | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                     | `true`          | No     | Render terminates TLS at its edge. Left `false`, every request is attributed to the platform's address and the whole deployment shares one rate-limit budget. |
| `MONGODB_AUTO_INDEX`              | `false`         | No     | An index build issued by a starting process can stall a live cluster. Run `pnpm indexes:sync` as an explicit deploy step.                                     |
| `LOG_LEVEL`                       | `info`          | No     | `debug` is too noisy and can echo request detail.                                                                                                             |
| `EMAIL_FROM`                      | verified sender | No     | Must be a domain verified with Resend.                                                                                                                        |
| `SESSION_RATE_LIMIT_MAX_REQUESTS` | `60`            | No     | `GET /api/session` is hit twice per page load.                                                                                                                |

### Must stay unset

| Variable                          | Why                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                            | Render supplies it and the service must bind to whatever it provides. Setting it overrides that.                                                                   |
| `COOKIE_DOMAIN`                   | The dashboard proxies `/api/*`, so the cookie must be scoped to the dashboard's host. Setting it to the API's domain makes the browser reject the cookie outright. |
| `MONITOR_ALLOW_PRIVATE_ADDRESSES` | Disables SSRF protection. Refused in production by the schema.                                                                                                     |

### Optional, with sensible defaults

Tuning values that need no configuration unless you are changing behaviour. All are non-secret:
`MONGODB_MAX_POOL_SIZE` (10), `RATE_LIMIT_WINDOW_SECONDS` (60), `RATE_LIMIT_MAX_REQUESTS` (120),
`AUTH_RATE_LIMIT_MAX_REQUESTS` (10), `WORKER_PORT` (4001), `MONITOR_POLL_INTERVAL_SECONDS` (15),
`MONITOR_CONCURRENCY` (10), `MONITOR_MAX_REDIRECTS` (5), `MONITOR_MAX_ATTEMPTS` (2),
`NOTIFICATION_MAX_ATTEMPTS` (3), `CHECK_RETENTION_DAYS` (90), `REPORT_POLL_INTERVAL_SECONDS` (60),
`REPORT_BATCH_SIZE` (3), `ADDITIONAL_TRUSTED_ORIGINS` (none).

### Optional integrations, not configured on this deployment

| Variable                | Secret  | Effect when unset                                                                                                                                    |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGESPEED_API_KEY`     | **Yes** | Performance monitoring falls back to server-side timings: no Lighthouse score, no LCP or CLS. Every result names which method produced it.           |
| `STRIPE_SECRET_KEY`     | **Yes** | No payment provider is constructed; billing routes answer `BILLING_NOT_CONFIGURED` and the dashboard says so. A supported state, not a degraded one. |
| `STRIPE_WEBHOOK_SECRET` | **Yes** | Required whenever the secret key is set; the schema refuses one without the other.                                                                   |
| `STRIPE_PRICE_*` (six)  | No      | A plan with no price id is simply not sold here — the pricing page still describes it.                                                               |

---

## Authentication across Vercel and Render

`vercel.app` and `onrender.com` are both on the Public Suffix List, so those are two different
_sites_. The session cookie is `HttpOnly` and `SameSite=Lax`, and a browser will not store a `Lax`
cookie that arrives on a cross-site response — nor would the dashboard be able to read one scoped to
the API's host, which is what `middleware.ts` and `app/dashboard/layout.tsx` both do.

The dashboard therefore proxies: `next.config.ts` rewrites `/api/*` onto `NEXT_PUBLIC_API_URL`, so
every browser request is same-origin and the cookie is set by, scoped to, and returned to the
dashboard's own host.

Two things must line up:

- **`APP_URL` must be the dashboard's exact origin.** Better Auth validates `Origin`/`Referer`
  against it on state-changing auth routes, and the rewrite forwards both. A mismatch refuses
  sign-out with a bare `403`. This is also what preserves CSRF protection through the proxy — a
  forged origin still arrives as the attacker's and is refused.
- **`COOKIE_DOMAIN` must stay unset**, so the cookie carries no `Domain` attribute.

---

## Deployment commands

```bash
# Both services build from this repository.
pnpm install --frozen-lockfile
pnpm build

# API service
node dist/server.js          # or: pnpm start

# Worker service — a separate Render service, no inbound traffic
node dist/worker.js          # or: pnpm start:worker

# Explicit, after a deploy that adds or changes an index
pnpm indexes:sync
pnpm indexes:verify
```

## Health checks

```bash
curl -s https://siteops-server.onrender.com/health          # liveness
curl -s https://siteops-server.onrender.com/health/ready    # readiness, includes the database

# NODE_ENV is production only if this prints a header.
curl -sI https://siteops-server.onrender.com/health | grep -i strict-transport-security
```

The worker exposes the same liveness probe on `WORKER_PORT`, reachable only inside the platform.

---

## Secret handling

- Real values live in `.env.prod` (git-ignored) and in each platform's environment settings.
- Nothing secret is ever committed. Only `.env.example` is tracked, in both repositories, and its
  history was checked: no other env file has ever been added in either repository.
- `AUTH_SECRET` must not be rotated casually — changing it signs out every user and invalidates
  every outstanding verification and password-reset link.
- The validation error names variables and messages but never values, because the value that failed
  is very often the secret itself. A test asserts that.
- The local development `.env` currently points at the **production** database. That is worth
  changing: `pnpm docker:up` provides a local replica set for exactly this reason, and a development
  process pointed at production data is one careless script away from a bad afternoon.
