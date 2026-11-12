# Sportspark

Soccer and indoor-soccer facility operating platform: customers, families, teams, programs, fields,
staff, officials, money, communications, and daily operations on one set of authoritative records.

The product and engineering requirements live in **[docs/spec/master-specification.md](docs/spec/master-specification.md)**
(version 2.0). Everything in this repository traces back to a `SPK-*` requirement in that document.

## Status

Test counts are from 2026-11-05 on the integration branch (stage 8): `vitest run` (the root
`pnpm test`, first half) runs 3716 tests in 451 files, all passing on PGlite and on PostgreSQL
through `TEST_DATABASE_URL`; the customer app's jest suite (`pnpm test:mobile`, second half) runs
1243 tests in 91 suites, all passing. The per-module and per-app counts in the table below are the tests `vitest` runs in each area (counted with `vitest list --staticParse=false`, which expands `it.each` and tests declared in loops exactly as a run does; the static `vitest list` default counts each such declaration once) and, with the 57 tests of the 31 cross-module journeys, add up to the 3716. All fourteen domain modules under `apps/api/src/modules/` are
implemented as backend code (159 SQL migrations from 0001 to 1480; 304 registered actions, listed in
[docs/package-a/permission-matrix.generated.md](docs/package-a/permission-matrix.generated.md); 483
HTTP paths and 579 operations in [docs/api/openapi.json](docs/api/openapi.json)), and 31
cross-module journeys drive the assembled application through HTTP
(`apps/api/src/__tests__/journeys/`, see
[docs/architecture/overview.md](docs/architecture/overview.md) section 11). Status words follow
§6.7: **Verified** means implemented and asserted by a test in this repository; **Proposed** means an
engineering proposal awaiting an operator; **Pending decision** means the answer belongs to the
owner named in [docs/package-a/decision-register.md](docs/package-a/decision-register.md). Nothing
here has been accepted by an operator, and no package gate of §6.5 has been signed off.

