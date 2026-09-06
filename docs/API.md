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

| Role   | Highlights                                                                 |
| ------ | -------------------------------------------------------------------------- |
| owner  | Everything, plus organization settings, member roles and removal, billing  |
| admin  | Websites, monitoring toggle, incident updates, invitations, audit log      |
| member | Read-only across the organization, plus their own notification preferences |

## Rate limits

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A refusal is
`429` with `RATE_LIMITED` and a `Retry-After` header.

| Scope                               | Default budget                     |
| ----------------------------------- | ---------------------------------- |
| general                             | `RATE_LIMIT_MAX_REQUESTS` / minute |
| sign-in and sign-up                 | 10 per 15 minutes, shared          |
| password reset, verification resend | 5 per hour                         |
| session read                        | 60 per minute                      |
| organization create                 | 10 per hour                        |
| website create                      | 60 per hour                        |
| member invite                       | 20 per hour                        |
| invitation accept                   | 20 per hour                        |

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

## Error codes

| Code                            | Typical status | Meaning                                              |
| ------------------------------- | -------------- | ---------------------------------------------------- |
| `VALIDATION_ERROR`              | 400            | Input failed a schema; see `fields`                  |
| `UNAUTHENTICATED`               | 401            | No usable session                                    |
| `FORBIDDEN`                     | 403            | Allowed to be here, not to do this                   |
| `NOT_FOUND`                     | 404            | No such route or resource                            |
| `CONFLICT`                      | 409            | Collided with something that exists                  |
| `RATE_LIMITED`                  | 429            | Budget exhausted; see `Retry-After`                  |
| `INTERNAL_ERROR`                | 500            | Unexpected fault; details are logged, never returned |
| `SERVICE_UNAVAILABLE`           | 503            | A dependency is down                                 |
| `EMAIL_ALREADY_REGISTERED`      | 409            | Address is taken                                     |
| `INVALID_CREDENTIALS`           | 401            | Sign-in failed; deliberately not more specific       |
| `EMAIL_NOT_VERIFIED`            | 403            | Address not confirmed yet                            |
| `INVALID_TOKEN`                 | 404            | Link is not valid                                    |
| `TOKEN_EXPIRED`                 | 400            | Link has expired                                     |
| `ORGANIZATION_NOT_FOUND`        | 404            | No such organization, or not yours                   |
| `ORGANIZATION_SLUG_TAKEN`       | 409            | Slug is in use                                       |
| `NOT_A_MEMBER`                  | 403            | Not a member of this organization                    |
| `INSUFFICIENT_ROLE`             | 403            | Role does not carry the permission                   |
| `CANNOT_REMOVE_LAST_OWNER`      | 409            | An organization must keep an owner                   |
| `MEMBER_NOT_FOUND`              | 404            | No such member here                                  |
| `ALREADY_A_MEMBER`              | 409            | Already joined                                       |
| `WEBSITE_NOT_FOUND`             | 404            | No such website, or not yours                        |
| `WEBSITE_URL_ALREADY_MONITORED` | 409            | This organization already monitors that URL          |
| `INVALID_WEBSITE_URL`           | 400            | URL is malformed or unsupported                      |
| `BLOCKED_WEBSITE_URL`           | 400            | URL points at an address that must not be reached    |
| `MONITOR_NOT_FOUND`             | 404            | Monitor is not configured for that website           |
| `MONITOR_DISABLED`              | 409            | Monitor must be on before it can be run              |
| `INCIDENT_NOT_FOUND`            | 404            | No such incident, or not yours                       |
| `INCIDENT_ALREADY_RESOLVED`     | 409            | Incident is already closed                           |
| `NOTIFICATION_NOT_FOUND`        | 404            | No such notification                                 |
| `PLAN_LIMIT_REACHED`            | 403            | The organization's plan does not allow it            |

The full list lives in `src/contracts/api/errors.ts` and is mirrored by the dashboard.
