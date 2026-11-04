# facilities module

**Owns:** Assets, maintenance tasks, inspections, operating restrictions, release-to-service,
preventive maintenance schedules

**Specification:** §3.17 (SPK-FAC-001..005), §4.4 Facilities (Asset, MaintenanceTask, Inspection,
Restriction), §4.8 `POST /v1/maintenance-restrictions`, SPK-AT-021, SPK-UX-006 (overdue
escalation), SPK-COND-003 (equipment reserved with a booking, through the asset directory port)

**Migration range:** `packages/db/migrations/0900_facilities_*.sql` … `0999` (present: `0900`,
`0901_facilities_task_owner_fk`, `0902_facilities_facility_scoped_keys`,
`0903_facilities_restriction_withdrawal`, `0904_facilities_restriction_transition_guard`,
`0905_facilities_restriction_delete_guard`, `0906_facilities_restriction_follow_on`)

**Depends on:** scheduling (closure port, resources public API) and identity
(`PERSON_DIRECTORY_PORT`, to check assigned task owners). Restrictions create scheduling closures
through the scheduling authority; this module never writes scheduling or identity tables (§4.2).

**Status: implemented** (verified by `apps/api/src/modules/facilities/__tests__` and
`facilities.state-machines.spec.ts`). Pending decisions are listed at the end. Labels follow §6.7:
**Verified** (implemented and covered by a named test), **Proposed** (implemented with a placeholder
value or rule that an operator decision may change), **Pending** (not decided; the conservative
behaviour is implemented or nothing is).

**Capability switches (DEC-016):** none. Nothing in this module is a Package G capability; every
behaviour here is always on. The asset directory port (FAC-02) is a read that the rental and party
bookings in enrollment consume, and those bookings are behind enrollment's `rentals` and `parties`
switches (DEC-016 with DEC-076 / DEC-077), off by default.

## Tables (migration `0900_facilities_core.sql`)