| Package (spec §6.5)                             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Operating model and specification baseline  | In progress: see [docs/package-a](docs/package-a). The registers, matrices and journeys are drafts; every operator decision in the decision register is still **Pending decision**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B — Production foundation                       | **Verified**: organization-scoped model with composite organization foreign keys; checksum-verified versioned migrations; zod command contracts with idempotency keys, revisions and reasons; `AuthorizationService` with the action registry; audit and audit reads; transactional outbox and inbox with dead-lettering; durable operations, operational exceptions, periodic jobs and a worker entrypoint; not-found for protected records; record authority (§5.6); per-organization capability switches (DEC-016); the client-version gate (426 `CLIENT_UPDATE_REQUIRED`) and CORS for configured origins; module settings; identity (accounts, people, relationships and grants, households, invitations, claims, access reviews, merges). Tests: kernel 201, identity 196, contracts 30, db 13, other API 30. **Verified** since 2026-11-09: a vendor-neutral managed identity adapter (OpenID Connect key set, `kernel/auth/oidc-jwks.identity-provider.ts`) admitted only under a recorded decision, a production boot with every provider gate set explicitly (`__tests__/production-boot.spec.ts`), JSON logs, readiness against the schema, signal metrics, rate limits, security headers, migration locking and status, and backup with verified restore (rehearsed on PostgreSQL 16). **Pending decision**: which identity provider (DEC-018), hosting, backups and the recovery environment (DEC-021); a restore on the production provider is not rehearsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| C — Soccer scheduling and competition           | **Verified**: scheduling (resources and conflict units, a database exclusion constraint, closures with withdrawal and lift guards, schedule drafts, series, imports; 117 tests); competition (seasons, divisions, rule sets, team entries, rosters, fixtures and generation, results with reviewed corrections, standings, brackets seeded from division or pool standings, shootout winners, discipline, disputes, appeals, match readiness, availability requests; 231 tests); workforce (requirements, assignments, replacements, qualifications, fees, booking staffing; 133 tests); facilities (restrictions through scheduling, maintenance, preventive schedules, the asset directory; 71 tests). Since 2026-11-09 **Verified**: a single-elimination bracket generated from a division's playoff structure, and fixture generation that never places a pitch and its half at overlapping times. Not implemented: an exact fixture solver (the generator is a greedy search). **Pending decision**: DEC-002, DEC-010, DEC-011, DEC-049, DEC-065 (the values in code are engineering placeholders)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D — Registration and money                      | **Verified**: catalog (programs, offerings, publication checks, policies, price rules, discounts with database per-person limits, acknowledgments; 127 tests); enrollment (applications, family baskets, capacity holds, waitlists and offers, transfers and cancellations with previews, placement, session bookings, makeups, trials, youth progression behind `youth_progression`; 232 tests); finance (quotes, checkout with outcomes kept `unknown` until reconciled, obligations and contributions, installments and booking deposits from approved terms, refunds, credits, cash tenders, reconciliation, money reads; 227 tests); communications (notices, audiences, preferences, inbox, delivery attempts; 152 tests). Behind the deterministic `FakePaymentProvider` and `FakeMessagingProvider` only. Not implemented: disputes and chargebacks, revenue recognition, refunds of cash tenders, automatic money movement on transfers and cancellations. **Pending decision**: DEC-006 to DEC-009, DEC-019, DEC-020, DEC-022                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| E — Customer and daily operations (native apps) | In progress, client side: the customer app (`apps/mobile`, Expo; SCR-C-01 to SCR-C-40) and the staff dashboard with the coach and referee workspace (`apps/staff`, React; SCR-S-01 to SCR-S-57, SCR-W-01 to SCR-W-10) on the typed API client (`packages/api-client`, regenerated from the OpenAPI document); entry (arrivals, check-ins, supervised release, offline sync; 142 tests) and support (cases, timelines, Today; 95 tests) serve them. Stage 4 moved both clients onto the stage-3 API (customer lists and previews, revisions, facility time zones, `GET /v1/me/permissions` and the capability switches): of the 40 customer screens 13 are implemented and tested and 27 partial; of the 67 staff and workspace screens 21 are implemented and tested, 45 partial and 1 shown as a pending decision (SCR-W-06 workspace messaging); partial means the part a named pending decision or remaining API gap blocks is shown as pending or not available. **Verified** only by automated tests (jest 1243 mobile tests; vitest 1370 staff and api-client tests: 1291 staff, 79 api-client) and the release bundle checks (Expo iOS export, staff production build). Per-screen status is in [apps/mobile/README.md](apps/mobile/README.md) and [apps/staff/README.md](apps/staff/README.md). **Pending decision**, shown as such in the screens: managed sign-in, verification and self-service recovery (DEC-018), in-app and desk card payment (DEC-019), messaging-delivered invitation tokens and push (DEC-020, DEC-061), adding a child and other adults' grants (DEC-004, DEC-089), supervised pickup (DEC-075, DEC-005), account deletion and data requests (DEC-059), channels (DEC-062), arrival guidance (POL-046), the stale-data threshold (DEC-032, DEC-033). **Pending**: native acceptance on signed builds and devices (§6.2) and staff acceptance on the actual workstations, tablets and scanners (§6.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| F — Controlled live pilot                       | Not started. The mechanisms a pilot needs exist and are **Verified** in process (migration imports with stable identities and the authority matrix, 88 tests; reporting with agreed cost inputs, 115 tests; the recovery gate, journey SPK-AT-028), but no pilot has run: **Pending decision** on the pilot scope (DEC-046), the legacy authority transfer (DEC-014), every provider (DEC-018 to DEC-023) and the restoration rehearsal (DEC-021)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| G — Full facility operation and differentiation | **Verified** behind per-organization capability switches that start off and change only by a system administrator naming DEC-016 or the capability's own record (audited): memberships (DEC-072), session packages (DEC-074), rentals (DEC-076), parties (DEC-077), tournaments (DEC-078), point of sale (DEC-079), access hardware (DEC-080, `FakeAccessControlProvider`), accounting export (DEC-081, `FakeAccountingProvider`), pickup sessions (DEC-082), youth progression and the assistant (DEC-016; automation 89 tests, `FakeAssistantProvider`). Cross-module journeys drive each one on the assembled application (pickup sessions in `capabilities-03-waitlist-gates`), and most show the refusal while the switch is off; four journeys switch a capability off again and prove that new commitments stop while what already exists continues: memberships (`capability-switches`: no new line and no checkout of a line held before the switch, while reads, the held basket's release, a refund, a cancellation, expiry at term end and a provider outcome for a payment started before the switch continue), pickup sessions (`capabilities-03-waitlist-gates`: waitlist join, staff offer and offer acceptance stop while a cancellation and the reads continue; the refusal of a direct pickup booking is asserted only by the module test `package-g-foundation.spec.ts`), tournaments (`tournaments`: standings still seed the final after the switch goes off) and the assistant (`spk-auto-005-assistant`: approvals stop, core work continues). For rentals, session packages, point of sale, access hardware, accounting export and youth progression the switch-off cases are asserted by module tests only, and parties has no switch-off test beyond its default-off refusal ([docs/architecture/overview.md](docs/architecture/overview.md) section 11). **Pending decision**: DEC-016 and each capability's own record; no capability is enabled for any real organization, and every rate, price, term and deposit plan is configuration with no default. Clients (stage 4, **Verified** by jest and jsdom only): the staff screens SCR-S-51 to SCR-S-57 (rentals, parties, memberships, session packages, point of sale, access hardware, accounting export batches) and the customer flows (rental and party bookings, memberships and renewal, session packages and booking with them, point-of-sale receipts, pickup sessions, youth feedback) are built behind `CapabilityGate`: while a switch is off they say "turned off" naming DEC-016 and the capability's record, keep what already exists readable and keep never-gated commands (cancellations, reversals, retirements) offered, and a CAPABILITY_DISABLED answer shows the same state. Card tenders, access devices and accounting connections reach only the fakes (DEC-019, DEC-023, DEC-022) |

