# SiteOps — server

**The API and monitoring worker behind SiteOps.**

SiteOps continuously checks the websites an agency looks after, confirms real outages before it
alerts anyone, and keeps the uptime history their clients ask about. This repository is the
backend: a REST API and a monitoring worker, sharing one MongoDB database.

The dashboard is a separate project, [`siteOps-client`](https://github.com/thesumonart/siteOps-client),
and reaches this API over HTTP. The two meet only at that boundary.

```text
siteOps-client  ──HTTPS──▶  Express API  ──▶  MongoDB
                                               ▲
                            Monitoring worker ─┘
                                   │
                                   ▼
                          the monitored websites
```

## Requirements

| Tool    | Version | Notes                                  |
| ------- | ------- | -------------------------------------- |
| Node.js | 24.15.0 | Pinned in `.nvmrc`; run `nvm use`      |
| pnpm    | >= 11   | `corepack enable` or install globally  |
| Docker  | any     | Only for the local MongoDB replica set |

## Getting started

```bash
# 1. Install dependencies
pnpm install

# 2. Copy the environment template and fill it in
cp .env.example .env

# 3. Start MongoDB (single-node replica set, required for transactions)
pnpm docker:up

# 4. Create the database indexes
pnpm indexes:sync

# 5. Run the API and the worker
pnpm dev
```

| Process | URL                   |
| ------- | --------------------- |
| API     | http://localhost:4000 |
| Worker  | http://localhost:4001 |

`AUTH_SECRET` is the only value in `.env` you must change before anything works. Generate one with:

```bash
openssl rand -base64 32
```

Without `RESEND_API_KEY` the API logs emails instead of sending them, and prints the verification
link to the terminal — enough to register an account locally. That fallback is refused in
production.

## Commands

| Command               | What it does                                      |
| --------------------- | ------------------------------------------------- |
| `pnpm dev`            | API and worker in watch mode                      |
| `pnpm dev:api`        | API only                                          |
| `pnpm dev:worker`     | Worker only                                       |
| `pnpm build`          | Compiles to `dist/`                               |
| `pnpm start`          | Runs the compiled API                             |
| `pnpm start:worker`   | Runs the compiled worker                          |
| `pnpm lint`           | ESLint                                            |
| `pnpm typecheck`      | `tsc --noEmit`                                    |
| `pnpm test`           | Unit and integration tests                        |
| `pnpm format`         | Prettier                                          |
| `pnpm format:check`   | Fails if anything is unformatted (used by CI)     |
| `pnpm indexes:sync`   | Creates or updates every declared index           |
| `pnpm indexes:verify` | Read-only; names what is missing, exits non-zero  |
| `pnpm seed`           | Seeds an organization and websites for an account |
| `pnpm docker:up`      | Starts local MongoDB                              |
| `pnpm docker:down`    | Stops local MongoDB                               |

## Tests

```bash
pnpm test
```

Unit tests run anywhere. The integration tests need a MongoDB and **skip themselves** when there
is none, so `pnpm test` is runnable on a machine with nothing started — but they are the ones that
prove the guarantees that only a real database can enforce (the unique partial index behind
incident deduplication, tenant isolation across a real middleware chain), so run `pnpm docker:up`
before trusting a green run.

`tests/integration/client-contract.test.ts` is the compatibility checklist: one case per call the
dashboard makes, asserting the path, the method and the shape it destructures. A failure there
means the dashboard is broken, not that a test is stale.

## Running the dashboard's end-to-end suite against this API

`siteOps-client` has a Playwright suite that drives a real browser against a real API. It does not
start one. Build and run this project against a throwaway database first:

```bash
pnpm build

NODE_ENV=test PORT=4100 \
APP_URL=http://localhost:3100 API_URL=http://localhost:4100 \
MONGODB_URI='mongodb://localhost:27017/siteops_e2e?replicaSet=rs0&directConnection=true' \
MONGODB_AUTO_INDEX=true \
AUTH_SECRET=e2e-only-auth-secret-value-not-used-anywhere-else \
LOG_LEVEL=warn AUTH_RATE_LIMIT_MAX_REQUESTS=1000 RATE_LIMIT_MAX_REQUESTS=5000 \
node dist/server.js
```

Then run `pnpm test:e2e` in `siteOps-client`. The `AUTH_SECRET` must match: that suite mints the
email-verification token itself, because there is no mail provider in a test run to deliver the
link.

## Repository layout

```text
src/
├── app.ts             Express assembly and the composition root
├── server.ts          API process: connect, listen, shut down
├── worker.ts          Monitoring worker process
├── config/            Validated environment, CORS, Better Auth
├── contracts/         The API contract; siteOps-client mirrors this
├── controllers/       Thin HTTP handlers
├── services/          Business logic, callable without a Request
├── repositories/      Database access, always tenant-scoped
├── models/            Mongoose schemas and indexes
├── routes/            Route tables with their own guards
├── middlewares/       Auth, tenancy, validation, rate limit, request id
├── validators/        Per-route validation bundles
├── errors/            ApiError and the global handler
├── responses/         The response envelope
├── monitoring/        SSRF guards, HTTP checker, incident rules
├── queues/            The MongoDB-backed monitoring work queue
├── jobs/              The scheduler loop and the per-website job
├── email/             Provider and transactional templates
├── database/          Connection and index management
└── utils/             Logger, cursors, ObjectId, crypto, rate limiter
```

## Documentation

| Document                                | Covers                                           |
| --------------------------------------- | ------------------------------------------------ |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layering, decisions and why                      |
| [API.md](docs/API.md)                   | Every endpoint, envelope and error code          |
| [DATABASE.md](docs/DATABASE.md)         | Collections, indexes and retention               |
| [SECURITY.md](docs/SECURITY.md)         | SSRF defence, tenant isolation, sessions, limits |
| [MONITORING.md](docs/MONITORING.md)     | How checks, incidents and notifications work     |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)     | Hosting, environment variables, operations       |

## Licence

Unlicensed and private.