| Table                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets`               | Turf, goals, nets, boards, dividers, lighting, scoreboards, equipment, other; optional `resource_id` (the space it belongs to); status `in_service / restricted / out_of_service / retired`; identifier unique among non-retired assets of a facility                                                                                                                                                                     |
| `maintenance_tasks`    | Asset or space (check: at least one), issue, severity, reporter snapshot, evidence (references only), assigned owner, due instant, status `open → assigned → in_progress → resolved → closed`, `requires_inspection`, resolution; `assigned` needs an owner, resolved/closed need a resolution                                                                                                                            |
| `inspections`          | Append-only (`forbid_mutation`) outcomes `passed / failed` with inspector snapshot and instant; the latest decides SPK-FAC-004                                                                                                                                                                                                                                                                                            |
| `restrictions`         | Affected area `resource_id` (whole pitch or subdivision), optional asset/task, kind `closed / limited`, `tstzrange during`, status `proposed → approved → active → released` or `proposed / approved → withdrawn` (0903), approval, release and withdrawal facts (check-constrained to the state), `scheduling_closure_id` (composite FK to closures), `affected_conflict_unit_ids` derived from scheduling at activation |
| `preventive_schedules` | Recurrence in facility-local time + zone, task template, restriction kind, lead time, status `active / paused / ended`                                                                                                                                                                                                                                                                                                    |

Assigned owner (SPK-FAC-002, §4.3): a task PATCH, a reported or generated task and a preventive
schedule's `taskTemplate.assignedOwnerPersonId` accept only an active adult person of the
organization (checked through `PERSON_DIRECTORY_PORT`; otherwise VALIDATION_FAILED with the path),
and migration `0901` adds the composite foreign key `(organization_id, assigned_owner_person_id)`
to `persons`. A template whose owner later becomes inactive fails generation with that error
until the template is edited. Facilities API tests keep the fake principals through
`__tests__/support.ts`, because importing IdentityModule brings its principal resolver.

Invariants enforced by the database: composite `(organization_id, id)` foreign keys everywhere
(including the closure reference and the assigned owner); facility-scoped keys (migration `0902`,
§4.3): an asset, preventive schedule, task or restriction names only the space, asset, task,
schedule and closure of its own facility; one closure backs at most one restriction; the unreleased
restrictions of a task never overlap in time (migration `0906`, below); a preventive schedule materializes each occurrence's task and
restriction at most once; `active` needs a closure, `released` needs who/when/which closure. A
preventive recurrence describes at most `maxScheduleOccurrences` (366) occurrences: a longer one is
refused at creation, and one stored before that rule is refused at generation, with
`VALIDATION_FAILED` `details.code = SERIES_TOO_LONG`, never truncated (**Verified**, R3-TIME-MONEY-04,
`__tests__/preventive-schedules.spec.ts`).
Migration `0903` (FAC-01): `withdrawn` exactly when `withdrawn_at` is set, with `withdrawn_by` and a
1..2000-character `withdrawal_reason`; a withdrawn restriction never took effect (no conflict units);
`proposed` carries no approval facts and `approved / active / released` always do (the 0900 check
`(status = 'proposed') = (approved_at is null)`, found in `pg_constraint` by its definition, is
replaced by these two halves); a withdrawn restriction no longer counts as the task's one open
restriction; the trigger `restrictions_terminal_guard` refuses any rewrite of a `released` or
`withdrawn` row (`restrict_violation`). **Verified**: `schema-invariants.spec.ts` "the database
rejects a withdrawn restriction without withdrawal facts (FAC-01, migration 0903)", "released and
withdrawn restrictions are final: the database refuses to rewrite them (FAC-01, migration 0903)".
Migration `0904` (INTEGRITY-05, §4.6) replaces the guard function so the database mirrors
RestrictionMachine: a status change is only `proposed → approved`, `proposed → withdrawn`,
`approved → active`, `approved → withdrawn` or `active → released` (so `active → approved`,
`approved → proposed` and `proposed → active` are refused); once approved, the approval facts and
what was approved (area, interval, kind, reason, links) are final, and only the lifecycle moves on
(status, closure link, conflict units at activation, release or withdrawal facts, `operation_id`,
`revision`); the closure link, once recorded, never changes or is cleared; the conflict units are
final while active. **Verified**: `schema-invariants.spec.ts` "§4.6 RestrictionMachine: the
database refuses transitions the machine forbids and keeps what was approved final (INTEGRITY-05,
migration 0904)". Migration `0905` (R2-SCHEMA-01, §4.7 invariant 9) refuses deleting a restriction
past `proposed` (`restrictions_no_delete`, `restrict_violation`), so who approved closing an area,
and its release or withdrawal, cannot vanish; a proposed one can still be deleted. **Verified**:
`schema-invariants.spec.ts` "R2-SCHEMA-01 / §4.7 invariant 9 (migration 0905)". Migration `0906`
(R4-OPS-MODULES-02, SPK-FAC-004) replaces `restrictions_open_task_idx` (one unreleased restriction
per task at all) with the exclusion constraint `restrictions_open_task_no_overlap`: the proposed,
approved and active restrictions of one task never overlap in time (`exclusion_violation`, answered
409 `RESOURCE_CONFLICT` `details.code = TASK_RESTRICTION_OVERLAP`), and a follow-on restriction of the
task that starts where the open one ends is accepted, so an overrunning repair keeps the area closed
under the same inspection gate. **Verified**: `schema-invariants.spec.ts` "SPK-FAC-002 / SPK-FAC-004:
a task carries at most one unreleased operating restriction at any instant; a follow-on may continue
it (R4-OPS-MODULES-02, migration 0906)".

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/facilities.ts`)

