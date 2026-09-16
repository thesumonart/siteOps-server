# API

Base URL: `${API_URL}/api`. Health probes sit outside that prefix.

Every date is an ISO 8601 string in UTC. Conversion to a person's timezone is a presentation
concern and happens in the browser.

## The envelope

Success:

```json
{ "success": true, "data": {} }
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "WEBSITE_NOT_FOUND",
    "message": "Website not found.",
    "fields": [{ "field": "url", "message": "Enter a valid URL." }]
  }
}
```

`fields` appears only for `VALIDATION_ERROR`. Clients branch on `code`; `message` is written for
people and may be reworded at any time.

`204 No Content` responses carry no body at all.

### Pagination

Pagination travels inside `data`, never at the top level.

**Offset** — for small bounded collections where a total is genuinely useful (websites, members):

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "totalItems": 100,
    "totalPages": 5,
    "hasNextPage": true
  }
}
```

**Cursor** — for high-volume append-only data (checks, incidents), where counting rows is wasteful
and offsets drift as new documents arrive:

```json
{
  "items": [],
  "pagination": { "nextCursor": "MTcw...", "hasNextPage": true, "pageSize": 20 }
}
```

The cursor is opaque: base64url of `<epoch ms>.<hex id>`. The id breaks ties, because a worker
processing a batch concurrently genuinely can write two documents in the same millisecond and a
timestamp-only cursor would skip one or repeat it. A forged cursor is still applied inside a
tenant-scoped query, so it can only move a caller around within data they can already read.

Default page size is 20; the maximum is 100. A larger `pageSize` is a `VALIDATION_ERROR`, not a
silently clamped value.

## Authentication and authorization

The session lives in an **HttpOnly cookie** named `siteops.session_token` (`__Secure-` prefixed in
production), `SameSite=Lax`, 30-day expiry with a sliding refresh. Nothing readable from JavaScript
is ever a credential. Cross-origin requests must send `credentials: 'include'`.

Organization-scoped routes read the active organization from the `X-Organization-Id` header, or
from an `:organizationId` path parameter where one exists (the path wins). **Both are hints.**
Membership is re-resolved from the session on every request, and only the role stored server-side
decides what is allowed.

A resource in an organization the caller does not belong to answers **404**, never 403.
Distinguishing the two would confirm the identifier exists and let an attacker enumerate other
tenants.

Each route below lists the permission it requires. Permissions come from
`contracts/domain/permissions.ts`; roles map to them there, and no route tests a role name.

| Role   | Highlights                                                                                   |
| ------ | -------------------------------------------------------------------------------------------- |
| owner  | Everything, plus organization settings, member roles and removal, billing                    |
| admin  | Websites, monitoring toggle, incident updates, invitations, audit log, notification channels |
| member | Read-only across the organization, plus their own notification preferences                   |

## Rate limits

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A refusal is
`429` with `RATE_LIMITED` and a `Retry-After` header.

| Scope                               | Default budget                                 |
| ----------------------------------- | ---------------------------------------------- |
| general                             | `RATE_LIMIT_MAX_REQUESTS` / minute             |
| sign-in and sign-up                 | 10 per 15 minutes, shared                      |
| password reset, verification resend | 5 per hour                                     |
| session read                        | 60 per minute                                  |
| organization create                 | 10 per hour                                    |
| website create                      | 60 per hour                                    |
| member invite                       | 20 per hour                                    |
| invitation accept                   | 20 per hour                                    |
| channel create                      | 30 per hour                                    |
| channel test                        | 10 per minute                                  |
| channel secret rotation             | 20 per hour                                    |
| custom domain verification          | 30 per hour                                    |
| public status pages                 | `PUBLIC_STATUS_RATE_LIMIT_PER_MINUTE` / minute |

Sign-in and sign-up share one scope on purpose: alternating between them must not double an
attacker's budget.

---

## Health

### `GET /health` · `GET /health/live`

Liveness. Public. Performs no dependency I/O — a slow database must not make the platform restart a
healthy API.

```json
{ "success": true, "data": { "status": "ok", "uptimeSeconds": 1443 } }
```

### `GET /health/ready` · `GET /ready`

Readiness. Public. Pings MongoDB; answers `503` with `SERVICE_UNAVAILABLE` when it is unreachable.

```json
{ "success": true, "data": { "status": "ready", "checks": { "database": "ok" } } }
```

The worker serves the same paths on `WORKER_PORT`, adding `lastTickAt` to its ready response.

---

## Authentication

Served by Better Auth, mounted at `/api/auth`. Responses are rewritten into the SiteOps envelope.

### `POST /api/auth/sign-up/email`

Public. Body: `{ name, email, password }`. Password minimum 12 characters, maximum 128.

Returns `{ user: { id, name, email, emailVerified } }` and sends a verification email.

**Signing up with an address that already exists also returns 200**, with a synthetic id and no
document written. That is deliberate: a distinguishable response is an oracle for "does this person
have a SiteOps account". The existing account's password is never replaced.

### `POST /api/auth/sign-in/email`

Public. Body: `{ email, password }`. Sets the session cookie.

| Failure                           | Status | Code                  |
| --------------------------------- | ------ | --------------------- |
| Wrong password or unknown address | 401    | `INVALID_CREDENTIALS` |
| Address not confirmed             | 403    | `EMAIL_NOT_VERIFIED`  |

The first row is one row on purpose: the response is identical either way.

### `POST /api/auth/sign-out`

Clears the session.

### `GET /api/auth/verify-email?token=&callbackURL=`

Public. Verifies the emailed token, signs the person in, and **302s to `callbackURL`** — a real
redirect, not a JSON body, because it is reached by clicking a link in a mail client.

### `POST /api/auth/request-password-reset`

Public. Body: `{ email }`. Always succeeds, even for an unknown address.

### `POST /api/auth/reset-password`

Public. Body: `{ token, newPassword }`. Revokes every existing session on success.

### `POST /api/auth/send-verification-email`

Public. Body: `{ email }`. Resends the confirmation link.

### `GET /api/session`

Public, and **null-returning by design**: the browser needs to tell "signed out" apart from
"request failed", and a 401 would make every first paint look like an outage.

Signed out:

```json
{ "success": true, "data": { "user": null } }
```

Signed in:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "…",
      "name": "…",
      "email": "…",
      "emailVerified": true,
      "image": null,
      "createdAt": "…"
    },
    "memberships": [
      {
        "organization": {
          "id": "…",
          "name": "…",
          "slug": "…",
          "plan": "free",
          "timezone": "UTC",
          "websiteCount": 3,
          "createdAt": "…"
        },
        "role": "owner",
        "permissions": ["organization:read", "…"],
        "joinedAt": "…"
      }
    ]
  }
}
```

Memberships are omitted until the address is confirmed. Permissions are sent so the UI can hide
actions it may not perform — a presentation aid only; the API re-checks every one on the request.

---

## Organizations

### `GET /api/organizations`

Auth. Organizations the caller belongs to, oldest membership first. Scoped by the session, so there
is nothing to tamper with. Returns `OrganizationMembershipDto[]`.

