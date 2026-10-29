# migration module

**Owns:** import batches, staged import rows and their outcomes, external mappings, import
exceptions (review queues), the authority matrix (authority assignments), reconciliation reports
with their discrepancies and per-area approvals

**Specification:** §5.3 (inventory), §5.4 (import behaviour), §5.5 (reconciliation), §5.6 (one
authority during transition), §5.7 and §5.8 (the authority transfer and recovery mechanisms they
rely on), §4.4 Migration (ExternalMapping, ImportBatch, ImportException, AuthorityAssignment),
§4.7 invariants 5, 9 and 11, SPK-AT-024

**Migration range:** `packages/db/migrations/1200_migration_*.sql` … `1299` (this module uses
`1200_migration_core.sql`, `1201_migration_import_commands.sql` and
`1280_migration_org_scoped_kernel_fks.sql`)

**Depends on:** identity (`PeopleService`, `HouseholdsService`, `RelationshipsService`,
`AUTHORITY_LOOKUP_PORT`), catalog (`ProgramsService`), competition (`CompetitionImportService`,
`SeasonsService`, `TEAM_ENTRY_QUERY_PORT`), scheduling (`EVENT_SCHEDULING_PORT.importEvent`),
communications (`CommunicationPreferencesService.importPreferences`), finance
(`ObligationsService`, `CreditsService`). It creates imported records only through those exported
services, with the import system principal (`migration.import:<batchId>`) and an import reason; it
never writes another module's tables (§4.2). Mappings reference the internal records through
composite `(organization_id, id)` foreign keys, read-only.

**Capability switches:** none. This module is §5 (migration and transition), not a Package G
capability, so nothing here is behind a DEC-016 switch. What gates an import is the authority
matrix (§5.6: a category is imported only while the legacy system is authoritative for it) and the
pending migration scope and writer-authority decision (DEC-014, §6.6).

**Status** (§6.7 labels): statements below are **verified** — by
`apps/api/src/modules/migration/__tests__` (PGlite and `TEST_DATABASE_URL` PostgreSQL) and the unit
specs `staging/staging.spec.ts` and `migration.machines.spec.ts` — unless marked **proposed** or
**pending**. "Stage 3" lists what MIG-00 to MIG-02 added.

## Stage 3 (MIG-00, MIG-01, MIG-02)