| Method                | Path                                                          | Action                                                                             |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| POST/GET/PATCH/DELETE | `/assets`, `/assets/{id}` (DELETE = retire)                   | `facilities.manage_asset` / `view_maintenance`                                     |
| POST                  | `/maintenance-tasks`                                          | `facilities.report_issue` (every staff role)                                       |
| GET                   | `/maintenance-tasks`, `/maintenance-tasks/{id}`               | `facilities.view_maintenance`                                                      |
| PATCH                 | `/maintenance-tasks/{id}`                                     | `facilities.manage_maintenance_task`: assign/unassign, edit, start, resolve, close |
| POST/GET              | `/maintenance-tasks/{id}/inspections`                         | `facilities.record_inspection` / `view_maintenance`                                |
| POST                  | `/maintenance-restrictions`                                   | `facilities.apply_restriction` (§4.8): propose and, by default, approve            |
| GET                   | `/maintenance-restrictions`, `/maintenance-restrictions/{id}` | `facilities.view_maintenance`                                                      |
| POST                  | `/maintenance-restrictions/{id}/approve`                      | `facilities.apply_restriction` (also resumes an interrupted activation)            |
| POST                  | `/maintenance-restrictions/{id}/release`                      | `facilities.release_to_service` (facilities operator, general manager)             |
| POST                  | `/maintenance-restrictions/{id}/withdraw`                     | `facilities.apply_restriction`: withdraw before it takes effect (FAC-01)           |
| GET                   | `/facilities/{id}/operating-status?at=`                       | `facilities.view_maintenance`: per resource `in_service` / `restricted` + why      |
| POST/GET/PATCH        | `/preventive-schedules[/{id}]`                                | `facilities.schedule_preventive_maintenance` / `view_maintenance`                  |
| POST                  | `/preventive-schedules/{id}/generate`                         | `facilities.schedule_preventive_maintenance`                                       |