### `POST /api/organizations`

Auth. Body: `{ name, slug? }`. The caller becomes its owner. `201`.

A slug is derived from the name when not supplied, suffixed until free. Returns
`OrganizationMembershipDto`.

| Failure    | Status | Code                      |
| ---------- | ------ | ------------------------- |
| Slug taken | 409    | `ORGANIZATION_SLUG_TAKEN` |

### `PATCH /api/organizations/:organizationId`

Permission: `organization:update`. Body: `{ name?, timezone? }`. Returns `OrganizationDto`.

Note what is **not** accepted: `plan`. The plan is server-owned and changes only on a verified
provider webhook. A `plan` field in this body is stripped by the schema and ignored.

### `GET /api/organizations/:organizationId/entitlements`

Permission: `organization:read` — every role, including `client`, because a member who cannot see
_why_ an action is unavailable is shown a failure they cannot explain. Returns `EntitlementsDto`:
the plan, its features, its limits and current usage against each.

Presentation only. Every gated route re-checks the same entitlement itself, so hiding a button and
enforcing a limit are two separate mechanisms and only the second is authoritative.

---

## Billing and subscriptions

Three rules, enforced by the shape of these endpoints rather than by convention:

- **The plan changes only on a signed webhook.** No route below writes it. Checkout returns a
  redirect and nothing more.
- **The price never travels in a request.** A checkout names a plan and an interval; the Stripe
  price id is resolved server-side from configuration.
- **The tenant is resolved from provider-held state**, never from anything the browser carries
  between hops.

When no payment provider is configured, every write below answers `503 BILLING_NOT_CONFIGURED` and
the catalogue reports `billingConfigured: false`. That is a supported deployment, not a broken one.

### `GET /api/billing/plans`

**No authentication.** The public price list, rendered by the marketing page before anyone has an
account. Returns `PlanCatalogDto`: every plan in `PLANS` with its name, tagline, prices in minor
units, limits, features, whether it is purchasable on this deployment, and whether it is featured.

Nothing here varies by caller. Prices are display information — the amount charged always comes
from the Stripe price object.

### `GET /api/organizations/:organizationId/subscription`

Permission: `billing:read` (owner). Returns `SubscriptionDto`: plan, status, interval, renewal date,
cancellation and trial state, plus `billingConfigured` and `canManage`.

Provider customer and subscription identifiers are deliberately absent. The dashboard has no use for
them, and an identifier that never reaches the browser cannot be substituted into a later request.

### `POST /api/organizations/:organizationId/billing/checkout`

Permission: `billing:manage` (owner — committing to a recurring charge is an ownership-level act).
Body: `{ plan, interval? }` where `plan` is one of `starter`, `agency`, `pro` and `interval` is
`month` (default) or `year`. Returns `{ url }` to send the browser to.

An organization that already has a live subscription is answered with a **portal** URL instead: a
second checkout would leave two subscriptions on one customer and bill for both.

Rate limited to 20 per hour.

| Failure                | Status | Code                           |
| ---------------------- | ------ | ------------------------------ |
| `free` or unknown plan | 400    | `VALIDATION_ERROR`             |
| Plan not sold here     | 400    | `BILLING_PLAN_NOT_PURCHASABLE` |
| No provider configured | 503    | `BILLING_NOT_CONFIGURED`       |
| Provider unreachable   | 502    | `BILLING_PROVIDER_ERROR`       |

### `POST /api/organizations/:organizationId/billing/portal`

Permission: `billing:manage`. Returns `{ url }` for Stripe's hosted customer portal, where upgrade,
downgrade, cancellation, payment methods and invoices all live. The session is created against the
customer id stored on the organization, so it can only ever open the billing of the tenant the
caller was authorized for.

Rate limited to 20 per hour.

| Failure                | Status | Code                     |
| ---------------------- | ------ | ------------------------ |
| No purchase yet        | 400    | `BILLING_NO_CUSTOMER`    |
| No provider configured | 503    | `BILLING_NOT_CONFIGURED` |

### `POST /api/billing/webhook`

**No authentication and no organization context.** Authorization is the `Stripe-Signature` header,
verified against the raw request body before a single field is read — HMAC-SHA256 over
`${timestamp}.${body}`, compared in constant time, with a 300-second replay window.

Mounted with its own `express.raw` parser. A parsed-and-reserialised body would not match the
signature, so the handler refuses anything that is not a Buffer rather than verifying a
reconstruction.

Handled events: `checkout.session.completed` (maps the customer to the organization),
`customer.subscription.created`, `.updated`, `.deleted`. Anything else is acknowledged with 200 and
ignored — a 4xx would make Stripe retry an event we will never act on and eventually disable the
endpoint.

Duplicate deliveries are no-ops: the event id is claimed in `billing_events` under a unique index
before processing. Out-of-order deliveries are discarded: an event older than the last one applied
fails the `billing.lastEventAt` guard, which is what stops a late `updated` from restoring a
cancelled plan.

| Failure         | Status | Code                      |
| --------------- | ------ | ------------------------- |
| Bad signature   | 400    | `BILLING_WEBHOOK_INVALID` |
| Stale timestamp | 400    | `BILLING_WEBHOOK_INVALID` |

---

## Members and invitations

### `GET /api/organizations/:organizationId/members`

Permission: `member:read`.

```json
{ "members": [], "invitations": [] }
```

Each member: `{ id, userId, name, email, role, joinedAt }`. Each invitation:
`{ id, email, role, invitedByName, expiresAt, createdAt }` — never the token.

### `POST /api/organizations/:organizationId/members`

Permission: `member:invite`. Body: `{ email, role }` where role is `admin` or `member`. `201`.

Owner is not assignable through this flow — ownership is transferred, not handed out. Sends an
invitation email valid for 7 days. Only the SHA-256 hash of the token is stored.

| Failure                      | Status | Code                 |
| ---------------------------- | ------ | -------------------- |
| Role above the inviter's own | 403    | `INSUFFICIENT_ROLE`  |
| Already a member             | 409    | `ALREADY_A_MEMBER`   |
| Plan member cap reached      | 403    | `PLAN_LIMIT_REACHED` |

### `PATCH /api/organizations/:organizationId/members/:memberId`

Permission: `member:update_role`. Body: `{ role }`. Returns `OrganizationMemberDto`.

| Failure                        | Status | Code                       |
| ------------------------------ | ------ | -------------------------- |
| Changing your own role         | 403    | `FORBIDDEN`                |
| Target outranks the actor      | 403    | `INSUFFICIENT_ROLE`        |
| Granting a role above your own | 403    | `INSUFFICIENT_ROLE`        |
| Demoting the last owner        | 409    | `CANNOT_REMOVE_LAST_OWNER` |

### `DELETE /api/organizations/:organizationId/members/:memberId`

Permission: `member:remove`. `204`. Removing yourself is leaving and is allowed, unless you are the
last owner.

### `DELETE /api/organizations/:organizationId/members/invitations/:invitationId`

Permission: `member:invite`. `204`.

### `POST /api/invitations/accept`

Auth only — the caller is not a member yet, so no organization permission applies. Body:
`{ token }`. Returns `{ organizationId }`.

