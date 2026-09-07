# SiteOps production feature audit

Five reported problems, what each one actually was, and what was changed. Every root cause below was
reproduced against the live deployment or the production database before anything was written.

Companion documents: [SITEOPS-RENDER-DEPLOYMENT-AUDIT.md](./SITEOPS-RENDER-DEPLOYMENT-AUDIT.md)
covers the earlier startup failure, [PRODUCTION-ENV.md](./PRODUCTION-ENV.md) is the standing
environment reference, and [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) now carries the operational
detail this document only summarises.

---

## Summary

| #   | Reported                       | Actual cause                                                                        | Status                      |
| --- | ------------------------------ | ----------------------------------------------------------------------------------- | --------------------------- |
| 1   | "Last checked: 18 hours ago"   | No monitoring process running in production at all.                                 | Fixed in code; needs deploy |
| 2   | Purchase goes to an email flow | No Stripe configuration → every plan unpurchasable → CTA fell through to `mailto:`. | UI fixed; needs Stripe keys |
| 3   | Domain expiry inaccurate       | RDAP requests sent with no `User-Agent` → HTTP 403 → misread as "TLD unsupported".  | Fixed and verified          |
| 4   | SSL information inaccurate     | The checker was correct; the _displayed day count_ was frozen at last check time.   | Fixed and verified          |
| 5   | Pages need full width          | Every page centred in a `max-w-*` column inside a 256px sidebar shell.              | Fixed                       |

