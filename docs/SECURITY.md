# Security

The rules in this document are not style preferences. Each one exists because weakening it has a
specific, describable consequence.

## SSRF: the defining risk of this product

SiteOps makes HTTP requests to URLs chosen by users. Without care, that is an open proxy into
whatever private network the worker runs in — and on a cloud host, into the instance metadata
endpoint that hands out credentials.

Defence is in **two layers**, and neither is sufficient alone.

### Layer 1 — string validation, at creation time

`src/contracts/url/normalize.ts`, run by `websiteUrlSchema` when a website is added or edited, and
again inside `WebsiteService` so the service holds on its own rather than trusting a caller used
the middleware.

It refuses:

- any scheme but `http:` and `https:`
- credentials in the URL (they would be logged and mailed in incident notifications)
- `localhost`, `ip6-localhost`, `metadata`, `metadata.google.internal`, `instance-data`
- reserved and internal suffixes: `.local`, `.internal`, `.corp`, `.lan`, `.home.arpa`, `.test`,
  `.invalid`, `.onion`, `.in-addr.arpa`, and the rest of the list in that file
- single-label hostnames (`router`, `intranet`) — almost always resolved through a search domain
- any IP literal that is not provably public unicast

IP classification lives in `src/contracts/url/ip.ts`. Notable choices:

- **Short and zero-padded IPv4 forms are rejected, not normalized.** `127.1` and `0177.0.0.1` are
  both accepted as loopback by some resolvers, so treating them as invalid stops the blocklist
  being bypassed by notation.
- **IPv4-mapped and IPv4-compatible IPv6 are judged by the address they carry**, or
  `::ffff:127.0.0.1` reaches loopback.
- **6to4 (`2002::/16`) and NAT64 (`64:ff9b::/96`) are unwrapped** and the embedded IPv4 classified.
- A **zone index** (`fe80::1%eth0`) never makes an address public, so it is stripped and the
  address itself classified.

Blocked IPv4 ranges cover RFC 1122, 1918, 3927, 5735 and 6598, plus `169.254.0.0/16` — the
link-local range that carries AWS, GCP and Azure instance metadata.

### Layer 2 — the resolved address, immediately before connecting

**This is the authoritative check.** DNS can change between the moment a website is added and the
moment it is checked, so string validation cannot be trusted at request time. That gap is DNS
rebinding, and only this layer closes it.

`src/monitoring/safe-lookup.ts` installs a custom `lookup` on the socket, so the address the guard
approves is the exact address the kernel connects to. Resolving separately and then connecting by
hostname would re-query DNS and could land somewhere unvalidated.

A hostname resolving to both a public and a private address returns **only the public ones**. All
addresses must be refused for the connection to fail, but a private address is never handed back.

### Redirects are followed by hand

`src/monitoring/http-checker.ts` follows redirects itself rather than letting the HTTP client do
it, so every hop is re-validated — both its URL string and, through the lookup, the address it
resolves to. A public URL that 302s into cloud metadata is refused mid-chain.

The string check runs again on **every hop**, and that is not redundant with the address guard:
Node's socket layer skips a custom `lookup` entirely when the host is already an IP literal
(`net.isIP()` short-circuits it), so a redirect straight to `http://169.254.169.254/` would never
reach `safe-lookup.ts`. The per-hop string check is what actually catches that case.

Connections are not pooled across checks (`pipelining: 0`, a fresh `Agent` per check): a reused
socket would skip the lookup, and with it the guard, on a later request.

### `MONITOR_ALLOW_PRIVATE_ADDRESSES`

Test-only, and **refused outright in production** by the environment schema.

It is deliberately narrower than its name suggests: it permits loopback only. Every other blocked
range — RFC 1918, link-local, cloud metadata, CGNAT — stays blocked with it on, so a test can still
prove that a redirect into metadata territory is refused.

That narrowness came from a real regression caught by this module's own tests: a first draft
bypassed the string check for any `blocked_hostname`/`blocked_ip` reason, which let a redirect to
`169.254.169.254` through in test mode.

### Rules

1. Never weaken either layer.
2. Never remove an entry from the blocked ranges.
3. Every new bypass idea gets a test.

## Tenant isolation

```text
User → Organization membership → Role → Permissions → Resource
```

1. **Never trust an organization id from the client.** `X-Organization-Id` and any
   `:organizationId` path parameter are _hints_. `requireOrganization` re-resolves membership from
   the session on every request, and only the role stored server-side decides what is allowed.