| Item   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIG-00 | `AuthorityWriteInterceptor` reads a handler's K-11 decorator first (`@RecordAuthority(category, scope)` guards it, `@NoRecordAuthority(reason)` exempts it), then falls back to the static lists in `services/authority-routes.ts`. `classifyWriteRoutes` counts decorators and list entries over the served route facts (IF-07). The kernel capability routes left the exempt list (they are decorated). `MigrationModule` registers the kernel's `RECORD_AUTHORITY_IMPL` (`AuthorityService.assertNoLegacyAuthority`, IF-42) next to finance's, so scheduling's in-process port writes (SCH-02) are guarded. | `route-classification.spec.ts` ("§5.6: a route classified by decorator is guarded exactly like a listed one", "a route both listed and decorated fails the classification test", "an unclassified new write route fails the classification test", the kernel port); `authority.spec.ts` (every served write route classified exactly once; the legacy-refusal test iterates decorated routes); `record-authority.spec.ts` (scheduling port write)                                                                                                                |
| MIG-01 | `GET /import-batches/{id}/reconciliation-reports` answers `{ items }` (documented); `ImportBatch.latestReconciliationReportId`; `ImportException.stagedAmountMinor` and `currency` for balance rows (obligations, credits, refunds); `GET /import-batches`, `/import-exceptions`, `/authority-assignments`, `/external-mappings` page by keyset (`created_at desc, id desc`, an exact microsecond cursor) and return `nextCursor`; an unreadable cursor is `VALIDATION_FAILED`.                                                                                                                                | `batch-views.spec.ts` ("§5.5: earlier reconciliation reports are listed from the batch and the batch names the latest", "an import exception about a balance states its currency", cursor paging of the four lists)                                                                                                                                                                                                                                                                                                                                              |
| MIG-02 | Persons, programs, seasons, teams, team entries, roster memberships, future events (drafts) and communication preferences are created only through the owning modules' import commands (IF-40), one row per migration unit of work that the command joins, with the record id the mapping reserved (migration 1201). Reconciliation level 4 reports those categories as created; enrollments and orders stay staged history.                                                                                                                                                                                   | `operational-import.spec.ts` ("SPK-AT-024: applying the same snapshot twice creates every person, program, season, team, entry, roster row, event and preference once", "an event that conflicts at import becomes one IMPORT_SCHEDULE_CONFLICT exception and the rest of the batch applies", "§5.6: imported events are drafts and nothing is published by the import", competition-scoped authority); `apply-recovery.spec.ts` (resume with the reserved id); `migration-schema.spec.ts` (MIG-02 mapping invariants); `staging.spec.ts` (operational payloads) |

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
- operational payloads (MIG-02, **proposed**): `season` (`competitionId`, `ruleSetId`, `name`,
  `startsOn`, `endsOn`, `status` — never defaulted, registration window); `team` is one record
  per row: a team (`record: 'team'`, the default: `name`, colors, `status`) or a team's entry in a
  season (`record: 'entry'`: `teamExternalId`, `seasonExternalId`, `status` `applied`/`approved`,
  `appliedAt`, `approvedAt` exactly when approved, optional `captainExternalId`, `divisionId`);
  `roster` (`entryExternalId`, `personExternalId`, playing `status`, `effectiveFrom`,
  `effectiveTo`, `jerseyNumber`); `future_schedule` (`facilityId`, `resourceIds`, `kind`,
  `title`, `scheduledStart`, `scheduledEnd`, buffers); `communication_preference`
  (`personExternalId`, `preferences`, in CSV `category.channel=true|false;…`). SportsPark
  configuration that is not a §5.3 inventory line — competitions, rule sets, divisions,
  facilities and resources (supplied by Operations, DEC-001) — is referenced by its SportsPark id;
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
these rows (or the contract is extended). **Pending decision:** migration scope and writer
authority (DEC-014, §6.6, owner Migration owner/operator).

## Tables (migrations `1200_migration_core.sql`, `1201_migration_import_commands.sql`)

