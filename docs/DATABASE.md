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

| Index                      | Keys                 | Why                                               |
| -------------------------- | -------------------- | ------------------------------------------------- |
| `organization_slug_unique` | `{ slug: 1 }` unique | Slugs appear in URLs and must be globally unique. |

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

| Index                            | Keys                                                 | Why                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incident_one_open_per_website`  | `{ websiteId }` unique, partial on `status: 'open'`  | **At most one open incident per website.** This is the deduplication guarantee, enforced by the database rather than by application bookkeeping. |
| `incident_org_started_at`        | `{ organizationId, startedAt: -1, _id: -1 }`         | The incident list, newest first.                                                                                                                 |
| `incident_org_status_started_at` | `{ organizationId, status, startedAt: -1, _id: -1 }` | The open-incident counter and the status filter.                                                                                                 |
| `incident_website_started_at`    | `{ websiteId, startedAt: -1, _id: -1 }`              | Incident history on a website's page.                                                                                                            |

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
pnpm indexes:sync     # creates or updates every declared index
pnpm indexes:verify   # read-only; names what is missing, exits non-zero
```

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

| Data                                | Window                             | Enforced by           |
| ----------------------------------- | ---------------------------------- | --------------------- |
| `website_checks`                    | `CHECK_RETENTION_DAYS`, default 90 | `check_ttl` TTL index |
| `audit_logs`                        | 365 days                           | `audit_ttl` TTL index |
| `session`, `verification`           | their own `expiresAt`              | TTL index at 0        |
| `incidents`, `websites`, membership | kept                               | —                     |

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