2. **Another tenant's resource is a 404, never a 403.** A 403 confirms the identifier exists, which
   turns the endpoint into an oracle for enumerating other tenants.
3. **Every repository method takes the organization id** and filters on it. Isolation is a property
   of the layer, not a habit of the caller.
4. **Check permissions, never role names.** `hasEveryPermission(role, required)`; a capability
   change happens in `contracts/domain/permissions.ts` rather than across every route.

`tests/integration/tenant-isolation.test.ts` asserts all of this against a real database and a real
middleware chain, including a forged header on a genuine session.

## Authentication

Better Auth owns password hashing, session issuing and token lifecycles. **Never hand-roll any of
them.**

| Property     | Value                                                       | Why                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie       | `siteops.session_token`, `__Secure-` prefixed in production | The dashboard's routing middleware matches this name.                                                                                                                                         |
| Flags        | `HttpOnly`, `SameSite=Lax`, `Secure` in production          | Not readable from JavaScript. Lax rather than Strict because a verification link arrives from a mail client as a cross-site navigation, and Strict would drop the cookie on exactly that hop. |
| Session      | 30 days, refreshed after 1 day of use                       |                                                                                                                                                                                               |
| Email tokens | 1 hour                                                      | They are bearer credentials: whoever holds the URL can act as the account.                                                                                                                    |
| Password     | 12–128 characters                                           | Length is what resists offline cracking. A character-class rule is deliberately omitted — it pushes people toward predictable substitutions without adding entropy.                           |
| Reset        | Revokes every existing session                              | A password change must evict a session an attacker already holds.                                                                                                                             |

**Email verification is required.** An account that has not proven its address cannot reach
organization data, and is never a notification recipient — it is the same address a stranger could
have typed at sign-up.

Verification is re-checked on **every request**, not assumed from how the session started: a
session can outlive a change to the account.

### Enumeration

- Sign-in answers identically whether the address is unknown or the password is wrong — same code,
  same wording.
- Sign-up with an existing address answers **200 with a synthetic id and writes nothing**. A
  distinguishable response is exactly what a credential-stuffing list is built from. The existing
  account's password is never replaced; `tests/integration/auth.test.ts` asserts that.
- Password reset always succeeds, even for an unknown address.

## Invitations

- Only the **SHA-256 hash** of the token is stored. A leaked database yields no working links.
- No salt and no stretching, deliberately: the input is 256 bits of randomness, not a password, so
  there is nothing for a rainbow table or a brute-force to shorten.
- Acceptance requires holding the token **and** being signed in as the address it was sent to,
  compared in **constant time** so acceptance cannot be probed by timing.
- Seven-day expiry, single use, revocable.

## Transport and headers

`helmet` with a CSP of `default-src 'none'; frame-ancestors 'none'` — this API serves JSON, so a
restrictive policy costs nothing and hardens any error page a browser renders. Plus
`Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-site`, and HSTS for a year with
subdomains in production.

`x-powered-by` is disabled. Nothing good comes of naming the framework and its version.

### CORS

An **explicit allowlist**, never a reflected origin. These requests carry the session cookie, so
echoing back whatever `Origin` arrives would let any page on the internet act as the signed-in
user. `Vary: Origin` is always sent, including for a rejected origin, so a cache cannot replay one
origin's response for another.

## Rate limiting

Fixed-window, keyed by client address **and** scope, so hammering the sign-in form cannot exhaust
an attacker's budget for reading the dashboard, and one abusive client cannot lock everyone else
out of an endpoint.

Sign-in and sign-up share one scope: alternating between them must not double the budget. Every
endpoint that sends an email has a tighter budget, which protects the sending reputation of the
domain as much as it protects the account.

**Known limitation:** counters are per-process, so with several API instances the effective limit
is `limit × instances`. That is acceptable for a single-instance deployment. The interface is one
`consume` call, so it can be re-implemented over a shared store without touching a caller.

`TRUST_PROXY` must be enabled **only** behind a proxy that actually sets `X-Forwarded-For`. With no
proxy in front, enabling it lets any client choose its own address and get a fresh budget per
request.

### The session endpoint has a budget of its own

`GET /api/session` is limited separately from everything else, at
`SESSION_RATE_LIMIT_MAX_REQUESTS` a minute (default 60). It is the one endpoint every page load
hits — twice, since a server component renders against it and the browser reads it again — so it
would otherwise be both the cheapest way to probe the API and the first thing a legitimate burst
exhausts. Raising it is only appropriate where many sessions share one address, which in practice
means an end-to-end suite.

