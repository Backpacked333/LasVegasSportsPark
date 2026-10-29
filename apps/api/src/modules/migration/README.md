# migration module

**Owns:** import batches, staged import rows and their outcomes, external mappings, import
exceptions (review queues), the authority matrix (authority assignments), reconciliation reports
with their discrepancies and per-area approvals

**Specification:** §5.3 (inventory), §5.4 (import behaviour), §5.5 (reconciliation), §5.6 (one
authority during transition), §5.7 and §5.8 (the authority transfer and recovery mechanisms they
rely on), §4.4 Migration (ExternalMapping, ImportBatch, ImportException, AuthorityAssignment),
§4.7 invariants 5, 9 and 11, SPK-AT-024

**Migration range:** `packages/db/migrations/1200_migration_*.sql` … `1299` (this module uses
`1200_migration_core.sql`)

**Depends on:** identity (`PeopleService`, `HouseholdsService`, `RelationshipsService`,
`AUTHORITY_LOOKUP_PORT`), catalog (`ProgramsService`), finance (`ObligationsService`,
`CreditsService`). It creates imported records only through those exported services, with the
import system principal (`migration.import:<batchId>`) and an import reason; it never writes
another module's tables (§4.2). Mappings reference the internal records through composite
`(organization_id, id)` foreign keys, read-only.

**Status: implemented** — verified by `apps/api/src/modules/migration/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs `staging/staging.spec.ts` and
`migration.machines.spec.ts`. Statements below are verified unless marked proposed or pending.

## Neutral staging contract (`staging-v1`) — proposed format

No legacy system or export has been supplied to this repository (§1.4), so the source's format is
unknown. The module therefore defines a neutral contract that an operator's extraction step
produces from whatever the source exports (`packages/contracts/src/api/migration.ts`):

- a row is `(entityType, externalId, payload)`; `entityType` is one §5.3 inventory line
  (`person`, `household`, `relationship_evidence`, `account`, `program`, `season`, `team`,
  `roster`, `future_schedule`, `attendance_history`, `result`, `order`, `open_obligation`,
  `credit`, `refund`, `document`, `communication_preference`); `externalId` is the source's own
  stable identifier — never a name or an email (§5.3); references between staged records use
  external ids;
- payload fields per entity type are the `*ImportPayloadSchema`s (validated at `validate`, so a
  bad row becomes a reviewable validation exception, not a refused snapshot);
- rows arrive as JSON or as CSV (one document per entity type: header row of payload field names
  plus `external_id`, RFC 4180 quoting, `;`-separated lists, empty cells absent, integer minor
  units, `true`/`false`); large snapshots are staged in chunks (`POST /import-batches/{id}/rows`);
- the batch checksum is SHA-256 over the sorted lines `entityType \t externalId \t payloadHash`
  (payload hash = SHA-256 of canonical JSON), independent of row order and chunking
  (`staging/checksum.ts`); a declared checksum and row count are verified when validation seals
  the batch;
- control totals: counts per entity type and amounts per (entity type, currency) as the source
  reports them.

The contract is a proposal: once the actual export is known, a transformation step maps it to
these rows (or the contract is extended). Pending decision: migration scope and writer authority
(§6.6, owner Migration owner/operator).

## Tables (migration `1200_migration_core.sql`)

| Table                          | Purpose                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_batches`               | Source system, snapshot taken at, received at, declared and computed checksum, declared row count, transformation version, extraction provenance, control totals, status `received/validated/reviewed/applied/aborted`, planned and final counts by outcome, validation summary, every actor, apply lock |
| `import_rows`                  | One per (batch, entity type, external id); payload and payload hash (immutable); planned outcome and reasons (validation); final outcome `created/matched/updated/skipped/exception`, mapping and applied time (final)                                                                                   |
| `external_mappings`            | Key (source system, entity type, external id); `pending` (reserved) → `linked` to exactly one typed internal record (person, household, relationship, program, obligation, credit); first and last seen batch; extraction provenance; applied payload hash                                               |
| `import_exceptions`            | One per (row, kind): `ambiguous_relationship/ambiguous_balance/conflict/validation`, phase, reasons, review owner role, `open/decided/withdrawn`, decision `accept/reject/defer` with reason, resolution and actor                                                                                       |
| `authority_assignments`        | Record category (the 17 inventory lines), scope (organization, facility, program, competition), authoritative system `legacy/sportspark`, effective period, reason, policy references, approver, superseded assignment, end                                                                              |
| `reconciliation_reports`       | Per applied batch: status `balanced/discrepancy`, the four level summaries, discrepancy count, required approval areas, approval status `pending/approved/rejected/superseded`                                                                                                                           |
| `reconciliation_discrepancies` | One row per discrepancy: level, area, entity type, code, external/internal id, expected, actual, currency, money or count difference — append-only                                                                                                                                                       |
| `reconciliation_approvals`     | One decision per (report, area): approved/rejected, approver person and role, reason, discrepancies acknowledged — append-only                                                                                                                                                                           |