| Table                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import_batches`               | Source system, snapshot taken at, received at, declared and computed checksum, declared row count, transformation version, extraction provenance, control totals, status `received/validated/reviewed/applied/aborted`, planned and final counts by outcome, validation summary, every actor, apply lock                                                                                                                    |
| `import_rows`                  | One per (batch, entity type, external id); payload and payload hash (immutable); planned outcome and reasons (validation); final outcome `created/matched/updated/skipped/exception`, mapping and applied time (final)                                                                                                                                                                                                      |
| `external_mappings`            | Key (source system, entity type, external id); `pending` (reserved) → `linked` to exactly one typed internal record (person, household, relationship, program, obligation, credit; since 1201 season, team or team entry, roster membership, event, preference import); the record id reserved before an import command runs (`reserved_record_id`); first and last seen batch; extraction provenance; applied payload hash |
| `import_exceptions`            | One per (row, kind): `ambiguous_relationship/ambiguous_balance/conflict/validation`, phase, reasons, review owner role, `open/decided/withdrawn`, decision `accept/reject/defer` with reason, resolution and actor                                                                                                                                                                                                          |
| `authority_assignments`        | Record category (the 17 inventory lines), scope (organization, facility, program, competition), authoritative system `legacy/sportspark`, effective period, reason, policy references, approver, superseded assignment, end                                                                                                                                                                                                 |
| `reconciliation_reports`       | Per applied batch: status `balanced/discrepancy`, the four level summaries, discrepancy count, required approval areas, approval status `pending/approved/rejected/superseded`                                                                                                                                                                                                                                              |
| `reconciliation_discrepancies` | One row per discrepancy: level, area, entity type, code, external/internal id, expected, actual, currency, money or count difference — append-only                                                                                                                                                                                                                                                                          |
| `reconciliation_approvals`     | One decision per (report, area): approved/rejected, approver person and role, reason, discrepancies acknowledged — append-only                                                                                                                                                                                                                                                                                              |

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
- **MIG-02 reservations (migration 1201):** a season, team, roster, future-schedule or preference
  mapping always carries its reserved record id; a mapping with a reservation links exactly that
  record; a reservation never changes once set.
- **§5.4 retention:** staged rows are unique per batch and immutable; a row outcome is final and a
  created/matched/updated outcome always names its mapping; the batch machine (guard trigger),
  sealed checksum and rows; abort or re-validation after an apply started is refused (§5.8).
- **Review decisions:** one exception per (row, kind); only ambiguity can be accepted; a decision
  is final.
- **§5.5 no netting:** a money discrepancy always carries its currency; discrepancies and
  approvals are append-only; one decision per area; approving an area with discrepancies needs a
  reason; one pending report per batch; report evidence is immutable.

## Behaviour

- **Staging:** `POST /import-batches` records the snapshot as received (JSON or CSV rows, control
  totals, provenance, declared checksum and row count); a snapshot that lists one external record
  twice is refused; `POST /import-batches/{id}/rows` appends chunks while received.
- **Validation (dry run):** seals the batch (computed checksum must equal the declared one;
  declared row count must match), plans every row with the same rules the apply uses, stores
  planned outcomes and reasons, opens review exceptions, withdraws exceptions whose cause is gone,
  compares control totals without netting, and raises one owned operational exception
  (`migration.import_review`, queue `migration`) while rows await review. A conflict only the
  owning module can see (a schedule clash at the moment of import) is found at apply.
- **Review queues (§5.4):** ambiguous relationships (evidence basis other than `documented`, the
  `collect` permission, guardianship of an adult, conflicting evidence for the same two people,
  changed evidence) → `support_operator`; ambiguous balances (negative, disputed,
  original − paid ≠ remaining, expired credit, changed opening balance, refund still in flight) →
  `finance_operator`; conflicts and validation errors → `system_administrator`; the general
  manager may decide any. Accept may narrow staged permissions or state the amount finance
  approved, never widen; validation errors and conflicts can only be rejected or deferred. The
  review completes when no exception is open. An exception about a balance states the staged
  amount and its currency.
- **Apply (§5.4, SPK-AT-024):** idempotent per external id — a mapped, unchanged record is
  `matched`. Rows are applied in dependency order (persons; programs; households and
  relationships; balances; seasons; teams before their entries; rosters; events; preferences).
  - **Import commands (MIG-02, IF-40, IF-28):** persons, programs, seasons, teams, team entries,
    roster memberships, future events and communication preferences. Per row the mapping first
    reserves the record id (UUID v7) in its own fenced transaction; then one migration unit of
    work (the outermost) renews the lease, calls the owning module's import command with
    `systemPrincipal(org, 'migration.import:<batchId>')` and the provenance
    `{ batchId, externalKey, recordId }` (the command joins it and inserts with
    `id = recordId`, source `import`), links the mapping and records the outcome — the record and
    its mapping commit together or not at all. A refusal (RESOURCE_CONFLICT incl.
    `IMPORT_SCHEDULE_CONFLICT` and `IMPORT_CONTENT_MISMATCH`, VALIDATION_FAILED, NOT_FOUND, an
    untranslated database constraint classified by `databaseConstraintOf`) rolls that row back
    whole and its import exception is recorded in a new transaction (`owning_module_refused` with
    the module's code), so rows never affect each other. A resumed apply reuses the reserved id,
    so it can only create that record. A rerun finds every mapping linked and calls nothing.
  - **Drafts, never publications (§5.6):** an imported future event is a draft that holds no
    space; it is published only through a scheduling schedule draft under SportsPark's
    scheduling authority. An event that ended before the apply is skipped as history
    (`not_a_future_event`). Imported competition records publish no events; imported preferences
    never override a person's own choice; nothing notifies, charges or reserves.
  - **Changes after import:** a changed person or program row is `updated` through the owning
    module while the legacy system is authoritative (never once SportsPark is: conflict). A
    changed season, team, entry, roster, event or preference row is a conflict
    (`imported_record_changed`): import commands only create, so the change is reviewed.
  - **Owning-module commands outside the import contract:** households (identity), relationships
    (identity's transactional `ensureAuthority`), opening obligations and credits (finance: no
    payment attempt, no receipt, no notice) keep the earlier path: a reserved mapping whose id is
    the correlation id of the owning module's audit record, recovered after an interruption, never
    created twice. A creation already in flight when an apply loses its lock cannot be fenced: an
    opening credit or obligation carries its mapping id as its source (finance's unique keys), so
    a second one is refused; a household the stale apply created anyway raises an owned
    `migration.orphaned_creation` exception and is reported by reconciliation
    (`unlinked_creation`).
  - History categories (orders, settled refunds, attendance, results, documents, accounts) are
    `skipped` with their reason and retained as staged history.
  - The apply is a durable operation (`migration.apply_batch`, `GET /v1/operations/{id}`), takes a
    per-source lock with a lease (default 15 minutes, renewed per row; the row unit of work holds
    the batch row while it runs, so a takeover waits for it), and resumes after an interruption.
- **Authority matrix (§5.6):** assignments per category and scope; a transfer names the
  assignment in effect and its revision, ends it and starts the next one at the same instant;
  never retroactive. Without an assignment SportsPark is authoritative; importing a category
  needs legacy authority in effect at the row's scope (a mapped program's program; a season's,
  team entry's or roster's competition; a future event's facility; otherwise the organization),
  else the row is a `sportspark_authoritative` conflict.
- **AuthorityGuard (§5.6):** `AUTHORITY_GUARD_PORT` (`resolve`, `assertSportsparkAuthority`,
  `assertNoLegacyAuthorityInEffect`) and the kernel's `RECORD_AUTHORITY_PORT`
  (`assertNoLegacyAuthority`, IF-42) for in-process callers, and a global interceptor
  (`AuthorityWriteInterceptor`) that refuses the HTTP write commands of a category while the
  legacy system is authoritative (`ACCESS_DENIED`, `nextAction: write_in_authoritative_system`,
  `details.code: LEGACY_AUTHORITY`). Deny-by-default: every served POST/PATCH/PUT/DELETE route is
  classified exactly once — by its handler's `@RecordAuthority` / `@NoRecordAuthority` decorator
  (read first) or by one entry of `AUTHORITY_ROUTES` / `AUTHORITY_EXEMPT_ROUTES`;
  `__tests__/authority.spec.ts` fails on an unclassified route, on a route classified twice and on
  a stale list entry. The scope is never taken from identifiers a client adds to the body (§4.8):
  a route creating a top-level record resolves at organization scope; a route names the
  validated field its handler writes to (`POST /schedule-drafts`, `/event-series`, `/closures`,
  `/maintenance-restrictions` → `facilityId`; `POST /fixtures` → `schedule.facilityId`;
  `POST /seasons` → `competitionId`; `POST /offerings` → `programId`, `facilityId`;
  `PATCH /programs/{id}`, `/competitions/{id}` → the path id); every other route is `unproven`
  and is refused while any assignment of its category in effect, at any scope, names the legacy
  system (`details.scopeResolution: unproven`). Where a scope is known the most specific scope
  wins (program/competition, facility, organization); two answers at one specificity refuse
  writes. Youth enrollment routes are guarded as `program` (participation follows its offering,
  authority matrix §4.1, a **proposed** reading pending DEC-014); makeup entitlements as `credit`
  (row 14).
- **In-process guard:** finance's `RefundsService.request` asserts finance's
  `RECORD_AUTHORITY_PORT` (support's refund helper and automation's refund proposal are refused
  like `POST /payments/{id}/refunds`); scheduling's port writes (create, series, move, cancel;
  SCH-02) assert the kernel's `RECORD_AUTHORITY_PORT` for the event's facility, both answered by
  this module's `AuthorityService` (`__tests__/record-authority.spec.ts`; the automation proposal
  in `automation/__tests__/record-authority.spec.ts`).
- **Reconciliation (§5.5):** four levels — control totals (declared against staged, and declared
  opening-balance amounts against what finance holds after the apply: `loaded_total_mismatch`);
  record identity (every row has an outcome, every mapping reaches an existing record; a row
  rejected in review is `rejected_in_review` with its source amount; a creation no mapping links is
  `unlinked_creation`); relationships (imported permissions are effective in identity; households
  hold their members); operational outcomes (opening balances hold the approved amounts; an
  amount re-valued in review is `revalued_in_review` against the source amount; seasons, teams,
  entries, rosters, events and preferences created through their import commands count as
  checked, and every active one not applied — an exception, a rejection — is
  `active_records_not_applied` per category with its reasons). Each discrepancy is reported on
  its own, per category and currency, never netted. Approval per area: finance
  (`finance_operator`, GM), participation (`program_manager`, `league_manager`, GM), schedule
  (`scheduler`, GM), identity (GM, `support_operator` — **proposed**); accepting discrepancies
  needs a reason and leaves them listed; regenerating supersedes the pending report, and the batch
  names its latest report while earlier ones stay listed; an owned operational exception
  (`migration.reconciliation_discrepancy`) is raised when discrepancies exist.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/migration.ts`)