## Input

Everything external is validated with Zod before a handler sees it: bodies, query strings, route
parameters. TypeScript types are erased at runtime and validate nothing.

The schemas live in `src/contracts/schemas` and the dashboard imports the same file, so the browser
form and the API enforce literally the same rule. Never write a looser server-side variant.

Bodies are capped at 100kb. A monitoring payload is small; a generous limit only helps an attacker.

Route parameters are validated as ObjectIds before any query. Without that,
`new Types.ObjectId('nope')` throws inside a query builder and turns what should be a 400 into a 500.

User-supplied search text is escaped before it becomes a regex, so it cannot smuggle regex syntax
into a query.

## Errors and logging

**Never returned to a client:** stack traces, driver errors, MongoDB error text, file paths,
connection strings, environment values. `errorHandler` logs the full error server-side and answers
with a message written for a person. A duplicate-key error does not say which index collided —
for `user.email` that would confirm an address is registered.

**Never logged:** passwords, tokens, cookies, API keys, secrets. The redaction list in
`src/utils/logger.ts` is the guarantee, rather than the discipline of whoever writes the next log
line.

Request bodies are never logged. Neither are query strings — a verification or reset link puts a
working credential in one, and a log aggregator is the wrong place for that to end up.

Every request carries a correlation id, echoed as `X-Request-Id`. A client-supplied id is honoured
only when it matches `^[A-Za-z0-9_-]{1,64}$`; anything else is replaced. Reflecting arbitrary text
into a response header is how header injection and log forgery start.

## Secrets

- Never commit `.env`. It is git-ignored, and `.env.example` carries placeholders only.
- `AUTH_SECRET` is at least 32 characters and validated at startup.
- Configuration is read in exactly one module. An ESLint rule makes reading the raw environment
  anywhere else an error, so a misconfigured process fails at startup rather than on first request.
- Startup validation prints field names and messages but **never values** — that output reaches
  logs, and the offending value is often the secret itself.

## Billing

Billing is the one place where a bug costs money rather than data, so its threat model is written
out rather than implied.

### The plan is never client-writable

There is no route that sets `organization.plan`. `PATCH /api/organizations/:id` accepts `name` and
`timezone` and the Zod schema strips everything else, so a `plan` field in that body is ignored
rather than refused-and-retried. The only writer is `applySubscriptionState`, reachable only from
the webhook handler, reachable only after a signature verifies. An integration test asserts the
plan is unchanged after every request shape a caller might reach for.

### The price is never client-supplied

A checkout request names a plan and an interval. The Stripe price id is resolved from
`PriceCatalog`, built from environment variables at startup. There is no amount, currency, quantity,
coupon or price field in `startCheckoutSchema` — so "buy Agency at the Professional price" is not a
request that can be expressed, let alone rejected.

### The checkout return is not evidence of payment

`/dashboard/billing?checkout=success` is a redirect target and nothing more. The dashboard re-reads
the subscription from the API when it lands; the plan itself was granted (or not) by the webhook.
Forging that URL grants nothing.

### Webhook verification

`Stripe-Signature` is verified against the **raw** body: HMAC-SHA256 over `${timestamp}.${body}`,
compared with `timingSafeEqual`, with a 300-second timestamp tolerance. Each element earns its place:

- **Raw body** — a parsed-and-reserialised payload changes key order and whitespace and would never
  verify, so a route that accepted one would be verifying nothing. The controller asserts it
  received a Buffer.
- **Constant-time compare** — a byte-by-byte early return leaks how much of a guess was right.
  Buffer lengths are checked first, because `timingSafeEqual` throws on a mismatch and a throw is
  itself a timing signal.
- **Timestamp tolerance** — without it a captured payload and its signature stay valid forever, and
  an observed `subscription.updated` could be replayed to restore a plan that is no longer paid for.
- **Uniform failures** — every rejection is the same opaque 400. Saying whether the timestamp or
  the digest was wrong tells a caller how to get closer.

`STRIPE_SECRET_KEY` without `STRIPE_WEBHOOK_SECRET` is refused at startup: a deployment that can
take money but cannot verify that it did would leave every subscription frozen. A `sk_live_` key is
refused outside production.

### Replay and ordering