Every table carries `organization_id`; references use composite `(organization_id, …)` keys;
editable records carry `revision` and `touch_updated_at`; no table allows DELETE.

### Database guarantees (tests in `__tests__/migration-schema.spec.ts`)

- **§4.7 invariant 11 (one authority):** exclusion constraint
  `authority_assignments_one_authority` — one assignment per (organization, category, scope kind,
  scope) at any instant, whichever system it names; adjacent periods hand over at one instant;
  schedule authority can only be organization- or facility-scoped (§5.6 shared pitches); an
  assignment can only be shortened, never moved, widened, re-pointed or deleted (§4.7 invariant 9).
- **One apply per source system:** partial unique index on the apply lock.
- **§5.3 stable identity:** unique (source system, entity type, external id); a linked mapping
  never changes its target; the target column matches the entity type; composite foreign keys
  forbid a mapping to another organization's record.
- **§5.4 retention:** staged rows are unique per batch and immutable; a row outcome is final and a
  created/matched/updated outcome always names its mapping; the batch machine (guard trigger),
  sealed checksum and rows; abort or re-validation after an apply started is refused (§5.8).
- **Review decisions:** one exception per (row, kind); only ambiguity can be accepted; a decision
  is final.
- **§5.5 no netting:** a money discrepancy always carries its currency; discrepancies and
  approvals are append-only; one decision per area; approving an area with discrepancies needs a
  reason; one pending report per batch; report evidence is immutable.

## Behaviour

- **Staging (verified):** `POST /import-batches` records the snapshot as received (JSON or CSV
  rows, control totals, provenance, declared checksum and row count); a snapshot that lists one
  external record twice is refused; `POST /import-batches/{id}/rows` appends chunks while received.
- **Validation (dry run, verified):** seals the batch (computed checksum must equal the declared
  one; declared row count must match), plans every row with the same rules the apply uses, stores
  planned outcomes and reasons, opens review exceptions, withdraws exceptions whose cause is gone,
  compares control totals without netting, and raises one owned operational exception
  (`migration.import_review`, queue `migration`) while rows await review.
- **Review queues (§5.4, verified):** ambiguous relationships (evidence basis other than
  `documented`, the `collect` permission, guardianship of an adult, conflicting evidence for the
  same two people, changed evidence) → `support_operator`; ambiguous balances (negative, disputed,
  original − paid ≠ remaining, expired credit, changed opening balance, refund still in flight) →
  `finance_operator`; conflicts and validation errors → `system_administrator`; the general
  manager may decide any. Accept may narrow staged permissions or state the amount finance
  approved, never widen; validation errors and conflicts can only be rejected or deferred. The
  review completes when no exception is open.
