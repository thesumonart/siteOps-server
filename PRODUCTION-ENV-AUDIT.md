# Production environment audit

What the deployed SiteOps needs configured, on which platform, and which values are secret.

Covers both halves of the product: the API and worker in this repository, and the dashboard in
`siteOps-client`. They are separate deployments with separate environments, and two of the defects
found in this audit came from a value being right in one of them and absent in the other.

**No secret value appears in this file.** Names, shapes and reasons only.

---

## Deployments

| Part      | Platform | Origin                                |
| --------- | -------- | ------------------------------------- |
| Dashboard | Vercel   | `https://siteops-client.vercel.app`   |
| API       | Render   | `https://siteops-server.onrender.com` |
| Worker    | Render   | no inbound traffic                    |
| Database  | Atlas    | private                               |

These are two different registrable domains, which is the fact the whole authentication section
below turns on. See "Cookies and origins".

---

## Dashboard — Vercel

Everything here is compiled into the JavaScript bundle at build time and served to every visitor.
There is no such thing as a private value in this project; anything secret belongs to the API.

| Variable              | Value                                 | Secret | Notes                                               |
| --------------------- | ------------------------------------- | ------ | --------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `https://siteops-server.onrender.com` | No     | The origin `/api/*` is proxied to. Must be `https`. |
| `NEXT_PUBLIC_APP_URL` | `https://siteops-client.vercel.app`   | No     | This app's own public origin.                       |

Both are validated at import time in `siteOps-client/src/lib/env.ts`; a missing or malformed value
fails the build rather than shipping a bundle that cannot reach the API.

**Set them for the Production environment specifically.** A variable configured only for Preview or
Development is absent from the production build, and because `NEXT_PUBLIC_*` values are inlined at
build time, changing one requires a redeploy — editing it in the dashboard does not affect the
bundle already serving traffic.

`NEXT_PUBLIC_API_URL` is read twice, and both readers matter:

- `next.config.ts` uses it as the rewrite destination for `/api/*`.
- `src/lib/api-base.ts` uses it as the base URL for requests made during server rendering, which
  have no origin to be relative to.

---

## API and worker — Render

Both processes read one environment and one schema (`src/config/env.schema.ts`). Every value is
validated at startup; a missing or malformed required value stops the process rather than letting it
run misconfigured.

### Required

| Variable         | Value                                 | Secret  | Notes                                                                          |
| ---------------- | ------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`       | `production`                          | No      | **Was missing.** See below — this is the defect that broke sign-in.            |
| `APP_URL`        | `https://siteops-client.vercel.app`   | No      | CORS allowlist, Better Auth trusted origin, and every link in an email.        |
| `API_URL`        | `https://siteops-server.onrender.com` | No      | Absolute callback URLs, including the verification link.                       |
| `MONGODB_URI`    | Atlas connection string               | **Yes** | Needs a replica set: one transaction creates an org with its first membership. |
| `AUTH_SECRET`    | ≥ 32 random characters                | **Yes** | Signs sessions and email tokens. `openssl rand -base64 32`.                    |
| `RESEND_API_KEY` | Resend key                            | **Yes** | Required in production; the schema refuses to start without it.                |
| `PORT`           | Render supplies this                  | No      | Do not hardcode.                                                               |

### `NODE_ENV` — the one that was wrong

The deployed API was running without it, so it defaulted to `development`. That single value decides
`useSecureCookies` and the cookie's `secure` attribute in `src/config/auth.ts`, so every session
cookie went out over https with neither `Secure` nor the `__Secure-` prefix. It also disables HSTS,
which is how this audit detected it from outside: the API served no `Strict-Transport-Security`
header, and `src/app.ts` only omits that when `isProduction` is false.

Nothing about this fails loudly. The process starts, the database connects, sign-in answers `200`
with a real session — and the cookie is one no browser should keep.

The schema now refuses to start when `APP_URL` is a remote `https` origin and `NODE_ENV` is not
`production`, because that combination has no working outcome.

### Recommended

| Variable                          | Value           | Secret | Notes                                                                                                                                                                                                                  |
| --------------------------------- | --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                     | `true`          | No     | Render terminates TLS at its own edge. Left `false`, every request is attributed to the platform's address and the whole deployment shares one rate-limit budget. See "Known limitation".                              |
| `MONGODB_AUTO_INDEX`              | `false`         | No     | An index build issued by a starting process can stall a live cluster. Run `pnpm indexes:sync` as an explicit deploy step instead — without one or the other, none of the uniqueness the product relies on is enforced. |
| `LOG_LEVEL`                       | `info`          | No     |                                                                                                                                                                                                                        |
| `EMAIL_FROM`                      | verified sender | No     | Must be a domain verified with Resend.                                                                                                                                                                                 |
| `SESSION_RATE_LIMIT_MAX_REQUESTS` | `60`            | No     | `GET /api/session` is hit twice per page load — once by the server component, once by the browser.                                                                                                                     |

