# Changelog

All notable changes to the SiteOps backend are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Versions are release-level: a version
is cut when a milestone is complete and verified, not on every edit.

The dashboard, `siteOps-client`, is versioned in lockstep — the two are one product and are
deployed together.

## [Unreleased]

### Added

- **Plan entitlements.** `EntitlementService` is the single place a plan decides whether something
  is allowed. Plans now carry a feature list as well as limits, and the new entitlements endpoint
  reports both alongside current usage, so the dashboard can explain a locked feature instead of
  letting someone discover it by being refused. Every gated route re-checks the same entitlements
  server-side.
- **Audit log API.** `GET /api/audit-logs` and `GET /api/audit-logs/actors` expose the activity the
  backend was already recording, with filtering by area, action, actor, target, free text and date
  range, and cursor pagination. Append-only: no route creates, edits or deletes an entry.
- **Incident categories.** Incidents now carry a category, a severity and a one-line detail, so a
  certificate warning and an outage can be open for the same website at the same time. Only
  `availability` incidents count against uptime.
- `pnpm migrate` and `src/database/migrations.ts`, for the case where a new index would reject
  documents written before a field existed. Migrations are idempotent and run before
  `pnpm indexes:sync`.

### Changed

- The unique partial index that deduplicates open incidents moved from `{ websiteId }` to
  `{ websiteId, category }` and is renamed `incident_one_open_per_website_category`. Existing
  documents are backfilled by `pnpm migrate`, which must run before the index is rebuilt.
- `MembershipRepository.countForOrganization` counts accepted members for the team-size limit.
  Pending invitations are deliberately excluded — an invitation nobody accepts would otherwise
  occupy a seat forever.

## [0.1.0]

Initial release: authentication, organizations and roles, website management, uptime and
response-time monitoring with a leased worker queue, incident confirmation and recovery, email
alerts, dashboard analytics and maintenance mode.