Every POST/PATCH/DELETE is `@Idempotent()` and validated with zod; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Approve, release and generate are
multi-step commands recorded as operations (`facilities.approve_restriction`,
`facilities.release_restriction`, `facilities.withdraw_restriction`,
`facilities.generate_preventive_maintenance`), readable at `GET /v1/operations/{id}` and referenced
by `operationId` on the restriction. §5.6 record authority: approve, release and the create route are
listed in the migration module's `AUTHORITY_ROUTES` as `future_schedule`; the withdraw route carries
`@RecordAuthority('future_schedule', 'unproven')` on its handler (IF-41). List flags `overdue`
(`GET /maintenance-tasks`) and `includeRetired` (`GET /assets`) use `QueryBoolean` (IF-06): only
`true` / `false`, so `?overdue=false` is no filter (**Verified**, `maintenance-tasks.spec.ts`
"IF-06 (FAC-01): list flags read ?overdue=false and ?includeRetired=false as false and refuse other
values").

## Behaviour notes

- **SPK-FAC-003, SPK-AT-021.** Approving a restriction records the authority in one transaction,
  then calls the scheduling `ClosurePort` (`createClosure` with `source: 'maintenance'`, then
  `applyClosure`), then activates the restriction with the conflict units of the affected
  resource (read through `ResourcesService`). A subdivision restriction blocks only that
  subdivision's unit (the other half stays bookable; a whole-pitch booking is rejected because the
  pitch shares the unit); a whole-pitch restriction blocks every subdivision. Approval, the
  closure commands and the activation run in ONE transaction (scheduling's commands join it;
  `UnitOfWork.run` is reentrant), so an interruption or a refused step leaves the restriction as it
  was, never `approved` with the field still bookable (§4.7 invariant 12; **Verified**,
  `__tests__/restrictions.spec.ts` "approval, closure and activation commit together"). A
  restriction left `approved` by an earlier version is still resumed by `POST …/approve`. Release
  (lift the closure, then release) is one transaction in the same way.
  Exactly one closure backs a restriction (SPK-FAC-004, SPK-AT-021): the closure id is linked under
  the restriction's row lock, a concurrent or retried approval that created its own closure uses the
  linked one instead and withdraws its own, still pending, closure through
  `CLOSURE_PORT.withdrawClosure` in the same unit of work (FAC-01, IF-11; audit
  `facilities.restriction_closure_superseded` with `supersededClosureWithdrawn: true`), and an
  approval that finds the restriction already activated with that closure succeeds
  (`alreadyActive` on its operation). The authorized release therefore lifts the only closure that
  blocks the area, and no orphan closure is left in scheduling (**Verified**:
  `restriction-withdrawal.spec.ts` "SPK-FAC-004 / SPK-AT-021: an approval that loses the race for
  the closure link withdraws the closure it created").
- **Withdrawal (FAC-01, SPK-FAC-004, §4.6, §4.9, §4.2).** `POST …/withdraw { reason,
expectedRevision? }` (authority `facilities.apply_restriction`, the restriction authority that
  proposes and approves) moves `proposed → withdrawn` and `approved → withdrawn` with
  `withdrawnBy / withdrawnAt / withdrawalReason`, an audit record `facilities.restriction_withdrawn`,
  the outbox event `facilities.restriction_withdrawn` (IF-13, no handler yet) and a
  `facilities.withdraw_restriction` operation. An approved restriction backed by a pending closure
  (an activation interrupted under an earlier version) withdraws that closure through
  `CLOSURE_PORT.withdrawClosure`, which joins the same transaction, so both are withdrawn or neither
  is. An active restriction, or an approved one whose closure is already applied, is refused with
  `INVALID_TRANSITION` (machine `Restriction` or `SchedulingClosure`): the area was closed, so it is
  completed with `approve` and returned through the authorized release. The asset's status is never
  touched (only activation restricts it). A withdrawn preventive occurrence counts as decided and is
  never materialized again. **Verified**: `restriction-withdrawal.spec.ts` "SPK-FAC-004: a proposed
  restriction is withdrawn with its reason, audited and announced; it holds nothing and can never
  take effect", "SPK-FAC-004: an approved restriction whose activation never created a closure is
  withdrawn without a scheduling call", "an active restriction cannot be withdrawn", "SPK-FAC-005: a
  withdrawn preventive occurrence is decided and never materialized again"; and "SPK-FAC-004: a
  proposed restriction is withdrawn; an approved one withdraws its pending closure atomically"
  (through scheduling SCH-01, migration 0302). Who may withdraw follows the approval roles, which
  stay **Pending** (DEC-001).
- **SPK-FAC-004.** Closing a task never touches its restriction (`openRestrictionIds` says so).
  `release` requires `facilities.release_to_service`, and when the task `requires_inspection` the
  latest inspection must be a pass that speaks for the work as it now stands (R4-OPS-MODULES-03):
  inspected at or after both the restriction's approval and the task's latest resolution, with the
  task not back at work (`in_progress`). Otherwise `ELIGIBILITY_FAILED`, `details.code =
inspection_required`, with `details.cause` (`not_inspected`, `inspection_failed`,
  `work_in_progress`, `inspection_predates_current_work`) and `details.inspectionRequiredAfter`. A
  pass recorded before the task was reopened for rework, or the pass that released an earlier
  restriction of the same task, therefore never releases the area (`in_progress` is left only by
  resolving or closing the task, which stamps a new resolution instant); an open or assigned task
  is released on a pass after the approval (the inspection found the area fit). **Verified**:
  `restriction-release-gate.spec.ts` "SPK-FAC-004: a pass recorded before the task was reopened for
  rework does not release the area", "SPK-FAC-004: the pass that released an earlier restriction of
  the task does not release a later one", "SPK-FAC-004: an open or assigned task may be released on
  a pass recorded after the approval (the inspection found the area fit)". An inspection is recorded only once it has happened: an `inspectedAt` after the
  server clock is refused (`VALIDATION_FAILED`, `details.code = inspection_in_future`), so a
  future-dated pass can never outrank a later failed inspection. While a restriction on the task is open (proposed, approved or active), turning
  `requiresInspection` off is refused the same way, so the gate cannot be removed before release;
  any change of the requirement is audited (`details.requiresInspection { from, to }`). The
  closure is lifted through the port, then the release is recorded. A failed
  inspection sends a resolved task back to `in_progress`; on a closed task it raises an
  operational exception. A closure backing an approved or active restriction cannot be lifted
  directly in scheduling: facilities registers a `ClosureLiftGuards` guard that refuses the lift
  (422 `ELIGIBILITY_FAILED`, `details.code = restriction_release_required`) unless the
  restriction's own release operation is running (conservative default; who may reopen a
  maintained space is pending with Operations, DEC-001). As defense in depth, a closure found
  lifted anyway raises `facilities.closure_lifted_outside_release` (outbox handler on
  `scheduling.closure_lifted`) and the restriction keeps its state.
