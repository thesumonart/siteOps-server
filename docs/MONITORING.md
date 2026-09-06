# Monitoring

How a website goes from "added" to "someone gets an email", and why each threshold exists.

## The pipeline

```text
scheduler tick  (every MONITOR_POLL_INTERVAL_SECONDS)
      │
      ▼
claimBatch()            atomic findOneAndUpdate per website:
      │                 due, unleased → lease taken
      ▼
runMonitoringJob()      one per claimed website, concurrently
      │
      ├─ checkWebsiteWithRetries()   up to MONITOR_MAX_ATTEMPTS
      │        │
      │        └─ checkWebsite()     SSRF-guarded, redirects followed by hand
      │
      ├─ processCheckResult()
      │        ├─ insert the check          (append-only)
      │        ├─ derive counters           (streak in, streak out)
      │        ├─ decideIncidentTransition  (pure)
      │        ├─ applyIncidentTransition   (open / resolve / ongoing / none)
      │        └─ update the website        (status, counters, last-* fields)
      │
      ├─ notifyWebsiteDown / notifyWebsiteRecovered   only on a transition
      │
      └─ finally: releaseAndReschedule()   always, on every path
```

## The queue

There is no broker. The queue is the `websites` collection:

- `nextCheckAt` is the ready time.
- `leaseExpiresAt` is the visibility timeout.
- One `findOneAndUpdate` finds a website that is due and unleased **and** takes the lease, in the
  same round trip.

Two workers racing on the same document can never both win it: MongoDB serialises the update, so
the loser simply finds nothing left to claim.

The lease **expires** rather than being held indefinitely, so a worker that crashes mid-check does
not strand a website — the next tick, on any process, reclaims it. Its duration is derived, not
guessed:

```text
MAX_REQUEST_TIMEOUT_MS × (MONITOR_MAX_REDIRECTS + 1) × MONITOR_MAX_ATTEMPTS + 30s
```

It uses the _maximum any website is allowed to configure_, not this worker's default: a worker
still legitimately checking a slow site must not have its own lease stolen out from under it.

Claims are ordered oldest-due first, so one perpetually overdue site cannot starve the queue behind
it. `MONITOR_CONCURRENCY` bounds both the batch size and the concurrency — the batch _is_ the
limiter.

The loop is a recursive `setTimeout`, not `setInterval`: the next tick is scheduled only once the
current one has fully finished, so a long tick cannot overlap with the next and issue a second,
mostly-empty claim while the first is still in flight.

`releaseAndReschedule` runs in a `finally`. That is the actual reliability guarantee — every
exception path still leaves the website rescheduled promptly, rather than waiting for the lease to
expire.

## One check

`src/monitoring/http-checker.ts`. A `GET` with a 10-second default timeout (per-website,
1s–60s), following up to `MONITOR_MAX_REDIRECTS` hops.

The response body is never read — only its availability matters — but it is discarded explicitly,
or the socket leaks.

Outcomes:

| Status    | When                                              |
| --------- | ------------------------------------------------- |
| `up`      | HTTP 200–399 after redirects                      |
| `down`    | HTTP 400+, or redirects exhausted                 |
| `timeout` | Connect, headers or body timeout                  |
| `error`   | DNS, connection, TLS, blocked target, invalid URL |

Errors are mapped onto a closed vocabulary — `dns_failure`, `connection_refused`,
`connection_reset`, `timeout`, `ssl_error`, `too_many_redirects`, `blocked_target`, `invalid_url`,
`http_error`, `unknown` — so the UI can explain a failure without parsing free text.

The mapping walks the **cause chain**, because undici wraps socket and TLS errors rather than
rethrowing them. TLS chain-verification codes are mapped individually:
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and friends are the single most common TLS misconfiguration in
the wild — browsers often paper over it from cache — so a monitor that reported it as a generic
failure would be unhelpful exactly where it is most useful.

Response time is measured to **response headers**, not to the end of the body.

### Retries within one check