Two of these need something only the account owner can do — see
[What still has to be done by hand](#what-still-has-to-be-done-by-hand).

---

## 1. Monitoring was not running

### What the evidence said

The production database, read directly:

```text
now = 2026-09-07T13:32:05Z

Sumon Portfolio   nextCheckAt 2026-09-06T19:35:21Z   overdue 1077 min   lease null
Salman Portfolio  nextCheckAt 2026-09-06T19:35:22Z   overdue 1077 min   lease null

website_checks: 118 documents, newest 2026-09-06T19:30:22Z
```

Both websites were due, neither was leased, and the newest check was eighteen hours old. A lease of
`null` is the important detail: nothing had claimed them and crashed. Nothing had claimed them at
all.

Meanwhile `/health` and `/health/ready` both answered 200 with `database: ok`, and the dashboard
reported **100% uptime, 2 operational, 0 incidents** — every figure accurate about the previous
evening and presented as the present.

### Root cause

**The monitoring worker was never running in production.** The architecture is two processes —
`dist/server.js` and `dist/worker.js` — and only the first was deployed. Render's Background Workers
are a paid service type, so on the current plan there was nowhere for the second one to run.

Nothing had crashed and nothing was misconfigured in the code. The deployment was simply missing
half of itself, and no signal anywhere said so.

### What changed

**The loops can now run inside the API process.** `src/jobs/monitoring-runtime.ts` is the scheduler
composition extracted out of `worker.ts`; both entry points construct one. `MONITORING_RUNTIME`
selects the host:

```text
separate  (default)  a dedicated worker process — still the better architecture
inline               the API process runs the same three loops
```

The queues, leases, jobs and incident rules are byte-for-byte the same in both. Only the event loop
they share differs.

**An external clock drives it.** `inline` alone is not sufficient on a plan that suspends an idle
service, because a suspended process runs no timers and an in-process loop cannot wake itself.
`cloudflare/` is a Cloudflare Worker whose cron trigger fires every minute and makes one
authenticated request to `POST /api/internal/monitoring/tick`, which wakes the instance _and_ runs a
sweep before returning.

The Worker deliberately does no monitoring itself. It cannot: certificate inspection needs
`node:tls` with the peer certificate read off the socket, the SSRF guard needs `node:dns` to
classify a resolved address before connecting, and results go to MongoDB over a TCP driver
connection. None exist in the Workers runtime, so putting the checks there would have meant deleting
certificate inspection and the SSRF guard. Cloudflare is the clock; Node does the work.

**Failures are now visible.** A `worker_heartbeats` collection records one document per runtime
instance, refreshed on every tick and every 30s while idle. `GET /api/internal/monitoring/health`
derives a verdict from the newest heartbeat rather than from whatever process answers the request:

```json
{
  "status": "running",
  "heartbeatAgeSeconds": 23,
  "host": "api",
  "liveInstances": 1,
  "pendingChecks": 0,
  "overdueChecks": 0,
  "failedChecksLast24h": 3,
  "totalChecksLast24h": 6,
  "lastCheckRecordedAt": "2026-09-07T14:28:25.564Z"
}
```

`running` / `degraded` / `stopped` / `never_started` come from heartbeat age. `overdueChecks` —
websites due for over five minutes with nothing claiming them — is the figure that would have caught
this on day one.

Customers get a plainer version that names nothing about infrastructure: `MonitoringFreshness` on
the dashboard raises a banner when the newest check across their websites is older than three times
their shortest configured interval. It does not diagnose; it refuses to present stale numbers as
current.

### Both operator endpoints are authenticated

`/api/internal/*` sits behind a single bearer token (`INTERNAL_API_KEY`), compared in constant time
with `timingSafeEqual`. With the variable unset both endpoints answer 503 rather than running open:
an unauthenticated endpoint that can force work is a denial-of-service amplifier, and one that
reports queue depth is reconnaissance.

### Resilience, as verified rather than as claimed

Run against a scratch database with six deliberately awkward targets — a healthy HTTPS site, a
multi-level ccTLD, an expired certificate, a hostname-mismatched certificate, a hostname that does
not resolve, and a plain-HTTP site:

```text
14:28:23  scheduler.tick_claimed        count=6
14:28:25  monitor.run_completed  ssl     passing
14:28:25  monitor.run_completed  ssl     failing     (expired)
14:28:25  monitor.run_completed  ssl     error       (DNS failure)
14:28:26  monitor.run_completed  ssl     failing     (hostname mismatch)
14:28:27  monitor.run_completed  domain  passing
...
14:30:31  website.check.completed  status=error  newStatus=down  transition=ongoing
```

After four minutes: **17 checks across 6 websites**, every `nextCheckAt` advanced by exactly the
configured interval, every lease released, failure thresholds crossed so three sites moved
`unknown → degraded → down`, and three incidents opened. One unresolvable hostname and two invalid
certificates in the same batch did not stop the sweep, the loop or the process.

The scratch database was dropped afterwards and production data was never written to.

---

## 2. Purchasing sent you to email

### Root cause

Reproduced in the live dashboard. Every paid plan's button was this:

```html
<a href="mailto:sales@siteops.app?subject=SiteOps%20plan%20enquiry">Contact us</a>
```

Clicking "Upgrade" opened a mail client. That is the reported "email flow", and it was not an
authentication redirect, a verification requirement or a route collision.

The chain:

1. No `STRIPE_*` variables are set on the deployment — all eight are commented out in `.env.prod`.
2. With no `STRIPE_SECRET_KEY`, no provider is constructed and `PriceCatalog` is empty.
3. `GET /api/billing/plans` therefore reports `billingConfigured: false` and `purchasable: false`
   for **every** plan — confirmed against production.
4. `PlanCta` tested `!entry.purchasable` _before_ it tested `billingConfigured`, so the branch meant
   for "this deployment does not sell this particular tier" fired for all four.

Step 4 is the code defect. Steps 1–3 are configuration.

### What changed

The two states are now distinguished, because they need different answers:

- **no provider configured at all** → a disabled "Checkout unavailable", alongside the banner that
  already explained the state;
- **provider configured, this tier not sold here** → "Contact us" stays, because a sales
  conversation genuinely is the next step.

"Contact us" is a sales answer to _we don't sell this tier_. It was the wrong answer to _billing
isn't set up_, and dressing one up as the other made a broken deployment look like a deliberate
pricing decision.

### What was **not** changed

Nothing in the payment path was faked, stubbed or bypassed. There is no mock checkout, no fabricated
success and no route that sets a plan directly. `organization.plan` is still written by exactly one
code path — the webhook handler, after a signature verifies. The audited flow is intact:

```text
Pricing → plan chosen (never a price) → checkout session created server-side
        → provider-hosted payment → signed webhook → subscription → organization plan → limits
```

The server-side implementation was audited and found correct: `createCheckout` takes a plan
identifier and resolves the price from configuration, so no request can influence what is charged;
`parseWebhook` verifies the signature before returning anything; the browser's return from checkout
is treated as a redirect target and never as evidence of payment.

**This cannot be verified end-to-end without Stripe credentials**, which this deployment does not
have. See [the Stripe setup](#stripe-setup) below for the exact steps.

---

## 3. Domain expiry was wrong

### Root cause

Two independent bugs, both reproduced.

**(a) `rdap.org` answers 403 to a request with no `User-Agent`.** It sits behind Cloudflare, and
undici's `request()` sends no `User-Agent` by default. Reproduced directly:

```text
GET https://rdap.org/domain/mdsumon.dev
  (no User-Agent)                → 403  Cloudflare challenge page
  User-Agent: SiteOpsMonitor/1.0 → 302 → 200 application/rdap+json
```

The provider classified any non-200 as `outcome: 'unsupported'`, so the chain fell through to WHOIS,
WHOIS has no server for `.dev`, and the stored result was:

```json
{ "status": "error", "summary": "No WHOIS server is published for this TLD.", "source": "none" }
```

A transient block, reported as a permanent property of the TLD, for every domain in the product.

**(b) The registrable domain was guessed by walking labels, and the guess was wrong.** The lookup
tried two labels first and accepted the first registry that answered. But `co.uk` _is_ a real RDAP
object:

```text
GET https://rdap.org/domain/co.uk → 200, registrar "Nominet UK", no expiry date
```

So `www.bbc.co.uk` resolved to `co.uk`, got a confident 200 back, and reported its expiry as
unknown. A miss would have been obvious; a wrong answer with a real registrar attached was not.

### What changed

- **Every RDAP request now sends a `User-Agent`.** This is a correctness requirement, not
  politeness — several registries apply the same rule.
- **403 is classified as `error`, not `unsupported`.** "We were blocked" is transient and must not
  end the provider chain looking like "this TLD has none".
- **IANA's bootstrap registry decides which server to ask.** `https://data.iana.org/rdap/dns.json`
  (1,200 TLDs, cached for a day) maps `.dev` to Google's registry and `.uk` to Nominet, and the
  query goes straight there. `rdap.org` is now only the fallback for TLDs the registry does not
  list. A single volunteer-run redirector in front of every lookup was one outage away from every
  domain reporting "expiry unknown".
- **The Public Suffix List decides where a registrable name begins.** Fetched from publicsuffix.org
  and cached for a day rather than bundled — a committed copy is stale the day after, and a TLD
  delegated next month then looks like a lookup failure. The ICANN section only: the private section
  would make `siteops.vercel.app` "registrable", which no registrar has ever heard of.
- **A dateless answer no longer wins.** When the suffix list is unavailable the label-walk is still
  the fallback, but a candidate that returns no registration or expiry date is kept only as a last
  resort. That is what stops the walk settling on `co.uk`.
- **An unregistered domain is now `failing`, not `error`**, with its own wording. For a site someone
  is actively monitoring it is the most serious verdict this monitor has, and filing it under
  "could not find out" buried it among transient registry outages.

### Verified against live registries

| URL                              | Registrable domain | Registrar                        | Expires    | Days |
| -------------------------------- | ------------------ | -------------------------------- | ---------- | ---- |
| `https://mdsumon.dev/`           | `mdsumon.dev`      | Name.com, Inc.                   | 2027-06-17 | 283  |
| `https://farshi.dev/`            | `farshi.dev`       | Name.com, Inc.                   | 2027-05-11 | 245  |
| `https://www.bbc.co.uk/news`     | **`bbc.co.uk`**    | British Broadcasting Corporation | 2034-12-13 | 3018 |
| `https://example.com/path?q=1`   | `example.com`      | IANA                             | 2027-08-13 | 339  |
| `https://www.daraz.com.bd/`      | `daraz.com.bd`     | —                                | —          | —    |
| `https://…-does-not-exist-…com/` | —                  | —                                | —          | —    |

The last two are the honest cases. `.bd` publishes neither RDAP nor WHOIS, so the result is
`error: "No WHOIS server is published for this TLD."` with every field null — never a fabricated
date. The unregistered domain is `failing: "This domain is not registered."`

Suffix resolution, against the real 6,926-rule ICANN list:

```text
mdsumon.dev          → mdsumon.dev
www.bbc.co.uk        → bbc.co.uk        (not co.uk)
shop.example.co.uk   → example.co.uk
example.com.bd       → example.com.bd   (three labels, via the *.bd wildcard)
sub.example.com      → example.com
co.uk                → null             (a suffix, nothing to look up)
```

A unit test caught a real defect in the matcher during this work: a `continue` after a plain-rule
match skipped the wildcard check for the same label, so every TLD listed as both `ck` and `*.ck`
resolved one label short.

---

## 4. SSL information was inaccurate

### Root cause

**The SSL checker itself was correct** and needed no repair. It opens a real TLS connection to the
guard-approved address with SNI set to the hostname, reads the peer certificate off the socket, and
reports `authorized` and `authorizationError` as OpenSSL gave them. Verified across five cases:

| Target                   | valid | Issuer                         | Days  | Hostname |
| ------------------------ | ----- | ------------------------------ | ----- | -------- |
| `mdsumon.dev`            | true  | WE1 (Google Trust Services)    | 67    | yes      |
| `bbc.co.uk`              | true  | GlobalSign GCC R46 OV TLS 2025 | 138   | yes      |
| `expired.badssl.com`     | false | COMODO RSA DV                  | -4166 | yes      |
| `wrong.host.badssl.com`  | false | YR2 (Let's Encrypt)            | 49    | **no**   |
| `self-signed.badssl.com` | false | \*.badssl.com (BadSSL)         | 724   | yes      |
| `http://neverssl.com/`   | —     | not served over HTTPS          | —     | —        |

The inaccuracy was **in the display, and it was staleness**. `daysRemaining` is computed when the
check runs and stored with the result — correct for the historical record. The dashboard printed
that stored number as though it were current, so a certificate checked yesterday and recorded as
"68 days remaining" still said 68 today. While the worker was down it would have said 68
indefinitely. Same defect on the domain monitor's countdown.

### What changed

- `src/lib/expiry.ts` derives the day count from the expiry date at render time; the stored value is
  only a fallback for a record that has a count but no date. Floored, never rounded — "expires in 23
  hours" must read as 0 days, not 1.
- The collapsed monitor row rebuilds its own summary line for SSL and domain rather than printing
  the server's prose, which froze at check time along with the number in it.
- The clock is read through `useNow()`, a `useSyncExternalStore` subscription, so the value is not
  read impurely during render and a tab left open re-evaluates instead of holding the verdict it
  loaded with.
- **The detail panels now carry every field asked for.** SSL: status, issuer, valid from, valid
  until, days remaining, hostname match, certificate names (SAN), TLS version and key algorithm.
  Domain: domain, registrar, registered, expires, days remaining, registry status codes, and which
  source answered. Missing values read `Unavailable` or `Unknown` — never a blank that looks like a
  date nobody noticed.
- A monitor that has run but is still `unknown` no longer claims "Not yet run". The badge only
  reaches a real status after several consecutive errors, so a monitor erroring since yesterday sat
  there claiming it had never run, directly above the message explaining why it had.

### SSRF protection is unchanged

No part of the guard was touched. Hostnames are still resolved, every address still goes through
`classifyIpAddress`, and the socket still connects to the approved IP with SNI carrying the original
hostname — connecting by name would re-query DNS inside the TLS layer and reopen the rebinding
window. `rejectUnauthorized: false` in the SSL checker remains what it was: nothing is sent over
that socket, it exists to read a certificate a browser would reject, and `authorized` still reports
truthfully what a browser would have decided.

The two new outbound fetches (IANA bootstrap, publicsuffix.org) are fixed URLs set in code, not
user-supplied, so they are outside the SSRF boundary by construction. Both are size-bounded,
timeout-bounded and cached, and a failure degrades the lookup rather than failing it.

---

## 5. Full-width layout

Every dashboard page opened with the same shape:

```html
<div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10"></div>
```

— with the number varying between `3xl` and `6xl` for no reason anyone could name, inside a shell
that had already taken 256px for the sidebar. On a 1600px screen that left content in a ribbon with
dead space either side, and gave the tables that need width most the least of it.

**All dashboard pages** now use `PageContainer`: full width, responsive padding, no maximum. One
component so the width policy is one decision rather than eleven.

**Three routes render with no sidebar at all** — website detail, reports, and billing. The `<aside>`
is _not rendered_ on them rather than hidden: a hidden aside that keeps its track in the flex row
leaves a 256px gap where the navigation used to be, which reads as a rendering bug rather than a
layout.

Navigation is not lost. Those routes get a 56px top bar carrying what the sidebar was load-bearing
for — where to go, which organization, who is signed in — with labels collapsing to icons below the
`md` breakpoint so the whole set stays reachable without horizontal scroll. Identical at every
breakpoint, since there is no drawer to open.

Route matching is by prefix except for websites: `/dashboard/websites` is the list and keeps its
sidebar, while `/dashboard/websites/<id>` is the detail view and does not. Prefix matching there
would have taken it off both.

---

## What still has to be done by hand

Two of the five fixes need something only the account owner can do. Neither is code.

### Render environment

| Variable             | Value       | Why                                                                |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| `MONITORING_RUNTIME` | `inline`    | Without it the API still runs no loops and nothing changes.        |
| `INTERNAL_API_KEY`   | (generated) | Already written into the local `.env.prod`; copy the value across. |

Both are in `.env.prod`, which is git-ignored and stays local.

If a Background Worker becomes available later, set `MONITORING_RUNTIME=separate`, add a second
service with start command `node dist/worker.js` and the same environment, and remove the Cloudflare
Worker. Nothing else changes.

### Cloudflare Worker

```bash
cd siteOps-server/cloudflare
npx wrangler secret put INTERNAL_API_KEY   # the same value as above
npx wrangler deploy
```

`SITEOPS_API_URL` is already set to `https://siteops-server.onrender.com` in `wrangler.toml`.

### Stripe setup

Billing stays at "checkout unavailable" until these exist. In the Stripe dashboard, **test mode**
first:

1. Create three products — Professional, Agency, Pro — each with a monthly and a yearly price, at
   the amounts the API already serves (`$19 / $190`, `$79 / $790`, `$199 / $1990`).
2. Copy the six `price_…` ids.
3. Add a webhook endpoint at `https://siteops-server.onrender.com/api/billing/webhook`, subscribed
   to `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated` and `customer.subscription.deleted`. Copy its signing secret.
4. Set on Render:

```text
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_STARTER_MONTHLY=price_…
STRIPE_PRICE_STARTER_YEARLY=price_…
STRIPE_PRICE_AGENCY_MONTHLY=price_…
STRIPE_PRICE_AGENCY_YEARLY=price_…
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_YEARLY=price_…
```

The schema refuses to start with a secret key and no webhook secret — a deployment that can take
money and has no verified way to learn that it did is the worst of the three states. It also refuses
an `sk_live_` key outside production.

Confirm with `GET /api/billing/plans`: `billingConfigured` becomes `true` and each configured plan
`purchasable`. The dashboard's buttons change from "Checkout unavailable" to "Upgrade to …" on their
own — nothing is cached.

---

## Checks

| Command          | Server         | Client    |
| ---------------- | -------------- | --------- |
| `pnpm lint`      | pass           | pass      |
| `pnpm typecheck` | pass           | pass      |
| `pnpm test`      | 590 unit, pass | 218, pass |
| `pnpm build`     | pass           | pass      |

**Two pre-existing integration failures** in `tests/integration/auth.test.ts` are unrelated to this
work: organization creation returns 500 without a local MongoDB replica set, and Docker Desktop was
not available on this machine. Both were confirmed to fail identically on a clean checkout with
every change stashed. The remaining integration tests skip themselves when no database is present.

New tests: `reference-data.test.ts` (15 — suffix rules, wildcards, exceptions, bootstrap parsing),
`monitoring-health.service.test.ts` (5 — heartbeat verdicts, monotonic escalation), `expiry.test.ts`
(14 — live day counts, drift, unknown handling), and rewritten domain-runner and pricing-table cases
covering the two production bugs directly.

---

## Remaining limitations

- **Live checkout is unverified.** No Stripe account exists for this deployment. The flow is covered
  by unit tests against the provider interface and the signature verifier, and audited by reading;
  it has not been clicked through against Stripe.
- **`inline` is a workaround for the plan, not an improvement.** A dedicated worker remains the
  better architecture and the code still defaults to it.
- **The Cloudflare Worker is a dependency.** If it stops, an idle instance sleeps and monitoring
  stops with it — visibly now, via the heartbeat and the dashboard banner, but it does stop.
- **`.bd` and similar TLDs publish no registration data.** Reported as unavailable, which is
  accurate. A commercial domain API is the only fix and would be a new provider behind the existing
  interface.
- **An HTTP-only site reports SSL as `failing`.** This is the existing deliberate behaviour, not a
  regression: there is no certificate, and the actionable advice is to move to HTTPS. It opens one
  incident and sends one email, not a repeating alert.
- **Integration tests need a MongoDB replica set** that was not available here.
