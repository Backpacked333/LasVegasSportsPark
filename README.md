# Sportspark

Soccer and indoor-soccer facility operating platform: customers, families, teams, programs, fields,
staff, officials, money, communications, and daily operations on one set of authoritative records.

The product and engineering requirements live in **[docs/spec/master-specification.md](docs/spec/master-specification.md)**
(version 2.0). Everything in this repository traces back to a `SPK-*` requirement in that document.

## Status

Test counts are from 2026-10-29 on the integration branch: `vitest run` (the root `pnpm test`,
first half) runs 2433 tests in 366 files, all passing on PGlite and on PostgreSQL through
`TEST_DATABASE_URL`; the customer app's jest suite (`pnpm test:mobile`, second half) runs 588 tests
in 60 suites, all passing. All fourteen domain modules under `apps/api/src/modules/` are
implemented as backend code (105 SQL migrations from 0001 to 1480; 301 registered actions, listed in
[docs/package-a/permission-matrix.generated.md](docs/package-a/permission-matrix.generated.md); 480
HTTP paths and 575 operations in [docs/api/openapi.json](docs/api/openapi.json)), and 30
cross-module journeys drive the assembled application through HTTP
(`apps/api/src/__tests__/journeys/`, see
[docs/architecture/overview.md](docs/architecture/overview.md) section 11). Status words follow
§6.7: **Verified** means implemented and asserted by a test in this repository; **Proposed** means an
engineering proposal awaiting an operator; **Pending decision** means the answer belongs to the
owner named in [docs/package-a/decision-register.md](docs/package-a/decision-register.md). Nothing
here has been accepted by an operator, and no package gate of §6.5 has been signed off.

| Package (spec §6.5)                             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Operating model and specification baseline  | In progress: see [docs/package-a](docs/package-a). The registers, matrices and journeys are drafts; every operator decision in the decision register is still **Pending decision**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B — Production foundation                       | **Verified**: organization-scoped model with composite organization foreign keys; checksum-verified versioned migrations; zod command contracts with idempotency keys, revisions and reasons; `AuthorizationService` with the action registry; audit and audit reads; transactional outbox and inbox with dead-lettering; durable operations, operational exceptions, periodic jobs and a worker entrypoint; not-found for protected records; record authority (§5.6); per-organization capability switches (DEC-016); the client-version gate (426 `CLIENT_UPDATE_REQUIRED`) and CORS for configured origins; module settings; identity (accounts, people, relationships and grants, households, invitations, claims, access reviews, merges). Tests: kernel 148, identity 163, contracts 27, db 13, other API 19. **Pending decision**: the managed identity provider (DEC-018; only the local JWT provider exists, refused in production), hosting, backups and the recovery environment (DEC-021); recovery is tested in process only |
| C — Soccer scheduling and competition           | **Verified**: scheduling (resources and conflict units, a database exclusion constraint, closures with withdrawal and lift guards, schedule drafts, series, imports; 98 tests); competition (seasons, divisions, rule sets, team entries, rosters, fixtures and generation, results with reviewed corrections, standings, brackets seeded from division or pool standings, shootout winners, discipline, disputes, appeals, match readiness, availability requests; 176 tests); workforce (requirements, assignments, replacements, qualifications, fees, booking staffing; 91 tests); facilities (restrictions through scheduling, maintenance, preventive schedules, the asset directory; 51 tests). Not implemented: a bracket generator from the playoff structure; an exact fixture solver (the generator is a greedy search). **Pending decision**: DEC-002, DEC-010, DEC-011, DEC-049, DEC-065 (the values in code are engineering placeholders)                                                                                   |
| D — Registration and money                      | **Verified**: catalog (programs, offerings, publication checks, policies, price rules, discounts with database per-person limits, acknowledgments; 107 tests); enrollment (applications, family baskets, capacity holds, waitlists and offers, transfers and cancellations with previews, placement, session bookings, makeups, trials, youth progression behind `youth_progression`; 152 tests); finance (quotes, checkout with outcomes kept `unknown` until reconciled, obligations and contributions, installments and booking deposits from approved terms, refunds, credits, cash tenders, reconciliation, money reads; 152 tests); communications (notices, audiences, preferences, inbox, delivery attempts; 117 tests). Behind the deterministic `FakePaymentProvider` and `FakeMessagingProvider` only. Not implemented: disputes and chargebacks, revenue recognition, refunds of cash tenders, automatic money movement on transfers and cancellations. **Pending decision**: DEC-006 to DEC-009, DEC-019, DEC-020, DEC-022   |
| E — Customer and daily operations (native apps) | In progress, client side: the customer app (`apps/mobile`, Expo; SCR-C-01 to SCR-C-40) and the staff dashboard with the coach and referee workspace (`apps/staff`, React; SCR-S-01 to SCR-S-57, SCR-W-01 to SCR-W-10) on the typed API client (`packages/api-client`, regenerated from the OpenAPI document); entry (arrivals, check-ins, supervised release, offline sync; 117 tests) and support (cases, timelines, Today; 76 tests) serve them. **Verified** only by automated tests (jest 588 mobile tests; vitest 569 staff and 47 api-client tests) and the release bundle checks (Expo iOS export, staff production build). Per-screen status is in [apps/mobile/README.md](apps/mobile/README.md) and [apps/staff/README.md](apps/staff/README.md). **Pending**: native acceptance on signed builds and devices (§6.2) and staff acceptance on the actual workstations, tablets and scanners (§6.3)                                                                                                                               |
| F — Controlled live pilot                       | Not started. The mechanisms a pilot needs exist and are **Verified** in process (migration imports with stable identities and the authority matrix, 78 tests; reporting with agreed cost inputs, 99 tests; the recovery gate, journey SPK-AT-028), but no pilot has run: **Pending decision** on the pilot scope (DEC-046), the legacy authority transfer (DEC-014), every provider (DEC-018 to DEC-023) and the restoration rehearsal (DEC-021)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| G — Full facility operation and differentiation | **Verified** behind per-organization capability switches that start off and change only by a system administrator naming DEC-016 or the capability's own record (audited): memberships (DEC-072), session packages (DEC-074), rentals (DEC-076), parties (DEC-077), tournaments (DEC-078), point of sale (DEC-079), access hardware (DEC-080, `FakeAccessControlProvider`), accounting export (DEC-081, `FakeAccountingProvider`), pickup sessions (DEC-082), youth progression and the assistant (DEC-016; automation 78 tests, `FakeAssistantProvider`). Cross-module journeys prove each one on the assembled application, including that switching it off stops new commitments while reads, cancellations, refunds, expiry and provider outcomes continue. **Pending decision**: DEC-016 and each capability's own record; no capability is enabled for any real organization, and every rate, price, term and deposit plan is configuration with no default                                                                         |

