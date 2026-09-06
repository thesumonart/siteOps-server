# Changelog

All notable changes to the SiteOps backend are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Versions are release-level: a version
is cut when a milestone is complete and verified, not on every edit.

The dashboard, `siteOps-client`, is versioned in lockstep — the two are one product and are
deployed together.

## [Unreleased]

### Added

- **Billing and subscriptions.** Stripe, behind a provider interface (`src/billing/`), with hosted
  checkout for the first purchase and the hosted customer portal for every change after it —
  upgrade, downgrade, cancel, resume, payment method, invoices. SiteOps never mutates a
  subscription itself: proration is wrong in ways that show up on a real card, and the portal has
  solved it.
  - `GET /api/billing/plans` is unauthenticated and serves the public price list, so the marketing
    page renders the same plans, limits and features the API actually enforces.
  - `GET /api/organizations/:id/subscription` (`billing:read`),
    `POST .../billing/checkout` and `POST .../billing/portal` (`billing:manage`) — owner-only, and
    provider identifiers never leave the server.
  - `POST /api/billing/webhook` is the only route that writes `organization.plan`. It has no
    session; its authorization is an HMAC-SHA256 signature verified against the raw body in
    constant time, inside a 300-second replay window.
  - Duplicate deliveries are no-ops (unique event id claimed in the new `billing_events`
    collection); out-of-order deliveries are discarded by a `billing.lastEventAt` guard, so a late
    `updated` cannot restore a plan that was cancelled.
  - A checkout request names a plan and an interval and nothing else. The price id is resolved
    server-side from configuration, so there is no field a caller could send to be charged less.
  - Entirely optional: with no `STRIPE_SECRET_KEY` no provider is constructed, the routes answer
    `BILLING_NOT_CONFIGURED`, and the catalogue reports `billingConfigured: false`. There is no
    stub provider — a fabricated checkout URL is the one thing billing code must never produce.
- **Plan pricing in the contract.** `contracts/domain/billing.ts` carries the public price list,
  subscription vocabulary and per-plan taglines, mirrored into the dashboard, so the pricing page
  and the dashboard's upgrade prompts describe a plan identically. Amounts are in minor units and
  are display information only; the charge always comes from the Stripe price.
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

- **Auxiliary monitor framework.** A second lease queue (`website_monitors`) and a second scheduler
  loop in the worker, running one monitor type at a time with its own concurrency budget and
  timeout. Results are append-only in `monitor_results` and expire on the same window as raw
  checks. A paused website pauses every monitor on it.
- **SSL certificate monitoring.** Chain validity, hostname coverage per RFC 6125, issuer, protocol
  and days remaining, with configurable warning and critical windows. The handshake is performed
  directly so an invalid certificate is still readable, and the address guard runs before it.
- **Domain expiry monitoring.** RDAP first, WHOIS as a fallback, behind a provider interface. The
  registrable domain is found by asking registries rather than by bundling a public suffix list. An
  unparseable date becomes null rather than a guess.
- Per-monitor notification preferences, and email alerts for a monitor problem and its recovery.
- **Performance monitoring**, behind a provider interface. Google PageSpeed Insights supplies real
  Lighthouse scores and Core Web Vitals when `PAGESPEED_API_KEY` is set; a synthetic provider
  measures time to first byte, page weight and render-blocking resources otherwise, and reports
  null for everything it cannot measure rather than inventing it. Every result names its source.
- **Website change detection**, with a normalizer that strips timestamps, tokens, counters and
  tracking parameters before hashing, and configurable sensitivity so a news homepage and a pricing
  page can be watched differently.
- **SEO health monitoring** over the machine-readable signals in one document. The scope is
  documented rather than implied: no rankings, no content quality, nothing needing a browser.
- **Broken-link crawling**, bounded on pages, depth, links, wall clock, bytes and concurrency, with
  `robots.txt` honoured by default and every fetch behind the shared address guard.

- **Reports.** Uptime, response-time, incident and monitor summaries over a period, generated on the
  worker and downloadable as PDF, CSV or JSON. A report stores the _facts_; each format is rendered
  from them on download, so there is no blob storage, a branding change applies retroactively, and a
  CSV and a PDF of one report cannot disagree. Every number is aggregated from documents the worker
  actually wrote — an unmeasured website reports null, never 100%.
- **Scheduled reports**, weekly or monthly, emailed to a list of addresses with the rendered file
  attached. Each recipient gets its own copy, so a client contact never sees an agency's other
  clients. Times are UTC throughout.
- **White-label branding** on the organization, applied to rendered reports. Stored regardless of
  plan and applied only on a plan that includes it, so a downgrade loses nothing but stops applying.

- **Client management.** Agency clients, with websites assigned to one and a client list that shows
  website and contact counts. Archiving is reversible and hides a client from the working view;
  deleting is explicit and keeps the websites, unassigning them rather than destroying history.
- **The white-label client portal.** A client contact is a normal user whose membership carries the
  `client` role and a `clientId`. That second scope narrows every tenant-scoped query to one
  client's websites, so a contact sees their own sites and cannot reach another client's, the
  agency's team, the audit log, or anything that writes. Every permission the role holds ends in
  `:read`, and a test asserts that rather than listing them.
- Portal access reuses the existing invitation flow — same token, same expiry, same acceptance
  route — with the client carried on the invitation so the recipient cannot choose one.

### Changed

- The unique partial index that deduplicates open incidents moved from `{ websiteId }` to
  `{ websiteId, category }` and is renamed `incident_one_open_per_website_category`. Existing
  documents are backfilled by `pnpm migrate`, which must run before the index is rebuilt.
- **`error` is now distinct from `failing` throughout monitoring.** A check that could not reach an
  answer neither opens nor resolves an incident, and does not change the monitor's displayed status
  until three consecutive failures. Reporting an unreachable registry as a healthy domain, or
  resolving an expiry incident because a lookup timed out, were both possible before this split
  existed.
- `NotificationPreferences` grew from two toggles to ten, and the model, repository, validator and
  settings form are now generated from one list in the contract rather than written out separately.
- The SSRF boundary moved into `src/monitoring/safe-request.ts` and is now shared by the uptime
  checker and every page-fetching monitor. It was duplicated the moment a second fetcher existed,
  and a second implementation of that boundary is a second thing to get wrong.
- The members list and member-management lookups now exclude client contacts. They are memberships
  too, but they belong to a client rather than to the agency, and mixing them into the members table
  would make it a place where somebody could accidentally promote a customer's contact to admin.
- `canAssignRole` refuses every role when the actor is a client. The rank comparison alone let a
  client assign their own role — unreachable today, since they hold no invite permission, but this
  primitive is what a route would be checked against if one ever forgot.
- `MembershipRepository.countForOrganization` counts accepted members for the team-size limit.
  Pending invitations are deliberately excluded — an invitation nobody accepts would otherwise
  occupy a seat forever.

## [0.1.0]

Initial release: authentication, organizations and roles, website management, uptime and
response-time monitoring with a leased worker queue, incident confirmation and recovery, email
alerts, dashboard analytics and maintenance mode.
