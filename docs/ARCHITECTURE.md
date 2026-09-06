# Architecture

How this backend is put together, and why it is put together that way. Decisions are recorded with
their reasoning so a later change can tell "deliberate" apart from "how it happened to end up".

## Two processes, one database

```text
                    siteOps-client
                          │
                          │ HTTPS, credentials: include
                          ▼
                  ┌───────────────┐
                  │  Express API  │   src/server.ts
                  └───────┬───────┘
                          │
                     middleware
                          │
                     controller
                          │
                       service
                          │
                     repository
                          │
                       Mongoose
                          │
                          ▼
                      MongoDB  ◀────────────┐
                          ▲                 │
                          │                 │
              ┌───────────┴──────────┐      │
              │  Monitoring worker   │      │  src/worker.ts
              └───────────┬──────────┘      │
                          │                 │
                    scheduler loop          │
                          │                 │
                     claim a lease ─────────┘
                          │
                     HTTP checker  ──▶  the monitored website
                          │
                    check result
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         incident rules          website status
              │
        notification dispatch ──▶  Resend
```

The API and the worker are **separate processes** deliberately. Monitoring is long-running I/O
against targets chosen by users, and it must not compete with request handling for the event loop,
the connection pool or a restart. They share only the database and the code in `src/` — no queue
protocol, no RPC.

## Layering

```text
Route → Middleware → Controller → Service → Repository → Mongoose → MongoDB
```

**Controllers are thin.** They read validated input, call one service method and choose a status
code. Everything a controller appears to enforce is enforced again in the service, which the worker
can also call. A rule that needed a `Request` object to work would be unreachable from the worker,
which is the test for whether it is in the right place.

**Services hold business logic.** Plan limits, the last-owner rule, incident thresholds, URL
normalization. They take an `OrganizationContext` rather than a request, so they are callable from
a script or a job.

**Repositories own database access.** Every method that touches organization-scoped data takes the
organization id as a _required argument_, and every query filters on it. That is what makes tenant
isolation a property of the layer rather than a habit of the caller — there is no query path that
omits the tenant, so forgetting one is not possible rather than merely unlikely.

**Composition happens in one place.** `src/app.ts` constructs every repository and service by hand
and passes them down. There is no DI container: the graph is small enough that a container would
hide more than it explains, and the wiring in `createApp` reads as the architecture diagram.

## Decisions

### The response envelope is `{ success, data }`

Not `{ success, statusCode, message, data }`.

`siteOps-client/src/lib/api-client.ts` reads `payload.success` and returns `payload.data`, turning
`payload.error.code` into the typed `ApiError` every screen branches on. A different top-level shape
breaks the whole dashboard at once. Pagination therefore travels _inside_ `data`, as
`{ items, pagination }` — the shapes the client already has types for.

`src/responses/ApiResponse.ts` is the only place a body is shaped, so this cannot drift per handler.

### The prefix is `/api`, not `/api/v1`

The dashboard addresses `/api/...` directly. Versioning today would be a breaking change to every
screen for no present benefit. When a second version is genuinely needed it can be mounted
alongside this one.

### Authentication is Better Auth, mounted as raw middleware

Password hashing, session issuing and token lifecycles are delegated to Better Auth rather than
hand-rolled. That is the single most valuable thing the library provides, and re-implementing it is
how authentication bugs happen.

It is also a **contract**, not just an implementation choice:

- The session cookie is named `siteops.session_token`, which
  `siteOps-client/src/middleware.ts` matches to decide whether to redirect a signed-out visitor.
- The email-verification token is a self-contained HS256 JWT over `{ email }` signed with
  `AUTH_SECRET`. The dashboard's Playwright suite **mints this token itself**, because there is no
  mail provider in a test run.

Replacing the library means reproducing both exactly. `src/config/auth.ts` says so at the top.

It is mounted _before_ the body parser in `app.ts` because its handler consumes the raw request
stream; a parser would leave every sign-in with an empty body.
`src/middlewares/better-auth.middleware.ts` adapts its Web `Request`/`Response` handler to Express
and rewrites both its successes and its errors into the SiteOps envelope, so the whole API speaks
one shape and the dashboard needs one parser.

The rest of the codebase never touches the library. It sees `AuthService`, which returns a narrow
`RequestAuthContext` — an id, an address, a name, a verification flag — and never the raw session.

### There is no separate `monitors` collection

A website has exactly one monitor. Its configuration — `monitoringEnabled`,
`monitoringIntervalSeconds`, `requestTimeoutMs`, `failureThreshold`, `recoveryThreshold` — is what
`WebsiteDto` already carries, and the dashboard presents the two as one thing. A separate
collection would mean a join on every read to rebuild a document that was never apart.

What _is_ separate is `MonitorService`: pausing monitoring is a different operation from editing a
website, with a different permission (`monitoring:toggle`) and different side effects on the check
schedule.

### There is no Redis and no BullMQ

The queue is the `websites` collection. `nextCheckAt` is the ready time, `leaseExpiresAt` is the
visibility timeout, and both are manipulated by one atomic `findOneAndUpdate` — see
`src/queues/monitoring.queue.ts`. That buys the two properties a broker would have provided:
at-most-one worker per website, and recovery from a worker that dies mid-check.

The reasoning against adding one:

- **No second service** to run, monitor, secure and pay for.
- **No second source of truth.** Incident and notification idempotency are already enforced by
  unique partial indexes in MongoDB. A broker's own delivery semantics would be a _different_
  guarantee layered on top, and reconciling the two is where duplicate-alert bugs live.

The cost, stated honestly: claiming is one round trip per website rather than a batched pop, and
the poll interval bounds how promptly a due check starts. Neither matters at this product's scale.
If it ever does, `monitoring.queue.ts` is the only module that has to change — `claimBatch` and
`releaseAndReschedule` are the whole interface.