- **Restriction interval end (R4-OPS-MODULES-02, SPK-FAC-004, SPK-AT-021).** A restriction is
  approved for a bounded interval and its scheduling closure ends with it, so an active restriction
  that nobody releases stops blocking the area at its end while it still reads `active` (and its
  asset `restricted`). The chosen semantics (option b of the finding): nothing reopens on record
  without the authorized release, and the facilities operator is told before the area reopens. The
  periodic job `facilities.raise_unreleased_restriction_exceptions` (every 300 s, failure owner
  `facilities_operator`, `services/facilities-jobs.ts`) runs
  `RestrictionsService.raiseUnreleasedAtEndExceptions` per organization with an active facility, in
  one transaction each, locking the restrictions `FOR UPDATE SKIP LOCKED`. It raises one
  `facilities.restriction_unreleased_at_end` exception per restriction (dedupe key
  `restriction:<id>:unreleased_at_end`, affected `restriction`, deadline the interval end): `high`
  from `restrictionEndWarningHours` before the end while the task's inspection is outstanding (the
  release gate would refuse), `warning` once the interval ended without a release. To keep the area
  closed, the operator applies a follow-on restriction for the same task starting at the end
  (migration `0906`), whose release the same inspection gates; an active follow-on of the same task
  and area covering the end, a passed inspection before the end, or the release itself settles the
  exception (system actor `facilities.restriction_unreleased_at_end_settled`; the release settles
  it in its own unit of work). `GET /operating-status` and scheduling keep reporting the area by the
  closures in force at the instant. **Verified**: `restriction-interval-end.spec.ts` "SPK-FAC-004 /
  SPK-AT-021: an active restriction whose task still needs its inspection raises an owned exception
  before its interval ends, and a follow-on restriction of the same task keeps the area closed past
  the end under the same inspection gate", "SPK-FAC-004: a passed inspection before the end settles
  the warning; an interval that then ends without a release is raised again until the release
  settles it". The warning lead (24 h) is **Proposed** (`FACILITIES_POLICY`, DEC-001); open-ended
  restrictions released only by the release (option a) would need open-ended scheduling closures and
  are not built.
- **SPK-FAC-005.** `generate` materializes occurrences starting before `now + leadTimeDays` (or
  `through`) and not yet ended: a task from the template (due at the occurrence end) plus a
  restriction approved under the schedule's own authority (`system` principal
  `preventive_schedule:<id>`; creating the schedule was the human approval, so a scheduler or an
  automation run may generate). Each occurrence is materialized once; reruns report
  `alreadyGeneratedOccurrenceIndexes` and resume proposed/approved leftovers.
- **Overdue escalation (SPK-UX-006).** Reporting or re-dating a task of an escalating severity
  enqueues `facilities.maintenance_task_due_reached` with `availableAt = dueAt`; the handler
  raises `facilities.maintenance_task_overdue` (dedupe key `maintenance_task:<id>:overdue`) if
  the task is still open. The periodic job `facilities.raise_overdue_task_exceptions` (FAC-03,
  §4.12, every 300 s, failure owner `facilities_operator`, `services/facilities-jobs.ts`) runs
  `MaintenanceTasksService.raiseOverdueExceptions` for each organization with an active facility,
  one transaction per organization, at the runner's clock instant; the dedupe key keeps one open
  exception per task, so a replay raises nothing new. **Verified**: `facilities-jobs.spec.ts` "an
  escalating task past due raises one exception when the job runs after FixedClock passes its due
  time", "a second run raises nothing new". Which severities escalate is **Proposed**
  (`FACILITIES_POLICY`, DEC-001).
