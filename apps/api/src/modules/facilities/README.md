# facilities module

**Owns:** Assets, maintenance tasks, inspections, operating restrictions, release-to-service,
preventive maintenance schedules

**Specification:** §3.17 (SPK-FAC-001..005), §4.4 Facilities (Asset, MaintenanceTask, Inspection,
Restriction), §4.8 `POST /v1/maintenance-restrictions`, SPK-AT-021, SPK-UX-006 (overdue
escalation)

**Migration range:** `packages/db/migrations/0900_facilities_*.sql` … `0999` (present: `0900`,
`0901_facilities_task_owner_fk`, `0902_facilities_facility_scoped_keys`)

**Depends on:** scheduling (closure port, resources public API) and identity
(`PERSON_DIRECTORY_PORT`, to check assigned task owners). Restrictions create scheduling closures
through the scheduling authority; this module never writes scheduling or identity tables (§4.2).

**Status: implemented** (verified by `apps/api/src/modules/facilities/__tests__` and
`facilities.state-machines.spec.ts`). Pending decisions are listed at the end.

## Tables (migration `0900_facilities_core.sql`)

| Table                  | Purpose                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets`               | Turf, goals, nets, boards, dividers, lighting, scoreboards, equipment, other; optional `resource_id` (the space it belongs to); status `in_service / restricted / out_of_service / retired`; identifier unique among non-retired assets of a facility                                                                                                             |
| `maintenance_tasks`    | Asset or space (check: at least one), issue, severity, reporter snapshot, evidence (references only), assigned owner, due instant, status `open → assigned → in_progress → resolved → closed`, `requires_inspection`, resolution; `assigned` needs an owner, resolved/closed need a resolution                                                                    |
| `inspections`          | Append-only (`forbid_mutation`) outcomes `passed / failed` with inspector snapshot and instant; the latest decides SPK-FAC-004                                                                                                                                                                                                                                    |
| `restrictions`         | Affected area `resource_id` (whole pitch or subdivision), optional asset/task, kind `closed / limited`, `tstzrange during`, status `proposed → approved → active → released`, approval and release facts (check-constrained to the state), `scheduling_closure_id` (composite FK to closures), `affected_conflict_unit_ids` derived from scheduling at activation |
| `preventive_schedules` | Recurrence in facility-local time + zone, task template, restriction kind, lead time, status `active / paused / ended`                                                                                                                                                                                                                                            |

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
schedule and closure of its own facility; one closure backs at most one restriction; a task carries at
most one unreleased restriction; a preventive schedule materializes each occurrence's task and
restriction at most once; `active` needs a closure, `released` needs who/when/which closure.

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
| GET                   | `/facilities/{id}/operating-status?at=`                       | `facilities.view_maintenance`: per resource `in_service` / `restricted` + why      |
| POST/GET/PATCH        | `/preventive-schedules[/{id}]`                                | `facilities.schedule_preventive_maintenance` / `view_maintenance`                  |
| POST                  | `/preventive-schedules/{id}/generate`                         | `facilities.schedule_preventive_maintenance`                                       |

Every POST/PATCH/DELETE is `@Idempotent()` and validated with zod; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Approve, release and generate are
multi-step commands recorded as operations (`facilities.approve_restriction`,
`facilities.release_restriction`, `facilities.generate_preventive_maintenance`), readable at
`GET /v1/operations/{id}` and referenced by `operationId` on the restriction.

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
  linked one instead (audit `facilities.restriction_closure_superseded`; its own closure stays
  `pending`, which blocks nothing), and an approval that finds the restriction already activated
  with that closure succeeds (`alreadyActive` on its operation). The authorized release therefore
  lifts the only closure that blocks the area.
- **SPK-FAC-004.** Closing a task never touches its restriction (`openRestrictionIds` says so).
  `release` requires `facilities.release_to_service`, and when the task `requires_inspection` the
  latest inspection must be `passed` (`ELIGIBILITY_FAILED`, `details.code = inspection_required`
  otherwise). An inspection is recorded only once it has happened: an `inspectedAt` after the
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
- **SPK-FAC-005.** `generate` materializes occurrences starting before `now + leadTimeDays` (or
  `through`) and not yet ended: a task from the template (due at the occurrence end) plus a
  restriction approved under the schedule's own authority (`system` principal
  `preventive_schedule:<id>`; creating the schedule was the human approval, so a scheduler or an
  automation run may generate). Each occurrence is materialized once; reruns report
  `alreadyGeneratedOccurrenceIndexes` and resume proposed/approved leftovers.
- **Overdue escalation (SPK-UX-006).** Reporting or re-dating a task of an escalating severity
  enqueues `facilities.maintenance_task_due_reached` with `availableAt = dueAt`; the handler
  raises `facilities.maintenance_task_overdue` (dedupe key `maintenance_task:<id>:overdue`) if
  the task is still open. `MaintenanceTasksService.raiseOverdueExceptions` is the sweep for
  automation.
- Assets follow their restrictions: `in_service → restricted` on activation and back on release
  when no other open restriction remains; other asset states are left alone. Retiring an asset
  with open tasks is refused.

## Ports (`ports.ts`, provided by `FacilitiesModule`)

- `MAINTENANCE_REPORT_PORT` → `MaintenanceTasksService.reportIssue` (support, entry, automation).
- `OPERATING_STATUS_PORT` → `RestrictionsService.operatingStatus` / `activeRestrictions`
  (reporting, communications, Today workspace).
- `FACILITIES_POLICY` (`facilities.policy.ts`): default due hours per severity, escalating
  severities, preventive lead time and per-run limits, default closure resolution mode.

Test fixtures for downstream modules: `testing/facilities-fixtures.ts` (`seedAsset`,
`reportMaintenanceTask`, `recordInspection`, `createActiveRestriction`,
`createPreventiveSchedule`).

## Events (`facilities.events.ts`)

`facilities.maintenance_task_reported`, `facilities.maintenance_task_updated` (changes, status,
open restriction ids), `facilities.inspection_recorded`, `facilities.restriction_activated` /
`facilities.restriction_released` (area, affected conflict units, closure id),
`facilities.preventive_occurrences_generated`, and the internal timer
`facilities.maintenance_task_due_reached`.

Handlers registered in `onModuleInit`: `facilities.escalate_overdue_task` (own timer) and
`facilities.reconcile_lifted_closure` (`scheduling.closure_lifted`).

## Known gaps / pending decisions

- Due lead time per severity (critical 4 h, high 24 h, medium 72 h, low 168 h), the escalating
  severities (`critical`), the preventive lead time (14 days) and the default closure resolution
  mode (`leave_for_resolution`) are **proposed** defaults pending the operations decisions (§6.6);
  override by providing `FACILITIES_POLICY`.
- `limited` restrictions close the area for their interval exactly like `closed` ones; partial-use
  rules (formats, capacity, daylight-only) are a **pending** operations decision and would need a
  scheduling-side mechanism.
- The approval rule for restrictions (who may approve, whether a second approver is needed) is
  **pending** (permission matrix C.10); today the proposer approves in the same request.
- A `proposed` restriction cannot be withdrawn and an `approved` one cannot be released before
  activation completes (`approve` resumes it); the scheduling port offers no closure withdrawal.
  For the same reason the closure created by a superseded concurrent approval stays `pending` in
  scheduling (inert); removing it needs a `withdrawClosure` on the closure port (scheduling owner).
- Evidence is stored by reference only; file storage is a provider-selection gate (§5.2).
