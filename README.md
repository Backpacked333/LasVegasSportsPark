# Sportspark

Soccer and indoor-soccer facility operating platform: customers, families, teams, programs, fields,
staff, officials, money, communications, and daily operations on one set of authoritative records.

The product and engineering requirements live in **[docs/spec/master-specification.md](docs/spec/master-specification.md)**
(version 2.0). Everything in this repository traces back to a `SPK-*` requirement in that document.

## Status

Test counts are vitest counts from `pnpm test` on 2026-10-24: 883 tests in 145 files, all passing
both on PGlite and on PostgreSQL through `TEST_DATABASE_URL`. All fourteen domain modules under
`apps/api/src/modules/` are implemented as backend code (16 SQL migrations, 0001 to 1400; 227
registered actions, listed in
[docs/package-a/permission-matrix.generated.md](docs/package-a/permission-matrix.generated.md);
349 HTTP paths in [docs/api/openapi.json](docs/api/openapi.json)). "Implemented" below means
implemented and tested in this repository; nothing here has been accepted by an operator, and no
package gate of §6.5 has been signed off.

| Package (spec §6.5)                             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Operating model and specification baseline  | In progress: see [docs/package-a](docs/package-a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B — Production foundation                       | Implemented: organization-scoped model with composite organization foreign keys; checksum-verified versioned migrations; zod command contracts with idempotency keys, revisions and reasons; `AuthorizationService` with the action registry; audit; transactional outbox and inbox with dead-lettering; durable operations, operational exceptions and a worker entrypoint; not-found for protected records; relationship permissions (guardian grants, households, staff memberships) in identity. Tests: kernel 39, contracts 17, db 11, identity 75. Not implemented: managed identity integration (only the local JWT provider exists, for development and tests, refused in production; the managed provider is DEC-018); hosting, backups and recovery environment (DEC-021); recovery is tested in-process only (outbox and inbox replay)                                                                                                                                                                                                                          |
| C — Soccer scheduling and competition           | Implemented: scheduling (resources and conflict units, conflicts with a database exclusion constraint, closures, schedule drafts and publication; 54 tests); competition (seasons, divisions, rule sets, team entries, rosters, fixtures, fixture generation, results with reviewed corrections, standings, brackets, discipline, disputes, appeals, match readiness; 105 tests); workforce (official and coach assignments, replacements, the required-officials readiness check, fees; 36 tests); facilities restrictions that close space through scheduling (26 tests). Not implemented: bracket seeding from standings and a playoff generator; shootout winners; an exact fixture solver (the generator is a greedy search); readiness evidence for forms, financial conditions and change-notice delivery (reported as `unknown`: no module registers those ports); accepted assignments are not written into scheduling commitments and scheduling does not validate staffing; no staff interface. Pending decisions include DEC-002, DEC-010, DEC-049 and DEC-065 |
| D — Registration and money                      | Implemented: catalog (programs, offerings, publication, policies, price rules, discounts, acknowledgments; 62 tests); enrollment (applications and approval, family baskets, capacity holds, waitlists and offers, transfers and cancellations with previews, placement, session bookings, makeups, trials; 60 tests); finance (quotes, checkout with payment attempts kept `unknown` until reconciled, team obligations and contributions, installment plans, refunds, credits, cash tenders, settlement reconciliation; 58 tests). Not implemented: real test-provider payments (only the deterministic `FakePaymentProvider` exists; the processor is DEC-019); disputes and chargebacks; revenue recognition and the accounting export (DEC-022); refunds of cash tenders; automatic money movement on transfers and cancellations (finance computes the consequence, nothing executes it); splitting partial-fulfillment baskets at payment; youth development records and progression (SPK-YOUTH-005/006, DEC-003); list pagination beyond one page                  |
| E — Customer and daily operations (native apps) | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| F — Controlled live pilot                       | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| G — Full facility operation and differentiation | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
AUTH_LOCAL_SECRET=$(openssl rand -hex 32) pnpm --filter @sportspark/api dev
curl localhost:3000/v1/health
```

Run against a PostgreSQL server by setting `DATABASE_URL`; migrations apply with `pnpm db:migrate`.
Run the test suite against a PostgreSQL server (true concurrency) with `TEST_DATABASE_URL`.

## Working in this repository

Read [CLAUDE.md](CLAUDE.md) for the engineering conventions every change must follow and
[docs/architecture/overview.md](docs/architecture/overview.md) for how the pieces fit together.