- **Overdue settlement (ASYNC-09, SPK-UX-006, §4.12).** The fact that ends an overdue exception
  settles it: when `PATCH /v1/maintenance-tasks/{id}` leaves a task resolved or closed, re-dated
  to a later due time (or without one) or at a severity that does not escalate, the task command
  resolves its open or acknowledged `facilities.maintenance_task_overdue` exception in the same
  unit of work (system actor `facilities.maintenance_task_overdue_settled`, the reason naming the
  fact, the task's status, severity, due time and revision as the resolution; the task's own audit
  names the person). A task that is overdue again later is raised anew. The sweep locks the tasks
  it raises for (`FOR UPDATE SKIP LOCKED`): it leaves a task a command holds to that command, and a
  command that reaches a task the sweep holds waits, then settles what the sweep raised. The due
  timer handler reads the task row locked, so a task resolved in the same instant is never
  escalated. **Verified**: `facilities-jobs.spec.ts` "SPK-UX-006 (ASYNC-09): resolving, closing,
  re-dating or de-escalating an overdue task settles its exception, and the sweep raises nothing
  for it again", "§4.12 (ASYNC-09): a task resolved while the sweep is raising its exception keeps
  no open overdue exception (PGlite and TEST_DATABASE_URL)", "§4.12 (ASYNC-09): the due timer of a
  task being resolved never escalates it (PGlite and TEST_DATABASE_URL)". A manually closed
  exception of a task that is still overdue is raised again by the next sweep (intended).
- Assets follow their restrictions: `in_service → restricted` on activation and back on release
  when no other approved or active restriction names the asset (a merely proposed one holds
  nothing; R4-OPS-MODULES-05); other asset states are left alone. `restricted` is the lifecycle
  status ("an approved, unreleased restriction names it, now or later"); availability for a time is
  the asset directory's `usable` with the booking's intervals (below). While an approved or active
  restriction names the asset, `PATCH /v1/assets/{id}` refuses `status: in_service` (from any state)
  with `ELIGIBILITY_FAILED`, `details.code = restriction_release_required`: the asset returns to
  service only through the restriction's release, which needs `facilities.release_to_service` and
  the inspection gate (a system administrator holds `manage_asset` only); it may be set
  `restricted`, `out_of_service` or retired meanwhile. **Verified**: `asset-directory.spec.ts`
  "SPK-FAC-004 (R4-OPS-MODULES-05): a restricted asset returns to service only through its
  restriction release, never through PATCH /v1/assets". Retiring an asset with open tasks is
  refused.

## Ports (`ports.ts`, provided by `FacilitiesModule`)

- `MAINTENANCE_REPORT_PORT` → `MaintenanceTasksService.reportIssue` (support, entry, automation).
- `OPERATING_STATUS_PORT` → `RestrictionsService.operatingStatus` / `activeRestrictions`
  (reporting, communications, Today workspace).