### Reports are queries, not documents

`ReportService` answers uptime, response-time and dashboard questions by aggregating the check
history. Nothing is stored. A scheduled or exported report would need a collection of its own;
neither the dashboard nor the product asks for one, so there is none.

### Subscriptions are a field, not a collection

An organization has exactly one subscription and is never read without it, so the subscription is
an embedded `billing` subdocument on `organizations` rather than a collection of its own — a
separate document would be a join on the path that answers every entitlement question, for a
one-to-one relationship that cannot become one-to-many. Invoices and payment history stay at the
provider, which renders them better than SiteOps would.

`organization.plan` deliberately stays _outside_ that subdocument, where `EntitlementService` has
always read it. An organization with no billing record at all is still a valid free-plan tenant,
and a provider outage cannot make every plan lookup fail.

Three rules hold across `services/billing.service.ts`:

1. **The plan changes only on a signed provider event.** No route writes it. `startCheckout`
   returns a redirect URL and nothing else; the webhook handler is the sole caller of
   `applySubscriptionState`. Forging, replaying or editing the browser's return from checkout
   changes nothing, because the return trip is not what grants the plan.
2. **The price never travels in a request.** A checkout names a plan and an interval; the provider
   price id is resolved server-side from `PriceCatalog`. There is no field a caller could send to
   be charged less.
3. **The tenant is resolved from provider-held state** — metadata Stripe stored and echoed, or the
   unique `billing.customerId` mapping — never from anything carried by the browser between hops.

### SiteOps never mutates a subscription

Checkout creates one; Stripe's hosted customer portal changes, cancels and resumes it. That is not
a shortcut. Proration on a mid-cycle plan change is genuinely hard, it is wrong in ways that appear
on a real card, and the portal has solved it along with payment methods, invoices, tax and dunning.
What SiteOps owns is which plan a checkout is _for_, and mirroring the answer back.

Webhooks are unordered and delivered at least once, so two mechanisms guard the write:
`billing_events` holds a unique event id claimed before processing (a duplicate delivery stops
there), and `applySubscriptionState` refuses any event older than `billing.lastEventAt` — without
which a late `updated` could overwrite a newer `deleted` and leave a cancelled customer on a paid
plan indefinitely.

Billing is optional. With no `STRIPE_SECRET_KEY` no provider is constructed: the routes answer
`BILLING_NOT_CONFIGURED`, the catalogue reports `billingConfigured: false`, and the dashboard says
so. There is no stub provider — a fake checkout URL is the one thing billing code must never
produce.

### There is no user controller

The `user` collection belongs to the authentication layer, which owns password hashing and session
invalidation along with it. A profile write that bypassed it would put those in two places.
`GET /api/session` already returns the signed-in user, so a `/api/users/me` would duplicate it.
`UserRepository` exists — the members table and the notification recipients need to read names and
addresses — but it is read-only, and there is no service or route above it.

### Validation lives in the contract, composition lives in `validators/`

`src/contracts/schemas` holds one Zod schema per concept, and the dashboard imports the same
file. The browser form and the API therefore enforce literally the same rule and cannot drift.
`src/validators` composes them into per-route bundles — which schema applies to which part of which
request — and adds the route-parameter schemas, which have no browser counterpart.

`validate` writes parsed values to `request.validated` rather than over `request.body`, because
Express 5 makes `query` a getter with no setter. The accessors throw when a route forgot its
schema, so a missing one fails loudly at the first request instead of handing a controller
unvalidated input.

### Guards are declared per route, not applied globally

The trade-off is real: a global guard fails safe when a route forgets to opt in. But it also makes
the security posture of a route invisible at the route table.

Here every route states what it needs on the line that declares it — `requireAuth`, then
`requireOrganization(repo, 'website:create')` — so reading the chain top to bottom tells you what
protects it, with no ambient default to remember. `tests/integration` asserts the behaviour of each
one, so a forgotten guard surfaces as a failing test rather than as an absence a reviewer has to
notice.

### `src/contracts` is the source of truth, and it is copied

`siteOps-client/src/contracts` is a copy of this directory. Change it here first, port it there,
and let the tests that live alongside each module say whether the port was faithful.

The copy is only safe because every module here is platform-neutral — no Node built-ins, no
database types, nothing but TypeScript and Zod. Anything that cannot survive in a browser does not
belong in that directory. Publishing it to a registry is the right move once the contract changes
often enough that drift becomes likely; until then a copy plus its tests is cheaper.

## Request lifecycle

```text
request
  │
  ├─ requestId          correlation id, echoed as X-Request-Id
  ├─ helmet             security headers
  ├─ corsMiddleware     explicit origin allowlist, never reflected
  │
  ├─ /health*           probes, before rate limiting and before /api
  │
  ├─ /api/auth/*        authRateLimit → Better Auth (raw body, own envelope adapter)
  │
  ├─ express.json       100kb limit
  ├─ defaultRateLimit   the general allowance
  │
  └─ /api               router
       ├─ rateLimit(...)          stricter, per route
       ├─ requireAuth             session or 401
       ├─ validate(...)           body / query / params
       ├─ requireOrganization     membership + permission, or 404
       └─ controller → service → repository
  │
  ├─ notFoundHandler    unmatched paths, in the envelope
  └─ errorHandler       every failure, in the envelope
```

`errorHandler` is terminal. Nothing about the internals leaves the process: stack traces, driver
errors, file paths and connection strings are logged server-side and replaced with a message
written for a person.

## Keeping this current

Update this file when a decision changes: a new layer boundary, a new security rule, a dependency
chosen or dropped for a reason. Endpoint detail belongs in `API.md`, storage detail in
`DATABASE.md`.
