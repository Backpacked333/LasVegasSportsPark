# Domain model and relationship diagram

Status legend: **Verified** = implemented and tested in this repository today (file cited). **Proposed** = engineering proposal from the specification or from this document, awaiting operator approval. **Pending decision** = needs an operator answer; the owner is named from specification §6.6. "No answer yet" never becomes "not applicable" (§6.6).

Last derived from specification v2.0 (2026-10-22). Source: `docs/spec/master-specification.md` (repository copy supplied 2026-10-23).

This is the "Domain model and relationship diagram" artifact required by §6.7. It covers every entity in the §4.4 "Minimum domain entities" table, grouped by the owning module of §4.2, the key relationships between them, and the canonical lifecycles of §4.6 exactly as defined in `packages/contracts/src/state-machines.ts`. The companion document for commands, errors and events is `docs/architecture/api-and-events.md`; the kernel and module map are in `docs/architecture/overview.md`.

## 1. How to read this document

| Rule                                                                                                                                                                                                                                                                                                                                                 | Status                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| An entity is **Verified** only when a table for it exists in `packages/db/migrations/`, has a Kysely interface in `packages/db/src/schema/`, and a test in this repository exercises it. The three migrations that exist today are `0001_core_schema.sql` (kernel), `0100_identity_core.sql` (identity) and `0300_scheduling_core.sql` (scheduling). | **Verified** by inspection of `packages/db/migrations/` and `packages/db/src/schema/index.ts` on 2026-10-23                          |
| Every other §4.4 entity is **Proposed**: its shape below is derived from the requirement text cited on the row, and it is not persisted anywhere in this repository. Twelve of the fourteen modules of §4.2 are scaffolds (`apps/api/src/modules/<module>/README.md`, "Status: scaffold").                                                           | **Verified** by inspection of `apps/api/src/modules/*/README.md`                                                                     |
| Where the shape of an entity depends on an operator answer (field vocabularies, policy values, capacity units, fee bases), the row names the §6.6 owner and the `DEC-###` record in `docs/package-a/decision-register.md`. The entity itself stays **Proposed**; the value is **Pending decision**.                                                  | **Proposed** (documentation rule, §6.6 and §6.7)                                                                                     |
| The "original platform specification" (`.docx`, §1.3) and the "existing local demonstration" (§1.4) are not in this repository. Nothing here describes legacy requirement identifiers or demonstration behaviour; the §4.5 table in section 9 lists the demo shortcuts the specification names and how this model replaces each one.                 | **Verified** absence (`docs/spec/master-specification.md` repository note; `docs/architecture/overview.md` "Not in this repository") |
| Diagrams are Mermaid `erDiagram` and `stateDiagram-v2`. Entity names in diagrams are the §4.4 names in PascalCase; the table after each diagram maps them to physical table names where a table exists. Attributes shown are keys, scope and lifecycle columns, not full column lists.                                                               | **Proposed** (documentation convention)                                                                                              |

## 2. Record conventions shared by every entity (§4.3, §4.4, §4.7)

| Convention                                                                                                                                                                                                                                                     | Where it is enforced today                                                                                                                                                           | Status                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable identity: `id uuid primary key`, application-generated time-ordered UUID v7 (`newId()`), never `serial`.                                                                                                                                                | `packages/contracts/src/ids.ts`; every table in migrations 0001, 0100, 0300                                                                                                          | **Verified** (`packages/contracts/src/ids.spec.ts`)                                                                                                                  |
| Organization scope on every operational record: `organization_id uuid not null references organizations(id)`; references between scoped tables use composite foreign keys `(organization_id, <id>)` so a row can never point at another organization's record. | `0001_core_schema.sql` header, `facilities (organization_id, id)` unique; every table in 0100 and 0300                                                                               | **Verified** (`packages/db/src/core-schema.spec.ts` "facility references cannot cross organizations"; `identity-schema.spec.ts`; `schema-invariants.spec.ts` "§4.3") |
| Revision where applicable: `revision integer not null default 1`; updates use `where revision = expected` and bump it; a mismatch is `STALE_REVISION`.                                                                                                         | `organizations`, `facilities`, `operations`, `operational_exceptions`, `persons`, `accounts`, `relationships`, `access_grants`, `resources`, `events`, `schedule_drafts`, and others | **Verified** (`apps/api/src/kernel/__tests__/unit-of-work.spec.ts` STALE_REVISION; `people.spec.ts` "§4.9: PATCH ... requires the current revision")                 |
| Timestamps: `timestamptz` (`created_at`, `updated_at` maintained by the `touch_updated_at` trigger); facility-local behaviour derives from `facilities.timezone`.                                                                                              | `0001_core_schema.sql` `touch_updated_at()`; `events.timezone`, `event_series.timezone`                                                                                              | **Verified** (`event-series.spec.ts` SPK-SCHED-008)                                                                                                                  |
| Provenance: an actor snapshot (`jsonb`: kind, accountId, personId, staffRoles, sessionId, actorLabel) on created/decided/granted columns and on every `audit_records` row; never child information.                                                            | `apps/api/src/kernel/audit/audit.writer.ts` `snapshotActor`; `persons.created_by`, `access_grants.granted_by`, `closures.created_by`, `schedule_drafts.author`                       | **Verified** (`unit-of-work.spec.ts` "writes audit records with a principal snapshot")                                                                               |
| Append-only facts: tables that record history carry the `forbid_mutation` trigger; corrections are new rows that reference what they correct.                                                                                                                  | `audit_records`, `access_review_decisions`, `person_merges`, `publications`                                                                                                          | **Verified** (`core-schema.spec.ts` "audit records are append-only"; `schema-invariants.spec.ts` "§4.7 invariant 9")                                                 |
| Lifecycle states: the database `check` constraint lists exactly the states of the contract state machine; services only move through `Machine.next(from, event)`.                                                                                              | `packages/contracts/src/state-machines.ts`; `apps/api/src/modules/identity/identity.machines.ts`; `apps/api/src/modules/scheduling/scheduling.state-machines.ts`                     | **Verified** (`schema-invariants.spec.ts` "check constraints list exactly the lifecycle states"; `state-machines.spec.ts`)                                           |
| Money: `bigint` minor units beside a `currency text` column (SPK-PAY-001).                                                                                                                                                                                     | `packages/contracts/src/money.ts`; no money column exists in any migration yet                                                                                                       | **Verified** contract (`money.spec.ts`); **Proposed** for every finance table                                                                                        |
| Integrity that matters is a database constraint, not only an application check: partial unique indexes for duplicate entitlements, GiST exclusion on `tstzrange` for physical reservations and overlapping grants, check constraints for balances.             | `reservation_units_no_overlap`, `event_commitments_no_overlap`, `access_grants` exclusion, `accounts_one_active_per_person_idx`                                                      | **Verified** for scheduling and identity; **Proposed** for capacity, entitlement, credit and refund constraints (§4.7 invariants 2, 3, 6, 7)                         |

## 3. Entity inventory: every §4.4 entity, grouped by owning module

The "Physical record today" column names the table in `packages/db/migrations/` when one exists. "Evidence" cites the migration and the test that exercises it, or the requirement the proposed shape is derived from.

### 3.1 Kernel (shared by every module; §4.3, §4.4 "Operations" and "Reliability")

| §4.4 area   | Entity           | Owning module                                              | Physical record today         | Status       | Evidence                                                                                                                                                            |
| ----------- | ---------------- | ---------------------------------------------------------- | ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.3        | Organization     | kernel                                                     | `organizations`               | **Verified** | `0001_core_schema.sql`; `packages/db/src/core-schema.spec.ts`; `apps/api/src/kernel/__tests__/authorization.spec.ts` "never crosses organization scope"             |
| §4.3        | Facility         | kernel                                                     | `facilities`                  | **Verified** | `0001_core_schema.sql`; `core-schema.spec.ts` "facility references cannot cross organizations"                                                                      |
| Operations  | Operation        | kernel (`OperationsService`)                               | `operations`                  | **Verified** | `0001_core_schema.sql`; `apps/api/src/kernel/__tests__/auth-and-operations.spec.ts`                                                                                 |
| Operations  | AuditRecord      | kernel (`AuditWriter`)                                     | `audit_records` (append-only) | **Verified** | `0001_core_schema.sql`; `unit-of-work.spec.ts`; `core-schema.spec.ts` "audit records are append-only"                                                               |
| Operations  | Exception        | kernel (`OperationalExceptions`); support module workflows | `operational_exceptions`      | **Verified** | `0001_core_schema.sql`; `unit-of-work.spec.ts` "exceptions deduplicate while open, transition with authorization and revision checks"                               |
| Operations  | Case             | support                                                    | none                          | **Proposed** | SPK-SUPPORT-002 (owner, category, related records, history, resolution); `apps/api/src/modules/support/README.md` (scaffold)                                        |
| Reliability | OutboxEvent      | kernel (`Outbox`, `OutboxDispatcher`)                      | `outbox_events`               | **Verified** | `0001_core_schema.sql`; `apps/api/src/kernel/__tests__/outbox.spec.ts`                                                                                              |
| Reliability | InboxEvent       | kernel (`Inbox`)                                           | `inbox_events`                | **Verified** | `0001_core_schema.sql`; `apps/api/src/kernel/__tests__/inbox.spec.ts`                                                                                               |
| Reliability | JobAttempt       | kernel (`OutboxDispatcher`)                                | `job_attempts`                | **Verified** | `0001_core_schema.sql`; `outbox.spec.ts` "dispatches each event to every handler exactly once" (asserts `job_attempts` outcomes)                                    |
| (§4.12)     | EventConsumption | kernel                                                     | `event_consumptions`          | **Verified** | `0001_core_schema.sql`; `outbox.spec.ts`, `inbox.spec.ts` (one business effect per handler per event). Not named in §4.4; it realises "one logical business effect" |
| (§4.9)      | IdempotencyKey   | kernel (`IdempotencyInterceptor`)                          | `idempotency_keys`            | **Verified** | `0001_core_schema.sql`; `apps/api/src/kernel/__tests__/idempotency.spec.ts`; `core-schema.spec.ts` "idempotency keys are unique per organization and scope"         |
| (§4.1)      | SchemaMigration  | kernel (`packages/db/src/migrate.ts`)                      | `schema_migrations`           | **Verified** | `packages/db/src/migrate.spec.ts` (checksum-verified, immutable migrations)                                                                                         |

### 3.2 Identity (§4.2 "Accounts, people, relationships, grants")

| §4.4 area     | Entity                             | Owning module | Physical record today                       | Status       | Evidence                                                                                                                                                                |
| ------------- | ---------------------------------- | ------------- | ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity      | Person                             | identity      | `persons`                                   | **Verified** | `0100_identity_core.sql`; `apps/api/src/modules/identity/__tests__/people.spec.ts`; `identity-schema.spec.ts`                                                           |
| Identity      | Account                            | identity      | `accounts`                                  | **Verified** | `0100_identity_core.sql`; `claims-and-accounts.spec.ts`; `principal-resolver.spec.ts`                                                                                   |
| Identity      | ContactPoint                       | identity      | `contact_points`                            | **Verified** | `0100_identity_core.sql`; `people.spec.ts` "contact points: primaries are exclusive per kind and verified identifiers are unique"                                       |
| Identity      | Household                          | identity      | `households`, `household_memberships`       | **Verified** | `0100_identity_core.sql`; `staff-memberships.spec.ts` "§4.5: household membership never grants authority"; `identity-schema.spec.ts` "§4.5"                             |
| Identity      | Relationship                       | identity      | `relationships`                             | **Verified** | `0100_identity_core.sql`; `relationships.spec.ts`                                                                                                                       |
| Identity      | AccessGrant                        | identity      | `access_grants`                             | **Verified** | `0100_identity_core.sql`; `relationships.spec.ts` (SPK-IAM-003, SPK-IAM-006, SPK-AT-004); `identity-schema.spec.ts` (overlapping grants rejected, six permissions only) |
| (SPK-IAM-004) | Invitation                         | identity      | `invitations`                               | **Verified** | `0100_identity_core.sql`; `invitations.spec.ts`. Not named in §4.4; required by SPK-IAM-004                                                                             |
| (SPK-IAM-002) | Claim                              | identity      | `claims`                                    | **Verified** | `0100_identity_core.sql`; `claims-and-accounts.spec.ts`. Not named in §4.4; required by SPK-IAM-002 ("claimable by the correct verified customer")                      |
| (§2.1)        | StaffMembership                    | identity      | `staff_memberships`                         | **Verified** | `0100_identity_core.sql`; `staff-memberships.spec.ts`; `principal-resolver.spec.ts`. The "Staff assignment" of SPK-IAM-001                                              |
| (SPK-IAM-005) | AccessReview, AccessReviewDecision | identity      | `access_reviews`, `access_review_decisions` | **Verified** | `0100_identity_core.sql`; `access-reviews.spec.ts`. The disputed-access workflow of SPK-IAM-005                                                                         |
| (SPK-IAM-007) | DuplicateCandidate, PersonMerge    | identity      | `duplicate_candidates`, `person_merges`     | **Verified** | `0100_identity_core.sql`; `duplicates.spec.ts`                                                                                                                          |

### 3.3 Catalog and policies (§4.2 "Programs, offerings, policies")

| §4.4 area | Entity                | Owning module                                                                                       | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | --------------------- | --------------------------------------------------------------------------------------------------- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog   | Program               | catalog                                                                                             | none                  | **Proposed** | SPK-CAT-001 "reusable program definitions"; `apps/api/src/modules/catalog/README.md` (scaffold, migration range 0200)                                                                                                                                                                                                                                                                              |
| Catalog   | Offering              | catalog                                                                                             | none                  | **Proposed** | SPK-CAT-001 (the thirteen required attributes), SPK-CAT-002 (kinds), SPK-CAT-003 (copy creates a draft), SPK-CAT-004 (publication state; registration opening distinct from schedule publication)                                                                                                                                                                                                  |
| Catalog   | Session               | catalog                                                                                             | none                  | **Proposed** | SPK-CAT-001 "individual sessions"; a session's scheduled time is a scheduling `events` row with `source_type = 'session'` (`0300_scheduling_core.sql` `events.source_type/source_id`, **Verified** column)                                                                                                                                                                                         |
| Catalog   | EntitlementDefinition | catalog                                                                                             | none                  | **Proposed** | SPK-CAT-001 "participation entitlement"; §4.7 invariant 2 "no equivalent duplicate active entitlement where prohibited" needs a definition of equivalence; SPK-COND-001 (membership entitlement effects)                                                                                                                                                                                           |
| (§4.5)    | PriceRuleVersion      | catalog                                                                                             | none                  | **Proposed** | §4.5 "`Offering.priceCents` must become versioned price rules and quotes"; SPK-PAY-002, SPK-PAY-003. Values are **Pending decision**: Finance (DEC-007)                                                                                                                                                                                                                                            |
| Policies  | PolicyVersion         | catalog                                                                                             | none                  | **Proposed** | SPK-REG-002 "versioned policies and the configured reference date"; SPK-PAY-002 "applicable policies"; SPK-RESULT-003 "versioned rule set"; `policyReferences` in `packages/contracts/src/commands.ts` (**Verified** command field) refer to these records                                                                                                                                         |
| Policies  | Acknowledgment        | catalog                                                                                             | none                  | **Proposed** | SPK-REG-009 "Staff must not falsely sign a guardian acknowledgment"; `MISSING_ACKNOWLEDGMENT` error code (`packages/contracts/src/errors.ts`, **Verified**); records who acknowledged which policy version, for which participant, in which context (application, order)                                                                                                                           |
| Policies  | Approval              | catalog (record); the command that needs it lives in enrollment, finance, competition or scheduling | none                  | **Proposed** | SPK-REG-002 "Overrides require specific authority, reason, and audit history"; SPK-REG-007 "obtain required human approval before capturing a new payment" (**Proposed** default, DEC-028); SPK-DISC-002 "Approval"; SPK-STAFF-006 "Approver". Modelled as one record type (policy version, target record, approver snapshot, decision, reason, effective dates) rather than a flag on each target |