`MONITOR_MAX_ATTEMPTS` (default 2) absorbs a check that simply had a rough moment. This is a
_different_ layer of noise absorption from the failure threshold: that one tolerates a bad check
now and then across many minutes; this one tolerates one right now.

Deterministic rejections — `blocked_target`, `invalid_url` — are **never** retried. They fail
identically every time, so retrying only delays the result.

## Incidents

### Thresholds

```text
healthy
   │  consecutiveFailures reaches failureThreshold (default 3)
   ▼
incident open  ──▶  one "down" notification
   │  consecutiveSuccesses reaches recoveryThreshold (default 2)
   ▼
incident resolved  ──▶  one "recovered" notification
```

**Never declare a site down on one failed check.** Both thresholds exist to absorb transient
network noise, are configurable per website (1–10), and are enforced in `incident-rules.ts` — which
is pure, database-free and exhaustively tested. An off-by-one there either pages someone for a
blip or silently fails to notice a real outage.

A success resets the failure streak and vice versa.

### Deduplication

Guaranteed by a **unique partial index**, `incident_one_open_per_website_category` on
`{ websiteId, category }` where `status: 'open'` — not by application bookkeeping.

The key includes the category because SiteOps raises incidents from more than one source. Every
uptime failure maps to the `availability` category, so two outages for one website still cannot
coexist; an expiring certificate is `ssl` and can be open at the same time, because suppressing it
because the site also happens to be down would lose the alert that mattered.

If two callers somehow race (the lease should make it impossible, but the index makes it impossible
even if the lease is ever bypassed), the loser's insert fails with a duplicate-key error, which is
caught and treated as "an incident is already open" rather than surfaced as a fault. No second
incident, and no second notification.

Resolution is conditioned on `status: 'open'` in the _filter_, so a concurrent resolver loses
cleanly instead of double-resolving.

### What an ongoing incident records

A **successful** check during an unresolved incident writes nothing to it. It carries no
information about the outage, and letting it through would overwrite the record with a 200 and no
error — so a resolved outage would be filed forever as "0 failed checks, HTTP 200", which is both
useless and untrue.

`failedCheckCount` is incremented rather than assigned, because it counts failed checks seen
_during this incident_, while the website's own consecutive counter resets on any success.

### Displayed status

| Status        | Meaning                                    |
| ------------- | ------------------------------------------ |
| `operational` | Responding normally                        |
| `degraded`    | Responding slowly (≥ 2s) or intermittently |
| `down`        | An incident is open                        |
| `paused`      | Monitoring is off                          |
| `unknown`     | Awaiting the first check                   |

Status follows **whether an incident is open**, not the raw pass/fail of the latest check. During a
recovering-but-not-yet-confirmed window the site still reads `down`, because the incident is still
open and showing anything else would contradict the incidents page.

`unknown` is the state of a newly added website. It never means "error".

### Manual resolution

`POST /api/incidents/:id/resolve` (permission `incident:update`) closes an incident by hand — for a
site decommissioned mid-outage, or one held open by a check that will never succeed again. It sets
`resolvedByUserId`, which is what distinguishes it from an automatic recovery in the history, and
leaves the website's own status to the worker.

## Notifications

Asynchronous by construction: they are dispatched by the worker after a check, so no API request
ever waits on an email.

**One notification per incident transition.** Never a repeat while a site stays down — that is the
difference between a monitoring product and a mailing list.

Idempotency has two layers, both enforced by the database:

1. `incident.downNotifiedAt` is claimed with a conditional update (`{ downNotifiedAt: null }` in
   the **filter**). A job that runs twice finds it already set and does nothing further.
2. Each recipient's notification carries `dedupeKey` = `<incidentId>:<event>:<userId>`, and the
   unique index on it makes a duplicate insert impossible.

### Recipients

Every member of the organization who:

- has a **verified** email address, and
- has not turned that event off.

A member with no stored preference **is** notified. Absence means "never asked", and defaulting
that to silence would mean an outage nobody hears about — the failure this product exists to
prevent.