Authorization is holding the emailed token **and** being signed in as the address it was sent to,
compared in constant time. A forwarded link is `403`.

| Failure           | Status | Code            |
| ----------------- | ------ | --------------- |
| Unknown token     | 404    | `INVALID_TOKEN` |
| Expired           | 400    | `TOKEN_EXPIRED` |
| Different address | 403    | `FORBIDDEN`     |

---

## Websites

### `GET /api/websites`

Permission: `website:read`. Query: `page`, `pageSize`, `search`, `status`.

Offset-paginated `WebsiteSummaryDto` — a `WebsiteDto` plus `uptimePercentage24h`,
`averageResponseTimeMs24h` and `openIncidentId`. The rollups are two organization-wide reads for
the whole page, not two per row.

`uptimePercentage24h` is `null`, never `100`, when nothing has been measured yet. An unchecked
website is not a healthy one.

### `POST /api/websites`

Permission: `website:create`. `201`.

```json
{
  "name": "Acme",
  "url": "acme.com",
  "monitoringIntervalSeconds": 300,
  "requestTimeoutMs": 10000,
  "failureThreshold": 3,
  "recoveryThreshold": 2
}
```

Only `name` and `url` are required. A scheme-less URL is treated as `https` and stored canonically.

| Failure                       | Status | Code                            |
| ----------------------------- | ------ | ------------------------------- |
| Unsafe or internal address    | 400    | `VALIDATION_ERROR` on `url`     |
| Malformed URL                 | 400    | `VALIDATION_ERROR` on `url`     |
| Already monitored here        | 409    | `WEBSITE_URL_ALREADY_MONITORED` |
| Plan website cap reached      | 403    | `PLAN_LIMIT_REACHED`            |
| Interval faster than the plan | 403    | `PLAN_LIMIT_REACHED`            |

Duplicate detection ignores scheme, `www.`, default ports and trailing slashes, so
`https://acme.com` and `http://www.acme.com/` are the same website.

### `GET /api/websites/:websiteId`

Permission: `website:read`. Returns `WebsiteDto`. `404` `WEBSITE_NOT_FOUND` for another tenant's id.

### `PATCH /api/websites/:websiteId`

Permission: `website:update`. Every create field is optional, plus `monitoringEnabled`.

Changing the URL to a different target resets the failure and recovery counters and re-queues the
website: those counters describe the old address and would otherwise confirm an outage that is not
happening.

### `DELETE /api/websites/:websiteId`

Permission: `website:delete`. `204`. Incidents are removed with it; checks are purged in the
background and expire on their own via the TTL index.

### `POST /api/websites/:websiteId/pause` · `POST /api/websites/:websiteId/resume`

Permission: `monitoring:toggle`. Returns `WebsiteDto`.

Resuming starts from a clean slate rather than a stale failure streak from before the pause, and
schedules the next check immediately.

---

## Monitoring reads

### `GET /api/dashboard/stats`

Permission: `monitoring:read`.

```json
{
  "totalWebsites": 12,
  "operational": 10,
  "degraded": 1,
  "down": 1,
  "paused": 0,
  "unknown": 0,
  "averageUptimePercentage24h": 99.87,
  "averageResponseTimeMs24h": 243,
  "openIncidents": 1
}
```

Status counts come from the website documents the worker keeps current, not from re-deriving state
out of the check history — the two must not be able to disagree on one screen.

### `GET /api/websites/:websiteId/stats?range=24h|7d|30d`

Permission: `monitoring:read`. Returns `UptimeStatsDto`.

Response-time figures cover successful checks only: the duration of a failed check measures how
long a failure took, not how fast the site is. `downtimeSeconds` is estimated from failed-check
counts at the resolution polling allows; an incident's own duration is the exact figure.

Uptime is **floored** at two decimals, never rounded up — showing "100%" for a site that had a
failed check erodes trust in every other number on the page.

### `GET /api/websites/:websiteId/uptime?range=24h|7d|30d`

Permission: `monitoring:read`. Returns a bare `UptimeBucketDto[]`, not a paginated result.

Buckets are one hour for 24h, four hours for 7d, one day for 30d. Buckets with no checks are
**absent rather than zero-filled**: a gap means monitoring was paused or the worker was down, and
drawing it as 0% uptime would invent an outage that never happened.

### `GET /api/websites/:websiteId/checks`

Permission: `monitoring:read`. Query: `cursor`, `pageSize`, `status`. Cursor-paginated
`WebsiteCheckDto`, newest first.

Each check carries `anomalous` and `zScore`: whether its response time was unusual for this
website, and by how many standard deviations above its rolling baseline. They are `false` and
`null` for a failed check, before a website has 30 successful checks of history, and on a plan
without anomaly detection. See docs/MONITORING.md.

### `GET /api/incidents`

Permission: `incident:read`. Query: `cursor`, `pageSize`, `status`, `category`, `websiteId`.
Cursor-paginated `IncidentDto`, newest first.

`category` is the incident's deduplication bucket — `availability`, `ssl`, `domain`, `performance`,
`content`, `seo`, `links` or `anomaly`. A website may have one open incident per category, so a
certificate warning and an outage can be open at the same time. Only `availability` incidents count
against uptime.

`websiteName` and `websiteUrl` are resolved onto the response rather than stored on the document,
so renaming a website changes how its past incidents read.

### `GET /api/incidents/:incidentId`

Permission: `incident:read`. `404` `INCIDENT_NOT_FOUND`.

### `POST /api/incidents/:incidentId/resolve`

Permission: `incident:update`. Closes an incident by hand — for a site decommissioned mid-outage,
or one whose incident is held open by a check that will never succeed again.

Records `resolvedByUserId`, which is what distinguishes it from an automatic recovery in the
history. The website's own status is left to the worker: this records that a person considers the
outage over, not that the site is back.

| Failure          | Status | Code                        |
| ---------------- | ------ | --------------------------- |
| Already resolved | 409    | `INCIDENT_ALREADY_RESOLVED` |

---

## Monitors

The six auxiliary checks: `ssl`, `domain`, `performance`, `content`, `seo`, `links`. Addressed by
`(websiteId, type)` rather than by id — a monitor is a property of the website, and whether a
document has been written for one yet is storage detail.

Each type needs its own plan feature (`ssl_monitoring`, `domain_monitoring`, …) **in addition to**
the permission. Turning one _off_ is always allowed regardless of plan: someone who downgrades with
a monitor already on must not be trapped with it.

### `GET /api/websites/:websiteId/monitors`

Permission: `monitoring:read`. `{ "items": MonitorDto[] }` — always six entries, one per type. A
type that has never been configured is returned disabled with its defaults, so the settings panel
renders every row without knowing which exist.

### `PATCH /api/websites/:websiteId/monitors/:type`

Permission: `monitoring:toggle` — the same capability as pausing uptime checks, because silencing a
certificate warning is the same kind of act. Body: `enabled`, `intervalSeconds` and `config`, all
optional. Creates the monitor on first write.