Deliveries are at-least-once and unordered. Duplicates are stopped by the unique index on
`billing_events.eventId`, claimed before processing; out-of-order deliveries are stopped by the
`billing.lastEventAt` guard on the update. Without the second, a late `updated` could overwrite a
newer `deleted` and leave a cancelled customer entitled indefinitely.

### Tenant isolation

A portal session is created against the customer id stored on the organization the caller was
already authorized for — there is no customer id in any request. Webhooks resolve a tenant from
metadata Stripe stored, or from the unique `billing.customerId` mapping; an event for a customer
this deployment does not know is logged and ignored, because one Stripe account can serve several
deployments. Provider identifiers never appear in an API response.

### Authorization

`billing:read` and `billing:manage` are held by `owner` only. An admin can run the product but
cannot commit the organization to a recurring charge, and cannot see what it pays. `client` holds
neither, along with nothing else that writes.

## API keys

A key is a credential that acts for a whole organization, from outside it, for as long as it lives.

- **Stored as a hash.** SHA-256 of 256 random bits, prefixed `so_live_` so a leaked key is
  recognisable in a secret scanner. Shown once, on issue or rotation; no response carries it again.
  Authentication is one lookup by hash on a unique index — there is no key-by-key comparison to
  time — and a token that could never be a key is refused before the database is asked.
- **Never a session.** `/api/v1` accepts a key and nothing else, and nothing that manages keys
  accepts one. A cookie that worked on the public API would make it a CSRF target; a key that could
  mint keys would outlive every revocation.
- **The tenant is the key's.** The organization comes from the key's own document. A header naming
  another is ignored, and another tenant's resource is a `404`, as everywhere else.
- **Capped at the issuer.** A scope may only be granted by someone whose role holds every
  permission behind it. Scopes are checked per route, on the line that declares it.
- **One refusal.** Missing, malformed, unknown, revoked and expired keys all answer the same
  `401 API_KEY_INVALID`.
- **Budgets.** A per-key limit smooths bursts; the plan's daily quota is counted in the database, so
  several API instances cannot each grant it in full.
- **Rotation has no overlap.** The old secret stops working in the write that issues the new one.

A key belongs to the organization, not to the person who made it. When somebody leaves, revoke the
keys they issued; the list says who issued each one.

## Public status pages and custom domains

The first surface SiteOps serves to people who have no account, about infrastructure that is not
theirs.

### What a stranger may learn

A component's display name, its public status, its daily uptime and whether an outage or slowdown is
open. Nothing else. `PublicStatusPageDto` is built field by field for that audience rather than
filtered from an internal DTO, so a field added to a website does not reach the public by default.

- **No identifiers.** No website, page or organization id: nothing a visitor could try against
  another endpoint.
- **No measurements.** No response times, status codes or error messages. An error message is often
  a map of exactly what broke — a hostname, a port, an upstream — and response times profile the
  hosting.
- **No internal names.** Components are shown under a display name chosen for the page, never the
  website's name or URL.
- **Only outages and slowdowns.** An expiring certificate or an SEO regression is the agency's
  business, not an announcement to its client's customers. Paused monitoring reads as "no data".
- **Unpublished is nonexistent.** Draft pages, unknown slugs and pages whose plan lapsed are one
  `404`.

### Tenant isolation without a tenant

A public request names a slug or a hostname, not an organization, so there is no membership to
resolve. The page names the organization instead, and every read after it is scoped by that id.
Component website ids are checked against the organization when they are stored, and again — as a
tenant-scoped query — before any history is read, so a page document edited by anything other than
the API still cannot show another tenant's website.

### Cross-origin reads

`/api/public` answers any origin with `Access-Control-Allow-Origin: *` and never
`Allow-Credentials`. That is safe there and nowhere else: nothing under that router reads a cookie,
a session or a key, so there is no ambient authority for a foreign page to borrow. It is a separate
router mounted outside `/api` so a session-reading route cannot end up behind the wildcard.

### Custom domains

- **Proof, not a claim.** A domain routes only after a TXT record at `_siteops-challenge.<domain>`
  carries the page's own random token. Until then the host means nothing. The token is not secret —
  it is published in DNS by design — so it is stored as it is.
- **First to prove wins.** Uniqueness applies to verified domains only (a partial unique index).
  A plain unique index would let anyone claim `status.acme.com` first and lock Acme out of its own
  name; here any number of organizations can be pending, and the database decides who verifies.