### 3.4 Competition, matches and discipline (§4.2 "Seasons, divisions, entries, rosters, results")

| §4.4 area        | Entity                    | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------- | ------------- | --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Competition      | League                    | competition   | none                  | **Proposed** | SPK-COMP-001 "Competition"; `apps/api/src/modules/competition/README.md` (scaffold, migration range 0400)                                                                                                                                                                                                                                                             |
| Competition      | Season                    | competition   | none                  | **Proposed** | SPK-COMP-001 "Renewal creates new season records without rewriting prior seasons"; SPK-AT-003                                                                                                                                                                                                                                                                         |
| Competition      | Division                  | competition   | none                  | **Proposed** | SPK-COMP-003 (age, playing level, category, season, location, format; documented criteria)                                                                                                                                                                                                                                                                            |
| Competition      | Team                      | competition   | none                  | **Proposed** | SPK-COMP-001 "Continuing team identity"; §4.5 "Team must separate continuing identity from season entry"                                                                                                                                                                                                                                                              |
| Competition      | TeamEntry                 | competition   | none                  | **Proposed** | SPK-COMP-001 "Season team entry"; SPK-COMP-004 (approval, financial status, roster completion and eligibility stay distinct). The `team_entry` authorization target and `teamRole: 'captain'` exist in the kernel (`apps/api/src/kernel/__tests__/authorization.spec.ts`, **Verified**); `TEAM_AUTHORITY_IMPL` is a kernel port awaiting the competition registration |
| Competition      | RosterMembership          | competition   | none                  | **Proposed** | SPK-COMP-005 (effective dates; a player removed today remains in last week's match record); SPK-CAP-004 substitutes and guests                                                                                                                                                                                                                                        |
| (SPK-COMP-002)   | CompetitionRuleSetVersion | competition   | none                  | **Proposed** | SPK-COMP-002 (the sixteen configurable rule areas per format), SPK-RESULT-003 (versioned standings rule set). Values are **Pending decision**: League manager (DEC-002)                                                                                                                                                                                               |
| Matches          | Fixture                   | competition   | none                  | **Proposed** | SPK-COMP-001, SPK-FIX-001..005; its scheduled time and field is a scheduling event with `source_type = 'fixture'` (**Verified** column) published through the normal scheduling command (SPK-FIX-005; `schedule-drafts.spec.ts` "SPK-FIX-005: a draft event from the solver is published by a create change targeting it")                                            |
| Matches          | ResultRevision            | competition   | none                  | **Proposed** | SPK-RESULT-001 (draft, submitted, official, superseded), SPK-RESULT-002 (classification), SPK-RESULT-004 (corrections preserve prior result, actor, reason, publication time); `ResultMachine` (**Verified**, section 6.9)                                                                                                                                            |
| Matches          | StandingsProjection       | competition   | none                  | **Proposed** | SPK-RESULT-001 "Official standings derive only from official results"; SPK-RESULT-003 (versioned rule set, explained tiebreaks); derived, recomputed on correction (SPK-RESULT-004)                                                                                                                                                                                   |
| Matches          | BracketNode               | competition   | none                  | **Proposed** | SPK-COMP-001 "Bracket progression"; SPK-RESULT-004 (a correction affecting a published bracket creates a management review task); SPK-FIX-001 "Playoff structure"                                                                                                                                                                                                     |
| (SPK-CAP-001)    | TeamInvitation            | competition   | none                  | **Proposed** | SPK-CAP-001 "Invite players"; §4.8 `POST /v1/team-entries/{id}/invitations`; distinct from the identity `invitations` table, which grants permissions over a person, not roster places                                                                                                                                                                                |
| (SPK-CAP-003)    | FixtureAvailability       | competition   | none                  | **Proposed** | SPK-CAP-003 (available, unavailable, tentative if enabled, no response; "RSVP is not attendance or eligibility"); §4.8 `POST /v1/fixtures/{id}/availability`                                                                                                                                                                                                          |
| (SPK-RESULT-005) | Dispute                   | competition   | none                  | **Proposed** | SPK-RESULT-005 (submitting role, fixture, window, reason, evidence, reviewer, decision, publication consequences, appeal handling)                                                                                                                                                                                                                                    |
| Discipline       | Incident                  | competition   | none                  | **Proposed** | SPK-DISC-001 (cards, misconduct reports, complaints, operational incidents), SPK-DISC-004 (narratives never public), SPK-DISC-005 (distinct from diagnosis)                                                                                                                                                                                                           |
| Discipline       | DisciplinaryDecision      | competition   | none                  | **Proposed** | SPK-DISC-003 "only through the approved rule set"; overrides need authorized review and history. Rules are **Pending decision**: League manager/operator (DEC-010)                                                                                                                                                                                                    |
| Discipline       | Suspension                | competition   | none                  | **Proposed** | SPK-DISC-002 (subject, basis, scope, period or match count, applicable competitions, approval, appeal status, completion criteria); SPK-AT-013                                                                                                                                                                                                                        |
| Discipline       | Appeal                    | competition   | none                  | **Proposed** | SPK-DISC-001 "Appeals"; SPK-DISC-002 "Appeal status"; SPK-RESULT-005 "Appeal handling if applicable"                                                                                                                                                                                                                                                                  |

### 3.5 Scheduling (§4.2 "Events, resources, reservations, publication")

| §4.4 area       | Entity          | Owning module | Physical record today                                                               | Status       | Evidence                                                                                                                                                                                                                        |
| --------------- | --------------- | ------------- | ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduling      | Resource        | scheduling    | `resources`                                                                         | **Verified** | `0300_scheduling_core.sql`; `apps/api/src/modules/scheduling/__tests__/resources.spec.ts`                                                                                                                                       |
| Scheduling      | Configuration   | scheduling    | `resource_configurations`, `resource_configuration_members`                         | **Verified** | `0300_scheduling_core.sql`; `resources.spec.ts` "configurations name which resources may operate simultaneously (SPK-SCHED-002)"; `events.spec.ts` "SPK-SCHED-002: compatible formats and configured arrangements are enforced" |
| Scheduling      | ConflictUnit    | scheduling    | `conflict_units`, `resource_conflict_units`                                         | **Verified** | `0300_scheduling_core.sql`; `schema-invariants.spec.ts` "a whole-pitch reservation conflicts with any overlapping half-pitch reservation" and "two halves ... may be reserved simultaneously"                                   |
| Scheduling      | Event           | scheduling    | `events`                                                                            | **Verified** | `0300_scheduling_core.sql`; `events.spec.ts`; `event-series.spec.ts`                                                                                                                                                            |
| Scheduling      | Reservation     | scheduling    | `reservations`, `reservation_units` (GiST exclusion `reservation_units_no_overlap`) | **Verified** | `0300_scheduling_core.sql`; `schema-invariants.spec.ts` (SPK-SCHED-002/003, invariant 4); `schedule-drafts.spec.ts` "SPK-AT-008"                                                                                                |
| Scheduling      | ScheduleDraft   | scheduling    | `schedule_drafts`, `draft_changes`                                                  | **Verified** | `0300_scheduling_core.sql`; `schedule-drafts.spec.ts` (SPK-SCHED-005/006)                                                                                                                                                       |
| (SPK-SCHED-001) | OperatingHours  | scheduling    | `operating_hours`                                                                   | **Verified** | `0300_scheduling_core.sql`; `events.spec.ts` "SPK-SCHED-001: operating hours bound events". Values are **Pending decision**: Operations (DEC-001)                                                                               |
| (SPK-SCHED-009) | Closure         | scheduling    | `closures`                                                                          | **Verified** | `0300_scheduling_core.sql`; `closures.spec.ts` (SPK-SCHED-009, SPK-FAC-003/004, SPK-AT-009/021)                                                                                                                                 |
| (SPK-SCHED-007) | EventSeries     | scheduling    | `event_series`                                                                      | **Verified** | `0300_scheduling_core.sql`; `event-series.spec.ts` (SPK-SCHED-007/008)                                                                                                                                                          |
| (SPK-SCHED-004) | EventCommitment | scheduling    | `event_commitments` (GiST exclusion `event_commitments_no_overlap`)                 | **Verified** | `0300_scheduling_core.sql`; `schema-invariants.spec.ts` "SPK-SCHED-004: team and official commitments cannot overlap"; `events.spec.ts`                                                                                         |
| (SPK-SCHED-006) | Publication     | scheduling    | `publications` (append-only)                                                        | **Verified** | `0300_scheduling_core.sql`; `schedule-drafts.spec.ts` "SPK-SCHED-006: publication commits creates, moves and cancels in one group"; `schema-invariants.spec.ts` "§4.7 invariant 9: publications are append-only"                |

### 3.6 Enrollment: participation and capacity (§4.2 "Applications, eligibility, capacity, waitlists")

| §4.4 area       | Entity            | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                           |
| --------------- | ----------------- | ------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Participation   | Application       | enrollment    | none                  | **Proposed** | SPK-REG-001 (the eight intents), SPK-REG-002 (eligibility result and reasons), SPK-REG-003 (approval is independent of enrollment); `ApplicationMachine` (**Verified**, section 6.1); `apps/api/src/modules/enrollment/README.md` (scaffold, migration range 0500)                 |
| Participation   | Enrollment        | enrollment    | none                  | **Proposed** | SPK-REG-003; SPK-REG-010 (a transfer connects the old and new enrollments and preserves attendance); §4.5 "Enrollment must not combine confirmation and waitlisting in one simplified status"; `EnrollmentMachine` (**Verified**, section 6.2)                                     |
| Participation   | PlacementRequest  | enrollment    | none                  | **Proposed** | SPK-PLACE-001..003, SPK-PLACE-005 (operator-mediated); `PlacementMachine` (**Verified**, section 6.3). The assigned target is a competition `TeamEntry`                                                                                                                            |
| Participation   | SessionBooking    | enrollment    | none                  | **Proposed** | SPK-CAT-002 "Individual sessions", SPK-PLACE-004 pickup sessions, SPK-YOUTH-004 makeups; `SessionBookingMachine` (**Verified**, section 6.5)                                                                                                                                       |
| Capacity        | CapacityPool      | enrollment    | none                  | **Proposed** | SPK-REG-005 (units: team entries, roster places, offering seats, session seats, camp-group places, rental resources, multiple simultaneous constraints; "must include active holds and accepted commitments"); SPK-YOUTH-002 (staffing requirement not bypassed); §4.7 invariant 3 |
| Capacity        | Hold              | enrollment    | none                  | **Proposed** | SPK-REG-006 (server-owned, expiring; one terminal outcome). Starting duration ten minutes is a **Proposed** default, **Pending decision**: Product and operations (DEC-027, which also depends on DEC-019); `HoldMachine` (**Verified**, section 6.4)                              |
| Capacity        | Allocation        | enrollment    | none                  | **Proposed** | SPK-REG-005 "accepted commitments"; the committed form of a hold, pointing at the enrollment, team entry or session booking it serves; SPK-AT-005 "at most one valid commitment"                                                                                                   |
| Capacity        | WaitlistEntry     | enrollment    | none                  | **Proposed** | SPK-REG-008 (participant, offering, priority basis, preferences, status, offer history). Priority policy is **Pending decision**: Product and operations (DEC-006)                                                                                                                 |
| Capacity        | WaitlistOffer     | enrollment    | none                  | **Proposed** | SPK-REG-008 ("An offer reserves a defined place until expiry. Acceptance consumes it once."); SPK-AT-006 (late payment never displaces a valid offer); §4.8 `POST /v1/waitlist-offers/{id}/accept`                                                                                 |
| (SPK-YOUTH-004) | MakeupEntitlement | enrollment    | none                  | **Proposed** | SPK-YOUTH-004 (originating session or policy event, eligible replacements, expiry, redemption limit, redemption history; distinct from a monetary credit); SPK-AT-020; §4.7 invariant 7                                                                                            |
| (SPK-YOUTH-005) | Assessment        | enrollment    | none                  | **Proposed** | SPK-YOUTH-005 (skill area, observation date, scale, author, comments, visibility, review status; private notes separate from parent-visible feedback); SPK-COMMS-002 "Approved youth feedback"                                                                                     |

### 3.7 Finance and accounting support (§4.2 "Quotes, orders, obligations, receipts, adjustments")

| §4.4 area          | Entity                   | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------ | ------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finance            | Quote                    | finance       | none                  | **Proposed** | SPK-PAY-002 (participant and item, base price, discounts, approved taxes and fees, credits applied, due now, future obligations, expiry, policies); `QUOTE_EXPIRED` (**Verified** code); §4.8 `POST /v1/registration-quotes`. Values **Pending decision**: Finance (DEC-007)             |
| Finance            | Order                    | finance       | none                  | **Proposed** | §4.11 step 4 "Create the order and durable operation"; SPK-PAY-011 distinguishes orders from obligations and receipts; `apps/api/src/modules/finance/README.md` (scaffold, migration range 0600)                                                                                         |
| Finance            | OrderLine                | finance       | none                  | **Proposed** | SPK-REG-004 (each line keeps its own participant, entitlement, eligibility result, price, policy, enrollment outcome). All-or-nothing household fulfillment is a **Proposed** default, **Pending decision**: Product and operations (DEC-026)                                            |
| Finance            | Obligation               | finance       | none                  | **Proposed** | SPK-PAY-004 (individual billing, one responsible team payer, team obligation with contributions; total, received, allocated, remaining), SPK-PAY-006 (installments). Billing model **Pending decision**: Finance and league manager (DEC-008)                                            |
| Finance            | PaymentAttempt           | finance       | none                  | **Proposed** | SPK-PAY-007 (a timeout is not failure; `unknown` reconciled before another charge); §4.5 "Payment must not reduce provider outcomes to only paid/refunded"; `PaymentAttemptMachine` (**Verified**, section 6.6). Processor **Pending decision**: Technical lead/account owners (DEC-019) |
| Finance            | RefundAttempt            | finance       | none                  | **Proposed** | SPK-PAY-008 (reserve the refundable amount first; concurrent requests cannot reserve the same funds; unknown retains the reservation); SPK-AT-007; `RefundMachine` (**Verified**, section 6.7); §4.7 invariant 6. Rules **Pending decision**: Finance (DEC-009)                          |
| Finance            | Credit                   | finance       | none                  | **Proposed** | SPK-PAY-009 (owner, currency, permitted uses, expiry when approved, remaining balance, source, redemption history; no double redemption); §4.7 invariant 7                                                                                                                               |
| (§4.6, §4.11)      | Checkout                 | finance       | none                  | **Proposed** | §4.11 coordinator steps 1..10; `CheckoutMachine` (**Verified**, section 6.8); §4.8 `POST /v1/registration-checkouts`; the `operations` row it creates is **Verified** infrastructure                                                                                                     |
| (SPK-PAY-006)      | InstallmentPlan          | finance       | none                  | **Proposed** | SPK-PAY-006 (amounts, due dates, authorization, retry policy, notices, extensions, outstanding obligations). Conditional capability (§1.6); applicability **Pending decision**: Product owner (DEC-016)                                                                                  |
| Accounting support | Journal                  | finance       | none                  | **Proposed** | SPK-PAY-010 "append-only operational subledger"; corrections are reversing or adjusting entries; `forbid_mutation` trigger pattern (**Verified** in `0001_core_schema.sql`)                                                                                                              |
| Accounting support | JournalEntry             | finance       | none                  | **Proposed** | SPK-PAY-010, SPK-PAY-011 (orders, obligations, receipts, refunds, credits, processor fees, disputes, settlements, cash kept distinct); §4.7 invariant 5 "no duplicate financial effect from replay" (realised by `event_consumptions`, **Verified**)                                     |
| Accounting support | PaymentAllocation        | finance       | none                  | **Proposed** | SPK-PAY-004 "allocated amount", SPK-PAY-005 (overpayment visible and traceable), SPK-AT-022                                                                                                                                                                                              |
| Accounting support | SettlementReconciliation | finance       | none                  | **Proposed** | SPK-PAY-011, §5.5; §4.11 step 10 "Reconcile or compensate failures"; SPK-AT-028                                                                                                                                                                                                          |

### 3.8 Workforce (§4.2 "Availability, assignments, approved fees")

| §4.4 area | Entity        | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------- | ------------- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workforce | Availability  | workforce     | none                  | **Proposed** | SPK-STAFF-001; `apps/api/src/modules/workforce/README.md` (scaffold, migration range 0700)                                                                                                                                                                                                                                 |
| Workforce | Qualification | workforce     | none                  | **Proposed** | SPK-STAFF-001 "qualification evidence where required". Required evidence is **Pending decision**: Operations/finance (DEC-011)                                                                                                                                                                                             |
| Workforce | Assignment    | workforce     | none                  | **Proposed** | SPK-STAFF-002 (proposed, offered, accepted, declined, withdrawn, completed), SPK-STAFF-003 (overlap and turnaround), SPK-STAFF-004 (time-bounded access); `AssignmentMachine` (**Verified**, section 6.10). The person's overlap guard is a scheduling `event_commitments` row with `party_type = 'person'` (**Verified**) |
| Workforce | FeeSubmission | workforce     | none                  | **Proposed** | SPK-STAFF-006 (assignment, rate basis, submitted amount, approver, adjustment history, export status; not payroll). Rate basis **Pending decision**: Operations/finance (DEC-011)                                                                                                                                          |

### 3.9 Entry: arrival, attendance, departure and pickup (§4.2 "Arrival, attendance, departure, release")

| §4.4 area       | Entity                | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------- | ------------- | --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arrival         | Visit                 | entry         | none                  | **Proposed** | SPK-ENTRY-001 "Facility arrival", SPK-ENTRY-006 (visitor categories without fabricated enrollments), SPK-ENTRY-008 (arrivals are not verified occupancy); `apps/api/src/modules/entry/README.md` (scaffold, migration range 0800)                                                                                                                                                                           |
| Arrival         | AttendanceObservation | entry         | none                  | **Proposed** | SPK-ENTRY-001 "Session check-in" and "Observed attendance", SPK-ENTRY-003 (staff select the people and sessions actually attending), SPK-ENTRY-005 (corrections preserve actor, time, reason: a new row referencing the corrected one); §4.5 "Attendance must preserve observations and corrections"; §4.15 queued observations (unique id, actor, event, observed time, snapshot reference, received time) |
| Arrival         | Departure             | entry         | none                  | **Proposed** | SPK-ENTRY-001 "Departure", SPK-ENTRY-008                                                                                                                                                                                                                                                                                                                                                                    |
| Arrival         | ReleaseRecord         | entry         | none                  | **Proposed** | SPK-ENTRY-007 (child, collecting person, verification outcome, staff actor, time, restriction or escalation, release outcome); SPK-AT-016; the authority check is the identity `collect` grant (**Verified**, `relationships.spec.ts`). Procedure **Pending decision**: Operations (DEC-005)                                                                                                                |
| (SPK-ENTRY-002) | Pass                  | entry         | none                  | **Proposed** | SPK-ENTRY-002 (opaque reference, never child or household details); SPK-COND-004 (hardware access is not attendance or pickup authorization)                                                                                                                                                                                                                                                                |

### 3.10 Facilities (§4.2 "Assets, maintenance, operating restrictions")

| §4.4 area  | Entity          | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                                         |
| ---------- | --------------- | ------------- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facilities | Asset           | facilities    | none                  | **Proposed** | SPK-FAC-001 (turf areas, goals, nets, boards, dividers, lighting, scoreboards, equipment); `apps/api/src/modules/facilities/README.md` (scaffold, migration range 0900). Inventory **Pending decision**: Operations (DEC-001)    |
| Facilities | MaintenanceTask | facilities    | none                  | **Proposed** | SPK-FAC-002 (asset or space, issue, severity, reporter, evidence, owner, due date, operating restriction, resolution and inspection)                                                                                             |
| Facilities | Inspection      | facilities    | none                  | **Proposed** | SPK-FAC-004 "Closing a maintenance task must not silently reopen a field if a separate inspection remains required"                                                                                                              |
| Facilities | Restriction     | facilities    | none                  | **Proposed** | SPK-FAC-003/005; realised as a scheduling `closures` row with `source = 'maintenance'` created through `CLOSURE_PORT` (`apps/api/src/modules/scheduling/ports.ts`, **Verified**; `closures.spec.ts` SPK-FAC-003/004, SPK-AT-021) |

### 3.11 Communications (§4.2 "Audiences, notices, delivery attempts")

| §4.4 area       | Entity                    | Owning module  | Physical record today | Status       | Evidence                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------- | -------------- | --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Communications  | Notification              | communications | none                  | **Proposed** | SPK-COMMS-002 (triggers), SPK-COMMS-003 (recipients from current permissions, rechecked before external handoff), SPK-COMMS-005 (old and new practical details; obsolete reminders suppressed); `apps/api/src/modules/communications/README.md` (scaffold, migration range 1000) |
| Communications  | DeliveryAttempt           | communications | none                  | **Proposed** | SPK-COMMS-004 (queued, provider accepted, delivered where confirmed, failed, unknown, read, acknowledged); §4.5 "Messages must represent actual delivery states". Providers **Pending decision**: Technical lead/account owners (DEC-020)                                        |
| Communications  | Preference                | communications | none                  | **Proposed** | SPK-COMMS-007 (essential operational versus promotional, separately represented), SPK-COMMS-001 channels. Policy **Pending decision**: Operator/privacy owner (DEC-012, DEC-062)                                                                                                 |
| Communications  | Acknowledgment            | communications | none                  | **Proposed** | SPK-COMMS-004 "Acknowledged"; distinct from the policy Acknowledgment of section 3.3 (a customer acknowledging a notice versus a guardian acknowledging a policy version)                                                                                                        |
| (SPK-COMMS-006) | Audience                  | communications | none                  | **Proposed** | SPK-COMMS-006 (staff compose against an authorized audience, preview recipients, confirm; no shared recipient list)                                                                                                                                                              |
| (SPK-COMMS-008) | CalendarFeedAuthorization | communications | none                  | **Proposed** | SPK-COMMS-008 (stable event identities, revocable authorization); SPK-IAM-006 (revocation affects private feed retrieval)                                                                                                                                                        |

### 3.12 Migration (§4.2 "Imports, mappings, authority records")

| §4.4 area | Entity              | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                                                         |
| --------- | ------------------- | ------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration | ExternalMapping     | migration     | none                  | **Proposed** | §5.3 "Preserve external identifiers and extraction provenance. Names and emails are not reliable migration keys."; SPK-AT-024; `apps/api/src/modules/migration/README.md` (scaffold, migration range 1200)       |
| Migration | ImportBatch         | migration     | none                  | **Proposed** | §5.4 (source, timestamp, checksum, transformation version, row outcomes, validation errors, review decisions; reimport never charges or notifies)                                                                |
| Migration | ImportException     | migration     | none                  | **Proposed** | §5.4 "Ambiguous relationships and balances enter review queues"                                                                                                                                                  |
| Migration | AuthorityAssignment | migration     | none                  | **Proposed** | §5.6 (one authority per record category and scope; a synchronized copy is not a writer); §4.7 invariant 11; `docs/package-a/authority-matrix.md`. Scope **Pending decision**: Migration owner/operator (DEC-014) |

### 3.13 Reporting and automation (§4.2; no §4.4 entities)

| Entity           | Owning module | Physical record today | Status       | Evidence                                                                                                                                                                           |
| ---------------- | ------------- | --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MetricDefinition | reporting     | none                  | **Proposed** | SPK-REPORT-001 (business question, grain, numerator and denominator, time basis, exclusions, dimensions, currency, freshness, access scope); `docs/package-a/metric-dictionary.md` |
| Export           | reporting     | none                  | **Proposed** | SPK-REPORT-007 (independent permission check, audit, reproducible after corrections); §4.14 "Expiring exports"                                                                     |
| Recommendation   | automation    | none                  | **Proposed** | SPK-AUTO-001..004 (supporting records and freshness; consequential actions reviewable; same commands and permissions)                                                              |

## 4. Verified diagrams: what exists in migrations today

### 4.1 Kernel (`0001_core_schema.sql`, `packages/db/src/schema/core.ts`)

**Verified** (`packages/db/src/core-schema.spec.ts`, `apps/api/src/kernel/__tests__/*.spec.ts`). Dashed lines are references without a database foreign key (`operation_id` on `audit_records` and `outbox_events`; `event_consumptions.event_id`, which holds an outbox or an inbox event id; `job_attempts.source_id`).

```mermaid
erDiagram
    Organization ||--o{ Facility : "owns"
    Organization ||--o{ Operation : "scopes"
    Organization ||--o{ AuditRecord : "scopes"
    Organization ||--o{ IdempotencyKey : "scopes"
    Organization ||--o{ OutboxEvent : "scopes"
    Organization o|--o{ InboxEvent : "scopes when known"
    Organization o|--o{ JobAttempt : "scopes when known"
    Organization ||--o{ OperationalException : "scopes"
    Facility o|--o{ OperationalException : "facility_id optional"
    Operation o|--o{ IdempotencyKey : "operation_id"
    Operation o|..o{ OutboxEvent : "operation_id"
    Operation o|..o{ AuditRecord : "operation_id"
    OutboxEvent ||..o{ EventConsumption : "event_id"
    InboxEvent ||..o{ EventConsumption : "event_id"
    OutboxEvent ||..o{ JobAttempt : "source outbox"
    InboxEvent ||..o{ JobAttempt : "source inbox"

    Organization {
        uuid id PK
        text slug UK
        text status "active suspended archived"
        int revision
    }
    Facility {
        uuid id PK
        uuid organization_id FK
        text slug "unique per organization"
        text timezone "IANA"
        text status "active closed archived"
        int revision
    }
    Operation {
        uuid id PK
        uuid organization_id FK
        text kind
        text status "pending running succeeded failed recovery_required compensated"
        jsonb requested_by "actor snapshot"
        text correlation_id
        jsonb result
        jsonb error
        int revision
    }
    AuditRecord {
        uuid id PK
        uuid organization_id FK
        jsonb actor "snapshot never child data"
        text action
        text target_type
        text target_id
        int before_revision
        int after_revision
        text reason
        text correlation_id
        uuid operation_id
    }
    IdempotencyKey {
        uuid organization_id PK
        text scope_key PK "account or principal"
        text idempotency_key PK
        text request_hash
        text status "in_progress completed"
        int response_status
        jsonb response_body
        uuid operation_id FK
        timestamptz expires_at
    }
    OutboxEvent {
        uuid id PK "stable event identity"
        uuid organization_id FK
        text event_type
        text aggregate_type
        text aggregate_id
        jsonb payload
        text correlation_id
        text causation_id
        uuid operation_id
        text status "pending dispatched dead"
        timestamptz available_at
        int attempts
        int max_attempts
        text locked_by
        timestamptz locked_until
        text failure_owner
    }
    InboxEvent {
        uuid id PK
        text provider UK
        text provider_event_id UK
        uuid organization_id FK
        text event_type
        bool signature_verified
        text status "received processed failed ignored dead"
        int attempts
    }
    EventConsumption {
        text handler PK
        uuid event_id PK
        timestamptz consumed_at
    }
    JobAttempt {
        uuid id PK
        text source "outbox inbox scheduled"
        uuid source_id
        text handler
        int attempt_number
        text worker_id
        text outcome "succeeded failed skipped"
        text correlation_id
    }
    OperationalException {
        uuid id PK
        uuid organization_id FK
        uuid facility_id FK
        text category
        text severity "info warning high critical"
        text owner_queue
        text status "open acknowledged resolved closed"
        text dedupe_key "unique while open"
        int revision
    }
```

| Diagram entity       | Table                    | Notes                                                                                                                                                                        | Status       |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Organization         | `organizations`          | §4.3; `unique (organization_id, id)` on `facilities` is the anchor for every composite foreign key                                                                           | **Verified** |
| Facility             | `facilities`             | `timezone` is the source of facility-local behaviour (SPK-SCHED-008)                                                                                                         | **Verified** |
| Operation            | `operations`             | Readable outcome of asynchronous and multi-step commands (`GET /v1/operations/{id}`); terminal statuses `succeeded`, `failed`, `compensated` (`operations.service.ts`)       | **Verified** |
| AuditRecord          | `audit_records`          | Append-only (`forbid_mutation`)                                                                                                                                              | **Verified** |
| IdempotencyKey       | `idempotency_keys`       | Primary key `(organization_id, scope_key, idempotency_key)`; same key + same `request_hash` replays, different hash conflicts (§4.9)                                         | **Verified** |
| OutboxEvent          | `outbox_events`          | Written in the business transaction; carries every §4.12 job field (organization, operation, stable identity, attempts, retry policy, correlation, failure owner)            | **Verified** |
| InboxEvent           | `inbox_events`           | `unique (provider, provider_event_id)` makes recording idempotent (§4.11 webhooks)                                                                                           | **Verified** |
| EventConsumption     | `event_consumptions`     | Primary key `(handler, event_id)`: one business effect per handler per event even when delivery repeats                                                                      | **Verified** |
| JobAttempt           | `job_attempts`           | One row per handler run with worker id and outcome                                                                                                                           | **Verified** |
| OperationalException | `operational_exceptions` | Powers the Today workspace (SPK-UX-006); closing it never resolves the underlying record; partial unique index on `(organization_id, dedupe_key)` while open or acknowledged | **Verified** |

### 4.2 Identity (`0100_identity_core.sql`, `packages/db/src/schema/identity.ts`)

**Verified** (`apps/api/src/modules/identity/__tests__/*.spec.ts`, `identity.machines.spec.ts`). Authority is only an unrevoked, unsuspended, currently effective `access_grants` row on an active relationship (SPK-IAM-003); households never confer authority (§4.5).

```mermaid
erDiagram
    Organization ||--o{ Person : "scopes"
    Person ||--o{ ContactPoint : "person_id"
    Person o|--o{ Account : "person_id nullable one active"
    Person o|--o{ Person : "merged_into_person_id"
    Household ||--o{ HouseholdMembership : "household_id"
    Person ||--o{ HouseholdMembership : "person_id grouping only"
    Person ||--o{ Relationship : "actor_person_id"
    Person ||--o{ Relationship : "subject_person_id"
    Relationship ||--o{ AccessGrant : "relationship_id same two people"
    AccessReview o|--o{ AccessGrant : "suspended_by_review_id"
    Person ||--o{ Invitation : "scope_person_id optional"
    Household o|--o{ Invitation : "scope_household_id optional"
    Person o|--o{ Invitation : "recipient_person_id optional"
    Person ||--o{ Claim : "subject_person_id"
    Account o|--o{ Claim : "accepted_by_account_id"
    Person ||--o{ StaffMembership : "person_id"
    Person ||--o{ AccessReview : "subject_person_id"
    AccessReview ||--o{ AccessReviewDecision : "review_id append-only"
    Person ||--o{ DuplicateCandidate : "person_a_id person_b_id a lt b"
    DuplicateCandidate o|--o{ PersonMerge : "candidate_id"
    Person ||--o{ PersonMerge : "survivor_person_id merged_person_id"
    Operation o|--o{ PersonMerge : "operation_id"

    Person {
        uuid id PK
        uuid organization_id FK
        text kind "adult child"
        date date_of_birth "minimized child data"
        text status "active inactive merged"
        uuid merged_into_person_id FK
        text source "staff self_service import"
        jsonb created_by "actor snapshot"
        int revision
    }
    ContactPoint {
        uuid id PK
        uuid person_id FK
        text kind "email phone"
        text value
        bool is_primary "one per kind"
        timestamptz verified_at "verified primary unique per org"
    }
    Account {
        uuid id PK
        text issuer UK
        text subject UK
        uuid person_id FK "nullable until claimed"
        text status "active disabled"
        int revision
    }
    Household {
        uuid id PK
        uuid organization_id FK
        text name
        int revision
    }
    HouseholdMembership {
        uuid id PK
        uuid household_id FK
        uuid person_id FK
        text label
    }
    Relationship {
        uuid id PK
        uuid actor_person_id FK
        uuid subject_person_id FK
        text kind "guardian delegate caregiver self_managed"
        text status "active suspended ended"
        timestamptz effective_from
        timestamptz effective_to
        text source
        int revision
    }
    AccessGrant {
        uuid id PK
        uuid relationship_id FK "deferred 4-column FK"
        uuid actor_person_id FK
        uuid subject_person_id FK
        text permission "view register pay receive_messages complete_forms collect"
        timestamptz effective_from "GiST exclusion while unrevoked"
        timestamptz effective_to
        timestamptz revoked_at
        timestamptz suspended_at
        uuid suspended_by_review_id FK
        int revision
    }
    Invitation {
        uuid id PK
        text scope_type "person household"
        text relationship_kind
        text_array requested_permissions
        text_array granted_permissions
        text token_hash UK
        text status "pending accepted revoked expired"
        timestamptz expires_at
        int revision
    }
    Claim {
        uuid id PK
        uuid subject_person_id FK
        text kind "self guardian"
        text_array requested_permissions
        text token_hash UK
        text status "pending accepted revoked expired"
        timestamptz expires_at
        int revision
    }
    StaffMembership {
        uuid id PK
        uuid person_id FK
        text_array roles "StaffRole vocabulary"
        uuid_array facility_ids "empty means every facility"
        text status "active ended"
        timestamptz effective_from
        timestamptz effective_to
        int revision
    }
    AccessReview {
        uuid id PK
        uuid subject_person_id FK
        text owner_role "general_manager system_administrator support_operator"
        text status "open escalated decided closed"
        jsonb parties
        jsonb evidence
        timestamptz effective_from
        timestamptz effective_to
        int revision
    }
    AccessReviewDecision {
        uuid id PK
        uuid review_id FK
        int sequence "unique per review"
        text kind "restrict lift escalate decide close note reassign"
        uuid_array affected_grant_ids
    }
    DuplicateCandidate {
        uuid id PK
        uuid person_a_id FK
        uuid person_b_id FK
        int score "0 to 100"
        text status "open merged dismissed"
        int revision
    }
    PersonMerge {
        uuid id PK
        uuid survivor_person_id FK
        uuid merged_person_id FK "merged at most once"
        uuid candidate_id FK
        jsonb moved
        uuid operation_id FK
    }
```

| Diagram entity                     | Table                                       | Key integrity rule                                                                                                                                                           | Status       |
| ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Person                             | `persons`                                   | `(status = 'merged') = (merged_into_person_id is not null)`; a merged person keeps its row so history stays reachable (SPK-IAM-007)                                          | **Verified** |
| ContactPoint                       | `contact_points`                            | One primary per kind per person; a verified primary identifier is unique per organization (`contact_points_verified_identifier_idx`)                                         | **Verified** |
| Account                            | `accounts`                                  | `unique (issuer, subject)`; `accounts_one_active_per_person_idx`; recovery relinks the same row and never touches grants (SPK-AT-025)                                        | **Verified** |
| Household, HouseholdMembership     | `households`, `household_memberships`       | Grouping only; never consulted by any authority check (§4.5)                                                                                                                 | **Verified** |
| Relationship                       | `relationships`                             | `relationships_live_idx`: one live row per (actor, subject, kind); `self_managed` only when actor = subject                                                                  | **Verified** |
| AccessGrant                        | `access_grants`                             | One row per permission; four-column deferred FK to the relationship; GiST exclusion forbids overlapping unrevoked grants for one permission; revoke and suspend keep the row | **Verified** |
| Invitation                         | `invitations`                               | SPK-IAM-004 fields; only the token hash is stored; acceptance grants only what the inviter still holds (`invitations.spec.ts`)                                               | **Verified** |
| Claim                              | `claims`                                    | SPK-IAM-002; `self` claims carry no permissions, `guardian` claims at least one                                                                                              | **Verified** |
| StaffMembership                    | `staff_memberships`                         | Staff authority comes only from here, time-bounded; roles limited to the `StaffRole` vocabulary (`packages/contracts/src/principal.ts`)                                      | **Verified** |
| AccessReview, AccessReviewDecision | `access_reviews`, `access_review_decisions` | SPK-IAM-005; decisions are append-only; a `restrict` decision suspends grants without deleting them                                                                          | **Verified** |
| DuplicateCandidate, PersonMerge    | `duplicate_candidates`, `person_merges`     | Canonical pair (`person_a_id < person_b_id`); a merge is an append-only fact; `person_merges_merged_once_idx`                                                                | **Verified** |

### 4.3 Scheduling (`0300_scheduling_core.sql`, `packages/db/src/schema/scheduling.ts`)

**Verified** (`apps/api/src/modules/scheduling/__tests__/*.spec.ts`, `time/recurrence.spec.ts`). Overlap between resources is expressed only through shared conflict units; `reservation_units_no_overlap` is the database guarantee of §4.7 invariant 4.

```mermaid
erDiagram
    Facility ||--o{ Resource : "facility_id"
    Resource o|--o{ Resource : "parent_resource_id subdivision"
    Facility ||--o{ ResourceConfiguration : "facility_id"
    ResourceConfiguration ||--o{ ResourceConfigurationMember : "configuration_id"
    Resource ||--o{ ResourceConfigurationMember : "resource_id"
    Facility ||--o{ ConflictUnit : "facility_id"
    Resource ||--o{ ResourceConflictUnit : "resource_id"
    ConflictUnit ||--o{ ResourceConflictUnit : "conflict_unit_id"
    Facility ||--o{ OperatingHours : "facility_id"
    Resource o|--o{ OperatingHours : "resource_id null means facility"
    Facility ||--o{ Closure : "facility_id"
    Resource o|--o{ Closure : "resource_id null means facility"
    Facility ||--o{ EventSeries : "facility_id"
    EventSeries o|--o{ Event : "series_id occurrence_index unique"
    Facility ||--o{ Event : "facility_id"
    Event ||--o{ Reservation : "event_id"
    Resource ||--o{ Reservation : "resource_id"
    Reservation ||--o{ ReservationUnit : "reservation_id"
    ConflictUnit ||--o{ ReservationUnit : "conflict_unit_id GiST exclusion"
    Event ||--o{ ReservationUnit : "event_id"
    Event ||--o{ EventCommitment : "event_id party overlap exclusion"
    Facility ||--o{ ScheduleDraft : "facility_id"
    ScheduleDraft ||--o{ DraftChange : "draft_id"
    Event o|--o{ DraftChange : "target_event_id"
    ScheduleDraft ||--o{ Publication : "draft_id append-only"
    Facility ||--o{ Publication : "facility_id"
    Operation o|..o{ Publication : "operation_id"

    Resource {
        uuid id PK
        uuid facility_id FK
        text kind "pitch subdivision room other"
        text name "unique per facility"
        uuid parent_resource_id FK
        text_array compatible_formats
        int default_setup_minutes
        int default_cleanup_minutes
        text status "active restricted closed"
        int revision
    }
    ResourceConfiguration {
        uuid id PK
        uuid facility_id FK
        text name "unique per facility"
        bool active
        int revision
    }
    ResourceConfigurationMember {
        uuid configuration_id PK
        uuid resource_id PK
    }
    ConflictUnit {
        uuid id PK
        uuid facility_id FK
        text name "unique per facility"
    }
    ResourceConflictUnit {
        uuid resource_id PK
        uuid conflict_unit_id PK
    }
    OperatingHours {
        uuid id PK
        uuid facility_id FK
        uuid resource_id FK
        smallint weekday "0 Sunday to 6 Saturday"
        time opens_at "facility local"
        time closes_at
    }
    Closure {
        uuid id PK
        uuid facility_id FK
        uuid resource_id FK
        tstzrange during
        text source "manual maintenance holiday"
        text status "pending active lifted withdrawn"
        jsonb impact
        jsonb resolution
        int revision
    }
    EventSeries {
        uuid id PK
        uuid facility_id FK
        text kind
        text timezone "IANA"
        jsonb recurrence
        time local_start_time
        text nonexistent_policy "shift_forward skip"
        text ambiguous_policy "first second"
        text status "active ended"
        int revision
    }
    Event {
        uuid id PK
        uuid facility_id FK
        text kind "game practice session rental party pickup maintenance block"
        uuid series_id FK
        int occurrence_index
        timestamptz scheduled_start "UTC"
        timestamptz scheduled_end
        text timezone "IANA copied from facility"
        text dst_resolution "exact shifted_forward first second"
        text status "draft published canceled"
        int published_revision
        text source_type "owning record fixture session rental"
        uuid source_id
        int revision
    }
    Reservation {
        uuid id PK
        uuid event_id FK
        uuid resource_id FK
        tstzrange occupied "scheduled plus buffers"
        text status "active released"
    }
    ReservationUnit {
        uuid id PK
        uuid reservation_id FK
        uuid event_id FK
        uuid conflict_unit_id FK
        tstzrange occupied "exclusion while active"
        text status "active released"
    }
    EventCommitment {
        uuid id PK
        uuid event_id FK
        text party_type "team person equipment"
        uuid party_id "cross-module reference"
        text role
        tstzrange occupied "exclusion per party while active"
        text status "active released"
    }
    ScheduleDraft {
        uuid id PK
        uuid facility_id FK
        jsonb base_revision "captured event revisions"
        jsonb author "actor snapshot"
        text status "editing validated publishing published failed discarded"
        jsonb validation_results
        uuid publication_group_id
        int revision
    }
    DraftChange {
        uuid id PK
        uuid draft_id FK
        int sequence "unique per draft"
        text kind "create move cancel resize resource_change"
        uuid target_event_id FK
        int base_event_revision
        jsonb proposed
    }
    Publication {
        uuid id PK
        uuid draft_id FK
        uuid facility_id FK
        jsonb actor
        timestamptz committed_at
        uuid_array event_ids
        uuid_array notice_event_ids
        jsonb summary "changes and remaining obligations"
        uuid operation_id
    }
```

| Diagram entity                                     | Table                                                       | Key integrity rule                                                                                                                                                                                               | Status       |
| -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Resource                                           | `resources`                                                 | A subdivision always has a parent (`kind <> 'subdivision' or parent_resource_id is not null`); SPK-SCHED-001 attributes                                                                                          | **Verified** |
| ResourceConfiguration, ResourceConfigurationMember | `resource_configurations`, `resource_configuration_members` | Names the set of resources that may operate simultaneously (SPK-SCHED-002)                                                                                                                                       | **Verified** |
| ConflictUnit, ResourceConflictUnit                 | `conflict_units`, `resource_conflict_units`                 | A whole pitch maps to all units of its subdivisions; a subdivision maps to its own (SPK-SCHED-002)                                                                                                               | **Verified** |
| OperatingHours                                     | `operating_hours`                                           | Facility-local windows per weekday; resource windows override facility windows                                                                                                                                   | **Verified** |
| Closure                                            | `closures`                                                  | `pending → active → lifted`, `withdrawn` from pending (`ClosureMachine`); impact preview names games, programs, rentals, parties (SPK-SCHED-009)                                                                 | **Verified** |
| EventSeries, Event                                 | `event_series`, `events`                                    | Instants in UTC with the facility zone (SPK-SCHED-008); `events_series_occurrence_idx` gives each occurrence a stable identity (SPK-SCHED-007); `status <> 'published' or published_revision is not null`        | **Verified** |
| Reservation, ReservationUnit                       | `reservations`, `reservation_units`                         | `occupied` = scheduled interval plus setup and cleanup buffers (SPK-SCHED-003); `reservation_units_no_overlap` GiST exclusion on `(organization_id, conflict_unit_id, occupied)` while active (§4.7 invariant 4) | **Verified** |
| EventCommitment                                    | `event_commitments`                                         | `event_commitments_no_overlap` on `(organization_id, party_type, party_id, occupied)` while active: teams, people and equipment cannot be double-booked (SPK-SCHED-004)                                          | **Verified** |
| ScheduleDraft, DraftChange                         | `schedule_drafts`, `draft_changes`                          | SPK-SCHED-005 fields; autosave guarded by the draft revision; `create` is the only change kind without a target event                                                                                            | **Verified** |
| Publication                                        | `publications`                                              | Append-only publication group (§4.7 invariant 9); carries `operation_id` of the `scheduling.publish_schedule` operation and the remaining fixture obligations (SPK-FIX-002)                                      | **Verified** |

## 5. Proposed diagrams: the §4.4 entities not yet in a migration

Every entity in this section is **Proposed**. The relationships are derived from the requirement text cited in section 3. Where a Proposed entity points at a Verified one (Person, Facility, Resource, Event, Operation), the reference is by `(organization_id, id)` composite foreign key, following the convention of section 2.

### 5.1 Catalog and policies

```mermaid
erDiagram
    Program ||--o{ Offering : "reusable definition to dated offering"
    Offering ||--o{ Session : "individual sessions"
    Offering }o--|| EntitlementDefinition : "participation entitlement"
    Offering }o--o{ PolicyVersion : "cancellation eligibility and price policies"
    Offering ||--o{ PriceRuleVersion : "versioned price rules"
    Facility ||--o{ Offering : "location"
    Person o|--o{ Offering : "responsible manager"
    Session ||..|| Event : "scheduling event with source_type session"
    PolicyVersion ||--o{ Acknowledgment : "acknowledged version"
    Person ||--o{ Acknowledgment : "acknowledging person"
    Person ||--o{ Acknowledgment : "participant"
    PolicyVersion o|--o{ Approval : "policy requiring approval"
    Approval }o--|| PolicyVersion : "basis"

    Program {
        uuid id PK
        text name
        text activity_type
        text status "draft published archived"
        int revision
    }
    Offering {
        uuid id PK
        uuid program_id FK
        uuid facility_id FK
        text kind "season term camp session trial makeup pickup coaching rental package membership"
        text format
        daterange dates
        tstzrange registration_window
        uuid entitlement_definition_id FK
        jsonb capacity_units "SPK-REG-005 vocabulary"
        text publication_state "draft published registration_open registration_paused closed"
        int revision
    }
    Session {
        uuid id PK
        uuid offering_id FK
        uuid event_id "scheduling event"
        int revision
    }
    EntitlementDefinition {
        uuid id PK
        text equivalence_key "duplicate entitlement rule"
        jsonb effects
        int revision
    }
    PriceRuleVersion {
        uuid id PK
        uuid offering_id FK
        int version
        bigint base_amount_minor
        text currency
        jsonb discounts "eligibility stacking caps rounding"
        tstzrange effective
    }
    PolicyVersion {
        uuid id PK
        text policy_key
        int version
        text kind "eligibility cancellation refund acknowledgment rules"
        jsonb body
        tstzrange effective
    }
    Acknowledgment {
        uuid id PK
        uuid policy_version_id FK
        uuid acknowledged_by_person_id FK
        uuid participant_person_id FK
        text context_type "application order"
        uuid context_id
        jsonb actor "staff never signs for a guardian"
    }
    Approval {
        uuid id PK
        uuid policy_version_id FK
        text target_type
        uuid target_id
        jsonb approver "actor snapshot"
        text decision "approved rejected"
        text reason
        tstzrange effective
    }
```

| Entity                                  | Status       | Pending inputs (owner from §6.6)                                                                                                                                 |
| --------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program, Offering, Session              | **Proposed** | Actual programs and formats: Program manager (DEC-003 youth), League manager (DEC-002); conditional kinds (rental, package, membership): Product owner (DEC-016) |
| EntitlementDefinition                   | **Proposed** | The equivalence rule behind "no equivalent duplicate active entitlement where prohibited" (§4.7 invariant 2, SPK-AT-004): Product and operations (DEC-006)       |
| PriceRuleVersion                        | **Proposed** | Prices, taxes, discounts, rounding: Finance (DEC-007)                                                                                                            |
| PolicyVersion, Acknowledgment, Approval | **Proposed** | Policy wording and which commands need approval: Operator/privacy owner (DEC-012), Product and operations (DEC-028)                                              |

### 5.2 Competition, matches and discipline

```mermaid
erDiagram
    League ||--o{ Season : "seasons"
    Season }o--|| CompetitionRuleSetVersion : "rule set version"
    Season ||--o{ Division : "divisions"
    Team ||--o{ TeamEntry : "continuing identity to season entry"
    Season ||--o{ TeamEntry : "entered season"
    Division o|--o{ TeamEntry : "placed in division"
    TeamEntry ||--o{ RosterMembership : "effective-dated roster"
    Person ||--o{ RosterMembership : "player"
    TeamEntry ||--o{ TeamInvitation : "invites players"
    Person o|--o{ TeamInvitation : "invitee"
    Division ||--o{ Fixture : "fixtures"
    TeamEntry ||--o{ Fixture : "home_team_entry_id"
    TeamEntry ||--o{ Fixture : "away_team_entry_id"
    Fixture ||..|| Event : "scheduling event with source_type fixture"
    Fixture ||--o{ FixtureAvailability : "RSVP per roster member"
    Fixture ||--o{ ResultRevision : "revisions"
    ResultRevision o|--o| ResultRevision : "supersedes"
    Division ||--o{ StandingsProjection : "derived from official results"
    CompetitionRuleSetVersion ||--o{ StandingsProjection : "tiebreak rules"
    Season ||--o{ BracketNode : "playoff structure"
    BracketNode o|--o| Fixture : "fixture"
    BracketNode o|--o{ BracketNode : "feeds_node_id"
    Fixture ||--o{ Dispute : "disputed fixture"
    Fixture o|--o{ Incident : "match incident"
    Incident ||--o{ DisciplinaryDecision : "decisions"
    DisciplinaryDecision o|--o{ Suspension : "suspensions"
    Person ||--o{ Suspension : "subject"
    Suspension }o--o{ Season : "applicable competitions"
    Suspension ||--o{ Appeal : "appeals"
    Dispute o|--o{ Appeal : "appeal of a dispute decision"

    League {
        uuid id PK
        text name
        text format "outdoor indoor futsal small_sided"
        int revision
    }
    Season {
        uuid id PK
        uuid league_id FK
        uuid rule_set_version_id FK
        daterange dates
        text status
        int revision
    }
    CompetitionRuleSetVersion {
        uuid id PK
        int version
        jsonb rules "SPK-COMP-002 sixteen areas"
        tstzrange effective
    }
    Division {
        uuid id PK
        uuid season_id FK
        jsonb criteria "age level category location format"
        int revision
    }
    Team {
        uuid id PK
        text name
        int revision
    }
    TeamEntry {
        uuid id PK
        uuid team_id FK
        uuid season_id FK
        uuid division_id FK
        text approval_status
        text eligibility_status "derived"
        int revision
    }
    RosterMembership {
        uuid id PK
        uuid team_entry_id FK
        uuid person_id FK
        text role "captain player guest substitute"
        tstzrange effective
        int revision
    }
    TeamInvitation {
        uuid id PK
        uuid team_entry_id FK
        uuid invitee_person_id FK
        text status "pending accepted declined revoked expired"
        timestamptz expires_at
    }
    Fixture {
        uuid id PK
        uuid division_id FK
        uuid home_team_entry_id FK
        uuid away_team_entry_id FK
        uuid event_id "scheduling event"
        int round
        text status "scheduled played postponed canceled forfeited abandoned"
        int revision
    }
    FixtureAvailability {
        uuid id PK
        uuid fixture_id FK
        uuid person_id FK
        text state "available unavailable tentative no_response"
    }
    ResultRevision {
        uuid id PK
        uuid fixture_id FK
        int revision_number
        text classification "ordinary forfeit cancellation abandonment postponement disputed"
        jsonb scores
        text status "draft submitted official superseded"
        uuid supersedes_result_id FK
        jsonb submitted_by
        jsonb published_by
        timestamptz published_at
    }
    StandingsProjection {
        uuid id PK
        uuid division_id FK
        uuid rule_set_version_id FK
        jsonb table_rows "with tiebreak explanations"
        timestamptz computed_at
    }
    BracketNode {
        uuid id PK
        uuid season_id FK
        uuid fixture_id FK
        uuid feeds_node_id FK
        text status "pending published played review_required"
    }
    Dispute {
        uuid id PK
        uuid fixture_id FK
        jsonb submitted_by
        text status "open under_review decided"
        jsonb decision
    }
    Incident {
        uuid id PK
        uuid fixture_id FK
        text kind "card misconduct complaint operational injury"
        text restricted_narrative "never public"
    }
    DisciplinaryDecision {
        uuid id PK
        uuid incident_id FK
        uuid rule_set_version_id FK
        jsonb approver
        text status
    }
    Suspension {
        uuid id PK
        uuid decision_id FK
        uuid subject_person_id FK
        text scope
        text basis "match_count or period"
        text appeal_status
        text status "pending active served lifted"
    }
    Appeal {
        uuid id PK
        uuid suspension_id FK
        uuid dispute_id FK
        text status "open decided"
        jsonb decision
    }
```

| Entity group                                              | Status       | Pending inputs (owner from §6.6)                                                                                              |
| --------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| League, Season, Division, CompetitionRuleSetVersion       | **Proposed** | Soccer formats and competition rules: League manager (DEC-002)                                                                |
| Team, TeamEntry, RosterMembership, TeamInvitation         | **Proposed** | Roster limits, guest and substitute rules: League manager (DEC-002); team billing model: Finance and league manager (DEC-008) |
| Fixture, FixtureAvailability                              | **Proposed** | Allowed start times, rest, byes, playoff structure (SPK-FIX-001): League manager (DEC-002), Operations (DEC-001)              |
| ResultRevision, StandingsProjection, BracketNode, Dispute | **Proposed** | Result publication authority (DEC-065) and protest deadlines: League manager (DEC-002)                                        |
| Incident, DisciplinaryDecision, Suspension, Appeal        | **Proposed** | Discipline and appeals: League manager/operator (DEC-010)                                                                     |

### 5.3 Enrollment: participation and capacity

```mermaid
erDiagram
    Person ||--o{ Application : "participant"
    Offering ||--o{ Application : "applied offering"
    Application }o--|| PolicyVersion : "eligibility policy version"
    Application o|--o{ Enrollment : "accepted application"
    Person ||--o{ Enrollment : "participant"
    Offering ||--o{ Enrollment : "entitlement to"
    Enrollment o|--o| Enrollment : "transferred_to_enrollment_id"
    Enrollment o|--o{ PlacementRequest : "placement"
    TeamEntry o|--o{ PlacementRequest : "assigned team entry"
    Person ||--o{ SessionBooking : "participant"
    Session ||--o{ SessionBooking : "session"
    Offering o|--o{ CapacityPool : "offering seats"
    Session o|--o{ CapacityPool : "session seats"
    TeamEntry o|--o{ CapacityPool : "roster places"
    Division o|--o{ CapacityPool : "team entries"
    Resource o|--o{ CapacityPool : "rental resources"
    CapacityPool ||--o{ Hold : "active holds count"
    CapacityPool ||--o{ Allocation : "accepted commitments count"
    Hold o|--o| Allocation : "committed hold"
    Allocation o|--o| Enrollment : "serves"
    Allocation o|--o| SessionBooking : "serves"
    Allocation o|--o| TeamEntry : "serves"
    CapacityPool ||--o{ WaitlistEntry : "waitlist"
    Person ||--o{ WaitlistEntry : "participant"
    WaitlistEntry ||--o{ WaitlistOffer : "offer history"
    WaitlistOffer ||--|| Hold : "reserved place until expiry"
    Checkout }o--o{ Hold : "acquires"
    Person ||--o{ MakeupEntitlement : "owner"
    Session o|--o{ MakeupEntitlement : "originating session"
    MakeupEntitlement o|--o{ SessionBooking : "redeemed by"
    Enrollment ||--o{ Assessment : "development records"
    Person ||--o{ Assessment : "author coach"

    Application {
        uuid id PK
        uuid participant_person_id FK
        uuid offering_id FK
        text intent "individual_league join_team create_team youth trial makeup pickup rental"
        jsonb eligibility_result "reasons and alternatives"
        text status "draft submitted awaiting_review accepted declined withdrawn"
        jsonb actor "staff actor separate from participant"
        int revision
    }
    Enrollment {
        uuid id PK
        uuid application_id FK
        uuid participant_person_id FK
        uuid offering_id FK
        text status "pending confirmed canceled transferred completed"
        uuid transferred_to_enrollment_id FK
        int revision
    }
    PlacementRequest {
        uuid id PK
        uuid enrollment_id FK
        uuid assigned_team_entry_id FK
        jsonb preferences "SPK-PLACE-001"
        text status "unassigned proposed assigned released"
        int revision
    }
    SessionBooking {
        uuid id PK
        uuid participant_person_id FK
        uuid session_id FK
        text status "pending confirmed canceled expired"
        int revision
    }
    CapacityPool {
        uuid id PK
        text unit "team_entries roster_places offering_seats session_seats camp_group_places rental_resources"
        text target_type
        uuid target_id
        int limit_units
        jsonb staffing_requirement "SPK-YOUTH-002"
        int revision
    }
    Hold {
        uuid id PK
        uuid capacity_pool_id FK
        uuid checkout_id FK
        int units
        timestamptz expires_at "server owned"
        text status "active committed released expired"
    }
    Allocation {
        uuid id PK
        uuid capacity_pool_id FK
        uuid hold_id FK
        text target_type "enrollment session_booking team_entry"
        uuid target_id
        int units
    }
    WaitlistEntry {
        uuid id PK
        uuid capacity_pool_id FK
        uuid participant_person_id FK
        jsonb priority_basis
        jsonb preferences
        text status "waiting offered accepted expired withdrawn"
        int revision
    }
    WaitlistOffer {
        uuid id PK
        uuid waitlist_entry_id FK
        uuid hold_id FK
        timestamptz expires_at
        text status "offered accepted expired declined"
    }
    MakeupEntitlement {
        uuid id PK
        uuid owner_person_id FK
        uuid originating_session_id FK
        jsonb eligible_replacements
        timestamptz expires_at
        int redemption_limit
        int redemptions
    }
    Assessment {
        uuid id PK
        uuid enrollment_id FK
        uuid author_person_id FK
        text skill_area
        date observed_on
        text visibility "private_note parent_visible"
        text review_status "draft approved"
    }
```

| Entity group                                              | Status       | Proposed defaults and pending inputs (owner from §6.6)                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application, Enrollment, PlacementRequest, SessionBooking | **Proposed** | Which offerings need human approval and whether approval reserves capacity (SPK-REG-007, **Proposed** default: approval before capturing a new payment): Product and operations (DEC-028); youth eligibility: Program manager (DEC-003)                                                          |
| CapacityPool, Hold, Allocation                            | **Proposed** | Hold starting duration ten minutes (SPK-REG-006, **Proposed** default, DEC-027); the database constraint that `active holds + allocations <= limit_units` is the mechanism for §4.7 invariant 3 and SPK-AT-005 (**Proposed**, following the exclusion-constraint pattern verified in scheduling) |
| WaitlistEntry, WaitlistOffer                              | **Proposed** | Priority basis and offer expiry: Product and operations (DEC-006)                                                                                                                                                                                                                                |
| MakeupEntitlement, Assessment                             | **Proposed** | Redemption limits and assessment templates: Program manager (DEC-003)                                                                                                                                                                                                                            |

### 5.4 Finance and accounting support

```mermaid
erDiagram
    Person ||--o{ Quote : "payer"
    Quote ||--o{ QuoteLine : "participant and item lines"
    QuoteLine }o--|| Person : "participant"
    QuoteLine }o--|| PriceRuleVersion : "price basis retained"
    Quote o|--o| Order : "stored quote to order"
    Order ||--o{ OrderLine : "lines"
    OrderLine }o--|| Person : "participant"
    OrderLine }o--|| EntitlementDefinition : "entitlement"
    OrderLine o|--o| Enrollment : "fulfilled by"
    Order ||--|| Checkout : "coordinated by"
    Checkout ||--|| Operation : "durable operation"
    Checkout ||--o{ PaymentAttempt : "provider executions"
    Order ||--o{ Obligation : "due now and future"
    TeamEntry o|--o{ Obligation : "team obligation"
    Person o|--o{ Obligation : "responsible payer"
    Obligation o|--o{ InstallmentPlan : "installments"
    PaymentAttempt ||--o{ PaymentAllocation : "allocates received money"
    Obligation ||--o{ PaymentAllocation : "to obligations"
    PaymentAttempt ||--o{ RefundAttempt : "refunds of a succeeded payment"
    Person ||--o{ Credit : "owner"
    Credit ||--o{ CreditRedemption : "redemption history"
    Order o|--o{ CreditRedemption : "applied to"
    Journal ||--o{ JournalEntry : "append-only subledger"
    PaymentAttempt ||--o{ JournalEntry : "receipt fact"
    RefundAttempt ||--o{ JournalEntry : "refund fact"
    Credit ||--o{ JournalEntry : "credit issue and redemption"
    Obligation ||--o{ JournalEntry : "obligation posted or adjusted"
    JournalEntry o|--o{ JournalEntry : "reverses_entry_id"
    SettlementReconciliation ||--o{ JournalEntry : "settlement and fee facts"
    SettlementReconciliation }o--o{ PaymentAttempt : "matched provider settlements"
    InboxEvent ||..o{ PaymentAttempt : "authoritative provider evidence"

    Quote {
        uuid id PK
        uuid payer_person_id FK
        bigint due_now_minor
        bigint future_obligations_minor
        text currency
        jsonb policy_references
        timestamptz expires_at
        text status "open expired converted"
    }
    QuoteLine {
        uuid id PK
        uuid quote_id FK
        uuid participant_person_id FK
        uuid price_rule_version_id FK
        bigint base_amount_minor
        bigint discounts_minor
        bigint taxes_fees_minor
        bigint credits_applied_minor
        jsonb eligibility_result
    }
    Order {
        uuid id PK
        uuid quote_id FK
        text fulfillment_mode "all_or_nothing partial"
        text status
        int revision
    }
    OrderLine {
        uuid id PK
        uuid order_id FK
        uuid participant_person_id FK
        uuid entitlement_definition_id FK
        uuid enrollment_id FK
        bigint amount_minor
        text outcome "pending fulfilled failed compensated"
    }
    Checkout {
        uuid id PK
        uuid order_id FK
        uuid operation_id FK
        text status "prepared awaiting_payment finalizing completed recovery_required compensated aborted"
        int revision
    }
    Obligation {
        uuid id PK
        uuid order_id FK
        uuid responsible_person_id FK
        uuid team_entry_id FK
        bigint total_minor
        bigint received_minor "derived"
        bigint allocated_minor "derived"
        bigint remaining_minor "derived"
        timestamptz due_at
        text status
    }
    InstallmentPlan {
        uuid id PK
        uuid obligation_id FK
        jsonb schedule "amounts due dates"
        jsonb authorization
        jsonb retry_policy
        text status
    }
    PaymentAttempt {
        uuid id PK
        uuid checkout_id FK
        text provider
        text provider_reference
        bigint amount_minor
        text currency
        text status "created action_required processing succeeded failed canceled unknown"
        uuid evidence_inbox_event_id
        int revision
    }
    PaymentAllocation {
        uuid id PK
        uuid payment_attempt_id FK
        uuid obligation_id FK
        bigint amount_minor
        bool overpayment "SPK-PAY-005 visible"
    }
    RefundAttempt {
        uuid id PK
        uuid payment_attempt_id FK
        bigint reserved_amount_minor "reserved before execution"
        text status "requested processing succeeded failed canceled unknown"
        jsonb approver
        int revision
    }
    Credit {
        uuid id PK
        uuid owner_person_id FK
        text currency
        bigint remaining_minor "check never negative"
        jsonb permitted_uses
        timestamptz expires_at
        text source
    }
    CreditRedemption {
        uuid id PK
        uuid credit_id FK
        uuid order_id FK
        bigint amount_minor
        text idempotency_scope "no double redemption"
    }
    Journal {
        uuid id PK
        text name
        text currency
    }
    JournalEntry {
        uuid id PK
        uuid journal_id FK
        text kind "order obligation receipt refund credit processor_fee dispute settlement cash"
        text source_type
        uuid source_id
        bigint amount_minor
        uuid reverses_entry_id FK
        timestamptz posted_at "append-only"
    }
    SettlementReconciliation {
        uuid id PK
        text provider
        daterange period
        jsonb control_totals
        text status "open matched discrepancy"
    }
```

| Entity group                                    | Status       | Proposed defaults and pending inputs (owner from §6.6)                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote, QuoteLine, Order, OrderLine, Checkout    | **Proposed** | Prices, taxes, discounts, rounding: Finance (DEC-007); all-or-nothing basket fulfillment (**Proposed** default, DEC-026); approval before capture (**Proposed** default, DEC-028). `QuoteLine` is not in §4.4; it is added so each basket line retains its own price and eligibility result (SPK-REG-004, SPK-PAY-002) |
| Obligation, InstallmentPlan, PaymentAllocation  | **Proposed** | Team liability, installments, overpayments: Finance and league manager (DEC-008); installments are a conditional capability: Product owner (DEC-016)                                                                                                                                                                   |
| PaymentAttempt, RefundAttempt                   | **Proposed** | Payment processor and merchant arrangement: Technical lead/account owners (DEC-019); refund rules: Finance (DEC-009). The `unknown` state and its reconciliation are modelled by the **Verified** machines (sections 6.6, 6.7); provider evidence arrives through the **Verified** `inbox_events` table                |
| Credit, CreditRedemption                        | **Proposed** | Credit issuance and expiry: Finance (DEC-009). `CreditRedemption` is not in §4.4; it is the "redemption history" of SPK-PAY-009 and the row whose uniqueness prevents double redemption (§4.7 invariant 7)                                                                                                             |
| Journal, JournalEntry, SettlementReconciliation | **Proposed** | Accounting mapping is a conditional capability (§3.16): Product owner (DEC-016); reconciliation owner per provider (§5.1): Technical lead/account owners (DEC-019)                                                                                                                                                     |

### 5.5 Workforce, entry, facilities, communications, support and migration

```mermaid
erDiagram
    Person ||--o{ Availability : "declared availability"
    Person ||--o{ Qualification : "evidence where required"
    Person ||--o{ Assignment : "official or coach"
    Event ||--o{ Assignment : "fixture or session event"
    Assignment ||..|| EventCommitment : "party_type person overlap guard"
    Assignment ||--o{ FeeSubmission : "approved hours or fees"
    Assignment o|--o| Assignment : "replacement_of_assignment_id"

    Facility ||--o{ Visit : "arrival"
    Person ||--o{ Visit : "visitor or participant"
    Visit o|--o| Departure : "departure"
    Visit ||--o{ AttendanceObservation : "check-in and observed attendance"
    Event ||--o{ AttendanceObservation : "session"
    AttendanceObservation o|--o{ AttendanceObservation : "corrects_observation_id"
    Visit o|--o{ ReleaseRecord : "supervised release"
    Person ||--o{ ReleaseRecord : "child"
    Person ||--o{ ReleaseRecord : "collecting person"
    Person ||--o{ Pass : "opaque reference"

    Resource o|--o{ Asset : "space"
    Asset ||--o{ MaintenanceTask : "maintenance"
    MaintenanceTask o|--o{ Inspection : "separate inspection"
    MaintenanceTask o|--o{ Restriction : "operating restriction"
    Restriction ||--|| Closure : "scheduling closure source maintenance"

    OutboxEvent ||..o{ Notification : "trigger event"
    Person ||--o{ Notification : "recipient from current permissions"
    Person o|--o{ Notification : "subject person"
    Notification ||--o{ DeliveryAttempt : "channel attempts"
    Notification o|--o{ CommsAcknowledgment : "acknowledged"
    Person ||--o{ Preference : "essential vs promotional per channel"
    Audience ||--o{ Notification : "staff composed send"
    Person ||--o{ CalendarFeedAuthorization : "revocable feed token"

    Person o|--o{ Case : "customer"
    Case ||--o{ CaseLink : "related records"
    OperationalException o|--o{ Case : "escalated exception"

    ImportBatch ||--o{ ExternalMapping : "source id to internal record"
    ImportBatch ||--o{ ImportException : "review queue"
    AuthorityAssignment }o--|| Facility : "scope"

    Availability {
        uuid id PK
        uuid person_id FK
        tstzrange window
        text kind "available unavailable"
    }
    Qualification {
        uuid id PK
        uuid person_id FK
        text kind
        jsonb evidence
        daterange valid
    }
    Assignment {
        uuid id PK
        uuid person_id FK
        uuid event_id FK
        text role "referee assistant coach"
        text status "proposed offered accepted declined withdrawn completed"
        tstzrange access_window "time-bounded access"
        uuid replacement_of_assignment_id FK
        int revision
    }
    FeeSubmission {
        uuid id PK
        uuid assignment_id FK
        text rate_basis
        bigint submitted_amount_minor
        text currency
        jsonb approver
        jsonb adjustments
        text export_status
    }
    Visit {
        uuid id PK
        uuid facility_id FK
        uuid person_id FK
        text category "participant guardian spectator"
        timestamptz arrived_at
    }
    Departure {
        uuid id PK
        uuid visit_id FK
        timestamptz departed_at
    }
    AttendanceObservation {
        uuid id PK
        uuid visit_id FK
        uuid event_id FK
        uuid person_id FK
        text kind "check_in present absent late"
        timestamptz observed_at
        timestamptz received_at "offline queue"
        uuid snapshot_reference "roster snapshot"
        uuid corrects_observation_id FK
        jsonb actor
        text reason
    }
    ReleaseRecord {
        uuid id PK
        uuid visit_id FK
        uuid child_person_id FK
        uuid collecting_person_id FK
        text verification_outcome "authorized denied escalated manual_outage"
        jsonb staff_actor
        text release_outcome
    }
    Pass {
        uuid id PK
        uuid person_id FK
        text opaque_reference UK
        text status "active revoked"
    }
    Asset {
        uuid id PK
        uuid resource_id FK
        text kind "turf goal net board divider lighting scoreboard equipment"
        text status
    }
    MaintenanceTask {
        uuid id PK
        uuid asset_id FK
        text severity
        jsonb reporter
        jsonb evidence
        uuid owner_person_id
        date due_on
        text status "open in_progress resolved closed"
    }
    Inspection {
        uuid id PK
        uuid maintenance_task_id FK
        text outcome "passed failed"
        jsonb inspector
    }
    Restriction {
        uuid id PK
        uuid maintenance_task_id FK
        uuid closure_id "scheduling closure"
        tstzrange during
        jsonb approver
        text status "pending active released"
    }
    Notification {
        uuid id PK
        uuid trigger_event_id "outbox event id"
        uuid recipient_person_id FK
        uuid subject_person_id FK
        text trigger "SPK-COMMS-002 trigger"
        jsonb old_details
        jsonb new_details
        bool essential
        text status "queued superseded sent"
    }
    DeliveryAttempt {
        uuid id PK
        uuid notification_id FK
        text channel "in_app push email sms"
        text provider
        text provider_reference
        text state "queued provider_accepted delivered failed unknown read"
        timestamptz authority_rechecked_at "SPK-COMMS-003"
    }
    CommsAcknowledgment {
        uuid id PK
        uuid notification_id FK
        timestamptz acknowledged_at
    }
    Preference {
        uuid id PK
        uuid person_id FK
        text category "essential promotional"
        text channel
        bool opted_in
    }
    Audience {
        uuid id PK
        jsonb criteria
        jsonb composer "staff actor"
        int recipient_count "previewed"
        text status "draft previewed confirmed"
    }
    CalendarFeedAuthorization {
        uuid id PK
        uuid person_id FK
        text token_hash UK
        text status "active revoked"
    }
    Case {
        uuid id PK
        uuid customer_person_id FK
        uuid exception_id FK
        jsonb owner
        text category
        text status "open resolved closed"
        jsonb resolution
    }
    CaseLink {
        uuid id PK
        uuid case_id FK
        text target_type
        uuid target_id
    }
    ImportBatch {
        uuid id PK
        text source
        text checksum
        text transformation_version
        jsonb row_outcomes
        text status
    }
    ExternalMapping {
        uuid id PK
        uuid import_batch_id FK
        text source_system
        text external_id
        text target_type
        uuid target_id
        jsonb provenance
    }
    ImportException {
        uuid id PK
        uuid import_batch_id FK
        text category "ambiguous_relationship ambiguous_balance validation"
        jsonb review_decision
        text status "open decided"
    }
    AuthorityAssignment {
        uuid id PK
        text record_category
        uuid facility_id FK
        text writer "sportspark legacy"
        tstzrange effective
    }
```

| Entity group                                                                                        | Status       | Pending inputs (owner from §6.6)                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability, Qualification, Assignment, FeeSubmission                                              | **Proposed** | Official qualifications and fees: Operations/finance (DEC-011)                                                                                                                                                                                                                                                    |
| Visit, Departure, AttendanceObservation, ReleaseRecord, Pass                                        | **Proposed** | Pickup and outage procedure: Operations (DEC-005); maximum offline roster age two hours (§4.15, **Proposed** default, DEC-033)                                                                                                                                                                                    |
| Asset, MaintenanceTask, Inspection, Restriction                                                     | **Proposed** | Actual facilities, spaces, subdivisions, hours: Operations (DEC-001)                                                                                                                                                                                                                                              |
| Notification, DeliveryAttempt, CommsAcknowledgment, Preference, Audience, CalendarFeedAuthorization | **Proposed** | Public information and communication policy: Operator/privacy owner (DEC-012, DEC-062); messaging providers: Technical lead/account owners (DEC-020). `CommsAcknowledgment` is the §4.4 Communications "Acknowledgment", renamed in the diagram to keep it distinct from the policy Acknowledgment of section 5.1 |
| Case, CaseLink                                                                                      | **Proposed** | Support, workload, service objectives: Technical lead/operator (DEC-015)                                                                                                                                                                                                                                          |
| ImportBatch, ExternalMapping, ImportException, AuthorityAssignment                                  | **Proposed** | Migration scope and writer authority: Migration owner/operator (DEC-014)                                                                                                                                                                                                                                          |

### 5.6 Cross-module spine

The chains the specification singles out, end to end, with the module boundary at each hop. A module never writes another module's table (§4.2, `CLAUDE.md`); cross-module links are composite foreign keys to the other module's `(organization_id, id)` or, for scheduling events, the `source_type`/`source_id` pair and `event_commitments.party_id` that scheduling owns (**Verified** columns).

```mermaid
erDiagram
    Person ||--o{ Account : "identity verified"
    Household ||--o{ HouseholdMembership : "identity verified grouping only"
    Person ||--o{ Relationship : "identity verified"
    Relationship ||--o{ AccessGrant : "identity verified authority"
    Program ||--o{ Offering : "catalog proposed"
    Offering ||--o{ Session : "catalog proposed"
    League ||--o{ Season : "competition proposed"
    Season ||--o{ Division : "competition proposed"
    Team ||--o{ TeamEntry : "competition proposed"
    TeamEntry ||--o{ RosterMembership : "competition proposed"
    Division ||--o{ Fixture : "competition proposed"
    Fixture ||--o{ ResultRevision : "competition proposed"
    Division ||--o{ StandingsProjection : "competition proposed derived"
    Resource ||--o{ ResourceConflictUnit : "scheduling verified"
    ConflictUnit ||--o{ ReservationUnit : "scheduling verified exclusion"
    Event ||--o{ Reservation : "scheduling verified"
    Fixture ||..|| Event : "source_type fixture"
    Session ||..|| Event : "source_type session"
    Application o|--o{ Enrollment : "enrollment proposed"
    Enrollment o|--o{ PlacementRequest : "enrollment proposed"
    PlacementRequest o|--o| TeamEntry : "assigned"
    CapacityPool ||--o{ Hold : "enrollment proposed"
    Hold o|--o| Allocation : "committed"
    CapacityPool ||--o{ WaitlistEntry : "enrollment proposed"
    WaitlistEntry ||--o{ WaitlistOffer : "enrollment proposed"
    Quote o|--o| Order : "finance proposed"
    Order ||--o{ Obligation : "finance proposed"
    Order ||--|| Checkout : "finance proposed"
    Checkout }o--o{ Hold : "acquires"
    Checkout ||--|| Operation : "kernel verified"
    Checkout ||--o{ PaymentAttempt : "finance proposed"
    PaymentAttempt ||--o{ RefundAttempt : "finance proposed"
    Credit ||--o{ JournalEntry : "finance proposed"
    PaymentAttempt ||--o{ JournalEntry : "finance proposed append-only"
    Operation ||--o{ OutboxEvent : "kernel verified"
    OutboxEvent ||..o{ Notification : "communications proposed"
```

## 6. Lifecycles (§4.6), exactly as defined in `packages/contracts/src/state-machines.ts`

All ten machines are **Verified**: they are defined in `packages/contracts/src/state-machines.ts` and tested by `packages/contracts/src/state-machines.spec.ts` ("every machine has an initial state, terminal states with no exits, and reachable states"; "holds have exactly one terminal outcome"; "unknown payment outcomes resolve only to authoritative terminal states"; "checkout keeps provider success with local failure visible as recovery_required"; "results never go backwards from official"). State and event names below are the code identifiers, not paraphrases. The entities that carry these lifecycles (section 3) are **Proposed** until their tables exist; the contract is the single source of truth for the services, the database check constraints and this document (`CLAUDE.md` "Data rules").

Reading the diagrams: `[*] -->` marks the `initial` state; a transition `--> [*]` marks a `terminal` state (no exits); each arrow label is the event name passed to `Machine.next(from, event)`.

### 6.1 Application (`ApplicationMachine`)

Initial `draft`; terminal `accepted`, `declined`, `withdrawn`. Carried by the enrollment Application (SPK-REG-003).

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> submitted : submit
    draft --> withdrawn : withdraw
    submitted --> awaiting_review : route_for_review
    submitted --> accepted : accept
    submitted --> declined : decline
    submitted --> withdrawn : withdraw
    awaiting_review --> accepted : accept
    awaiting_review --> declined : decline
    awaiting_review --> withdrawn : withdraw
    accepted --> [*]
    declined --> [*]
    withdrawn --> [*]
```

### 6.2 Enrollment (`EnrollmentMachine`)

Initial `pending`; terminal `canceled`, `transferred`, `completed`. Confirmation and waitlisting are separate records (§4.5); a transfer ends this enrollment and links the new one (SPK-REG-010).

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> confirmed : confirm
    pending --> canceled : cancel
    confirmed --> canceled : cancel
    confirmed --> transferred : transfer
    confirmed --> completed : complete
    canceled --> [*]
    transferred --> [*]
    completed --> [*]
```

### 6.3 Placement (`PlacementMachine`)

Initial `unassigned`; terminal `released`. A proposal reserves nothing (SPK-PLACE-003); `assign` checks capacity and eligibility at commitment.

```mermaid
stateDiagram-v2
    [*] --> unassigned
    unassigned --> proposed : propose
    unassigned --> assigned : assign
    proposed --> unassigned : reject_proposal
    proposed --> assigned : assign
    assigned --> released : release
    released --> [*]
```

### 6.4 Hold (`HoldMachine`)

Initial `active`; terminal `committed`, `released`, `expired`. Exactly one terminal outcome (SPK-REG-006); the server controls expiry.

```mermaid
stateDiagram-v2
    [*] --> active
    active --> committed : commit
    active --> released : release
    active --> expired : expire
    committed --> [*]
    released --> [*]
    expired --> [*]
```

### 6.5 Session booking (`SessionBookingMachine`)

Initial `pending`; terminal `canceled`, `expired`. Note that `confirmed` is not terminal: a confirmed booking can still be canceled.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> confirmed : confirm
    pending --> canceled : cancel
    pending --> expired : expire
    confirmed --> canceled : cancel
    canceled --> [*]
    expired --> [*]
```

### 6.6 Payment attempt (`PaymentAttemptMachine`)

Initial `created`; terminal `succeeded`, `failed`, `canceled`. `unknown` is not terminal: it is resolved only by authoritative reconciliation evidence (SPK-PAY-007), never by a timeout.

```mermaid
stateDiagram-v2
    [*] --> created
    created --> action_required : require_action
    created --> processing : process
    created --> succeeded : succeed
    created --> failed : fail
    created --> canceled : cancel
    created --> unknown : lose_track
    action_required --> processing : process
    action_required --> succeeded : succeed
    action_required --> failed : fail
    action_required --> canceled : cancel
    action_required --> unknown : lose_track
    processing --> succeeded : succeed
    processing --> failed : fail
    processing --> canceled : cancel
    processing --> unknown : lose_track
    unknown --> succeeded : succeed
    unknown --> failed : fail
    unknown --> canceled : cancel
    succeeded --> [*]
    failed --> [*]
    canceled --> [*]
```

### 6.7 Refund (`RefundMachine`)

Initial `requested`; terminal `succeeded`, `failed`, `canceled`. An unknown external result retains its reservation until reconciliation (SPK-PAY-008); `unknown` cannot be canceled.

```mermaid
stateDiagram-v2
    [*] --> requested
    requested --> processing : process
    requested --> canceled : cancel
    requested --> failed : fail
    requested --> unknown : lose_track
    processing --> succeeded : succeed
    processing --> failed : fail
    processing --> unknown : lose_track
    unknown --> succeeded : succeed
    unknown --> failed : fail
    succeeded --> [*]
    failed --> [*]
    canceled --> [*]
```

### 6.8 Checkout (`CheckoutMachine`)

Initial `prepared`; terminal `completed`, `compensated`, `aborted`. Provider success followed by local finalization failure stays visible as `recovery_required` (received money plus incomplete fulfillment, §4.11).

```mermaid
stateDiagram-v2
    [*] --> prepared
    prepared --> awaiting_payment : initiate_payment
    prepared --> finalizing : payment_succeeded
    prepared --> aborted : abort
    awaiting_payment --> finalizing : payment_succeeded
    awaiting_payment --> aborted : abort
    finalizing --> completed : finalized
    finalizing --> recovery_required : finalization_failed
    recovery_required --> completed : recovered
    recovery_required --> compensated : compensate
    completed --> [*]
    compensated --> [*]
    aborted --> [*]
```

### 6.9 Result (`ResultMachine`)

Initial `draft`; terminal `superseded`. `official` has no backward transition: a correction is a new revision that supersedes this one (SPK-RESULT-001, SPK-RESULT-004).

```mermaid
stateDiagram-v2
    [*] --> draft
    draft --> submitted : submit
    submitted --> official : publish
    submitted --> draft : return_for_correction
    official --> superseded : supersede
    superseded --> [*]
```

### 6.10 Assignment (`AssignmentMachine`)

Initial `proposed`; terminal `declined`, `withdrawn`, `completed`. A proposed assignment does not satisfy a required accepted-official check (SPK-STAFF-002).

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> offered : offer
    proposed --> withdrawn : withdraw
    offered --> accepted : accept
    offered --> declined : decline
    offered --> withdrawn : withdraw
    accepted --> withdrawn : withdraw
    accepted --> completed : complete
    declined --> [*]
    withdrawn --> [*]
    completed --> [*]
```

### 6.11 Module and kernel lifecycles that exist today (not in the §4.6 table)

These are **Verified** lifecycles defined beside the module that owns them, with the same `defineStateMachine` helper or an equivalent allowed-transition table, and listed by the database check constraints.

| Record                | Defined in                                                                        | Initial    | Transitions (from: event → to)                                                                                                                                                               | Terminal                       | Test                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Invitation            | `apps/api/src/modules/identity/identity.machines.ts` (`InvitationMachine`)        | `pending`  | pending: accept → accepted, revoke → revoked, expire → expired                                                                                                                               | accepted, revoked, expired     | `identity.machines.spec.ts` "invitations and claims leave pending exactly once"                               |
| Claim                 | `identity.machines.ts` (`ClaimMachine`, same transitions as Invitation)           | `pending`  | as Invitation                                                                                                                                                                                | accepted, revoked, expired     | `identity.machines.spec.ts`                                                                                   |
| Relationship          | `identity.machines.ts` (`RelationshipMachine`)                                    | `active`   | active: suspend → suspended, end → ended; suspended: reinstate → active, end → ended                                                                                                         | ended                          | `identity.machines.spec.ts` "relationships can be suspended and reinstated but never leave ended"             |
| StaffMembership       | `identity.machines.ts` (`StaffMembershipMachine`)                                 | `active`   | active: end → ended                                                                                                                                                                          | ended                          | `identity.machines.spec.ts`                                                                                   |
| AccessReview          | `identity.machines.ts` (`AccessReviewMachine`)                                    | `open`     | open: escalate → escalated, decide → decided, close → closed; escalated: decide → decided, close → closed; decided: close → closed                                                           | closed                         | `access-reviews.spec.ts` "state machine: open → escalated → decided → closed"                                 |
| DuplicateCandidate    | `identity.machines.ts` (`DuplicateCandidateMachine`)                              | `open`     | open: merge → merged, dismiss → dismissed                                                                                                                                                    | merged, dismissed              | `duplicates.spec.ts`                                                                                          |
| Event (scheduling)    | `apps/api/src/modules/scheduling/scheduling.state-machines.ts` (`EventMachine`)   | `draft`    | draft: publish → published, cancel → canceled; published: cancel → canceled                                                                                                                  | canceled                       | `schema-invariants.spec.ts` "check constraints list exactly the lifecycle states"; `events.spec.ts`           |
| Closure               | `scheduling.state-machines.ts` (`ClosureMachine`)                                 | `pending`  | pending: apply → active, withdraw → withdrawn; active: lift → lifted                                                                                                                         | lifted, withdrawn              | `closures.spec.ts`                                                                                            |
| ScheduleDraft         | `scheduling.state-machines.ts` (`ScheduleDraftMachine`)                           | `editing`  | editing, validated and failed each: edit → editing, validate → validated, publish → publishing, fail → failed, discard → discarded; publishing: commit → published, fail → failed            | published, discarded           | `schedule-drafts.spec.ts` "lifecycle: discard, and terminal drafts refuse further commands"                   |
| Operation (kernel)    | `apps/api/src/kernel/operations/operations.service.ts` (`transition`, `TERMINAL`) | `pending`  | any non-terminal status → any status (`pending`, `running`, `succeeded`, `failed`, `recovery_required`, `compensated`); a terminal status refuses every transition with `INVALID_TRANSITION` | succeeded, failed, compensated | `auth-and-operations.spec.ts` "operation transitions follow the lifecycle and terminal states are final"      |
| OperationalException  | `apps/api/src/kernel/exceptions/operational-exceptions.service.ts` (`allowed`)    | `open`     | open → acknowledged, resolved, closed; acknowledged → resolved, closed; resolved → closed                                                                                                    | closed                         | `unit-of-work.spec.ts` "exceptions deduplicate while open, transition with authorization and revision checks" |
| Outbox event (kernel) | `0001_core_schema.sql` `outbox_events.status`; `outbox-dispatcher.ts`             | `pending`  | pending → dispatched (every handler succeeded), pending → pending with a later `available_at` (retry), pending → dead (after `max_attempts`)                                                 | dispatched, dead               | `outbox.spec.ts`                                                                                              |
| Inbox event (kernel)  | `0001_core_schema.sql` `inbox_events.status`; `inbox.ts`                          | `received` | received or failed → processed, failed (retry), dead (after ten attempts); `ignored` is listed by the check constraint and not yet written by any code path                                  | processed, dead, ignored       | `inbox.spec.ts`                                                                                               |

## 7. The chains the specification names, hop by hop

Each row states what is true today and what is proposed, with the integrity rule that protects the hop.

| Chain (§4.4 and task wording)                                      | Hops and status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Person, account                                                    | **Verified**: `accounts.person_id` nullable until claimed; one active account per person; `(issuer, subject)` unique; recovery relinks without new access (SPK-AT-025, `claims-and-accounts.spec.ts`).                                                                                                                                                                                                                                                                                                                   |
| Household, relationship, access grant                              | **Verified**: households are grouping only; a relationship carries no permission; each permission is one `access_grants` row with its own effective window; revocation applies on the very next check (`relationships.spec.ts` SPK-IAM-006). **Proposed**: communications re-evaluates unsent protected notices on `identity.access_grant_revoked` (SPK-AT-017).                                                                                                                                                         |
| Program, offering, session                                         | **Proposed** (catalog): a program is reusable, an offering is dated with a registration window and publication state, a session is one dated unit whose time and space is a scheduling event (`events.source_type = 'session'`, **Verified** column). Copying creates a draft and never copies payments, attendance, enrollments, results or permissions (SPK-CAT-003).                                                                                                                                                  |
| League, season, division, team, team entry, roster membership      | **Proposed** (competition): a team is continuing identity; a team entry is that team in one season (and, once placed, one division); roster memberships are effective-dated so last week's match keeps its roster (SPK-COMP-005). Renewal creates new season records (SPK-COMP-001, SPK-AT-003). Captain authority is the `teamRole: 'captain'` check on the `team_entry` target (**Verified** kernel path, `authorization.spec.ts`; competition registration **Proposed**).                                             |
| Fixture, result revision, standings                                | **Proposed** (competition): a fixture is a division game between two team entries whose time and field is a scheduling event (`source_type = 'fixture'`); result revisions follow `ResultMachine` (**Verified**) with each correction superseding the prior official revision; standings are a projection over official results and a rule set version (SPK-RESULT-001/003/004). A correction touching a published bracket raises a management review (`operational_exceptions`, **Verified** mechanism).                |
| Resource, configuration, conflict unit, event, reservation         | **Verified** (scheduling): a resource maps to one or more conflict units; a configuration names which resources may run simultaneously; an event holds one reservation per resource and one reservation unit per conflict unit for the occupied interval (scheduled plus buffers); the GiST exclusion rejects the second overlapping unit (`schema-invariants.spec.ts`, `schedule-drafts.spec.ts` SPK-AT-008).                                                                                                           |
| Application, enrollment, placement                                 | **Proposed** (enrollment): approval, enrollment, placement and financial obligation are independent records (SPK-REG-003); an accepted application yields enrollments; a placement request hangs off an individual enrollment and is assigned to a team entry only after capacity and eligibility are checked at commitment (SPK-PLACE-003). Lifecycles **Verified** (sections 6.1 to 6.3).                                                                                                                              |
| Capacity pool, hold, allocation, waitlist                          | **Proposed** (enrollment): a pool counts active holds plus allocations against its limit (SPK-REG-005); a hold is server-owned with one terminal outcome (**Verified** machine, section 6.4) and becomes an allocation on commit; a waitlist offer is backed by a hold so acceptance consumes it once and expiry releases it by the priority policy (SPK-REG-008); a late payment never displaces a valid offer (SPK-AT-006). The counting constraint is the mechanism for §4.7 invariant 3.                             |
| Quote, order, obligation, payment attempt, refund, credit, journal | **Proposed** (finance): a stored quote (expiring, with policy references) converts to an order whose lines keep their participant, entitlement, price and outcome; obligations split what is due now from future installments and team liabilities; a checkout (**Verified** machine, section 6.8) creates the durable `operations` row (**Verified**) and drives payment attempts; refunds reserve funds first; credits redeem at most once; every money fact is an append-only journal entry. §4.7 invariants 5, 6, 7. |
| Trigger event, notification, delivery attempt                      | **Proposed** (communications): a notification is created by an outbox handler from a domain event (`outbox_events.id` is the trigger reference, **Verified** envelope); recipients are resolved from current grants and rechecked before external handoff (SPK-COMMS-003); each channel attempt records the SPK-COMMS-004 state. The event catalogue is in `docs/architecture/api-and-events.md` section 9.                                                                                                              |
| Operation, outbox event, job attempt, operational exception        | **Verified** (kernel): a multi-step command creates an operation; follow-ups are outbox events in the same transaction; each handler run is a job attempt; dead letters become owned operational exceptions (`outbox.spec.ts`, `inbox.spec.ts`).                                                                                                                                                                                                                                                                         |

## 8. Pending decisions that change the shape of this model (owners from §6.6)

Nothing in this table is answered in the repository (`docs/package-a/decision-register.md`, "every record ... has answer status unknown"). The model above is built so that each answer changes vocabularies and values, not table structure.

| Decision (§6.6 row)                                | Owner (§6.6)                  | Register id                        | Entities whose vocabulary or constraints depend on it                                                          | Status               |
| -------------------------------------------------- | ----------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- |
| Actual facilities, spaces, subdivisions, hours     | Operations                    | DEC-001                            | Resource, Configuration, ConflictUnit, OperatingHours rows; Asset                                              | **Pending decision** |
| Soccer formats and competition rules               | League manager                | DEC-002                            | CompetitionRuleSetVersion, Division criteria, RosterMembership roles, Fixture constraints, Suspension scope    | **Pending decision** |
| Youth eligibility, capacity, staffing, progression | Program manager               | DEC-003                            | Offering eligibility, CapacityPool staffing requirement, Assessment templates, MakeupEntitlement limits        | **Pending decision** |
| Guardian verification and child-account policy     | Operator/privacy owner        | DEC-004                            | Relationship `source`, Claim and Invitation flows, whether a child Person may hold an Account                  | **Pending decision** |
| Pickup and outage procedure                        | Operations                    | DEC-005                            | ReleaseRecord verification outcomes, AttendanceObservation offline fields, offline roster age (DEC-033)        | **Pending decision** |
| Waitlist, holds, approvals, basket behavior        | Product and operations        | DEC-006, DEC-026, DEC-027, DEC-028 | Hold expiry, WaitlistEntry priority basis, WaitlistOffer expiry, Order fulfillment mode, Approval requirements | **Pending decision** |
| Prices, taxes, discounts, rounding                 | Finance                       | DEC-007                            | PriceRuleVersion, QuoteLine amounts                                                                            | **Pending decision** |
| Team liability, installments, overpayments         | Finance and league manager    | DEC-008                            | Obligation responsible party, InstallmentPlan, PaymentAllocation overpayment handling                          | **Pending decision** |
| Refunds, credits, transfers, cash                  | Finance                       | DEC-009                            | RefundAttempt rules, Credit permitted uses and expiry, Enrollment transfer charges, cash JournalEntry kinds    | **Pending decision** |
| Discipline and appeals                             | League manager/operator       | DEC-010                            | DisciplinaryDecision rules, Suspension basis and applicable competitions, Appeal process                       | **Pending decision** |
| Official qualifications and fees                   | Operations/finance            | DEC-011                            | Qualification kinds, FeeSubmission rate basis and approver                                                     | **Pending decision** |
| Public information and communication policy        | Operator/privacy owner        | DEC-012, DEC-062                   | Preference categories, which triggers produce external DeliveryAttempts, StandingsProjection visibility        | **Pending decision** |
| Providers and production accounts                  | Technical lead/account owners | DEC-018, DEC-019, DEC-020          | Account issuer, PaymentAttempt and DeliveryAttempt provider fields, InboxEvent providers                       | **Pending decision** |
| Migration scope and writer authority               | Migration owner/operator      | DEC-014                            | AuthorityAssignment rows, ExternalMapping source systems                                                       | **Pending decision** |
| Conditional capability applicability               | Product owner                 | DEC-016                            | Offering kinds rental, package, membership, party, tournament; InstallmentPlan; POS and accounting entities    | **Pending decision** |
| Result publication authority                       | League manager (per DEC-065)  | DEC-065                            | Who may fire `publish` on `ResultMachine`                                                                      | **Pending decision** |

## 9. Replacing the demonstration shortcuts (§4.5)

The local demonstration is not in this repository, so its types cannot be quoted; the rows restate §4.5 and say how this model answers each item.

| §4.5 statement                                                         | Treatment in this model                                                                                                                                     | Status                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Person.householdId` cannot determine authority                        | Households are a grouping table; authority is only an `access_grants` row                                                                                   | **Verified** (`staff-memberships.spec.ts` "§4.5: household membership never grants authority")                                                                           |
| A stored `age` cannot replace date-based eligibility evaluation        | `persons.date_of_birth` is stored; `kind` must agree with it; eligibility is evaluated by the enrollment module against a policy version and reference date | **Verified** for the person record (`people.spec.ts` "§4.5: the declared kind must agree with the date of birth"); **Proposed** for eligibility evaluation (SPK-REG-002) |
| `Resource` must express physical overlap and configurations            | `conflict_units`, `resource_conflict_units`, `resource_configurations`                                                                                      | **Verified** (`schema-invariants.spec.ts`, `resources.spec.ts`)                                                                                                          |
| `Offering.priceCents` must become versioned price rules and quotes     | PriceRuleVersion and Quote with retained price basis per line                                                                                               | **Proposed** (section 5.1, 5.4); `Money` contract **Verified**                                                                                                           |
| Enrollment must not combine confirmation and waitlisting in one status | `EnrollmentMachine` has no waitlist state; WaitlistEntry and WaitlistOffer are separate records                                                             | **Verified** machine; **Proposed** records                                                                                                                               |
| Payment must not reduce provider outcomes to only paid/refunded        | `PaymentAttemptMachine` and `RefundMachine` with `action_required`, `processing`, `unknown`                                                                 | **Verified** machines; **Proposed** records                                                                                                                              |
| Team must separate continuing identity from season entry               | Team and TeamEntry                                                                                                                                          | **Proposed** (section 5.2)                                                                                                                                               |
| Attendance must preserve observations and corrections                  | AttendanceObservation rows with `corrects_observation_id`, never updated in place                                                                           | **Proposed** (section 5.5); append-only trigger pattern **Verified**                                                                                                     |
| Coach names must become person and assignment references               | Assignment references `persons.id`; `event_commitments.party_id` for overlap                                                                                | **Proposed** (section 5.5); `event_commitments` **Verified**                                                                                                             |
| Messages must represent actual delivery states                         | DeliveryAttempt state per channel (SPK-COMMS-004)                                                                                                           | **Proposed** (section 5.5)                                                                                                                                               |
| Global bootstrap responses must give way to scoped, paginated queries  | `PageRequestSchema` and cursor pages; organization scope from the principal                                                                                 | **Verified** (`packages/contracts/src/pagination.ts`; `events.spec.ts` "cursor pagination")                                                                              |
| Existing clients must be migrated together with contract tests         | No demonstration client is in this repository; parity tests (§4.1) cannot be written until it is added                                                      | **Pending decision**: Migration owner/operator (DEC-014), and the demonstration must be supplied                                                                         |

## 10. Specification ambiguities encountered

1. §4.4 lists "Acknowledgment" twice, under Policies and under Communications. This document treats them as two entities (a guardian acknowledging a policy version versus a recipient acknowledging a notice, SPK-COMMS-004) and names the second `CommsAcknowledgment` in the diagram.
2. §4.4 "Approval" (Policies) has no owning module in §4.2. It is placed with catalog ("policies") as a record type, while the commands that require an approval live in enrollment (SPK-REG-002, SPK-REG-007), finance (SPK-STAFF-006 approver, SPK-PAY-008), competition (SPK-DISC-002) and workforce. The alternative, an approval column on each target, was rejected because §4.6 requires actor, guards and recovery per command and §4.14 requires audited privileged actions.
3. §4.4 "Configuration" (Scheduling) and §4.5 "configurations" are read as the same thing: the named physical arrangement that `resource_configurations` implements (SPK-SCHED-002).
4. §4.4 "Exception" (Operations) is implemented in the kernel as `operational_exceptions`, while §4.2 gives "Cases and operational task coordination" to the support module. This document keeps the record in the kernel (every module raises exceptions) and the workflow in support, as the support README states.
5. §4.4 does not list the entities the specification elsewhere requires (Invitation, Claim, StaffMembership, AccessReview, Closure, EventSeries, EventCommitment, Publication, TeamInvitation, FixtureAvailability, Dispute, MakeupEntitlement, Assessment, InstallmentPlan, QuoteLine, CreditRedemption, Pass, Audience, CalendarFeedAuthorization, MetricDefinition). They are included and marked with the requirement that demands them; "Minimum domain entities" is read as a floor, not a ceiling.
6. §4.6 "Session booking" has `confirmed` as a non-terminal state with only `cancel`, and no `complete` event, unlike Enrollment. The contract reproduces §4.6 literally; whether a session booking should complete is left to the enrollment module design (**Proposed** to leave as is).
7. The workflow assignment for this document described identity and scheduling tables as not existing ("Mark the kernel tables that exist today as Verified ... and all others Proposed"). Both modules exist with migrations and tests on 2026-10-23, so their tables are marked **Verified** with citations; marking them Proposed would misstate the repository.
8. §6.6 names "Program manager" for youth decisions but the specification has no standalone row for "Result publication authority" (SPK-STAFF-005, SPK-RESULT-001); the decision register's DEC-065 assigns it under the League manager row, and this document follows the register.
