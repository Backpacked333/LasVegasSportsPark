# Engineering conventions

These rules apply to every change in this repository. The master specification
(`docs/spec/master-specification.md`) is the source of truth; cite the `SPK-*` requirement or `§`
section you implement in code comments, tests, and commit messages.

## Commands

```bash
pnpm install
pnpm verify          # format:check + lint + typecheck + test (what CI runs)
pnpm typecheck       # tsc -b (production build) + spec typecheck for every package
pnpm test            # vitest across all projects (PGlite in-process; TEST_DATABASE_URL for real Postgres)
pnpm --filter @sportspark/api exec vitest run src/modules/<module>   # one module's tests
pnpm lint && pnpm format
pnpm build && pnpm openapi   # regenerate docs/api/openapi.json
```

## Layout and ownership

- `apps/api/src/kernel/` — shared kernel: config, database access (`UnitOfWork`), auth guard,
  `AuthorizationService` + action registry, idempotency interceptor, error filter, `AuditWriter`,
  `Outbox`/`OutboxDispatcher`, `Inbox`, `OperationsService`, `OperationalExceptions`. Import from
  `../../kernel`.
- `apps/api/src/modules/<module>/` — one directory per domain module (spec §4.2). A module owns its
  tables and is the only writer of them. Other modules call its exported service (public API in
  `index.ts`); they never query or write its tables directly.
- `packages/db/migrations/NNNN_<module>_<name>.sql` — SQL migrations. Version ranges per module:
  core 0001–0099, identity 0100s, catalog 0200s, scheduling 0300s, competition 0400s,
  enrollment 0500s, finance 0600s, workforce 0700s, entry 0800s, facilities 0900s,
  communications 1000s, support 1100s, migration 1200s, reporting 1300s, automation 1400s.
  Applied migrations are immutable (checksum-verified); add a new file to change the schema.
- `packages/db/src/schema/<module>.ts` — Kysely table interfaces for the module (export one
  `<Module>Tables` interface); then run `node scripts/regenerate-registrations.mjs`, which rewrites
  `packages/db/src/schema/index.ts` and `packages/contracts/src/api/index.ts` from the files present
  (also the way to resolve merge conflicts in those two files).
- `packages/contracts/src/api/<module>.ts` — zod request/response schemas registered with the
  OpenAPI registry (picked up by the regeneration script above).
- Import `z` from `@sportspark/contracts`, never from `zod` directly (OpenAPI extension ordering).

## Data rules (spec §4.3, §4.4, §4.7)

- Every operational table has `organization_id uuid not null references organizations(id)`.
- References between org-scoped tables use composite foreign keys `(organization_id, <id>)` so a
  row can never point at another organization's record. Add `unique (organization_id, id)` to any
  table that will be referenced this way.
- Ids are application-generated UUID v7 (`newId()` from contracts). Never `serial`.
- Money: `bigint` minor units + `currency text` (SPK-PAY-001). Use the `Money` helpers.
- Time: `timestamptz`; facility-local behaviour derives from `facilities.timezone` (SPK-SCHED-008).
  Use the injected `Clock` (`@Inject(CLOCK)`), never `Date.now()` in services.
- Editable sensitive records carry `revision integer not null default 1`; updates use
  `where revision = expected` and bump it (STALE_REVISION on mismatch, §4.9).
- Lifecycles come from `packages/contracts/src/state-machines.ts` (§4.6). Database `check`
  constraints list the same states. Services call `Machine.next(from, event)`; never set a state
  the machine does not allow.
- Integrity that matters is enforced in the database: unique/partial-unique indexes for duplicate
  entitlements, GiST exclusion constraints on `tstzrange` for physical reservations, check
  constraints for balances. Application checks give earlier feedback but are not the guarantee.
- Append-only tables (journals, audit, observations) get the `forbid_mutation` trigger; corrections
  are new rows that reference what they correct.
- JSON columns: insert with `json(value)` from `@sportspark/db`.

## Command pattern (spec §4.9, §4.11)

Every consequential command, in order:

1. Validate input with a zod schema (`@ZodBody(Schema)`); accept `expectedRevision`, `reason`,
   `policyReferences` via `withCommandMeta`.
2. Mark the handler `@Idempotent()` (requires the `Idempotency-Key` header).
3. Inside `unitOfWork.run(async ({ trx }) => { ... })`: load records, call
   `authorization.require(principal, Actions.x, target)` with the real target (organization,
   facility, subject persons, team entry, `protected: true` for customer-private records), check
   the state machine and revision, write, `audit.record(...)`, `outbox.enqueue(...)` for every
   follow-up, and create/transition an `operation` for multi-step work.
4. Never call an external provider inside the transaction. Provider calls happen before/after,
   with the outcome recorded as a fact (payment attempt, delivery attempt) and `unknown` kept
   explicit until reconciled.

Actions are declared once with `defineActions({...})` in `<module>.actions.ts`:
`{ id: '<module>.<verb>', description, staffRoles, allowSelf?, subjectPermission?, teamRole?, requirements }`.
Domain events are declared with `defineEvent('<module>.<past_tense>', payloadSchema)` in
`<module>.events.ts`. Handlers subscribe through `EventHandlerRegistry.on(type, '<module>.<handler>', fn)`
in `onModuleInit`; a handler must be idempotent under replay and does all its writes through `ctx.trx`.

Errors: throw from `errors.*` (`@sportspark/contracts`). For a customer-private record the caller
may not see, throw `errors.protectedNotFound(...)` (never reveal existence, §4.10).

## Providers (spec §5.2)

Identity, payments, messaging, hosting, accounting, and hardware vendors are not selected. Code
against a port interface with a deterministic fake adapter (`Fake*Provider`) that supports success,
failure, timeout/unknown, and duplicate webhook scenarios. Do not add a vendor SDK or create accounts.

## Tests

- Unit tests next to the code (`*.spec.ts`); API tests in `__tests__/` using
  `createTestApp()` from `apps/api/src/testing` (fully migrated PGlite per file, local JWT tokens,
  `staffPrincipal` / `customerPrincipal` helpers, a `FixedClock` you advance explicitly).
- Every requirement you implement gets a test named after it; every integrity invariant gets a test
  that proves the database rejects the violation, not only the service.
- PGlite serializes transactions. Tests that need true concurrency must also pass under
  `TEST_DATABASE_URL` (CI runs the suite against PostgreSQL); write them so both modes pass.
- Deterministic only: no real time, no network, no randomness in assertions.

## Boundaries

- Do not add dependencies without saying so in your report (the lockfile is shared).
- Do not edit another module's directory, migrations, or schema file. Shared files you may touch
  are limited to the one-line registration points named above and your module's own files.
- Do not weaken a kernel guard, filter, or constraint to make a test pass.
- No model names, session links, or vendor choices in committed artifacts.
- Documentation must distinguish verified implementation, proposed behaviour, and pending decisions (§6.7).
