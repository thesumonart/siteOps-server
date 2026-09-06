# CLAUDE.md

Working notes for this repository. Read before changing anything.

## What this is

SiteOps is a production website-monitoring SaaS for agencies: add client websites, and it checks
uptime, HTTP status and response time on a schedule, confirms real outages, opens and resolves
incidents, and emails the people who need to know.

This repository is the **backend** — a REST API and a monitoring worker over one MongoDB database.
The dashboard is a separate project, `siteOps-client`, reached only over HTTP.

It is a real product, not a demo. Nothing in it may be faked.

## Stack

| Layer      | Choice                                       |
| ---------- | -------------------------------------------- |
| Runtime    | Node 24, ESM, TypeScript 5.9                 |
| HTTP       | Express 5                                    |
| Data       | MongoDB, Mongoose 9                          |
| Auth       | Better Auth 1.7                              |
| Validation | Zod 4                                        |
| Email      | Resend                                       |
| Tooling    | pnpm, ESLint 10, Prettier, Vitest, supertest |

Version choices that are deliberate and must not be "upgraded" casually:

- **TypeScript 5.9, not 7.** `typescript-eslint@8` peers on `typescript <6.1.0`; TS 7 silently
  disables every type-aware lint rule.
- **ESM throughout.** Better Auth is ESM-only. `"type": "module"` with `NodeNext` resolution, so
  relative imports need explicit `.js` specifiers.
- **No Redis, no BullMQ.** The monitoring queue is the `websites` collection, claimed by an atomic
  lease. See `docs/ARCHITECTURE.md` for the full reasoning; the short version is that adding a
  broker means a second required service _and_ a second idempotency mechanism competing with the
  unique indexes that already provide one.
- **Rate limiting is hand-written** in `src/utils/rate-limiter.ts`. Simple enough not to warrant a
  dependency; the interface is one `consume` call.
- **CORS is hand-written** in `src/config/cors.ts`. Fifteen lines, security-critical, worth reading
  in full.

## Layout

```text
src/app.ts          Express assembly; the composition root
src/server.ts       API process        src/worker.ts   Monitoring worker process
src/config/         Validated env, CORS, Better Auth
src/contracts/      The API contract — siteOps-client mirrors this directory
src/controllers/    Thin HTTP handlers      src/services/      Business logic
src/repositories/   Database access         src/models/        Schemas and indexes
src/routes/         Route tables            src/middlewares/   Guards and plumbing
src/validators/     Per-route schema bundles
src/errors/         ApiError, global handler
src/responses/      The envelope
src/monitoring/     SSRF guards, checker, incident rules
src/queues/         The MongoDB-backed work queue
src/jobs/           Scheduler loop, per-website job
src/email/          Provider and templates
src/database/       Connection, index sync and verification
tests/              Integration tests and shared support
docs/               Architecture, API, database, security, monitoring, deployment
```

## Commands

```bash
pnpm dev              # api + worker
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format
pnpm format:check
pnpm docker:up        # local MongoDB replica set
pnpm indexes:sync     # create/update every declared index
pnpm indexes:verify   # read-only; names what is missing
```

## Conventions

**Layering.** `Route → Middleware → Controller → Service → Repository → MongoDB`. Business logic
lives in services and must be callable from the worker, which has no HTTP layer. If a rule needs a
`Request` object, it is in the wrong place.

**Controllers are thin.** Read validated input, call one service method, choose a status. No
queries, no authorization logic, no large transformations.

**Repositories own queries.** Every method touching organization-scoped data takes `organizationId`
as a required argument and filters on it. There is no query path that omits the tenant.

**Validation.** One Zod schema per concept in `src/contracts/schemas`, imported by both the
dashboard's forms and the API. Never write a looser server-side variant — that is how a form starts
accepting input that fails on submit. `src/validators` only composes them per route.

**Types.** Strict, including `noUncheckedIndexedAccess`. `any` is an ESLint error. If it is truly
unavoidable, document why on the line.