`config` is a discriminated union on `type` and must match the path, or the request is a `400` with
a field error. Enabling a monitor makes it due immediately, so the first result appears within a
poll interval rather than after a full day.

| Failure                               | Status | Code                 |
| ------------------------------------- | ------ | -------------------- |
| Plan does not include this monitor    | 403    | `PLAN_LIMIT_REACHED` |
| Interval faster than the plan's floor | 403    | `PLAN_LIMIT_REACHED` |
| Config belongs to another type        | 400    | `VALIDATION_ERROR`   |

A `links` crawl asking for more pages than the plan allows is **clamped, not refused** — running the
crawl the customer is entitled to is better service than rejecting the request over a number they
cannot see.

### `POST /api/websites/:websiteId/monitors/:type/run`

Permission: `monitoring:toggle`. Marks the monitor due now and returns. **The check itself happens
on the worker**: a Lighthouse run or a site crawl inside a request handler would hold an HTTP
connection open for minutes and put the API's event loop under load meant for a background process.
The client polls for the result.

Rate limited to 20 per hour per client, well below the general allowance. This is the one route
that lets a signed-in user aim work at a third party's server on demand.

| Failure                | Status | Code                |
| ---------------------- | ------ | ------------------- |
| Monitor not configured | 404    | `MONITOR_NOT_FOUND` |
| Monitor is turned off  | 409    | `MONITOR_DISABLED`  |

### `GET /api/monitors/:monitorId/results`

Permission: `monitoring:read`. Query: `cursor`, `pageSize`, `status`. Cursor-paginated
`MonitorResultDto`, newest first.

`status` is one of `passing`, `warning`, `failing`, `error`, `unknown`. **`error` is not
`failing`**: it means the monitor could not reach an answer, not that the answer was bad. An
errored run never opens or resolves an incident.

### `GET /api/monitors/summary`

Permission: `monitoring:read`. `{ "items": MonitorSummaryDto[] }` — enabled monitors grouped by type
and status, for the overview cards.

---

## Reports

A report is **a stored set of facts, not a stored file**. Generating one runs the aggregations once
and writes the numbers; the PDF, CSV or JSON is rendered from those numbers on download. There is no
blob storage to provision, a branding change applies retroactively to every past report, and a CSV
and a PDF of one report cannot disagree.

Requires the `reports` plan feature. Three capabilities: `report:read` (every role), `report:create`
(admins and owners — generating one spends quota and loads the database), `report:manage`
(schedules, which decide what is mailed to a client every month).

### `POST /api/reports`

Permission: `report:create`. **Queues** a report and returns it as `pending`. The worker builds it;
a month of checks across fifty websites is not something to aggregate while an HTTP connection
waits.

```json
{ "type": "organization", "period": "last_month" }
```

`period` is one of `last_7_days`, `last_30_days`, `last_month`, `last_quarter`, `custom`.
`last_month` and `last_quarter` are **calendar** periods — a monthly report generated on the 1st
covers the month that just ended, not the previous thirty days.

A named period must not carry `from`/`to`, and `custom` requires both and is capped at 366 days. An
open-ended range would let one request aggregate an organization's entire check history.

Rate limited to 30 per hour.

### `GET /api/reports`

Permission: `report:read`. Query: `cursor`, `pageSize`, `status`, `type`. Cursor-paginated
`ReportDto`, newest first. `summary` carries the handful of figures a row shows; the full payload is
deliberately absent, because a page of fifty would be the heaviest response in the API.

### `GET /api/reports/:reportId`

Permission: `report:read`. `404` `REPORT_NOT_FOUND`.

### `GET /api/reports/:reportId/download?format=pdf|csv|json`

Permission: `report:read`. **The one route that does not return the standard envelope** — a browser
downloading a PDF needs bytes and a `Content-Disposition`, not JSON wrapping base64. Every failure
path still returns the envelope.

Sent as `attachment` with a filename derived from the title with everything outside `[a-z0-9-]`
replaced: the title is user input and lands in a response header. `Cache-Control: private, no-store`,
because a report is a snapshot and a cached copy would silently be the wrong one after a
regeneration.

| Failure                     | Status | Code               |
| --------------------------- | ------ | ------------------ |
| Still generating, or failed | 409    | `REPORT_NOT_READY` |

A half-built report is refused rather than rendered as a document full of zeroes — exactly the kind
of plausible-looking wrong number that must never leave this product.

The CSV carries **every** website where the PDF caps its table at a hundred rows, and every field is
guarded against spreadsheet formula injection: a website named `=HYPERLINK(...)` is prefixed so it
renders as text rather than becoming a live link in the recipient's spreadsheet.

### `DELETE /api/reports/:reportId`

Permission: `report:manage`. `204`.

### `GET /api/reports/schedules` · `POST /api/reports/schedules`

Permission: `report:manage`. Requires the `scheduled_reports` feature.

```json
{
  "name": "Monthly client report",
  "frequency": "monthly",
  "hourUtc": 8,
  "type": "organization",
  "format": "pdf",
  "recipients": ["client@example.com"]
}
```

`hourUtc` is UTC and named so: a scheduler that quietly interprets `8` in the server's local zone
sends at a different time depending on where it is deployed. A weekly schedule also takes
`dayOfWeek` (0 = Sunday); a monthly one always runs on the 1st, which is what makes `last_month`
resolve to the month that just ended.

Each recipient receives its own copy, so a client contact never learns the addresses of an agency's
other clients, and one rejected address does not stop the rest.

### `PATCH /api/reports/schedules/:scheduleId` · `DELETE /api/reports/schedules/:scheduleId`

Permission: `report:manage`. Changing the frequency, day or hour recomputes the next run; without
that, moving a Monday-09:00 report to Friday would still fire once at the already-scheduled Monday
time. `nextRunAt` is null while a schedule is disabled rather than showing a date that will not
happen.

---

## Clients

Agency clients, and who from each client may see their websites. Requires the `clients` plan
feature; portal access additionally requires `client_portal`.

**A client contact holds neither `client:read` nor `client:manage`**, so every route here is a `403`
for them. That is the point: a client must not be able to enumerate the agency's other customers.

### `GET /api/clients`

Permission: `client:read`. Query: `status`, `search`. `{ "items": ClientDto[] }`, archived last.
Each row carries `websiteCount` and `contactCount`, both from one grouped aggregation for the whole
page rather than two queries per row.

### `POST /api/clients`

Permission: `client:manage`. Body: `name`, and optionally `companyName`, `contactName`,
`contactEmail`, `notes`.

`notes` is internal and is never rendered in the portal.

| Failure                                | Status | Code                |
| -------------------------------------- | ------ | ------------------- |
| Name already used in this organization | 409    | `CLIENT_NAME_TAKEN` |

Uniqueness is scoped to the organization, so two agencies may both have a client called Acme.

### `GET /api/clients/:clientId` · `PATCH /api/clients/:clientId`

Permissions: `client:read` / `client:manage`. Setting `status` to `archived` **revokes every portal
membership for the client** — an agency that archives a client expects the portal to close.

### `DELETE /api/clients/:clientId`