| Method   | Path                                                                 | Who (action)                                                                      |
| -------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| POST/GET | `/import-batches`, `/import-batches/{id}`                            | stage: GM, system administrator; read: those plus the reviewing areas (protected) |
| POST     | `/import-batches/{id}/rows`                                          | GM, system administrator (`migration.stage_batch`)                                |
| GET      | `/import-batches/{id}/rows`                                          | readers (`migration.read_batch`)                                                  |
| POST     | `/import-batches/{id}/validate`, `/review`, `/apply`, `/abort`       | GM, system administrator                                                          |
| GET/POST | `/import-exceptions`, `/import-exceptions/{id}/decide`               | read: readers; decide: the owning queue's role or GM                              |
| GET      | `/external-mappings`                                                 | readers (`migration.read_mappings`)                                               |
| POST/GET | `/import-batches/{id}/reconciliation-reports` (GET: `{ items }`)     | readers of the areas (`migration.reconcile`)                                      |
| GET/POST | `/import-reconciliation-reports/{id}`, `/{id}/approvals`             | read: readers; approve: the area's approver roles                                 |
| GET/POST | `/authority-assignments`, `/authority-assignments/{id}`, `/{id}/end` | read: every staff role; assign/end: general manager only (§6.6)                   |
| GET      | `/authority-matrix`                                                  | every staff role                                                                  |

