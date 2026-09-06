# Database

MongoDB, accessed through Mongoose. One connection per process, shared with the authentication
layer so there is a single pool — which matters on the MongoDB Atlas free tier, the tightest
constraint in the initial deployment.

## Collections

Collection names are a **compatibility surface**, not an implementation detail: the dashboard's
end-to-end suite cleans up by addressing them directly. They are not renamed casually.

| Collection              | Model file                       | Owner      | What it holds                                   |
| ----------------------- | -------------------------------- | ---------- | ----------------------------------------------- |
| `user`                  | `user.model.ts`                  | auth layer | Accounts. Read-only from application code.      |
| `session`               | —                                | auth layer | Active sessions.                                |
| `account`               | —                                | auth layer | Credentials.                                    |
| `verification`          | —                                | auth layer | Email and reset tokens.                         |
| `organizations`         | `organization.model.ts`          | app        | Tenants.                                        |
| `organization_members`  | `organization-member.model.ts`   | app        | Who may act where, and as what.                 |
| `invitations`           | `invitation.model.ts`            | app        | Pending invitations, keyed by address.          |
| `websites`              | `website.model.ts`               | app        | Monitored sites **and** their monitor state.    |
| `website_checks`        | `check-result.model.ts`          | app        | One document per check. The largest collection. |
| `incidents`             | `incident.model.ts`              | app        | Confirmed outages.                              |
| `notifications`         | `notification.model.ts`          | app        | One delivery record per recipient per event.    |
| `notification_settings` | `notification-settings.model.ts` | app        | Per-user, per-organization alert rules.         |
| `audit_logs`            | `audit-log.model.ts`             | app        | Who changed what.                               |
| `billing_events`        | `billing-event.model.ts`         | app        | Provider webhook ids already applied.           |

Two file names read differently from their collections, and both are deliberate:
`check-result.model.ts` compiles `WebsiteCheckModel` over `website_checks`, and the notification
_rules_ live in `notification-settings.model.ts` while the _deliveries_ live in
`notification.model.ts`.

**Application code never writes to `user`.** Profile changes, password changes and verification all
go through the auth layer so hashing and session invalidation stay in one place.

## Tenancy

Every organization-owned document carries `organizationId`, and every repository method that reads
one takes it as a required argument. There is no query path that omits the tenant.

`website_checks` denormalizes `organizationId` even though it could be reached through
`websiteId`, so organization-wide rollups never need a join on the largest collection in the
product.

## Indexes

Every index below has a stated query. An index with no query is a write cost with no reader.

### `organizations`

| Index                                  | Keys                                                             | Why                                                                        |
| -------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `organization_slug_unique`             | `{ slug: 1 }` unique                                             | Slugs appear in URLs and must be globally unique.                          |
| `organization_billing_customer_unique` | `{ 'billing.customerId': 1 }` unique, partial on `$type: string` | Routes a webhook to a tenant — the payload names a customer, never an org. |

The billing index is **partial, not sparse**, and the distinction is load-bearing. `sparse` excludes
documents where the field is absent, but the schema writes an explicit `null` default, so every
organization would carry an indexed `null` and a unique index would permit exactly one to exist.
Filtering on `$type: 'string'` indexes only organizations that actually have a provider customer.
Uniqueness matters because two organizations sharing one customer would mean a single payment
silently entitling both.

### `organization_members`

| Index                    | Keys                                | Why                                                                                                   |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `member_org_user_unique` | `{ organizationId, userId }` unique | One role per person per organization. Makes a duplicate invite a database error rather than a race.   |
| `member_by_user`         | `{ userId }`                        | "Which organizations does this user belong to" — every request that resolves the active organization. |
| `member_org_joined_at`   | `{ organizationId, joinedAt }`      | The members table, in join order.                                                                     |

### `invitations`