## Layout

```
apps/api            NestJS modular monolith (HTTP API) and durable worker entrypoint
apps/mobile         Customer app (Expo, iOS and Android)
apps/staff          Staff dashboard and coach and referee workspace (React)
packages/api-client Typed API client generated from docs/api/openapi.json
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

### Local sign-in (development seed)

`seed:dev` creates synthetic data to sign in with (K-14; the real organization, facilities and
accounts are pending DEC-001 and DEC-018). It refuses unless `NODE_ENV` is `development` or `test`
and `AUTH_MODE=local`, and it is idempotent: a second run finds the same records.

```bash
export NODE_ENV=development AUTH_LOCAL_SECRET=$(openssl rand -hex 32) PGLITE_DATA_DIR=.pglite
pnpm --filter @sportspark/api seed:dev -- --timezone America/Los_Angeles   # add --enable <capability> to switch one on
pnpm --filter @sportspark/api dev
curl -X POST localhost:3000/v1/dev/tokens -H 'Content-Type: application/json' \
  -d '{"accountId":"<an accountId printed by the seed>"}'
```

It creates the organization `dev`, the facility `dev-facility` (time zone `--timezone`, default
UTC) and six local accounts: `dev-admin` (system administrator), `dev-desk` (front desk),
`dev-league` (league manager), `dev-coach` (coach), `dev-official` (official) and `dev-parent`
(a guardian holding the six permissions over a child). No capability is enabled unless named with
`--enable`, which records the change with DEC-016 and the reason `local development`. Keep the same
`AUTH_LOCAL_SECRET` and `PGLITE_DATA_DIR` (or `DATABASE_URL`) for the seed and the API.

## Working in this repository

Read [CLAUDE.md](CLAUDE.md) for the engineering conventions every change must follow and
[docs/architecture/overview.md](docs/architecture/overview.md) for how the pieces fit together.
