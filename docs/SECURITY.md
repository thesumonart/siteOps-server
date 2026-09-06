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