| Index                              | Keys                                                               | Why                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invitation_one_pending_per_email` | `{ organizationId, email }` unique, partial on `status: 'pending'` | Re-inviting replaces the pending invitation rather than stacking duplicates. The partial filter keeps accepted and revoked history out of the constraint. |
| `invitation_by_token`              | `{ tokenHash }`                                                    | Token lookup when a link is opened.                                                                                                                       |
| `invitation_org_status_created_at` | `{ organizationId, status, createdAt: -1 }`                        | Outstanding invitations beside the members list.                                                                                                          |

### `websites`

| Index                          | Keys                                                   | Why                                                                                                      |
| ------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `website_org_created_at`       | `{ organizationId, createdAt: -1 }`                    | The websites table, paginated without an in-memory sort.                                                 |
| `website_org_canonical_unique` | `{ organizationId, canonicalKey }` unique              | One website per URL per organization. A double-submitted form cannot create two monitors for one target. |
| `website_due_for_check`        | `{ nextCheckAt }` partial on `monitoringEnabled: true` | The scheduler's hot query. The partial filter keeps paused websites out of the index entirely.           |
| `website_org_status`           | `{ organizationId, status }`                           | The dashboard status counters.                                                                           |

### `website_checks`

| Index                             | Keys                                            | Why                                                |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `check_website_checked_at`        | `{ websiteId, checkedAt: -1, _id: -1 }`         | The check history and every per-website rollup.    |
| `check_website_status_checked_at` | `{ websiteId, status, checkedAt: -1, _id: -1 }` | The "errors only" filter on that history.          |
| `check_org_checked_at`            | `{ organizationId, checkedAt: -1 }`             | Organization-wide rollups for the dashboard cards. |
| `check_ttl`                       | `{ checkedAt: 1 }`, `expireAfterSeconds`        | Retention; see below.                              |

The first two end in `_id` because the history is paged by a keyset cursor sorted on
`(checkedAt, _id)`. Without `_id` in the index the database can satisfy the range but not the sort,
and every page would scan a website's entire history to top-K sort twenty rows out of it.

### `incidents`

| Index                                    | Keys                                                          | Why                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incident_one_open_per_website_category` | `{ websiteId, category }` unique, partial on `status: 'open'` | **At most one open incident per website per category.** The deduplication guarantee, enforced by the database rather than by application bookkeeping. Keyed on the category so an expiring certificate and an outage can be open together, while two outages still cannot. |
| `incident_org_started_at`                | `{ organizationId, startedAt: -1, _id: -1 }`                  | The incident list, newest first.                                                                                                                                                                                                                                           |
| `incident_org_category_started_at`       | `{ organizationId, category, startedAt: -1, _id: -1 }`        | The category filter on that list.                                                                                                                                                                                                                                          |
| `incident_org_status_started_at`         | `{ organizationId, status, startedAt: -1, _id: -1 }`          | The open-incident counter and the status filter.                                                                                                                                                                                                                           |
| `incident_website_started_at`            | `{ websiteId, startedAt: -1, _id: -1 }`                       | Incident history on a website's page.                                                                                                                                                                                                                                      |

### `website_monitors`

The auxiliary monitor queue: one document per `(website, type)`.

| Index                         | Keys                                              | Why                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `monitor_website_type_unique` | `{ websiteId, type }` unique                      | One monitor of each type per website.                                                                                                                                                |
| `monitor_due_for_run`         | `{ type, nextRunAt }`, partial on `enabled: true` | The scheduler's claim query, one type at a time. The partial filter keeps disabled monitors out of the index entirely, which matters because most websites will have most types off. |
| `monitor_org_website`         | `{ organizationId, websiteId }`                   | The Checks panel on a website's page.                                                                                                                                                |
| `monitor_org_type_status`     | `{ organizationId, type, status }`                | Organization-wide rollups.                                                                                                                                                           |

### `monitor_results`

Append-only, one document per run.

| Index                            | Keys                                       | Why                                                              |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `result_monitor_checked_at`      | `{ monitorId, checkedAt: -1, _id: -1 }`    | One monitor's history, keyset-paged.                             |
| `result_website_type_checked_at` | `{ websiteId, type, checkedAt: -1 }`       | One website's full picture, for the detail page and for reports. |
| `result_org_checked_at`          | `{ organizationId, checkedAt: -1 }`        | Period rollups for report generation.                            |
| `result_ttl`                     | `{ checkedAt: 1 }`, `CHECK_RETENTION_DAYS` | Retention, same window as raw checks.                            |

A crawl result carries a list of broken URLs, so these documents are much larger than a
`website_checks` row. Both halves are bounded: the list is capped at 100 findings when it is
written, and the document expires.

### `reports`

One generated report, holding the _facts_ rather than a file. See
`contracts/domain/report.ts` for why.