- `ASSET_DIRECTORY_PORT` (FAC-02, IF-33; SPK-COND-003) → `AssetDirectoryService.describe(organizationId,
assetIds, trx?, { intervals? })`, registered as `ASSET_DIRECTORY_IMPL`: reads through the passed
  transaction, else the active one, and returns `{ id, facilityId, kind, name, status, usable }` per
  known asset of the organization. Without `intervals`, `usable` is `in_service` with no active
  restriction naming the asset at the clock instant (conservative: an asset an approved future
  restriction already marks `restricted` reads unusable at every time). With the booking's
  `intervals` (R4-OPS-MODULES-05, SPK-FAC-003: a restriction affects availability for its approved
  interval), `usable` is: in service, or `restricted` only by approved or active restrictions, and
  none of them overlaps any interval; out-of-service, retired, and manually restricted assets with no
  restriction behind them are never usable, and a malformed interval is `VALIDATION_FAILED`
  (**Verified**, `asset-directory.spec.ts` "SPK-FAC-003 / SPK-COND-003 (R4-OPS-MODULES-05): with the
  booking intervals, equipment a future restriction names is usable outside its window and unusable
  inside it"). Enrollment's rental and party bookings do not pass their occurrences yet, so they
  still get the conservative answer (**Pending** the enrollment change, deferred from
  R4-OPS-MODULES-05). Unknown, malformed and other-organization ids are omitted, so a booking naming them
  is refused (enrollment's rental and party bookings). Scheduling equipment commitments keep the
  asset id as party id. **Verified**: `asset-directory.spec.ts` "a retired or restricted asset reads
  as not usable", "another organization's asset is omitted", "reads through the passed or active
  transaction (a booking sees its own uncommitted writes)".
- `FACILITIES_POLICY` (`facilities.policy.ts`): default due hours per severity, escalating
  severities, preventive lead time and per-run limits, default closure resolution mode.

Test fixtures for downstream modules: `testing/facilities-fixtures.ts` (`seedAsset`,
`reportMaintenanceTask`, `recordInspection`, `createActiveRestriction`,
`createPreventiveSchedule`).

## Events (`facilities.events.ts`)

`facilities.maintenance_task_reported`, `facilities.maintenance_task_updated` (changes, status,
open restriction ids), `facilities.inspection_recorded`, `facilities.restriction_activated` /
`facilities.restriction_released` (area, affected conflict units, closure id),
`facilities.restriction_withdrawn` (FAC-01, IF-13: area, interval, reason, closure id or null),
`facilities.preventive_occurrences_generated`, and the internal timer
`facilities.maintenance_task_due_reached`.

Handlers registered in `onModuleInit`: `facilities.escalate_overdue_task` (own timer) and
`facilities.reconcile_lifted_closure` (`scheduling.closure_lifted`). Periodic jobs:
`facilities.raise_overdue_task_exceptions` (FAC-03) and
`facilities.raise_unreleased_restriction_exceptions` (R4-OPS-MODULES-02).

## Known gaps / pending decisions

- Due lead time per severity (critical 4 h, high 24 h, medium 72 h, low 168 h), the escalating
  severities (`critical`), the preventive lead time (14 days), the default closure resolution
  mode (`leave_for_resolution`) and the warning lead before an unreleased restriction's end (24 h,
  `restrictionEndWarningHours`) are **proposed** defaults pending the operations decisions (§6.6);
  override by providing `FACILITIES_POLICY`.
- `limited` restrictions close the area for their interval exactly like `closed` ones; partial-use
  rules (formats, capacity, daylight-only) are a **pending** operations decision and would need a
  scheduling-side mechanism.
- The approval rule for restrictions (who may approve, whether a second approver is needed) is
  **pending** (permission matrix C.10); today the proposer approves in the same request.
- An `approved` restriction cannot be released before activation completes (`approve` resumes it);
  it can be withdrawn while its closure is still pending (FAC-01).
- Stage-3 cross-module dependencies (**Verified**, merged): the closure withdrawal path calls
  scheduling's `ClosurePort.withdrawClosure` (SCH-01, migration 0302). The two SPK-FAC-004 tests that
  exercise it (`restriction-withdrawal.spec.ts`) run unconditionally, with no feature detection, so a
  change to the closure schema or port fails them instead of skipping them (R2-TESTS-09). The withdraw
  route is classified for §5.6 only by its `@RecordAuthority('future_schedule', 'unproven')`
  decorator (MIG-00).
- Evidence is stored by reference only; file storage is a provider-selection gate (§5.2).

## Stage-3 integration fixes — verified 2026-10-29

- `RestrictionsService.assertClosureWithdrawAllowed`: a scheduling closure linked to a proposed,
  approved or active restriction cannot be withdrawn through scheduling
  (`RESOURCE_CONFLICT` `OWNED_BY_RESTRICTION`); the restriction's own withdrawal stays the way to
  withdraw it (`__tests__/restriction-withdrawal.spec.ts`, scheduling
  `__tests__/closure-withdrawal.spec.ts`).