## Production readiness

The path from verified code to a controlled pilot is in
[docs/deploy/production-readiness-checklist.md](docs/deploy/production-readiness-checklist.md)
(the twelve §6.8 items with today's evidence), [docs/deploy/production.md](docs/deploy/production.md)
(topology, environment, release, observability, backups) and
[docs/package-a/launch-decision-packet.md](docs/package-a/launch-decision-packet.md) (the decisions
the pilot waits on, their owners and where each answer takes effect). The protected staging
environment is in [docs/deploy/staging.md](docs/deploy/staging.md).

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

### Follow-ups need the worker

The API process serves requests and finishes in the request what the request itself settles. A
checkout whose payment succeeds at once (the fake provider's `pm_fake_visa`, "Succeeds at once" in
the customer app's development payment picker) is finalized inline: the response is `completed`
and the enrollments are confirmed (`apps/api/src/modules/finance/services/checkout.service.ts`;
`modules/finance/__tests__/checkout.spec.ts`). A refund the provider settles at once is recorded in
the request as well, and a pending invitation past its expiry reads as expired and is recorded as
expired when someone accepts or declines it.

What follows a commit runs only in the separate worker process (`apps/api/src/worker.ts`, started
with `pnpm --filter @sportspark/api start:worker` after a build; `main.ts` starts none of it):

- the outbox dispatcher: every notice, the cross-module reactions to events (for example the
  membership start and package issue that follow `enrollment.enrollment_confirmed`), hold and
  checkout expiry, and `finance.finalize_checkout`, the durable backstop that finalizes a checkout
  the request did not finish;
- the provider inbox, which applies payment webhooks: the outcome of a payment that is processing
  or needs a customer action arrives that way (or through `POST /v1/payments/{id}/reconcile`, a
  provider lookup in the request), and the checkout it pays is then finalized by
  `finance.finalize_checkout` in the outbox, so without the worker it stays unfinalized;
- the finance provider worker: refunds left requested, abandoned payment challenges, the provider
  lookup of payments and refunds whose outcome is unknown (a timeout), and installment collection;
- the periodic jobs (the invitation and claim sweep, package expiry and the others listed in
  [docs/architecture/overview.md](docs/architecture/overview.md) section 7.1);
- message delivery (`communications.delivery_worker`).

The fake payment provider keeps its charges in the memory of the process that made them
(`FakePaymentProvider`), so a worker's provider lookup finds nothing the API process charged; with
the fake provider, delayed payment outcomes are exercised by the tests, which run the API, the
inbox and the provider worker in one process.

The in-process PGlite database cannot be shared by two processes. Without `PGLITE_DATA_DIR` each
process has its own in-memory database, so a worker started next to a PGlite API works on a
different, empty database. With `PGLITE_DATA_DIR`, a second process (the worker, a `seed:dev` run,
another API) that tries to open a directory one process holds is refused at startup naming the
holder (**Verified**: `createPgliteDatabase` takes a lock file, `packages/db/src/client.spec.ts`;
a lock left by a process that no longer runs is taken over). PGlite itself takes no lock: verified
2026-11-01 with `@electric-sql/pglite` 0.5.11, a second process opened a held directory and its
committed rows were lost when both closed, which is why the lock exists.

To exercise follow-ups on one machine with PGlite, run the API and the worker's loops in one
process (**Verified**: `apps/api/src/dev-all.ts`, loops in `kernel/workers/inline-worker.ts`,
`kernel/__tests__/inline-worker.spec.ts`):

```bash
export NODE_ENV=development AUTH_LOCAL_SECRET=$(openssl rand -hex 32) PGLITE_DATA_DIR=.pglite
pnpm dev:all -- --seed      # migrates, creates the development seed, serves :3000 with the worker loops
```

`--seed` takes `--timezone <IANA zone>` for the seeded facility (default UTC) and `--demo` for the
demo dataset described under "Local sign-in" below.

To run them as separate processes, as production does, use one PostgreSQL database:

```bash
export NODE_ENV=development AUTH_LOCAL_SECRET=$(openssl rand -hex 32) \
  DATABASE_URL=postgres://<user>:<password>@localhost:5432/<database>
pnpm --filter @sportspark/api dev            # builds dist/, migrates (development) and serves :3000
pnpm --filter @sportspark/api start:worker   # second shell, same environment
```

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
`AUTH_LOCAL_SECRET` and `PGLITE_DATA_DIR` (or `DATABASE_URL`) for the seed and the API. With
`PGLITE_DATA_DIR`, run the seed before the API starts, never while it runs, and never start a
worker on the same directory (previous section); use `DATABASE_URL` for the seed, the API and the
worker when follow-ups matter.

#### Demo dataset (`--demo`)

The seed alone leaves every screen empty. `--demo` adds a demo dataset on top of it, so the staff
dashboard and the customer app have records to show (**Verified**:
`apps/api/src/dev/seed-demo.ts` with its stages in `apps/api/src/dev/demo/`, asserted by
`apps/api/src/dev/__tests__/seed-demo.spec.ts`; run by hand against PGlite with `seed:dev` and
`dev:all` on 2026-11-09 and 2026-11-10). **Every name, price, rule, capacity, policy wording and time in it is an
invented example, not operator policy (specification §1.4)**; the names say so ("Demo United",
"Alex Example (demo captain)", "Demo Junior Skills (synthetic)"), and so does the seed's output.

```bash
pnpm --filter @sportspark/api seed:dev -- --timezone America/Los_Angeles --demo   # the seed, then the demo dataset
pnpm dev:all -- --seed --demo --timezone America/Los_Angeles                      # or: seed, demo dataset and :3000 with the worker loops
```

The same rules as the seed apply: it refuses unless `NODE_ENV` is `development` or `test` and
`AUTH_MODE=local`, and it enables no capability. It is created through the API's own commands: the
seed boots the assembled application and sends the HTTP requests a client would send, signed in as
the seeded accounts, so each module writes its own tables and every command is authorized, audited
and followed up as usual (§4.2, §4.9); it then runs the outbox and the delivery worker until they
are idle, so enrollments are confirmed and notices delivered before it returns (§4.12). The only
record the seed writes itself is a kernel operation of kind `dev.seed_demo`.

What it contains, anchored to the day it runs in the facility's time zone (SPK-SCHED-008):

- Facility: two pitches with two halves each, an indoor boarded court and a room; opening hours;
  one maintenance restriction on a half, three days ahead.
- League: one competition with its own rule-set version, a season in progress, one division, six
  teams with captains and five-player rosters, and 30 fixtures on the indoor court: four weekly
  rounds played with official results (so standings are populated), three games today, five
  rounds to come. `dev-parent` is captain of Demo United.
- Youth: one program with a published term, 20 sessions (one today, more this week), ten seats
  all taken by the children of four families, and one child on the waitlist. `dev-parent` is
  guardian of two enrolled children.
- Money: prices from catalog price rules on the term and on the league's player registration;
  five checkouts completed through `FakePaymentProvider` (four families, and one adult who joined
  Demo United through the league's registration); six team fees, five paid and the fee of
  `dev-parent`'s team outstanding.
- Operations: seven arrivals and five check-ins to today's session; two open support cases (one
  opened by `dev-parent` from the app); one staff notice delivered to the families' inboxes;
  coaches and officials for the next session and games (two accepted, two offered, one game
  without an official).
- Accounts: the six seeded accounts keep their roles. None of them may approve a cancellation
  policy (finance) or a maintenance restriction (facilities), so the demo adds `demo-finance` and
  `demo-facilities`, and with them `demo-program` (the program manager responsible for the
  offerings), `demo-manager`, `demo-support`, `demo-coach-2`, `demo-official-2` and
  `demo-official-3`, plus ten customer accounts (five team captains, four parents, one player);
  the seed prints their account ids for `POST /v1/dev/tokens`. On the seeded people it records a
  synthetic email address each and a date of birth for `dev-parent` and the seeded child
  (eligibility is evaluated from it).

A second run on the same database changes nothing and says which day the dataset is anchored on:
"today's" games, session and arrivals keep that date, so for a dataset anchored on today start
from an empty development database. A run that stopped part-way is not resumed: the next run
refuses and names the failed operation. Not in the dataset: fixtures from the fixture generator
(the schedule is created fixture by fixture so that it reaches from past weeks to today),
attendance marks, refunds, and anything behind a Package G capability switch.

## Working in this repository

Read [CLAUDE.md](CLAUDE.md) for the engineering conventions every change must follow and
[docs/architecture/overview.md](docs/architecture/overview.md) for how the pieces fit together.