| Index                   | Keys                                               | Why                                                                                                                    |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `report_org_created_at` | `{ organizationId, createdAt: -1, _id: -1 }`       | The reports list, keyset-paged.                                                                                        |
| `report_pending`        | `{ nextAttemptAt }`, partial on pending/generating | The generation queue's claim query. The partial filter keeps finished reports — almost all of them — out of the index. |
| `report_ttl`            | `{ createdAt: 1 }`, 365 days                       | Retention.                                                                                                             |

Retained for a **year**, not the 90 days raw checks get. A report is a summary somebody may need for
a client review long after the checks behind it have expired — which is exactly why the facts are
stored rather than recomputed on demand.

### `report_schedules`

| Index                     | Keys                                        | Why                 |
| ------------------------- | ------------------------------------------- | ------------------- |
| `schedule_org_created_at` | `{ organizationId, createdAt: -1 }`         | The schedules list. |
| `schedule_due`            | `{ nextRunAt }`, partial on `enabled: true` | The claim query.    |

The third lease queue in the product, and the one where a duplicate claim is most costly: it means a
client receives the same report twice.

### `clients`

An agency's clients. Which websites belong to one lives on the website
(`website.clientId`), not as a list here — a website has at most one client, and the alternative
would be two documents to keep in step on every reassignment.