Permission: `client:manage`. Revokes portal access and removes the client record. **The websites
survive and become unassigned**: deleting a client relationship is not a request to stop monitoring
their sites.

### `GET /api/clients/:clientId/contacts`

Permission: `client:manage`. `{ "items": ClientContactDto[] }` — accepted contacts and pending
invitations together, so an agency can see that an invite was sent and not yet accepted.

### `POST /api/clients/:clientId/contacts`

Permission: `client:manage`. Body: `email`. Sends the same invitation the member flow uses, with the
client carried on the invitation so the recipient cannot choose one. Rate limited to 20 per hour.

| Failure                                      | Status | Code               |
| -------------------------------------------- | ------ | ------------------ |
| Address already belongs to this organization | 409    | `ALREADY_A_MEMBER` |
| Client is archived                           | 409    | `CONFLICT`         |

Refused rather than silently converted: the address may belong to an agency admin, and turning their
membership into a client-scoped one would lock them out of their own organization.

### `DELETE /api/clients/:clientId/contacts/:contactId`

Permission: `client:manage`. Removes the membership. The lookup filters on the `client` role, so
this route can never remove a colleague — internal members go through the members routes, which
enforce the last-owner rule.

### Assigning a website

`PATCH /api/websites/:websiteId` takes `clientId`. An explicit `null` clears the assignment; an
absent field leaves it alone. An id naming another organization's client is `404` `CLIENT_NOT_FOUND`.

`GET /api/websites?clientId=…` narrows an agency's own list. For a client contact the scope is
already applied from their membership and this parameter cannot widen it.

---

## Plan entitlements

### `GET /api/organizations/:organizationId/entitlements`

Permission: `organization:read`. What the organization's plan allows, and how much of it is in use.

```json
{
  "plan": "agency",
  "features": ["ssl_monitoring", "clients", "api_access", "..."],
  "limits": { "maxWebsites": 50, "maxClients": 50, "apiRequestsPerDay": 20000 },
  "usage": { "websites": 12, "members": 4, "clients": 7 }
}
```

Read by the dashboard so it can explain a locked feature rather than letting someone discover it by
being refused. **It is never the enforcement.** Every gated route calls the same
`EntitlementService` before doing any work, so an API client, a stale tab or a hand-written request
is refused identically to a button that was never rendered. A refusal is `403`
`PLAN_LIMIT_REACHED`, and its message names the cheapest plan that would allow the action.

---

## Audit log

Append-only. There is **no** route that creates, edits or deletes an entry, on any plan, at any
role — entries are written as a side effect of the action they describe, and removed only by the
365-day TTL index. An audit log an owner can rewrite is not an audit log.

Requires the `audit_logs` plan feature (Professional and above) in addition to the permission.

### `GET /api/audit-logs`

Permission: `audit_log:read` — admins and owners, not ordinary members. Cursor-paginated
`AuditLogDto`, newest first.

| Query         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `cursor`      | Opaque page position from a previous response                         |
| `pageSize`    | 1–100, default 20                                                     |
| `area`        | One of `organization`, `website`, `member`, `billing`, …              |
| `action`      | An exact action; wins over `area` when both are given                 |
| `actorUserId` | Entries by one person                                                 |
| `targetType`  | Entries about one kind of thing, e.g. `website`                       |
| `targetId`    | Entries about one specific thing                                      |
| `search`      | Free text over the recorded actor and target names; treated literally |
| `from` / `to` | ISO 8601 bounds, inclusive; an inverted range is a field error        |

`actorName` and `targetLabel` are snapshots taken when the entry was written, so the feed still
reads correctly after a rename and does not rewrite its own history.

### `GET /api/audit-logs/actors`

Permission: `audit_log:read`. `{ "items": [{ "id": "...", "name": "..." }] }` — the distinct people
who appear in this organization's log, newest first, capped at 50. Populates the filter dropdown
without the client having to derive it from whichever page is loaded.

---

## Notification settings

### `GET /api/notification-settings`

Permission: `notification:read`. The **signed-in user's** preferences for the active organization.
Taken from the session, never a parameter: a member must not be able to change what a colleague is
alerted about.

```json
{ "preferences": { "websiteDown": true, "websiteRecovered": true } }
```

A user with no stored row is notified. Absence means "never asked", and defaulting that to silence
would mean an outage nobody hears about.

### `PATCH /api/notification-settings`

Permission: `notification:update`. Body: either preference, both optional. A partial patch never
rewrites the field it did not mention.

---

## Notification channels

Slack, Discord and outgoing webhooks. Email alerting is per person; a channel belongs to the
organization and carries its own subscription list, so a member turning off outage emails does not
silence the team's Slack.

Every route needs `integration:read` or `integration:manage` — admins and owners. Creating,
enabling, re-pointing or testing a channel also needs the plan feature for its type (`webhooks`,
`slack_notifications`, `discord_notifications`, Professional and above) and counts against
`maxIntegrations`. Reading, renaming, disabling and deleting never do: an organization that
downgrades must still be able to see what it had and clean it up. After a downgrade its channels
stay, and simply stop receiving.

**A destination URL goes in and never comes out.** A Slack or Discord webhook URL is a credential
for posting into somebody's workspace, so it is stored sealed and every response carries `target`
instead — the origin and the last four characters, `https://hooks.slack.com/…a1B2`.

Channel events are incident transitions, and use the same names as the rest of the product:

| Event                          | When                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `website.down`                 | An availability incident opens                                 |
| `website.recovered`            | It resolves                                                    |
| `website.degraded`             | A response-time anomaly opens: still up, far slower than usual |
| `website.degradation_resolved` | It resolves                                                    |
| `monitor.problem`              | An SSL, domain, performance, … incident opens                  |
| `monitor.recovered`            | It resolves                                                    |
| `channel.test`                 | Only from `POST /test`; not subscribable                       |

One message per channel per transition, never a repeat while a site stays down — guaranteed by a
unique index, as for email.

### `GET /api/channels`

Permission: `integration:read`. `{ "items": NotificationChannelDto[] }`, newest first. Unpaginated:
the count is bounded by the plan's integration limit.

```json
{
  "id": "…",
  "name": "Slack on-call",
  "type": "slack",
  "enabled": true,
  "events": ["website.down", "website.recovered"],
  "target": "https://hooks.slack.com/…uvwx",
  "metadata": {},
  "hasSigningSecret": false,
  "lastDeliveryAt": "2026-09-10T08:00:03.000Z",
  "lastDeliveryStatus": "delivered",
  "lastFailureReason": null,
  "consecutiveFailures": 0,
  "createdAt": "…",
  "updatedAt": "…"
}
```

`consecutiveFailures` counts messages that never arrived. A failing channel keeps receiving — it is
never switched off automatically, because silence is an explicit choice in this product.

### `POST /api/channels`

Permission: `integration:manage`. `201` with `{ channel, signingSecret }`.

| Field      | Notes                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| `type`     | `webhook`, `slack` or `discord`. Fixed once created.                                   |
| `name`     | Unique within the organization. `CHANNEL_NAME_TAKEN` otherwise.                        |
| `url`      | See below.                                                                             |
| `events`   | Optional; defaults to every event. At least one.                                       |
| `enabled`  | Optional; defaults to `true`.                                                          |
| `metadata` | Webhooks only. Up to 10 string pairs echoed in every payload — an environment, a team. |