Every consequential POST is `@Idempotent()` and zod-validated. `GET /import-batches`,
`/import-exceptions`, `/authority-assignments` and `/external-mappings` are newest first and page
with `cursor`/`nextCursor`; staged rows page by sequence. Batches, rows, exceptions, mappings and
reports carry customer-private data: a caller without migration authority (customer, staff of
another role, another organization) receives `NOT_FOUND` (§4.10).

## Ports

- `AUTHORITY_GUARD_PORT` (`AuthorityGuardPort`, `migration.ports.ts`): `resolve(org, category,
scope?, at?)`, `assertSportsparkAuthority(org, category, scope?)`,
  `assertNoLegacyAuthorityInEffect(org, category)` (for a caller that cannot name the record's
  scope); reads through the active transaction. The same service is registered as the kernel's
  `RECORD_AUTHORITY_IMPL` (IF-42, `assertNoLegacyAuthority(org, category, scope?, trx?)`) and as
  finance's `RECORD_AUTHORITY_IMPL`.
- `EXTERNAL_MAPPING_PORT` (`ExternalMappingPort`): `findInternalId(org, source, entityType,
externalId)`, `mappingsFor(org, entityType, internalId)`.
- Fixtures for downstream tests: `testing/migration-fixtures.ts`
  (`createAuthorityAssignmentFixture`, `legacyAuthorityFixture`, `createImportBatchFixture`,
  `createExternalMappingFixture`, `staged*` row builders incl. `stagedSeason`, `stagedTeam`,
  `stagedTeamEntry`, `stagedRoster`, `stagedEvent`, `stagedPreferences`, `controlTotalsFor`).

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
(finance's decision is recorded as the reason). No value is invented for the operational
categories: a season's status, an entry's status and dates, roster dates and preferences come from
the source; a team's status defaults to `active` (competition's import default).