| Index                    | Keys                               | Why                                                                                                                                                                  |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client_org_name_unique` | `{ organizationId, name }` unique  | Two clients in one organization may not share a name: an agency picking one from a dropdown needs the names to be distinguishable. Serves the alphabetical list too. |
| `client_org_status_name` | `{ organizationId, status, name }` | Separating active clients from archived ones.                                                                                                                        |

### `notifications`

| Index                              | Keys                                        | Why                                                                                                                           |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `notification_dedupe_unique`       | `{ dedupeKey }` unique                      | **One notification per recipient per incident transition.** A replayed job's insert fails rather than sending a second email. |
| `notification_user_org_created_at` | `{ userId, organizationId, createdAt: -1 }` | One person's feed in one organization.                                                                                        |
| `notification_user_unread`         | `{ userId, readAt, createdAt: -1 }`         | The unread badge, without scanning the feed.                                                                                  |
| `notification_status_created_at`   | `{ status, createdAt: -1 }`                 | "What failed to deliver, and when" — the only read outside a user's own feed.                                                 |

`dedupeKey` is `<incidentId>:<event>:<userId>`: deterministic, so two dispatches for the same
transition produce the same key and the second one loses.

### `notification_settings`

| Index                                   | Keys                                | Why                                             |
| --------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `notification_settings_org_user_unique` | `{ organizationId, userId }` unique | One preference row per person per organization. |

### `audit_logs`

| Index                  | Keys                                | Why                |
| ---------------------- | ----------------------------------- | ------------------ |
| `audit_org_created_at` | `{ organizationId, createdAt: -1 }` | The activity feed. |
| `audit_ttl`            | `{ createdAt: 1 }`, 365 days        | Retention.         |

The feed's narrower filters — actor, target, free text — are applied on top of the range
`audit_org_created_at` already selects, and are bounded by the page size, so none of them turns into
a collection scan. They are deliberately _not_ given indexes of their own: an audit log is
write-heavy and read rarely, and six more indexes would cost every write to speed up a screen a few
people open a few times a month.

The collection is append-only. No route updates or deletes an entry, on any plan, at any role; the
TTL index is the only thing that removes one.

### `billing_events`

| Index                     | Keys                     | Why                                                    |
| ------------------------- | ------------------------ | ------------------------------------------------------ |
| `billing_event_id_unique` | `{ eventId: 1 }` unique  | Makes a duplicate webhook delivery a no-op.            |
| `billing_event_ttl`       | `{ receivedAt: 1 }`, 30d | Retention; a provider stops retrying long before that. |

The unique index **is** the idempotency guarantee. `BillingEventRepository.claim` inserts and treats
duplicate key as "someone else has this one" — two workers handling the same retry concurrently both
attempt the insert and exactly one wins, with no window a `findOne`-then-`insert` would leave open.
The claim is released if processing then throws, so a transient database failure does not turn the
provider's retry into a silently dropped subscription change.

### Auth collections

Better Auth creates its documents but not its indexes, and its uniqueness checks are read-then-write
rather than atomic. Without a unique index on `user.email`, two sign-ups racing on the same address
can both pass the check. They are declared in `src/database/auth-indexes.ts` and created by the
same sync as everything else.

| Collection     | Index                 | Why                                                                |
| -------------- | --------------------- | ------------------------------------------------------------------ |
| `user`         | `{ email }` unique    | One account per address, enforced against a concurrent race.       |
| `session`      | `{ token }` unique    | Session lookup on every authenticated request.                     |
| `session`      | `{ userId }`          | Revoking every session for a user, such as after a password reset. |
| `session`      | `{ expiresAt }` TTL 0 | Expired sessions are removed rather than accumulated.              |
| `account`      | `{ userId }`          | Credential lookup during sign-in.                                  |
| `verification` | `{ identifier }`      | Verification and reset token lookup.                               |
| `verification` | `{ expiresAt }` TTL 0 | Expired tokens are removed.                                        |

## Index management

**Indexes are never created automatically in production.** `MONGODB_AUTO_INDEX` is false there,
because an index build issued by a booting process can stall a live cluster. Deployments run:

```bash
pnpm migrate          # backfills documents that a new index would reject
pnpm indexes:sync     # creates or updates every declared index
pnpm indexes:verify   # read-only; names what is missing, exits non-zero
```

`pnpm migrate` runs **first**, and only matters when an index changes shape. A document written
before a field existed indexes as null, so widening a unique index without backfilling either fails
the build or — worse — succeeds and stops deduplicating. Every migration in
`src/database/migrations.ts` is idempotent, so running it on an already-current database reports
zero changes.

Mongoose's own `autoIndex` does nothing in this codebase, and the reason is worth knowing: models
compile at import time, before the connection opens, and `bufferCommands` is off — so the automatic
build never happens. Relying on it produced a development database with _no unique indexes at all_.

Skipping the sync does not look like a failure. Every query still returns rows and every page still
renders. The only symptom is that the guarantees the product depends on quietly stop holding: a
website monitored twice, two incidents for one outage, the same alert email sent again. Run
`indexes:verify` after a deploy.

`indexes:verify` reports extra indexes as information, not as a failure — an index added by hand
while diagnosing a slow query is a normal thing to find.

## Retention

Monitoring data grows fast: one website on a one-minute interval writes 525,600 documents a year.

| Data                                | Window                             | Enforced by            |
| ----------------------------------- | ---------------------------------- | ---------------------- |
| `website_checks`                    | `CHECK_RETENTION_DAYS`, default 90 | `check_ttl` TTL index  |
| `monitor_results`                   | `CHECK_RETENTION_DAYS`, default 90 | `result_ttl` TTL index |
| `reports`                           | 365 days                           | `report_ttl` TTL index |
| `audit_logs`                        | 365 days                           | `audit_ttl` TTL index  |
| `session`, `verification`           | their own `expiresAt`              | TTL index at 0         |
| `incidents`, `websites`, membership | kept                               | —                      |

Retention is enforced by MongoDB's TTL monitor, not by a scheduled job in this codebase. That is
the point: a cleanup job that quietly stops working grows the largest collection forever, and
nobody notices until the cluster fills.

Because the window is baked into the index, changing `CHECK_RETENTION_DAYS` only takes effect after
`pnpm indexes:sync` drops and recreates `check_ttl`.

Long-term dashboards read aggregations over the retained window, never millions of raw documents:
every rollup in `CheckResultRepository` is a `$group` the database answers from an index, bounded by
both a website (or organization) and a time window.

`src/database/retention.test.ts` asserts these definitions from the compiled schemas, so a renamed
index or a TTL pointed at the wrong field fails a test rather than silently never deleting anything.

## Transactions

SiteOps uses exactly one: creating an organization together with its first membership, in
`OrganizationRepository.createWithOwner`. An organization with no owner would be unreachable by
anyone, including the person who made it.

That single transaction is why local development runs a **single-node replica set** — MongoDB
supports multi-document transactions only there.

Everything else relies on unique indexes and atomic single-document updates instead, which is both
cheaper and stronger: an index holds regardless of which process wrote the document.

## Reading efficiently

- `.lean()` on every read-only query. A hydrated document is only worth it when its methods are.
- `.select()` wherever a few fields are needed, especially against `user` and `websites`.
- Aggregation for anything countable, never loading documents to count them in Node.
- One `$in` per page, never one query per row — see `MembershipRepository.listMembers` and
  `IncidentService.labelsFor`.
- One extra document per page decides `hasNextPage`, which is cheaper than a matching
  `countDocuments` and cannot disagree with the page it was computed from.
