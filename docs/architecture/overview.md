# Architecture overview

Status legend: **verified** = implemented and tested here; **proposed** = design intent not yet
implemented; **pending** = waiting on an operator decision (see `docs/package-a/decision-register.md`).

## Shape (spec §4.1) — verified

A modular monolith in one repository:

- `apps/api` — NestJS application. One HTTP process (`main.ts`) and one or more worker processes
  (`worker.ts`) share the same modules; workers run the outbox dispatcher and inbox processor.
- `packages/contracts` — shared types and schemas used by the API today and by the native customer
  apps and staff dashboard later (Package E).
- `packages/db` — PostgreSQL schema as immutable SQL migrations, Kysely table types, two clients
  (node-postgres for servers, PGlite in-process for development and tests).

No microservices. Module ownership is explicit (§4.2); a module never writes another module's tables.

## Request lifecycle — verified

1. `correlationMiddleware` assigns `X-Correlation-Id` (honours a well-formed incoming header).
2. `AuthGuard` (global) verifies the bearer token through `IdentityProviderPort` and resolves the
   `Principal` through `PrincipalResolverPort`. Routes marked `@Public()` get the anonymous principal.
   The principal's organization comes from the resolver, never from the request (§4.8).
3. `IdempotencyInterceptor` (global) enforces `Idempotency-Key` on handlers marked `@Idempotent()`:
   same key + same canonical payload → stored response replayed with `Idempotent-Replayed: true`;
   same key + different payload → `IDEMPOTENCY_CONFLICT`; still running → `IDEMPOTENCY_IN_PROGRESS`.
   4xx domain outcomes are stored and replayed; unexpected failures release the key for retry.
4. Zod pipes validate body/query/params into typed values.
5. Services authorize through `AuthorizationService.require(principal, action, target)` using the
   action registry (`defineActions`) and the identity module's relationship authority. A denial on a
   protected record is returned as `NOT_FOUND` so record existence never leaks across households.
6. Writes happen inside `UnitOfWork.run` together with `AuditWriter.record` and `Outbox.enqueue`.
7. `DomainExceptionFilter` renders every error as `{ code, message, correlationId, nextAction, details? }` (§4.10).

## Durable work (spec §4.12) — verified

- `outbox_events` is written in the business transaction. `OutboxDispatcher` claims batches with
  `FOR UPDATE SKIP LOCKED` and a lock lease, runs each registered handler in its own transaction
  together with an `event_consumptions` row (one business effect per handler per event even when a
  delivery repeats), retries with exponential backoff, and dead-letters to an `operational_exceptions`
  row owned by `system_administrator` after `max_attempts`. An expired lease makes an event claimable
  again, which is how an interrupted worker is recovered (SPK-AT-023).
- `inbox_events` records provider webhooks idempotently on `(provider, provider_event_id)`; the
  same consumption rule applies to inbox handlers.
- `operations` exposes the readable outcome of multi-step commands (`GET /v1/operations/{id}`),
  visible to the requester and to staff of the organization.

## Identity and authorization — verified

The kernel ships a local HS256 JWT provider for development and tests that refuses to run in
production. The managed identity provider is a provider-selection gate (§5.2). The identity module
registers the principal resolver and relationship authority (`PRINCIPAL_RESOLVER_IMPL`,
`RELATIONSHIP_AUTHORITY_IMPL`): a verified `(issuer, subject)` maps to an active account, its
person and the staff memberships in effect at the clock; a relationship permission is exactly an
unrevoked, unsuspended, currently effective `access_grants` row on an active relationship (see
`apps/api/src/modules/identity/README.md`). The competition module registers team authority. Where
a registration is absent the kernel falls back to deny-all.

Two kernel limitations are worked around inside the identity module and documented in its README:
`*_IMPL` tokens must be `useValue` providers (Nest probes the kernel's lazy proxy during
instantiation), and the relationship-authority port is called without a transaction handle, so
identity commands run in an AsyncLocalStorage transaction context the port falls back to.

## Data conventions — verified

See `CLAUDE.md` (organization scope on every table, composite foreign keys, UUID v7 ids, bigint
minor units, timestamptz, revisions, state machines in contracts, database-enforced invariants,
append-only tables, immutable migrations).

## Testing strategy — verified, with one limitation

Tests run real PostgreSQL 18 in-process via PGlite (with `btree_gist`), fully migrated per test file.
PGlite serializes transactions, so tests prove correctness under serialized interleavings; the CI
job `test-postgres` runs the same suite against a PostgreSQL service with `TEST_DATABASE_URL` to
exercise true concurrency. Concurrency-critical invariants must be enforced by constraints so both
modes agree.

## Module map (spec §4.2)

| Module         | Depends on                                 | Registers with kernel                         |
| -------------- | ------------------------------------------ | --------------------------------------------- |
| identity       | —                                          | principal resolver, relationship authority    |
| catalog        | identity                                   | —                                             |
| scheduling     | — (facilities table in core)               | — (offers FIXTURE_OBLIGATION_IMPL hook)       |
| competition    | identity, scheduling                       | team authority                                |
| workforce      | identity, scheduling, competition          | —                                             |
| facilities     | scheduling                                 | outbox handlers (due timers, lifted closures) |
| communications | identity                                   | outbox handlers for notices                   |
| enrollment     | identity, catalog, competition, scheduling | —                                             |
| finance        | identity, catalog, enrollment              | inbox handlers for payment provider events    |
| entry          | identity, enrollment, scheduling           | —                                             |
| support        | identity (+ reads everything)              | —                                             |
| migration      | all                                        | —                                             |
| reporting      | all (read models)                          | —                                             |
| automation     | all (through commands)                     | —                                             |

Each module directory has a README naming its owned records and specification sections.

## Not in this repository (proposed / pending)

- Native customer apps (Expo) and the React staff dashboard — Package E.
- Provider adapters for real vendors — pending decisions (§5.2).
- The pre-existing local demonstration application — not migrated here; parity tests (§4.1) are
  pending until it is added.