- **A customer's domain is not SiteOps.** `customDomainRouting` runs before Better Auth. On a
  verified custom domain every path outside `/api/public/` is a `404`, so sign-in, sessions and the
  dashboard API are never served on a name somebody else controls in DNS. SiteOps's own hosts
  (`APP_URL`, `API_URL`, the trusted origins, loopback) are recognised without a query and can never
  be claimed.
- **Host lookups are bounded.** Hostnames come from a header the client chooses, so the lookup cache
  is capped and cleared rather than grown without limit.
- **Verification is rate limited.** Each attempt is an outbound DNS query; 30 an hour per address.
  A TXT lookup needs no SSRF screen — it goes to the configured resolver, not to the name asked
  about, and the answer is compared, never followed.

### Load

A status page is read by everyone at once exactly when something is down. Rendered pages and host
lookups are cached per instance for `STATUS_PAGE_CACHE_TTL_SECONDS`, the endpoint has its own
per-address budget, and the daily history is grouped in the database from a covering index rather
than read as documents — ninety days of a one-minute monitor is over a hundred thousand checks.

## AI incident analysis

The one place SiteOps sends tenant data to a third party it did not choose per tenant: the
deployment's configured model provider. Everything below follows from taking that seriously.

### What leaves, and what does not

Sent: an incident's times, type, status codes, error types and error messages; response-time
statistics and a collapsed timeline of checks around it; overlapping incidents; the website's name,
**hostname** and check interval. Not sent: the URL's path or query — which can carry a token — any
person's name or email, the organization's name, credentials, or anything from another incident's
organization. The facts are assembled field by field in `src/ai/incident-facts.ts`, so a field added
to a model does not reach a provider by default. Nothing is sent at all unless an operator configures
a key, and then only for organizations whose plan includes AI insights.

### Prompt injection

Error messages and status lines are written by the monitored server, which is not necessarily
friendly. The facts are one JSON block inside `<incident_data>`, with every `<` escaped, so no string
can close the block; error text is clipped to 200 characters; and the standing instructions say the
block is data that never contains instructions. The worst an injection can then do is mislead the
summary shown to the organization that owns the incident — it cannot reach another tenant, call a
tool, or change anything, because the model is given no tools and its output is only stored.

### Rendering the output

A summary is untrusted Markdown. The API stores it as text, capped at 12,000 characters, and the
contract says to render it without raw HTML. It is never interpolated into an email or a page on the
server.

### Keys and errors

Provider keys are read only by `config/env.ts` and sent only to the provider's fixed API host. A
provider's error message is logged for the operator, truncated, and never stored or returned: the
reason shown to an organization names the HTTP status and the provider's error _type_, restricted to
a short identifier.

### Spend

Each analysis is reserved from the plan's `aiGenerationsPerMonth` before the provider is called, by
an atomic conditional increment — concurrent analyses cannot each find room and overspend it. A
request to regenerate is rate limited, needs `incident:update`, and returns the pending analysis
instead of queuing a second one.

### Tenancy

Analyses are read through the incident, scoped by organization, and — for a client membership — by
the website's client, so a client portal user cannot read the analysis of another client's outage.

## Notification channels and outgoing webhooks

A webhook is the second place SiteOps sends a request to a URL a customer chose, and it gets the same
treatment as the first.

### SSRF

Both layers apply, unchanged. `validateChannelUrl` screens a webhook URL with `normalizeWebsiteUrl`
at creation and on every edit, and requires `https`. `postToChannel` re-validates the string
immediately before every send and connects through the guarded dispatcher, whose lookup refuses a
private address — a fresh pool per request, so no reused socket skips it. A stored URL that points
inward, however it got there, fails with a reason and is not retried.

**Redirects are not followed.** Following one would mean deliver a signed payload to a hop the
customer never saw. A `3xx` is a failed delivery that says so.

Slack and Discord URLs are held to an allowlist of their own hosts and paths. A "Slack" channel is
a promise that the message goes to Slack.

`POST /api/channels/:channelId/test` makes the server send a request on demand, so it has its own
rate limit on top of the SSRF boundary: the boundary decides where a request may go, the budget how
often.

### Credentials at rest

