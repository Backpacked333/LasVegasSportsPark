# Sportspark

Soccer and indoor-soccer facility operating platform: customers, families, teams, programs, fields,
staff, officials, money, communications, and daily operations on one set of authoritative records.

The product and engineering requirements live in **[docs/spec/master-specification.md](docs/spec/master-specification.md)**
(version 2.0). Everything in this repository traces back to a `SPK-*` requirement in that document.

## Status

| Package (spec §6.5)                             | State                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A — Operating model and specification baseline  | In progress: see [docs/package-a](docs/package-a)                                           |
| B — Production foundation                       | Kernel delivered (org-scoped model, auth/authorization, idempotent commands, audit, outbox) |
| C — Soccer scheduling and competition           | Not started (modules scaffolded)                                                            |
| D — Registration and money                      | Not started (modules scaffolded)                                                            |
| E — Customer and daily operations (native apps) | Not started                                                                                 |
| F — Controlled live pilot                       | Not started                                                                                 |
| G — Full facility operation and differentiation | Not started                                                                                 |

The "persistent local demonstration" referenced by the specification is not in this repository.
Provider selections (identity, payments, messaging, hosting, accounting, hardware) are gated
decisions (spec §5.2); the code ships ports with fake adapters only.

## Layout

```
apps/api            NestJS modular monolith (HTTP API) and durable worker entrypoint
packages/contracts  Shared contracts: ids, money, errors, commands, state machines, events, OpenAPI
packages/db         PostgreSQL SQL migrations, Kysely types, PGlite/pg clients, test harness
docs/spec           Master specification (source of truth)
docs/architecture   Engineering architecture and conventions
docs/package-a      Package A artifacts (cross-reference, matrices, registers, journeys, fixtures)
docs/api            Generated OpenAPI document
docs/runbooks       Operational runbooks
```

## Quick start

Requirements: Node 22.12+, pnpm 10. No database server is needed for development or tests:
the API and the test suite run real PostgreSQL in-process through PGlite.

```bash
pnpm install
pnpm verify                 # format check, lint, typecheck, tests
NODE_ENV=development AUTH_LOCAL_SECRET=$(openssl rand -hex 32) pnpm --filter @sportspark/api dev
curl localhost:3000/v1/health
```

Run against a PostgreSQL server by setting `DATABASE_URL`; migrations apply with `pnpm db:migrate`.
Run the test suite against a PostgreSQL server (true concurrency) with `TEST_DATABASE_URL`.

## Working in this repository

Read [CLAUDE.md](CLAUDE.md) for the engineering conventions every change must follow and
[docs/architecture/overview.md](docs/architecture/overview.md) for how the pieces fit together.