### Must stay unset

| Variable                          | Why                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COOKIE_DOMAIN`                   | The dashboard proxies `/api/*`, so the cookie must be scoped to the dashboard's own host. Setting this to the API's domain makes the browser reject it outright. |
| `MONITOR_ALLOW_PRIVATE_ADDRESSES` | Disables SSRF protection. The schema refuses it in production.                                                                                                   |

### Optional

| Variable                     | Secret  | Effect when unset                                                                                                                                                                               |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAGESPEED_API_KEY`          | **Yes** | Performance monitoring falls back to server-side timings: no Lighthouse score, no LCP or CLS. Every result names which method produced it.                                                      |
| `STRIPE_SECRET_KEY`          | **Yes** | No payment provider is constructed; billing routes answer `BILLING_NOT_CONFIGURED` and the dashboard says so plainly. This is a fully supported state, and currently the deployed one.          |
| `STRIPE_WEBHOOK_SECRET`      | **Yes** | Required whenever `STRIPE_SECRET_KEY` is set; the schema refuses one without the other, because a deployment that can take money but cannot verify that it did leaves every subscription stuck. |
| `STRIPE_PRICE_*` (six)       | No      | A plan with no price id is not sold by this deployment — the pricing page still describes it and checkout refuses it with a clear message.                                                      |
| `ADDITIONAL_TRUSTED_ORIGINS` | No      | Extra browser origins allowed to send credentialed requests. Not needed for the current single-dashboard deployment.                                                                            |

---

## Cookies and origins

The dashboard and the API are on different registrable domains — `vercel.app` and `onrender.com`
are both public suffixes, so those are two different _sites_, not two hosts of one site.

That matters because the session cookie is `HttpOnly` and `SameSite=Lax`:

- A browser will not **store** a `Lax` cookie that arrives on a cross-site response. Sign-in
  returned `200` and Chrome discarded the `Set-Cookie` unread.
- Even stored, the cookie would be scoped to the API's host. The dashboard's routing middleware and
  its server components both read the cookie on the _dashboard's_ origin, and would never see it.

`SameSite=None` fixes only the first of those. The fix therefore is not a cookie setting: the
dashboard now serves the API from its own origin by rewriting `/api/*` to `NEXT_PUBLIC_API_URL`.
Every request the browser makes is same-origin, so the cookie is set by, scoped to, and returned to
the dashboard's host, and `SameSite=Lax` is both correct and the safer setting.

Two consequences worth knowing:

- **`APP_URL` on Render must be the dashboard's origin.** Better Auth validates `Origin`/`Referer`
  against its trusted origins on state-changing auth routes, and the proxy forwards both headers.
  A mismatch refuses sign-out with a bare `403`. This is also what keeps CSRF protection intact
  through the proxy: a forged cross-site request still arrives carrying the attacker's origin.
- **CORS is no longer on the browser's path.** It still applies to nothing the browser does, but the
  allowlist in `src/config/cors.ts` remains correct and is left in place — it is the boundary if
  anything ever calls the API directly again.

---

## Known limitation: rate limiting behind two proxies

With the dashboard proxying, API requests reach Render from Vercel's edge rather than from the
visitor. Per-address rate limiting therefore depends on `X-Forwarded-For` surviving that chain, and
on Express being told how many hops to trust — `src/app.ts` sets `trust proxy` to `1`.

This is not a regression introduced by the proxy: with `TRUST_PROXY=false` today, every request is
already attributed to the platform's own address, so the whole deployment shares one budget. Setting
`TRUST_PROXY=true` is a clear improvement. Whether hop `1` resolves to the real visitor through
Vercel _and_ Cloudflare _and_ Render's own proxy is not something this audit could measure from
outside, and it should be verified with real traffic before the limits are relied on for abuse
prevention rather than for basic protection.

---

## Verifying a deployment from outside

Two checks that need no credentials and would have caught the defect above:

```bash
# Must print a Strict-Transport-Security header. If it does not, NODE_ENV is not production.
curl -sI https://siteops-server.onrender.com/health | grep -i strict-transport-security

# Must report the database as reachable.
curl -s https://siteops-server.onrender.com/health/ready
```