- **Apply (§5.4, SPK-AT-024, verified):** idempotent per external id — a mapped, unchanged record
  is `matched`; a changed one is `updated` through the owning module while the legacy system is
  authoritative, never rewritten once SportsPark is (conflict); history categories (orders,
  settled refunds, attendance, results, documents, accounts) are `skipped` with their reason and
  retained as staged history; operational categories with no import command in their owning module
  (seasons, teams, rosters, future schedules, communication preferences) are `skipped` and reported
  by reconciliation. Opening obligations and credits go through finance's obligation and credit
  commands: no payment attempt, no receipt, no notice (§5.4). Re-importing the same snapshot
  creates nothing, charges nothing and sends nothing (counts, payment attempts, notifications and
  outbox events asserted in `reimport.spec.ts`). The apply is a durable operation
  (`migration.apply_batch`, `GET /v1/operations/{id}`), takes a per-source lock with a lease
  (default 15 minutes, renewed per row), and resumes after an interruption: a creation that
  committed before its mapping was linked is found through the owning module's audit record of
  the mapping's correlation id (`migration:<mappingId>`), never created twice
  (`apply-recovery.spec.ts`). A row the owning module refuses becomes an apply-phase exception.
  Every reservation and every outcome is fenced by the lock: an apply whose lock another apply
  took over (after the lease ran out while it stalled) stops before it reserves anything new, and
  a mapping changed under it is refused (`MAPPING_CHANGED`). A creation already in flight cannot
  be fenced, so the database keys what it can: an opening credit carries its mapping id as its
  source (finance's `credits_source_idx`, as obligations already do), so a second credit for one
  imported balance is refused; a person or household the stale apply created anyway raises an
  owned `migration.orphaned_creation` exception and is reported by reconciliation
  (`unlinked_creation`) — verified on PGlite and PostgreSQL (support-migration-05).
- **Authority matrix (§5.6, verified):** assignments per category and scope; a transfer names the
  assignment in effect and its revision, ends it and starts the next one at the same instant;
  never retroactive. Without an assignment SportsPark is authoritative; importing a category needs
  legacy authority in effect (otherwise every row is a `sportspark_authoritative` conflict).
- **AuthorityGuard (§5.6, verified):** `AUTHORITY_GUARD_PORT` (`resolve`,
  `assertSportsparkAuthority`) for in-process callers, and a global interceptor
  (`AuthorityWriteInterceptor`, registered by this module) that refuses the HTTP write commands
  of a category while the legacy system is authoritative (`ACCESS_DENIED`,
  `nextAction: write_in_authoritative_system`, `details.code: LEGACY_AUTHORITY`). The guard is
  deny-by-default: every served POST/PATCH/PUT/DELETE route is classified exactly once in
  `services/authority-routes.ts`, either guarded (`AUTHORITY_ROUTES`, with its category and scope
  source) or exempt with the reason it changes no record of an authority category
  (`AUTHORITY_EXEMPT_ROUTES`); `__tests__/authority.spec.ts` fails on an unclassified or unserved
  route. The scope is never taken from identifiers a client adds to the body (§4.8): a route
  creating a top-level record resolves at organization scope; a route names the validated field
  its handler writes to (`POST /schedule-drafts`, `/event-series`, `/closures`,
  `/maintenance-restrictions` → `facilityId`; `POST /fixtures` → `schedule.facilityId`;
  `POST /seasons` → `competitionId`; `POST /offerings` → `programId`, `facilityId`;
  `PATCH /programs/{id}`, `/competitions/{id}` → the path id); every other route is `unproven`
  and is refused while any assignment of its category in effect, at any scope, names the legacy
  system (`details.scopeResolution: unproven`). Where a scope is known the most specific scope
  wins (program/competition, facility, organization); two answers at one specificity refuse
  writes. Youth enrollment routes are guarded as `program` (participation follows its offering,
  authority matrix §4.1, a proposed reading pending DEC-014); makeup entitlements as `credit`
  (row 14).
- **Refunds in-process (§5.6, verified):** `RefundsService.request` (finance) checks the record
  authority itself through finance's `RECORD_AUTHORITY_PORT`, which this module implements
  (`RECORD_AUTHORITY_IMPL`), so support's refund helper and automation's refund proposal are
  refused exactly like `POST /payments/{id}/refunds` (`__tests__/record-authority.spec.ts`;
  the automation proposal in `automation/__tests__/record-authority.spec.ts`).
- **Reconciliation (§5.5, verified):** four levels — control totals (declared against staged, and
  declared opening-balance amounts against what finance holds after the apply:
  `loaded_total_mismatch`); record identity (every row has an outcome, every mapping reaches an
  existing record; a row rejected in review is `rejected_in_review` with its source amount; a
  creation no mapping links is `unlinked_creation`); relationships (imported permissions are
  effective in identity; households hold their members); operational outcomes (opening balances
  hold the approved amounts; an amount re-valued in review is `revalued_in_review` against the
  source amount; active records not applied are counted). Review decisions therefore never make
  the totals appear correct: finance approves those differences with a reason
  (support-migration-07). Each discrepancy is reported on its own, per category and currency,
  never netted. Approval per area: finance
  (`finance_operator`, GM), participation (`program_manager`, `league_manager`, GM), schedule
  (`scheduler`, GM), identity (GM, `support_operator` — proposed); accepting discrepancies needs a
  reason and leaves them listed; regenerating supersedes the pending report; an owned operational
  exception (`migration.reconciliation_discrepancy`) is raised when discrepancies exist.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/migration.ts`)

| Method   | Path                                                                 | Who (action)                                                                      |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST/GET | `/import-batches`, `/import-batches/{id}`                            | stage: GM, system administrator; read: those plus the reviewing areas (protected) |
| POST     | `/import-batches/{id}/rows`                                          | GM, system administrator (`migration.stage_batch`)                                |
| GET      | `/import-batches/{id}/rows`                                          | readers (`migration.read_batch`)                                                  |
| POST     | `/import-batches/{id}/validate`, `/review`, `/apply`, `/abort`       | GM, system administrator                                                          |
| GET/POST | `/import-exceptions`, `/import-exceptions/{id}/decide`               | read: readers; decide: the owning queue's role or GM                              |
| GET      | `/external-mappings`                                                 | readers (`migration.read_mappings`)                                               |
| POST/GET | `/import-batches/{id}/reconciliation-reports`                        | readers of the areas (`migration.reconcile`)                                      |
| GET/POST | `/import-reconciliation-reports/{id}`, `/{id}/approvals`             | read: readers; approve: the area's approver roles                                 |
| GET/POST | `/authority-assignments`, `/authority-assignments/{id}`, `/{id}/end` | read: every staff role; assign/end: general manager only (§6.6)                   |
| GET      | `/authority-matrix`                                                  | every staff role                                                                  |

Every consequential POST is `@Idempotent()` and zod-validated. Batches, rows, exceptions,
mappings and reports carry customer-private data: a caller without migration authority (customer,
staff of another role, another organization) receives `NOT_FOUND` (§4.10).

## Ports

- `AUTHORITY_GUARD_PORT` (`AuthorityGuardPort`, `migration.ports.ts`): `resolve(org, category,
scope?, at?)`, `assertSportsparkAuthority(org, category, scope?)`,
  `assertNoLegacyAuthorityInEffect(org, category)` (for a caller that cannot name the record's
  scope); reads through the active transaction. The same service is registered as finance's
  `RECORD_AUTHORITY_IMPL`.
- `EXTERNAL_MAPPING_PORT` (`ExternalMappingPort`): `findInternalId(org, source, entityType,
externalId)`, `mappingsFor(org, entityType, internalId)`.
- Fixtures for downstream tests: `testing/migration-fixtures.ts`
  (`createAuthorityAssignmentFixture`, `legacyAuthorityFixture`, `createImportBatchFixture`,
  `createExternalMappingFixture`, `staged*` row builders, `controlTotalsFor`).

## Events (`migration.events.ts`)

`migration.batch_received`, `batch_validated`, `batch_reviewed`, `batch_applied`,
`batch_aborted`, `import_exception_raised`, `import_exception_decided`, `authority_assigned`,
`authority_ended`, `reconciliation_generated`, `reconciliation_decided`. Payloads carry ids,
categories and counts only — staged personal data never travels in events (§4.14). No handler of
these events notifies a customer.

## Policy defaults (proposed, `migration.policy.ts`, pending operator decisions §6.6)

Relationship evidence imported without review: `documented` only; `collect` always reviewed
(§6.6 "Guardian verification and child-account policy", Operator/privacy owner). Queue owners and
area approvers as above (§5.5; identity area proposed). Apply lease 15 minutes; at most 50,000
rows per batch; imported credits usable for registrations and obligations unless the source says
otherwise (finance, SPK-PAY-009). Accepting an expired credit issues it without the expired date
(finance's decision is recorded as the reason).

## Known gaps

- **Operational categories without an import command:** seasons, teams, rosters, future
  schedules and communication preferences are staged, validated, retained and reported by
  reconciliation level 4, but not created: competition, scheduling and communications expose no
  import command (communications only lets a person set their own preferences). Active
  participation (enrollments, rosters) is therefore not imported; schedules are rebuilt in
  scheduling under one authority (§5.6).
- **Accounts and documents:** legacy logins are never imported (claims through the identity
  provider, DEC-018); documents are kept by reference only — restricted object storage is not
  provisioned (§4.1).
- **Provenance in the owning modules:** identity's `createPerson` and catalog's `create` take no
  import source, so imported persons and programs carry source `staff` there; the import
  provenance lives in `external_mappings` and the audit records (actor
  `migration.import:<batchId>`). Relationships and grants carry source `import`.
- **Team obligations:** opening balances are imported for person debtors only (team entries are
  not imported).
- **Import keys for persons and households:** identity has no unique import reference, so a person
  or household an apply created after losing its lock (a stall longer than the lease) is not
  refused by the database; it is reported (owned exception, `unlinked_creation`) and identity's
  duplicate detection flags a duplicate person. A database key would need an identity schema
  change (proposed follow-up).
- **Guarded routes:** routes whose scope is only known from the record behind a path id
  (`PATCH /fixtures/{id}`, `/seasons/{id}`, team entries, rosters, results, checkouts,
  obligations, closures, offerings by id, …) cannot prove their scope before the owning module
  loads the record, so they are refused while the category is legacy in any scope. During a
  facility-by-facility or program-by-program cutover this over-refuses writes to records SportsPark
  already owns. Follow-up (proposed): the owning modules call `AUTHORITY_GUARD_PORT
.assertSportsparkAuthority` inside their unit of work with the loaded record's scope
  (fixture/event → facility, old and new; season, division, team entry, roster, result →
  competition; order, obligation → program or facility), and those routes move to exact
  resolution. In-process writes are guarded only for refunds (finance); other outbox handlers and
  service-to-service calls of the owning modules are not guarded.
- **Size:** the apply runs synchronously in the request (rows in their own small transactions);
  very large batches would need chunked or background apply. HTTP bodies are bound by the server's
  body limit, so large snapshots are staged in chunks.
- **Post-apply review:** an exception raised during an apply can be rejected or deferred
  afterwards; accepting it needs a new batch (re-import).
- **Cutover and recovery runbooks (§5.7, §5.8):** the module provides the mechanisms (authority
  transfer at an instant, prelaunch abort, resumable apply, reconciliation evidence); the runbooks
  themselves, payment routing and customer activation are operational documents, not code.
- List endpoints return one page (`nextCursor: null`), except staged rows (cursor by sequence).

## Kernel limitations worked around here

- `UnitOfWork.run` always opens a new transaction, so the owning modules' commands (which open
  their own) are called outside any migration transaction; crash safety comes from the reserved
  mapping plus recovery through the owning module's audit record, and from the per-source lock.
- The kernel offers no global write-authority hook, so this module registers its own
  `APP_INTERCEPTOR` (it only ever refuses; it never relaxes a guard).