The URL is validated against the type:

- **Slack** — `https://hooks.slack.com/services/…` and nothing else.
- **Discord** — `https://discord.com/api/webhooks/{id}/{token}` (or `discordapp.com`).
- **Webhook** — any public `https` URL. It passes the same string-level SSRF screen as a monitored
  website, and the connect-time address guard runs again on every delivery.

`signingSecret` is returned **exactly once**, here, for a webhook channel (`so_whsec_…`), and is
`null` for Slack and Discord, which authenticate the sender by URL alone. It is stored sealed and
never returned by a read; losing it means rotating it.

### `GET /api/channels/:channelId` · `PATCH /api/channels/:channelId`

Permissions: `integration:read` / `integration:manage`. A patch takes any of `name`, `url`,
`events`, `enabled`, `metadata`. A new `url` is judged by the rule for the type the channel already
is. `metadata` on a Slack or Discord channel is a field error.

### `DELETE /api/channels/:channelId`

Permission: `integration:manage`. `204`. Anything still queued for the channel is dropped with it.

### `POST /api/channels/:channelId/test`

Permission: `integration:manage`. Sends a `channel.test` message **now** and answers with the
outcome — `{ delivered, statusCode, durationMs, failureReason }` — rather than queueing it. It takes
exactly the path a real alert takes: the same formatter, signature and SSRF boundary, so a passing
test means a real alert will arrive. Works on a disabled channel, which is when a test is useful.

### `POST /api/channels/:channelId/rotate-secret`

Permission: `integration:manage`. Webhook channels only. `{ "signingSecret": "so_whsec_…" }`,
shown once and effective immediately — there is no window where both secrets are valid, which is
the safe direction to fail in when the reason for rotating is a leak.

### `GET /api/channels/:channelId/deliveries`

Permission: `integration:read`. Cursor-paginated `ChannelDeliveryDto`, newest first, optionally
filtered by `status` (`pending`, `delivered`, `failed`). Kept 30 days.

```json
{
  "id": "…",
  "event": "website.down",
  "status": "pending",
  "attemptCount": 1,
  "responseStatus": 503,
  "failureReason": "HTTP 503: deploying",
  "createdAt": "…",
  "lastAttemptAt": "…",
  "nextAttemptAt": "…",
  "deliveredAt": null
}
```

### Delivery and retries

Deliveries are queued by the worker when a transition happens and sent by a loop of their own, so
a slow receiver never holds up a check. A 2xx is delivered. A timeout, a refused connection, `408`,
`429` or `5xx` is retried with exponential backoff — 30 s, 2 m, 8 m, 32 m by default, or longer if
the receiver sends `Retry-After` — up to `CHANNEL_DELIVERY_MAX_ATTEMPTS`. Any other `4xx` is
final. A `3xx` is final too: redirects are not followed, so a signed payload never goes somewhere
the customer did not choose.

Delivery is **at least once**. A receiver that accepted a request but did not answer in time will
see it again, with the same `X-SiteOps-Delivery`.