### Delivery, retries and status

Each message is attempted up to `NOTIFICATION_MAX_ATTEMPTS` (default 3) with exponential backoff,
tracked on the delivery record as `attemptCount` and `lastAttemptAt`. A failure the provider will
never accept — or no provider configured at all — is not retried, so a misconfiguration does not
burn the whole budget.

Retrying happens **inside one dispatch**, not through a sweeper over `failed` rows. Sending an
email is not idempotent: a background job that re-sent anything marked failed would deliver
duplicates whenever a send actually succeeded and only the status write failed.

Status is `pending` → `sent` or `failed`, with a truncated `failureReason`.

A failed alert **never** rolls back the incident that triggered it. The incident and check state
are durably written before dispatch, so a notification failure is only ever logged.

## Statistics

Every number comes from checks the worker actually performed.

- A website with no checks reports `null`, never `100%`. An unmeasured site is not a healthy one.
- Uptime is **floored** at two decimals, never rounded up.
- Response-time figures exclude failed checks — the duration of a failure measures how long a
  failure took, not how fast the site is.
- Organization-wide average response time is weighted by successful checks per website. Averaging
  per-site averages would give a site checked every five minutes the same weight as one checked
  every minute.
- Chart buckets with no checks are **absent, not zero-filled**: a gap means monitoring was paused
  or the worker was down, and drawing it as 0% uptime would invent an outage.
- `downtimeSeconds` is estimated from failed-check counts at the resolution polling allows. An
  incident's own duration is the exact figure and is what its page shows.

## Configuration

| Variable                          | Default | What it controls                                          |
| --------------------------------- | ------- | --------------------------------------------------------- |
| `MONITOR_POLL_INTERVAL_SECONDS`   | 15      | How often the scheduler looks for due websites            |
| `MONITOR_CONCURRENCY`             | 10      | Websites checked simultaneously, and the claim batch size |
| `MONITOR_MAX_REDIRECTS`           | 5       | Hops followed before giving up                            |
| `MONITOR_MAX_ATTEMPTS`            | 2       | Attempts per scheduled check, including the first         |
| `NOTIFICATION_MAX_ATTEMPTS`       | 3       | Delivery attempts per alert email                         |
| `CHECK_RETENTION_DAYS`            | 90      | Raw check retention; baked into the TTL index             |
| `MONITOR_ALLOW_PRIVATE_ADDRESSES` | false   | Test-only. Refused in production.                         |

No magic numbers: every monitoring parameter is an environment variable validated at startup.

Per-website settings — interval, timeout, thresholds — live on the website document and are capped
by the organization's plan.

## Operating the worker

`/health` on `WORKER_PORT` answers without touching a dependency. `/health/ready` pings MongoDB and
reports `lastTickAt`, which is the useful signal: a worker whose last tick is far older than the
poll interval is alive but not working.

Shutdown stops claiming new work, waits for checks already in flight, then closes the health server
and drains the pool. A 25-second watchdog forces an exit if a handle fails to release, so it is
this process — not the platform's SIGKILL — that records why.

---

## Auxiliary monitors

Uptime is one loop. Six other checks run alongside it — SSL, domain expiry, performance, content
change, SEO health and broken links — and they are deliberately a separate mechanism.

### Why they are separate

They differ from uptime in every dimension that matters to a scheduler:

|                  | Uptime           | Auxiliary                    |
| ---------------- | ---------------- | ---------------------------- |
| Cadence          | 1–60 minutes     | 1 hour – 30 days             |
| Cost per run     | One HTTP request | Up to a full site crawl      |
| What it measures | Reachability now | State that changes over days |
| Queue document   | `websites`       | `website_monitors`           |

Sharing one queue would mean either throttling uptime to a crawl's pace or letting crawls run at
uptime's concurrency. Sharing one lease would let a seven-minute crawl hold up a two-second
certificate check on the same site.

### The queue