A Slack or Discord webhook URL is a bearer credential, and a webhook signing secret has to be usable
again to sign, so neither can be hashed the way invitation tokens are. Both are sealed with
AES-256-GCM (`src/utils/secret-box.ts`) under a key derived from `AUTH_SECRET` with HKDF, with a
fresh IV per value and the organization id bound in as associated data. A leaked database yields
ciphertext; a ciphertext copied onto another tenant's channel does not open there; a tampered one
fails to open rather than decrypting to something else.

Neither ever leaves the server after it arrives. Responses carry `target` — origin plus the last
four characters — and the signing secret is returned exactly once, on creation or rotation. Both
are on the logger's redaction list.

### Signing

`X-SiteOps-Signature: t=<unix>,v1=<hex HMAC-SHA256 over "${t}.${body}">` — the same scheme this API
verifies Stripe's webhooks with, for the same reasons: the signature covers the exact bytes, and the
timestamp inside it lets a receiver refuse a replay. Requests are signed at send time, so a retry
carries a fresh timestamp rather than one a receiver would reject as stale. Secrets are 256 bits,
prefixed `so_whsec_` so a leaked one is recognisable in a scanner.

### Content

Everything a customer typed that reaches a chat message is escaped for the platform: `&`, `<` and
`>` for Slack, whose `<!channel>` would page a whole workspace, and markdown for Discord, whose
messages are sent with `allowed_mentions: { parse: [] }` so no website name can mention anyone. An
error body from a receiver is truncated and stripped of control characters before it reaches the
delivery log.

### Authorization

`integration:read` and `integration:manage` belong to admins and owners. A channel decides where
the whole organization's alerts go; a member manages their own email preferences and nothing else.
Another organization's channel is a `404`, like every other tenant boundary.

## Reporting

This is a private repository. Raise a security concern directly with the maintainer rather than in
a public issue.

---

## The client portal

An agency's client gets a read-only window into part of that agency's data. This is the only place
in SiteOps where somebody _outside_ an organization is given a session inside it, so the boundary is
worth stating in full.

### Portal access is an organization membership

A client contact is a normal user: normal password, normal verified address, normal session. Their
membership carries the `client` role and a `clientId`.

That is a decision, not an accident. The alternative — a `client_users` collection with its own
tokens and its own login — would mean two implementations of authentication, and the second one is
always the one with the hole in it. Here there is one auth path, one session store, and revoking
access is deleting a membership, which the product already does correctly.

### Two scopes, not one

Every other role is scoped by `organizationId` alone. A client membership is scoped by two things:

|                  | Internal role     | Client role      |
| ---------------- | ----------------- | ---------------- |
| `organizationId` | The organization  | The organization |
| `clientScope`    | null (everything) | One client       |

`clientScope` is resolved by `requireOrganization` from the membership row **read from the
database**, never from a header, a body or a token claim. Every repository method that can return
website-scoped data applies it, so "read websites" means "read this client's websites" and a website
belonging to another client of the same agency does not resolve at all — a 404, not a 403, exactly
like a cross-tenant request.

The scope covers everything _about_ a website, not only websites themselves. Incidents, a website's
stats, uptime and checks, the overview cards, the monitor summary and monitor results, and reports
all narrow to the websites the membership can see (`WebsiteRepository.idsVisibleTo`). A report is
visible to a client only when every website it covers is theirs, so an organization-wide report — or
one mixing two clients — never is. These reads once used the organization alone, which let a contact
list every outage in the agency, take a website id from it and read that website's checks;
`tests/integration/client.test.ts` now asserts each path from a contact's session.

A `client` membership with no `clientId` would be a contact scoped to nothing, which must not read
as "everything". The service refuses to create one and the middleware refuses to _use_ one, so a row
written by anything other than the API still fails closed.

### What a client cannot reach

`client:read` and `client:manage` are absent from the role, so the client list is a `403` — a client
cannot enumerate the agency's other customers. So are `member:read` (they cannot learn who works at
the agency), `audit_log:read`, `notification:*`, `billing:*` and every write capability. Every
permission a client holds ends in `:read`, and there is a test that asserts exactly that rather than
listing them.

The members list and member-management lookups exclude client memberships, so the members table
cannot be used to promote a customer's contact to admin.

### Archiving revokes access

Archiving a client deletes every portal membership for it. An agency that archives a client expects
the portal to close; expecting them to also remember each contact individually is how a former
client keeps reading a live dashboard for a year.

Deleting a client revokes access too, but **keeps the websites** and unassigns them. Deleting a
client relationship is not a request to stop monitoring their sites, and silently deleting the
monitoring would destroy history the agency may still need.