## What remains

- **Pending (DEC-014, §6.6):** which categories are migrated from which sources, and who writes
  each during transition; the staging contract and the authority-matrix rows stay **proposed**
  until then. **Pending (DEC-018):** accounts are never imported — legacy logins are claimed
  through the identity provider.
- **Documents:** kept by reference only — restricted object storage is not provisioned (§4.1).
- **Active participation beyond rosters:** enrollments and orders stay staged history (no
  enrollment import command exists); team-entry debtors for opening obligations are not imported
  (person debtors only).
- **Households, relationships and balances** still use the reserve-and-recover path instead of an
  import command with a reserved id: identity has no import key for households, so a household a
  stale apply created after losing its lock is reported (owned exception, `unlinked_creation`)
  rather than refused by the database (**proposed** follow-up: an identity import command for
  households).
- **Configuration references:** competitions, rule sets, divisions, facilities and resources are
  referenced by SportsPark id; they are created in SportsPark (or by Operations, DEC-001) before
  the import. Imported events are published through scheduling's schedule drafts (SPK-SCHED-005),
  not by this module.
- **Guarded routes:** routes whose scope is only known from the record behind a path id
  (`PATCH /fixtures/{id}`, `/seasons/{id}`, team entries, rosters, results, checkouts,
  obligations, closures, offerings by id, …) cannot prove their scope before the owning module
  loads the record, so they are refused while the category is legacy in any scope. During a
  facility-by-facility or program-by-program cutover this over-refuses writes to records SportsPark
  already owns (**proposed** follow-up: the owning modules assert `RECORD_AUTHORITY_PORT` inside
  their unit of work with the loaded record's scope, as scheduling's port writes now do, and those
  routes move to exact resolution). Other outbox handlers and service-to-service writes are
  guarded only at their routes.
- **Size:** the apply runs synchronously in the request (rows in their own small transactions);
  very large batches would need chunked or background apply. HTTP bodies are bound by the server's
  body limit, so large snapshots are staged in chunks.
- **Post-apply review:** an exception raised during an apply can be rejected or deferred
  afterwards; accepting it needs a new batch (re-import).
- **Cutover and recovery runbooks (§5.7, §5.8):** the module provides the mechanisms (authority
  transfer at an instant, prelaunch abort, resumable apply, reconciliation evidence); the runbooks
  themselves, payment routing and customer activation are operational documents, not code.

## Kernel mechanisms used here

- `UnitOfWork.run` joins an active transaction in its own savepoint (K-07, IF-28): the import
  commands join the migration's row unit of work, which is the only isolation mechanism used
  (joined units run one at a time; no savepoint helper of its own). Commands that are not import
  commands are still called outside any migration transaction.
- Route classification uses the kernel's K-11 decorators and K-02 route facts; the write guard is
  this module's own `APP_INTERCEPTOR` (it only ever refuses; it never relaxes a guard).