`website_monitors` holds one document per `(website, type)`. It is the same lease pattern as the
uptime queue and for the same reasons: `nextRunAt` is the ready time, `leaseExpiresAt` is the
visibility timeout, one atomic `findOneAndUpdate` claims a document, and an expired lease is
reclaimable so a crashed worker strands nothing.

`MonitorSchedulerLoop` runs in the same worker process as the uptime loop but on its own timer.
Within a tick it processes **one type at a time, sequentially**, each with its own concurrency
budget and timeout:

| Type          | Concurrency | Timeout |
| ------------- | ----------- | ------- |
| `ssl`         | 10          | 15 s    |
| `domain`      | 3           | 20 s    |
| `performance` | 2           | 90 s    |
| `content`     | 5           | 30 s    |
| `seo`         | 4           | 45 s    |
| `links`       | 1           | 300 s   |

Sequential across types is the important part: running them concurrently would let a batch of
crawls and a batch of performance runs start together and put the worker well past what either
budget allowed alone. The cost is that a tick takes as long as the slowest type, which is invisible
against a daily check.

A **paused website pauses everything about it**. Someone who silences alerts for a site being
rebuilt does not expect a certificate warning from it the next morning, and no result is recorded
either — a gap in the history is honest about the fact that nothing was measured.

### `error` is not `failing`

This distinction runs through the whole subsystem and is the single most important rule in it.

- `failing` — the monitor ran and the answer was bad. A certificate has expired.
- `error` — the monitor could not get an answer. A registry timed out.

An `error` result **never** opens an incident and **never** resolves one. Resolving on an error
would send a recovery notification for a problem that has not gone away; opening one would page
somebody about an expiry that may not exist. An errored run also leaves the monitor's displayed
status alone until three consecutive failures, because flipping a green check to red over one DNS
blip teaches people to ignore the colour.

### Incidents

Monitor incidents use the same unique partial index as uptime, keyed on `(websiteId, category)`, so
an SSL incident and an outage can be open at once while two of either cannot.

Unlike uptime, there is no consecutive-failure threshold. A certificate that expires in four days
expires in four days on every run, and checking three times before saying so only delays the alert.
One bad result opens; one good result closes.

### SSL

`ssl-checker.ts` performs the TLS handshake directly rather than through the HTTP checker, because
an invalid certificate is exactly what this monitor exists to report and an HTTP client refuses the
connection before anything can be read off it.

The handshake uses `rejectUnauthorized: false`. **This is not a weakening of SSRF protection or of
transport security**, and the reasoning is worth stating plainly:

- Nothing is transferred. No request is sent, no body is read, no data crosses the socket. It is
  opened, the peer certificate is copied out, and it is destroyed.
- `socket.authorized` and `socket.authorizationError` still report, truthfully, whether a browser
  would have accepted the chain — which is the answer the monitor needs.
- The address guard runs **before** the handshake. The hostname is resolved, every address goes
  through the same `checkAddress` used by the HTTP checker, and the socket connects to the approved
  IP with SNI carrying the hostname. Connecting by hostname would re-query DNS inside the TLS layer
  and reopen the rebinding window.

Hostname matching follows RFC 6125: a wildcard covers exactly one label and never the apex, and the
subject common name is consulted only when the certificate carries no SANs at all.

### Domain expiry

Behind a provider interface, because no single source covers every TLD.

1. **RDAP** first — structured JSON, mandatory for gTLDs, unambiguous dates. The default endpoint is
   IANA's `rdap.org` bootstrap redirector, which is configurable.
2. **WHOIS** second — port 43, free text, heuristics. IANA is queried for the TLD's authoritative
   server, then that server for the domain.

A date the parser does not recognise becomes `null`, never a guess: a misparsed date could read
years into the future and silence a real warning. An ambiguous `04/03/2030` is refused for the same
reason.

**No public suffix list is bundled.** The registrable domain is found by walking the labels from
`example.com` outwards and taking the first name a registry recognises — `co.uk` answers "not
found" and `example.co.uk` answers with a record, so the registry itself is the authority. That is
one request in the common case, three at most, and nothing to keep up to date.