**Database.** Timestamps are UTC. `.lean()` for read-only queries, `.select()` for narrow reads,
aggregation for anything countable. A new index needs a stated query and a note in
`docs/DATABASE.md`. Indexes are created only by `pnpm indexes:sync` — Mongoose's `autoIndex` does
nothing here, because models compile before the connection opens and command buffering is off.

**API.** Success is `{ success: true, data }`; failure is
`{ success: false, error: { code, message } }`. Codes come from `API_ERROR_CODES`. Pagination lives
inside `data`. Everything paginated, never unbounded.

**Comments.** Explain decisions, security reasoning and non-obvious edge cases. Do not restate the
code.

## Security rules

These are not style preferences.

1. **SSRF.** Users control the URLs the worker fetches. String validation happens at creation
   (`normalizeWebsiteUrl`); the authoritative check is `classifyIpAddress` against the **resolved
   IP, immediately before connecting, on every redirect hop**. Never weaken either layer. Never
   remove an entry from the blocked ranges. New bypass ideas get a test.
2. **Tenant isolation.** Never trust an organization id from the client. Resolve membership from
   the session first. Another tenant's resource is a `404`, never a `403`.
3. **Authorization.** Check permissions, never role names. Every route declares what it needs on
   the line that declares it.
4. **Secrets.** Never commit `.env`. Never log a password, token or connection string.
5. **Errors.** Never return a stack trace, driver error or internal path to a client.
6. **Auth.** Never hand-roll password hashing or session management. That is Better Auth's job.
7. **`MONITOR_ALLOW_PRIVATE_ADDRESSES`** exists for tests only and is refused in production.

## Client compatibility

`siteOps-client` is a separate repository and deployment. Nothing in a normal build here catches a
renamed field until a screen breaks in front of someone, so these are load-bearing:

- The response envelope is `{ success, data }`. Not negotiable — `apiRequest` in the dashboard
  parses exactly that.
- The prefix is `/api`, not `/api/v1`.
- The session cookie is `siteops.session_token`. The dashboard's routing middleware matches it by
  name; renaming it signs everyone out.
- The email-verification token is an HS256 JWT over `{ email }` signed with `AUTH_SECRET`. The
  dashboard's Playwright suite mints it itself.
- Collection names are addressed directly by that suite's cleanup. Do not rename them casually.
- `src/contracts` is the source of truth and `siteOps-client/src/contracts` is a copy. Change it
  here first, then port it there, then run the tests that came across with the code.

`tests/integration/client-contract.test.ts` is the checklist. A failure there means the dashboard
is broken, not that a test is stale.

## Monitoring rules

- Never declare a site down on one failed check. Failure and recovery thresholds absorb transient
  noise.
- Incident and notification logic must be idempotent, and the guarantees are enforced by unique
  indexes (`incident_one_open_per_website_category`, `notification_dedupe_unique`), not by application
  bookkeeping. Keep it that way.
- One notification per incident transition. Never repeat while a site stays down.
- Uptime is floored, never rounded up. Response-time statistics exclude failed checks.
- No magic numbers. Monitoring parameters are environment variables validated at startup.

## Git

- Conventional Commits, lowercase, imperative: `feat: add website management api`.
- Commit after each meaningful, working portion. Verify first:
  `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm build` after
  architectural changes.
- Push after each verified commit.

## Never do these

- Never add `Co-authored-by`, `Generated with`, or any AI/Claude/ChatGPT attribution to a commit,
  PR, or code comment. Commits carry the developer's own identity and nothing else.
- Never mention AI in a commit message.
- Never `git push --force` or rewrite remote history without being asked.
- Never change the configured Git identity.
- Never commit `.env` or any real secret.
- Never fake monitoring data, uptime, incidents, response times or API responses. Mock data is for
  tests and isolated development only.
- Never leave dead code: unused imports, files, or commented-out implementations.
- Never disable a lint rule or a type error to make something pass. Fix the cause.
- Never commit code knowing a check fails.
- Never weaken SSRF protection, tenant isolation or authorization to make a test or feature easier.
- Never break the client contract above without changing `siteOps-client` in the same breath.

## Keeping this current

Update this file when an architectural decision changes: a new layer boundary, a new security rule,
a version pin with a reason. Deeper detail belongs in `docs/`, not here.