### Receiving a webhook

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json
User-Agent: SiteOpsWebhooks/1.0 (+https://siteops.app)
X-SiteOps-Event: website.down
X-SiteOps-Delivery: 66e0…
X-SiteOps-Signature: t=1757491200,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

```json
{
  "id": "website.down:66e0…",
  "type": "website.down",
  "createdAt": "2026-09-10T08:00:00.000Z",
  "organizationId": "…",
  "data": {
    "website": { "id": "…", "name": "Acme Store", "url": "https://acme.com/" },
    "incident": {
      "id": "…",
      "status": "open",
      "type": "http_error",
      "category": "availability",
      "severity": "critical",
      "detail": null,
      "startedAt": "2026-09-10T08:00:00.000Z",
      "resolvedAt": null,
      "durationSeconds": null,
      "failedCheckCount": 3,
      "lastStatusCode": 503,
      "lastErrorType": "http_error",
      "lastErrorMessage": "Responded with HTTP 503."
    },
    "monitor": null,
    "anomaly": null,
    "dashboardUrl": "https://app.siteops.app/dashboard/websites/…"
  },
  "metadata": { "environment": "production" }
}
```

`id` is the same on every retry and on every channel, so a receiver subscribed twice can tell it
heard about one transition twice. `data.monitor` is set for `monitor.*` events. `data.anomaly` is set for
`website.degraded`: the response time that tipped it, the baseline mean and standard deviation it was
judged against, the sample count and the z-score — enough to re-derive the verdict.

**Verify before parsing.** The signature is HMAC-SHA256 over `${t}.${raw body}` with the channel's
signing secret. Compute it over the bytes received — a parsed and re-serialised body will never
match — compare in constant time, and refuse a timestamp more than five minutes old:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySiteOpsSignature(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const received = Buffer.from(parts.v1 ?? '', 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
```

`tests/integration/channel-dispatch.test.ts` verifies real deliveries with exactly this procedure.

---

## Status pages

A status page shows a chosen set of the organization's websites to the public: whether each works,
its daily uptime, and any outage or slowdown in progress. Available on plans with `status_pages`
(Starter and above), up to `maxStatusPages`. Permissions `status_page:read` (members and above) and
`status_page:manage` (admins and owners).

### Managing pages

#### `GET /api/status-pages`

`{ "items": StatusPageDto[] }`, newest first.

```json
{
  "id": "…",
  "slug": "acme",
  "title": "Acme status",
  "description": null,
  "published": true,
  "theme": { "mode": "auto", "accentColor": "#2563EB" },
  "components": [{ "websiteId": "…", "displayName": "Storefront" }],
  "customDomain": {
    "domain": "status.acme.com",
    "status": "pending",
    "verificationRecord": {
      "type": "TXT",
      "name": "_siteops-challenge.status.acme.com",
      "value": "siteops-verification=…"
    },
    "cnameTarget": "api.siteops.example",
    "verifiedAt": null
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

#### `POST /api/status-pages`

Body: `{ title, slug, description?, components?, theme?, published? }`. `201` with the page.

- `slug` is the public address — 3 to 48 lowercase letters, digits and single hyphens — and is
  unique across every organization (`409 STATUS_PAGE_SLUG_TAKEN`).
- `components` is up to 50 `{ websiteId, displayName }`, each website once. Every website must be
  this organization's; any other id is `404 WEBSITE_NOT_FOUND`, whether it exists elsewhere or not.
  The display name is what visitors read — the website's own name is never shown.
- `published` defaults to `false`. Nothing about a page is public until it is `true`.

#### `GET /api/status-pages/:statusPageId` · `PATCH /api/status-pages/:statusPageId`

`PATCH` takes any subset of the create body; `components`, when given, replaces the list. Changes
need the `status_pages` feature, except `{ "published": false }` alone, which always works — it is
how a downgraded organization takes a page down.

#### `DELETE /api/status-pages/:statusPageId`

`204`. Allowed on any plan. Deleting a website also removes it from every page that showed it.

### Custom domains

Serve a page on a domain the customer owns, such as `status.acme.com`. Needs the `custom_domains`
feature (Agency and Pro); each page holding a domain, verified or not, counts against
`maxCustomDomains`.

1. `PUT` the domain. The response's `customDomain` names a TXT record and a CNAME target.
2. The customer adds a TXT record at `verificationRecord.name` with `verificationRecord.value`, and
   a CNAME from the domain to `cnameTarget`.
3. `POST …/verify`. Once the record resolves, the domain is `verified` and starts routing.

#### `PUT /api/status-pages/:statusPageId/custom-domain`

Body: `{ domain }` — a hostname without scheme, port or path. Returns the page. Claiming the domain
the page already holds changes nothing, so a published TXT record stays valid. Several organizations
may be pending on one name; a domain another organization has already verified is
`409 CUSTOM_DOMAIN_TAKEN`, and so is losing the race to verify it.

#### `POST /api/status-pages/:statusPageId/custom-domain/verify`

Looks the TXT record up and returns the page. `400 CUSTOM_DOMAIN_NOT_VERIFIED` when the record is not
there yet, or when DNS did not answer — the message says which. Limited to 30 attempts an hour.

#### `DELETE /api/status-pages/:statusPageId/custom-domain`

Returns the page with `customDomain: null`. Idempotent. The domain stops routing at once.

### Reading a page publicly

No session and no key. Any origin may read these — `Access-Control-Allow-Origin: *`, never with
credentials — and responses carry `Cache-Control: public, max-age=STATUS_PAGE_CACHE_TTL_SECONDS`.
Budget: `PUBLIC_STATUS_RATE_LIMIT_PER_MINUTE` per address.

#### `GET /api/public/status-pages/:slug?days=30|60|90`

`PublicStatusPageDto`. A page that does not exist, is unpublished, or belongs to a plan without
status pages is the same `404 STATUS_PAGE_NOT_FOUND`.

```json
{
  "slug": "acme",
  "title": "Acme status",
  "description": null,
  "theme": { "mode": "auto", "accentColor": "#2563EB" },
  "status": "degraded",
  "components": [
    {
      "name": "Storefront",
      "status": "degraded",
      "uptimePercentage": 99.95,
      "history": [
        { "date": "2026-06-19", "uptimePercentage": 100 },
        { "date": "2026-06-20", "uptimePercentage": null }
      ]
    }
  ],
  "activeIncidents": [{ "componentName": "Storefront", "kind": "degraded", "startedAt": "…" }],
  "historyDays": 90,
  "showPoweredBy": true,
  "generatedAt": "…"
}
```

- `status` is `operational`, `degraded`, `down` or `unknown`. A paused or not-yet-checked website is
  `unknown`; the page's headline is its worst component, with `unknown` ranking lowest.
- `history` has one entry per UTC day, oldest first, ending today. `null` means nothing was measured
  that day — not an outage. Uptime is floored, like everywhere else.
- `historyDays` is the request capped at the plan's check retention: a Starter page asked for 90
  days shows 60, because older checks no longer exist.
- `activeIncidents` lists open outages (`outage`) and response-time anomalies (`degraded`) only.
  Certificate, domain, content and SEO incidents are never published.
- Deliberately absent: website ids and URLs, response times, status codes, error messages, and
  anything naming the organization. See `docs/SECURITY.md`.

The response is rebuilt at most once per `STATUS_PAGE_CACHE_TTL_SECONDS` per API instance; changes
made through the dashboard show at once on the instance that made them.

#### `GET /api/public/status-page?days=30|60|90`

The same response, for the page the request's **host** serves: a verified custom domain whose CNAME
points at this API, or a proxy that preserves `Host`. On any other host, `404`. The page must be
published, and the organization's plan must still include custom domains — the slug keeps working
without them.

On a verified custom domain, **every path outside `/api/public/` is `404`**, sign-in included.

---

## Public API

`/api/v1` is for integrations — a script, Terraform, a status board — and authenticates with an
**API key and nothing else**. A session cookie is not consulted there at all, so a page a signed-in
admin visits cannot use their cookie to call it; the dashboard's own routes stay under `/api` and
never accept a key.

It is versioned where `/api` is not: the dashboard ships with this API, and somebody's script does
not. The envelope, the DTOs, the validation and every plan limit are the dashboard's own — each route
calls the same service — so an integration cannot do anything the dashboard would refuse. Available
on plans with `api_access` (Agency and Pro).

### Keys

Managed with a session, from the dashboard. Permissions `api_key:read` / `api_key:manage` — admins
and owners. A key can never be used to manage keys.

#### `GET /api/api-keys`

`{ "items": ApiKeyDto[] }`, newest first: the 100 most recent, revoked ones included.

```json
{
  "id": "…",
  "name": "Terraform",
  "prefix": "so_live_Ab12Cd34",
  "scopes": ["monitors:read", "monitors:write"],
  "status": "active",
  "createdByName": "Ada",
  "lastUsedAt": "2026-09-10T08:00:00.000Z",
  "expiresAt": null,
  "revokedAt": null,
  "createdAt": "…"
}
```

`lastUsedAt` is refreshed at most once a minute. `status` is `active`, `expired` or `revoked`.

#### `POST /api/api-keys`

Body: `{ name, scopes, expiresInDays? }` — `expiresInDays` from 1 to 365, or omitted for a key that
works until it is revoked. `201` with `{ apiKey, token }`. **`token` is shown once**, here; only its
SHA-256 is stored, so neither a leaked backup nor this API can produce it again. Counts against
`maxApiKeys`; revoked and expired keys do not.

A person can only grant scopes whose permissions their own role holds, so a key cannot be how a
lesser role acts with a greater one's reach.

#### `POST /api/api-keys/:apiKeyId/rotate`

`{ apiKey, token }` with a new secret; name, scopes and expiry are kept. The old secret stops working
in the same write — there is no overlap, because a key is rotated when it may have leaked. A revoked
or expired key cannot be rotated (`409`).

#### `DELETE /api/api-keys/:apiKeyId`

Revokes the key. `204`, and idempotent. The document is kept so the audit log still resolves.

### Authenticating

```http
GET /api/v1/monitors HTTP/1.1
Authorization: Bearer so_live_…
```

Every failure to authenticate — a missing, malformed, unknown, revoked or expired key — is the same
`401 API_KEY_INVALID`, with `WWW-Authenticate: Bearer`. Which it was is not something to tell a
caller looking for a key that works. The organization is the key's own: there is no
`X-Organization-Id` on this surface, and one sent is ignored. After a downgrade to a plan without API
access, keys answer `403 PLAN_LIMIT_REACHED` until the plan returns; they are not deleted.

### Scopes

| Scope             | Allows                                        |
| ----------------- | --------------------------------------------- |
| `monitors:read`   | Listing and reading monitors                  |
| `monitors:write`  | Creating, changing, pausing and deleting them |
| `checks:read`     | A monitor's check history                     |
| `incidents:read`  | Listing and reading incidents                 |
| `incidents:write` | Resolving an incident                         |
| `metrics:read`    | Uptime, response-time and summary metrics     |

A route whose scope the key does not carry answers `403 INSUFFICIENT_SCOPE`.

### Budgets

Two, both checked before a route runs:

- **Per key, per minute** — `API_KEY_RATE_LIMIT_PER_MINUTE` (120). Keyed by the key rather than the
  address, so integrations behind one cloud egress IP do not throttle each other. `429 RATE_LIMITED`
  with `Retry-After`, and the usual `RateLimit-*` headers.
- **Per organization, per UTC day** — the plan's `apiRequestsPerDay`, counted in the database and
  shared by all of the organization's keys. Every response carries `X-Quota-Limit` and
  `X-Quota-Remaining`; past it, `429 API_QUOTA_EXCEEDED` with `Retry-After` until midnight UTC.

### Routes

| Method and path                      | Scope             | Same as                           |
| ------------------------------------ | ----------------- | --------------------------------- |
| `GET /api/v1/monitors`               | `monitors:read`   | `GET /api/websites`               |
| `POST /api/v1/monitors`              | `monitors:write`  | `POST /api/websites`              |
| `GET /api/v1/monitors/:id`           | `monitors:read`   | `GET /api/websites/:id`           |
| `PATCH /api/v1/monitors/:id`         | `monitors:write`  | `PATCH /api/websites/:id`         |
| `DELETE /api/v1/monitors/:id`        | `monitors:write`  | `DELETE /api/websites/:id`        |
| `POST /api/v1/monitors/:id/pause`    | `monitors:write`  | `POST /api/websites/:id/pause`    |
| `POST /api/v1/monitors/:id/resume`   | `monitors:write`  | `POST /api/websites/:id/resume`   |
| `GET /api/v1/monitors/:id/checks`    | `checks:read`     | `GET /api/websites/:id/checks`    |
| `GET /api/v1/monitors/:id/stats`     | `metrics:read`    | `GET /api/websites/:id/stats`     |
| `GET /api/v1/monitors/:id/uptime`    | `metrics:read`    | `GET /api/websites/:id/uptime`    |
| `GET /api/v1/metrics/summary`        | `metrics:read`    | `GET /api/dashboard/stats`        |
| `GET /api/v1/incidents`              | `incidents:read`  | `GET /api/incidents`              |
| `GET /api/v1/incidents/:id`          | `incidents:read`  | `GET /api/incidents/:id`          |
| `POST /api/v1/incidents/:id/resolve` | `incidents:write` | `POST /api/incidents/:id/resolve` |

Query parameters, bodies and responses are exactly those of the dashboard route in the last column.
"Monitor" is the public name for a website's uptime monitor. Writes are audited, and the audit log
names the key — `API key “Terraform”` — as well as the person who issued it.

---

## Error codes

| Code                            | Typical status | Meaning                                                |
| ------------------------------- | -------------- | ------------------------------------------------------ |
| `VALIDATION_ERROR`              | 400            | Input failed a schema; see `fields`                    |
| `UNAUTHENTICATED`               | 401            | No usable session                                      |
| `FORBIDDEN`                     | 403            | Allowed to be here, not to do this                     |
| `NOT_FOUND`                     | 404            | No such route or resource                              |
| `CONFLICT`                      | 409            | Collided with something that exists                    |
| `RATE_LIMITED`                  | 429            | Budget exhausted; see `Retry-After`                    |
| `INTERNAL_ERROR`                | 500            | Unexpected fault; details are logged, never returned   |
| `SERVICE_UNAVAILABLE`           | 503            | A dependency is down                                   |
| `EMAIL_ALREADY_REGISTERED`      | 409            | Address is taken                                       |
| `INVALID_CREDENTIALS`           | 401            | Sign-in failed; deliberately not more specific         |
| `EMAIL_NOT_VERIFIED`            | 403            | Address not confirmed yet                              |
| `INVALID_TOKEN`                 | 404            | Link is not valid                                      |
| `TOKEN_EXPIRED`                 | 400            | Link has expired                                       |
| `ORGANIZATION_NOT_FOUND`        | 404            | No such organization, or not yours                     |
| `ORGANIZATION_SLUG_TAKEN`       | 409            | Slug is in use                                         |
| `NOT_A_MEMBER`                  | 403            | Not a member of this organization                      |
| `INSUFFICIENT_ROLE`             | 403            | Role does not carry the permission                     |
| `CANNOT_REMOVE_LAST_OWNER`      | 409            | An organization must keep an owner                     |
| `MEMBER_NOT_FOUND`              | 404            | No such member here                                    |
| `CLIENT_NOT_FOUND`              | 404            | No such client, or not yours                           |
| `CLIENT_NAME_TAKEN`             | 409            | A client with that name already exists                 |
| `ALREADY_A_MEMBER`              | 409            | Already joined                                         |
| `WEBSITE_NOT_FOUND`             | 404            | No such website, or not yours                          |
| `WEBSITE_URL_ALREADY_MONITORED` | 409            | This organization already monitors that URL            |
| `INVALID_WEBSITE_URL`           | 400            | URL is malformed or unsupported                        |
| `BLOCKED_WEBSITE_URL`           | 400            | URL points at an address that must not be reached      |
| `MONITOR_NOT_FOUND`             | 404            | Monitor is not configured for that website             |
| `MONITOR_DISABLED`              | 409            | Monitor must be on before it can be run                |
| `INCIDENT_NOT_FOUND`            | 404            | No such incident, or not yours                         |
| `INCIDENT_ALREADY_RESOLVED`     | 409            | Incident is already closed                             |
| `NOTIFICATION_NOT_FOUND`        | 404            | No such notification                                   |
| `CHANNEL_NOT_FOUND`             | 404            | No such channel, or not yours                          |
| `CHANNEL_NAME_TAKEN`            | 409            | A channel with that name already exists                |
| `API_KEY_NOT_FOUND`             | 404            | No such API key, or not yours                          |
| `API_KEY_INVALID`               | 401            | Missing, malformed, unknown, revoked or expired key    |
| `INSUFFICIENT_SCOPE`            | 403            | The key does not carry the route's scope               |
| `API_QUOTA_EXCEEDED`            | 429            | The organization's daily API quota is used up          |
| `STATUS_PAGE_NOT_FOUND`         | 404            | No such status page, not yours, or not published       |
| `STATUS_PAGE_SLUG_TAKEN`        | 409            | Another status page uses that address                  |
| `CUSTOM_DOMAIN_TAKEN`           | 409            | The domain is verified for another status page         |
| `CUSTOM_DOMAIN_NOT_VERIFIED`    | 400            | The TXT record is not there yet, or DNS did not answer |
| `REPORT_NOT_FOUND`              | 404            | No such report, or not yours                           |
| `REPORT_NOT_READY`              | 409            | Report is still generating, or failed                  |
| `REPORT_SCHEDULE_NOT_FOUND`     | 404            | No such schedule, or not yours                         |
| `PLAN_LIMIT_REACHED`            | 403            | The organization's plan does not allow it              |

The full list lives in `src/contracts/api/errors.ts` and is mirrored by the dashboard.
