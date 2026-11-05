# workforce module

**Owns:** availability windows, qualifications, assignment requirements, assignments
(proposed → completed), fee submissions, fee adjustments, fee export batches; the replacement
workflow and time-bounded access for temporary and substitute work

**Specification:** §3.10 (SPK-STAFF-001..006), §2.4 SPK-UX-007, §4.4 Workforce (Availability,
Qualification, Assignment, FeeSubmission), §4.6 Assignment machine, §4.8
`POST /v1/assignments/{id}/accept`, SPK-AT-012, §1.7 (no payroll execution)

**Migration range:** `packages/db/migrations/0700_workforce_*.sql` … `0799`

**Depends on:** identity (`PERSON_DIRECTORY_PORT`, `STAFF_DIRECTORY_PORT`, `PeopleService` for
display names, `StaffMembershipsService` for time-bounded access), scheduling (`EventsService` for
event targets, its exported `ConflictDetector` and `SCHEDULING_POLICY` for person commitments,
`scheduling.event_changed`), competition (`FIXTURE_PORT`, `TEAM_ENTRY_QUERY_PORT`,
`READINESS_CHECK_REGISTRY`, `ASSIGNMENT_CHECK_IMPL`, `competition.fixture_changed`), catalog
(`OfferingsService`, `SessionsService`, `catalog.session_canceled`), communications
(`NotificationsService.composeAndQueueIn` for its own assignment notices, IF-22; communications
does not import workforce), identity again for merges (`identity.persons_merged`,
`PERSON_DIRECTORY_PORT.personIdsResolvingTo` / `resolveCanonicalPersonId`, IF-21/IF-09), and the
kernel (`FacilityDirectory`, IF-03; module settings, IF-43). It never reads or writes those
modules' tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/workforce/__tests__` and the unit
specs next to the code (`workforce.state-machines.spec.ts`, `workforce.shared.spec.ts`), under
PGlite and PostgreSQL (`TEST_DATABASE_URL`). Statements below are **verified** unless marked
**proposed**, **pending** or **gap** (§6.7). Stage 3 (WRK-01 to WRK-06) is summarized in
"Stage 3" below; every policy value is now configuration with no default ("Policy settings").

## Kernel and module registrations — verified

- Competition readiness check `workforce.required_officials` (SPK-READY-001, SPK-STAFF-002):
  every requirement of a fixture short of accepted (or completed) assignments is a `blocking`
  issue (`warning` when the requirement does not demand acceptance); proposed and offered
  assignments are named in the message but never counted. A fixture without a requirement gets
  an `info` issue (`officials_not_required`); the "officials unknown" verdict disappears.
- The same check reports `required_official_unqualified` (`required_staff_unqualified` for other
  kinds; blocking when the requirement demands acceptance) when an accepted assignee no longer
  holds the requirement's qualifications, verified and valid at the game's current start: a
  revocation after acceptance, a requirement edited to add a qualification, or a reschedule past
  the qualification's validity (SPK-READY-002/004, SPK-STAFF-001). It is evaluated at read time
  from the qualification records; the coverage counts stay the assignment fact, and the message
  names no person or record status because readiness reaches team members
  (`__tests__/qualification-readiness.spec.ts`).
- `ASSIGNMENT_CHECK_IMPL` → `CoverageService.isAcceptedOfficial`: an accepted or completed
  `official` assignment for the fixture (competition lets that official submit results,
  SPK-STAFF-005).
- Outbox handlers (idempotent under replay, writes through `ctx.trx`):
  `workforce.follow_fixture` (`competition.fixture_changed`: rescheduled → assignments retimed;
  canceled/postponed/unscheduled → live assignments withdrawn), `workforce.follow_event`
  (`scheduling.event_changed` for event targets: the event's current state, read in the
  handler's transaction, decides — canceled → withdrawn, otherwise retimed to its current times —
  so a late or reordered delivery never retimes back to an older time, §4.12, §4.6),
  `workforce.follow_session` (`catalog.session_canceled` → withdrawn),
  `workforce.follow_session_retimed` (`catalog.session_retimed`, R2-JOURNEYS-03: live `session`
  assignments take the session's current times read in the handler's transaction, through the same
  retime, access window included; `__tests__/access-follow-ups.spec.ts` "R2-JOURNEYS-03"). A retime of an accepted
  assignment is checked against every commitment of the person (accepted or completed
  assignments, and person commitments held in scheduling); a conflict withdraws the moved
  assignment with the activity's new time recorded on it and escalates the slot as uncovered
  (`schedule_conflict`), evaluated against the new start (window, deadline, notice), never
  double-books. A canceled, postponed or unscheduled fixture, a canceled event and a canceled
  session also close the target's open `workforce.uncovered_assignment` exceptions (SPK-UX-006).
- Scheduling closure impact contributor `workforce.staff_assignments` (`ClosureImpactContributors`,
  registered in `onModuleInit`; SPK-SCHED-009, SPK-AT-009, R3-TRACE-A-06): a closure preview, and
  the impact stored on a created or applied closure, names the live assignments (proposed, offered
  or accepted) on the affected events by id, person, event, kind, role and status, read through
  the preview's own executor. It always answers, `[]` when none, which is what marks staff as
  identified (`__tests__/closure-impact-staff.spec.ts`).
- Scheduling party commitment source `workforce.assignments` (`PartyCommitmentSources`,
  registered in `onModuleInit`): scheduling's conflict detection and its post-lock re-check see
  accepted and completed assignments, so scheduling refuses to commit a person an assignment holds
  (`party_overlap` / `insufficient_rest` naming `externalCommitments`, SPK-SCHED-004 official and
  assigned-coach overlap, SPK-STAFF-003). `CommitmentChecker` takes the same per-person advisory
  lock (`lockParty`) before it reads, so an acceptance and a scheduling command for one person are
  serialized (tested under PostgreSQL concurrency in `__tests__/commitments-retime.spec.ts`).
  `assertAssignable` takes that lock first, before the qualification, availability and
  commitment reads, and a qualification revocation takes it too (see "Qualification lapses after
  acceptance").

## Tables (migration `0700_workforce_core.sql`)

| Table                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability`            | Person, `starts_at/ends_at` and generated `during tstzrange`, kind `available/unavailable`, note, status `active → withdrawn` (reason kept), revision. Exclusion `availability_no_overlap`: one active statement per person per instant                                                                                                                                                                                                                                                                          |
| `qualifications`          | Person, kind (slug), level, evidence reference (never an upload), `valid_from/valid_to`, status `pending_verification → verified → revoked` or `rejected`, verifier and instant, reason, revision                                                                                                                                                                                                                                                                                                                |
| `assignment_requirements` | Target (`fixture/event/session` + the matching composite FK to `fixtures`, `events` or `offering_sessions`), kind, role, `required_count`, `must_be_accepted`, required qualification kinds; unique per (target, role); retirement facts `retired_at`, `retired_reason`, `retired_by` (migration 0704)                                                                                                                                                                                                           |
| `assignments`             | Person, kind `official/coach/supervisor/organizer`, target (+ FKs), copied title and interval, role, slot, engagement `regular/temporary/substitute`, status per `AssignmentMachine` (check lists exactly its states), every state's fact (offered/responded/accepted/declined/withdrawn/completed instants, reasons, actors), turnaround, `committed_end` and generated `committed` range, `replaces_assignment_id`, access status/window/`access_membership_id` (FK to identity `staff_memberships`), revision |
| `fee_submissions`         | Assignment, person, `rate_basis` jsonb, computed and submitted amounts (bigint minor units + currency), status `submitted → approved/adjusted/rejected → exported`, approver and instant, current approved amount, rejection reason, `export_batch_id`; one live submission per assignment                                                                                                                                                                                                                       |
| `fee_adjustments`         | Append-only (`forbid_mutation`): sequence, previous and adjusted amount, currency, reason, actor, instant                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fee_export_batches`      | Append-only: currency, count, total, the exported lines, actor, operation                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `assignment_notices`      | Migration 0705, append-only (`forbid_mutation`): what the assignee was told about an assignment (WRK-04): per-assignment `sequence` (unique), the communications kind, the `notification_id` it became (no foreign key: that table is created later, by migration 1000, and owned by communications), the source event (unique), and the time it stated                                                                                                                                                          |

Invariants enforced by the database (tests in `__tests__/workforce-schema.spec.ts`):

- `assignments_no_overlap` — GiST exclusion on `(organization_id, person_id, committed)` where
  `status in ('accepted', 'completed')` (migration `0701_workforce_completed_holds_commitment.sql`:
  completion is allowed once the activity starts, so a completed assignment keeps holding its
  interval); `committed = [scheduled_start, scheduled_end + turnaround)`, so both double-booking
  and too-short turnaround are refused (SPK-STAFF-003).
- `assignments_one_accepted_per_slot` — one accepted or completed assignment per (target, role,
  slot); `assignments_one_live_per_person_slot` — one live assignment per person per slot.
- Check constraints: machine states, each state's fact, `committed_end` equals scheduled end plus
  turnaround, access only for temporary/substitute work, target/FK agreement.
- Every workforce table refuses `DELETE` (SPK-STAFF-004: expiry never removes historical work
  records); `fee_adjustments`, `fee_export_batches` and `assignment_notices` also refuse
  `UPDATE`; `assignment_notices` holds one row per (assignment, sequence), per notification and
  per source event (test in `__tests__/assignment-notices.spec.ts`).
- `fee_submissions (organization_id, export_batch_id, currency)` references the batch's
  `(organization_id, id, currency)`: a submission exports only in its own currency; a fee
  adjustment likewise names its submission with the submission's currency (`0703`).
- An event-type requirement or assignment always carries its composite-keyed
  `scheduling_event_id` (`0702`; a null id no longer satisfies the target check).
- Composite `(organization_id, …)` foreign keys on every reference (§4.3).
- Requirement retirement (`0704_workforce_requirement_retirement.sql`, WRK-02):
  `assignment_requirements_retirement_facts` (when, why and by whom: all three or none; the reason
  1..2000 characters); trigger `assignment_requirements_retirement_guard` refuses any update of a
  retired requirement (un-retiring included); trigger `assignments_requirement_not_retired`
  refuses inserting, or moving into, `proposed/offered/accepted` an assignment whose target and
  role have a retired requirement (it reads the requirement `FOR SHARE`, so a racing retirement
  either sees the assignment or refuses it). The delete guard stays.
- Assignment identity (`0706_workforce_assignment_identity_immutable.sql`, WRK-02, R2-SCHEMA-06):
  trigger `assignments_zz_identity_immutable` (every `UPDATE`) refuses any change to the id,
  person, kind, target (type, id, fixture, offering session, offering), role, slot or replaced
  assignment of a row (`check_violation`, constraint `assignments_identity_immutable`). A
  different person, target, role or slot is a new assignment (the replacement workflow), so the
  retired-requirement check made at insert and at every status change holds for the row's
  lifetime; the id is fixed because audit, outbox and exception rows name an assignment without a
  foreign key. Times, `scheduling_event_id` (a retime follows the activity), facility, title,
  status facts, access facts and the revision stay updatable. PostgreSQL runs BEFORE ROW triggers
  in name order and each sees the row as the earlier ones left it; the `zz_` name makes the guard
  run after `assignments_requirement_not_retired` and `assignments_touch`, so it compares what
  they produced. A new BEFORE UPDATE trigger on assignments must sort before it to be checked
  (tests in `__tests__/workforce-schema.spec.ts`, including a trigger that moves the slot).

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/workforce.ts`)

| Method   | Path                                                                        | Who (action)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST/GET | `/availability`, POST `/availability/{id}/withdraw`                         | own (`workforce.manage_own_availability`); league/program/general managers for others; read: the person or coverage staff                                                                                                                                                                                                                                                                                                                                                                  |
| POST/GET | `/qualifications`, POST `/{id}/verify`, `/{id}/reject`, `/{id}/revoke`      | self-submission awaits verification; league/program/general managers and system administrators record and decide; nobody verifies their own                                                                                                                                                                                                                                                                                                                                                |
| POST/GET | `/assignment-requirements`, PATCH `/{id}`                                   | league manager, program manager, scheduler, general manager (`workforce.manage_requirements`); GET returns coverage and uncovered slots                                                                                                                                                                                                                                                                                                                                                    |
| POST/GET | `/assignments`, GET `/assignments/{id}`                                     | list items carry `availableActions` (WRK-01, see Stage 3); propose (or propose and offer): the same assigners; temporary/substitute work also needs `workforce.grant_temporary_access` (league/program manager, system administrator); a `turnaroundMinutes` below the facility policy needs `workforce.override_turnaround` (league/program/general managers, POL-033 pending) and a reason, and the audit records both values; read: coverage staff or the assignee, otherwise NOT_FOUND |
| POST     | `/assignments/{id}/offer`                                                   | assigners                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST     | `/assignments/{id}/accept`, `/decline`                                      | only the assignee (§4.8); staff get `PARTICIPANT_AUTHORITY_REQUIRED`, others NOT_FOUND                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST     | `/assignments/{id}/withdraw`                                                | league/program/general managers or the assignee (reason required)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST     | `/assignments/{id}/complete`                                                | league/program/general managers, once the activity has started                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GET/POST | `/assignments/{id}/replacements`                                            | front desk and assigners (`workforce.trigger_replacement`): explained candidates; POST offers the slot to a replacement, optionally withdrawing the original in the same command                                                                                                                                                                                                                                                                                                           |
| POST/GET | `/fee-submissions`, GET `/{id}`, POST `/{id}/approve`, `/adjust`, `/reject` | submit: the assignee of a completed assignment; read: finance operator, general manager, the assignee; decide: finance operator, general manager — never their own fee; staff act only on fees of their facilities' assignments (others NOT_FOUND, absent from lists)                                                                                                                                                                                                                      |
| POST/GET | `/fee-export-batches`, GET `/{id}`                                          | finance operator, exporting only fees of their facilities; reading a batch needs the authority at every facility its lines belong to                                                                                                                                                                                                                                                                                                                                                       |
| GET      | `/me/assignments`                                                           | the caller's own assignments (SPK-UX-007); `activity.facility` names the facility and its time zone (WRK-01)                                                                                                                                                                                                                                                                                                                                                                               |

Both lists, `GET /assignments` and `GET /fee-submissions`, take `order=asc` (default: earliest
scheduled start, or oldest submission, first) or `order=desc` (latest first), keyed on the time and
the id; a cursor continues only the order it was issued for (`400 VALIDATION_FAILED`
`cursor_order_mismatch` otherwise). The staff workspace's earlier fee records (SCR-W-08) read both
newest first (**Verified**, `__tests__/fees-facility-scope.spec.ts` "SPK-STAFF-006 / SCR-W-08:
order=desc lists a person’s fee records and assignments newest first ...").

Every consequential POST/PATCH is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Multi-step commands create an
operation (`GET /v1/operations/{id}`): `workforce.accept_assignment` (temporary access grant),
`workforce.withdraw_assignment` (access end), `workforce.replace_assignment`,
`workforce.export_fees`.

## Behaviour — verified

- **Checks before an offer** (SPK-STAFF-001/003): the person is active; holds every required
  qualification verified and valid at the start (`ELIGIBILITY_FAILED` with
  `qualification_missing/unverified/expired`); has not declared themselves unavailable
  (`person_unavailable`); has no accepted assignment overlapping the held interval
  (`assignment_overlap`, `insufficient_turnaround`) and no person commitment in scheduling
  overlapping it with the turnaround as rest (`party_overlap`, `insufficient_rest`, through
  scheduling's `ConflictDetector`). Accepted and completed assignments both hold the person.
  Conflicts are `RESOURCE_CONFLICT` naming the assignment or event ids. Acceptance re-checks
  qualification and commitments; the database constraints decide races between assignments
  (tested under PostgreSQL concurrency: exactly one of two acceptances wins), and the shared
  per-person party lock decides races with scheduling commitments. Offering and accepting refuse
  an activity that its owning module no longer holds as scheduled (`target_not_scheduled`), so an
  offer left on a canceled game is never accepted and grants no access.
- **Uncovered slots** (SPK-STAFF-003, SPK-AT-012): declining an offered assignment, or withdrawing
  an accepted one, for a required slot that demands acceptance, with no other accepted assignment
  on the slot, within the configured escalation window before the start (at once when none is
  configured), raises `workforce.uncovered_assignment` (severity high, owner `league_manager` for fixtures and
  `scheduler` otherwise, deadline = start, deduplicated per slot) and enqueues
  `workforce.assignment_uncovered`; the command's response carries the notice. Accepting an
  assignment for the slot resolves the exception (it stays as history). Escalation and resolution
  take a per-slot advisory lock, so a decline racing an acceptance of the same slot never leaves
  an open exception on a covered slot (tested under PostgreSQL in
  `__tests__/replacement-target.spec.ts`). A requirement edit (PATCH) after which a slot is no
  longer required (the count lowered below it, or `mustBeAccepted` set to false) resolves that
  slot's open or acknowledged exception in the same transaction (system actor
  `workforce.coverage`; the resolution names the requirement id, revision, count and
  `mustBeAccepted`); exceptions of slots still required stay open (R4-OPS-MODULES-08, SPK-UX-006).
  The edit holds the requirement row `FOR UPDATE`, which an escalation or acceptance of the role
  waits for, so a withdrawal racing the edit never leaves an open exception on a slot the edit no
  longer requires (tested under PostgreSQL in `__tests__/requirement-edit-uncovered.spec.ts`).
  Raising the count again, or setting `mustBeAccepted` back to true, does not re-escalate a slot:
  escalation follows a decline or withdrawal only (see "Gap — slot required again by an edit").
  An operator may close or resolve the same card on Today (support's
  `POST /v1/exceptions/{id}/close|resolve`) without any workforce lock; every settlement by this
  module (the edit, an acceptance covering the slot, a retirement, a canceled activity) re-reads
  the exception under its row lock and leaves it alone when it is no longer open or acknowledged,
  so a card settled meanwhile never fails or rolls back the command (R4-OPS-MODULES-08 rework,
  `services/exception-settlement.ts`; **Verified** under PostgreSQL concurrency and PGlite for
  the edit and the acceptance, `__tests__/requirement-edit-uncovered.spec.ts`).
- **Replacement candidates** (SPK-AT-012): holders of the kind's staff role at the facility plus
  holders of every required qualification; each candidate lists reasons with severity
  `blocking/warning/info/positive` and source ids (qualification held or missing, declared
  availability, conflicting assignments or events, earlier declines, already on the slot);
  eligible candidates sort first. Candidates and the replacement itself use the activity as its
  owning module holds it now (time, event, facility), not the original row's copy: a declined or
  withdrawn original that predates a reschedule is replaced at the current time, and a canceled,
  postponed or unscheduled activity gets no replacement (`target_not_scheduled`). Residual race: a
  cancellation committed between the resolution and the insert is caught by the acceptance's own
  re-check, so it grants no access.
- **Time-bounded access** (SPK-STAFF-004): accepting temporary or substitute work creates an
  identity staff membership (roles per kind, scoped to the activity's facility; identity keeps
  each role at its own membership's facilities, so the access never extends the person's other
  facility-scoped roles to that facility, §2.1, §4.14) from acceptance until the activity's end
  plus the configured trailing hours (none configured: the end). The principal resolver drops the
  roles when the window closes; the assignment, its audit trail, its fee records and the membership row
  remain. Every change to the access runs inside the workforce transaction that causes it
  (identity's command joins it; `UnitOfWork.run` is reentrant), so the assignment and the
  membership commit together (§4.7 invariant 12): acceptance grants it, a withdrawal — by a person,
  by a replacement, or by a follow-up such as a canceled fixture, event or session — ends it at
  once, and a retime moves its end with the activity (new end plus the trailing hours). If
  identity refuses (for example a youth referee, identity grants staff memberships to adults only)
  the acceptance stands, access is `failed`, the operation is `recovery_required` and
  `workforce.temporary_access_failed` is raised for the system administrator. Each identity call
  runs in its own savepoint, so a call that fails after identity wrote anything leaves no
  membership behind (the outcome is never recorded as `failed` while a membership exists). A
  withdrawal sent while the grant is in flight waits for the acceptance's row lock and then ends
  the access. **Verified** (`__tests__/access-follow-ups.spec.ts`,
  `__tests__/access-fees-workspace.spec.ts`).
- **Qualification lapses after acceptance** (SPK-STAFF-001): revoking a qualification, creating a
  requirement (`POST /assignment-requirements` or `declareRequirements`) or editing its
  qualifications or required count raises `workforce.unqualified_assignment` (severity high,
  owner `league_manager` for fixtures and `scheduler` otherwise, deadline = start, one per
  assignment) for every accepted, unfinished assignment in a required slot whose assignee does not
  hold the requirement's qualifications. Nothing is withdrawn automatically: an operator decides
  (POL-033 pending). A requirement edit after which an accepted assignment is no longer
  unqualified (its slot above a lowered count, or its assignee holding every qualification the
  requirement now names, none included) resolves that assignment's open or acknowledged
  exception in the same transaction (system actor `workforce.coverage`; the resolution names the
  requirement id, revision, count and qualifications, the assignment, its slot and the ground
  `slot_not_required` or `qualified`), as readiness stops reporting it; an assignee still lacking a
  qualification keeps theirs (R4-OPS-MODULES-08 rework, SPK-UX-006; **Verified**,
  `__tests__/requirement-edit-uncovered.spec.ts`). The edit runs under the requirement row's
  `FOR UPDATE` lock, which a revocation's flagging waits for (below). Evidence recorded for a merged person counts for the survivor (WRK-05), so
  revoking it raises the survivor's assignments too (`__tests__/person-merge.spec.ts`).
  Overlapping commands (R2-RACES-02):
  - A revocation and an acceptance are serialized on the person: the revocation takes the party
    lock of everyone the evidence resolves to before it writes, and every assignability check
    (`assertAssignable`: propose, offer, accept, replace) takes the assignee's party lock before it
    reads qualifications. The acceptance either reads the revocation and is refused, or commits
    first and is raised.
  - A revocation and a requirement edit or creation are serialized on the requirement, not the
    person (requirement commands take no party lock): the revocation's flagging takes the shared
    key lock and the row share lock of every requirement the person's accepted assignments name
    (`services/requirement-locks.ts`), an edit holds the row `FOR UPDATE`, and a creation holds the
    key exclusively from before its insert. Whichever commits second reads the other and raises.
  - An acceptance and a requirement creation are serialized on the same key: every assignment
    command takes it shared first, so the acceptance either reads the new requirement and is
    refused, or commits first and is raised by the creation.

  **Verified** under PostgreSQL concurrency and PGlite, each pair in both orders
  (`__tests__/qualification-readiness.spec.ts`).

- **Fees** (SPK-STAFF-006, §1.7): the computed amount comes from the rate basis (per assignment,
  hourly with half-up rounding, flat) next to the submitted amount; approval records the approver;
  every adjustment appends a history row; export batches are immutable records handed to payment
  administration — nothing is paid or sent to a payroll system. A fee belongs to its assignment's
  facility: reads, decisions and exports follow the staff member's facility scope (§4.3, §4.14,
  `__tests__/fees-facility-scope.spec.ts`).
- **Workspace** (SPK-UX-007): own assignments only, the activity's practical details, team names
  for fixtures while the person is offered/accepted/completed (no dates of birth, contacts or
  payment data), the fee record and the commands available now.

## Ports (`ports.ts`)

- `ASSIGNMENT_COVERAGE_PORT` (`AssignmentCoveragePort`): `coverage(organizationId, targetType,
targetId)` per requirement and `acceptedAssignees(...)` for communications (notify the crew),
  entry (coach attendance) and reporting; `isAcceptedOnOffering(organizationId, offeringId,
personId, kind, trx?)` for enrollment (WRK-03, IF-34). All of them skip retired requirements.
- `WORKFORCE_STAFFING_PORT` (`WorkforceStaffingPort`, IF-32): `declareRequirements` and
  `withdrawRequirements` for enrollment's booking events (WRK-02); this module registers
  `WORKFORCE_STAFFING_IMPL` → `StaffingService` (the port itself is the kernel's lazy port).
- Exported services: `AvailabilityService`, `QualificationsService` (`check`, `holdersOfAll`),
  `CoverageService`, `RequirementsService`, `AssignmentsService`, `ReplacementsService`,
  `FeesService`, `WorkspaceService`; policy `WORKFORCE_POLICY`.
- `RequirementsService.listForTargets(principal, targets)` (R3-PERFORMANCE-01, SPK-UX-006): what
  `list` gives each target (requirements in force with their coverage), for many targets in two
  queries (`CoverageService.coverageForTargets`) and one `workforce.view_assignments` decision per
  facility, keyed by `coverageTargetKey(type, id)`; a target the caller may not read is
  `'not_permitted'`. Support's Today feed reads a facility day's coverage with one call
  (**Verified**, `__tests__/coverage-for-targets.spec.ts`).
- Fixtures for downstream tests: `testing/workforce-fixtures.ts` (`createQualificationFixture`,
  `createAvailabilityFixture`, `createRequirementFixture`, `createAssignmentFixture`), written
  directly so the constraints apply.

## Events (`workforce.events.ts`)

`workforce.assignment_changed` (every transition and retime; a change that moved the assignment
carries its previous times), `workforce.assignment_uncovered`,
`workforce.temporary_access_changed`, `workforce.availability_changed`,
`workforce.qualification_changed`, `workforce.requirement_changed`, `workforce.fee_submitted`,
`workforce.fee_decided`, `workforce.fees_exported`. Payloads carry identifiers and instants only.
`workforce.requirement_changed` carries `retiredAt` (WRK-02; null while in force). Handlers this
module registers on its own and identity's events: `workforce.assignment_offer_notice`
(`workforce.assignment_changed`, WRK-04) and `workforce.follow_person_merge`
(`identity.persons_merged`, WRK-05), both with failure owner `scheduler`.

## Policy settings (WRK-06; values pending DEC-011 / POL-033, DEC-052)

The mechanisms are **verified**; every value is **pending** operator decision DEC-011 / POL-033
and has **no default** (rule K-00 (i)). Each is a module setting (`workforce.settings.ts`, IF-43),
read from the environment and validated at boot (a malformed value refuses boot); an absent value
applies the conservative behaviour below (`__tests__/policy-settings.spec.ts`,
`workforce.shared.spec.ts`). A facility may override the turnaround per kind and the escalation
window through `facilities.settings.workforce` (`turnaroundMinutes.<kind>`,
`uncoveredEscalationHours`).

| Setting                                      | Absent (conservative behaviour)                                                                                                                               | Set                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFORCE_OFFICIAL_TURNAROUND_MINUTES`      | no turnaround: back-to-back assignments are accepted; only overlaps are refused (the `assignments_no_overlap` exclusion constraint, and `assignment_overlap`) | the held interval is the scheduled interval plus the minutes; an assignment inside it is refused (`insufficient_turnaround`, and the exclusion constraint); a shorter one is an override |
| `WORKFORCE_COACH_TURNAROUND_MINUTES`         | the same for coaches                                                                                                                                          | the same for coaches                                                                                                                                                                     |
| `WORKFORCE_UNCOVERED_ESCALATION_HOURS`       | a required slot left uncovered by a decline or withdrawal raises `workforce.uncovered_assignment` at once, however far away the start is                      | it is raised only when the activity starts within that many hours                                                                                                                        |
| `WORKFORCE_ACCESS_TRAILING_HOURS`            | time-bounded access (temporary/substitute work) ends with the activity                                                                                        | access ends that many hours after the activity                                                                                                                                           |
| `WORKFORCE_OFFICIAL_MAX_ASSIGNMENTS_PER_DAY` | unchecked                                                                                                                                                     | a further acceptance of an official assignment starting on the same facility-local day answers `VALIDATION_FAILED` with `details.code = OFFICIAL_DAILY_LIMIT`                            |

Supervisors and organizers have no turnaround setting (none is required). Still **proposed**
(permission matrix C.8 proposal, pending POL-033): who approves fees (finance operator, general
manager), who exports them (finance operator), who may shorten a turnaround
(`workforce.override_turnaround`: league, program and general managers), the scheduler holding
`workforce.trigger_replacement`, and the roles time-bounded access grants (`official` for
officials, `coach` for coaches, none for supervisors and organizers; `TEMPORARY_ACCESS_ROLES`).
The daily limit is checked under the person's party lock (two acceptances for one person are
counted one after the other); it is an application check, not a database constraint.

## Capability switches

Workforce owns no conditional capability, so nothing in this module is behind a capability
switch. Booking staffing (WRK-02) is requested by enrollment for rental and party bookings, which
enrollment and catalog gate behind the `rentals` and `parties` switches (DEC-016 with DEC-076 and
DEC-077; per-organization, default off, changed only by an authorized administrator with audit).
Which roles and how many a package needs is configuration on the package definition (pending
DEC-011).

## Stage 3 (WRK-01 to WRK-06) — verified

- **WRK-01 facility and available actions** (SPK-SCHED-008, SPK-UX-007, SPK-STAFF-001..004,
  SCR-W-01, SCR-S-32/33): `GET /v1/me/assignments` items carry `activity.facility` `{ id, name,
timezone }` from the kernel `FacilityDirectory`, one directory read per response. `GET
/v1/assignments` items are `StaffAssignment`: the assignment plus `availableActions`, the
  AssignmentMachine events allowed from its state (offer and accept only before the activity
  ends, complete only once it has started, as the commands refuse otherwise), each kept only when
  `AuthorizationService.decide` allows the action that performs it (`propose_assignment`,
  `accept_assignment`, `decline_assignment`, `withdraw_assignment`, `complete_assignment`) against
  the command's own target (the assignment's facility; the assignee as subject for accept,
  decline and withdraw). A scheduler sees `offer` on proposals only; a league manager also
  `withdraw` and, once started, `complete`; the assignee `accept/decline/withdraw` on an offer.
  No command changed. Tests: `__tests__/workspace-facility-actions.spec.ts`.
- **WRK-02 booking staffing and retirement** (SPK-COND-003, SPK-STAFF-001/002, IF-32):
  `declareRequirements` (callers: system principal `enrollment.booking`, or staff holding
  `workforce.manage_requirements` at the facility; any other system label is refused) writes one
  must-be-accepted requirement per (event, role) in the caller's unit of work, after reading the
  event from scheduling in the same transaction (it must exist, be at the stated facility and not
  be canceled); a repeat is a no-op that answers the existing ids. `withdrawRequirements` locks the
  event's requirements in force, retires them (when, why, by whom; audited
  `workforce.requirement_retired`, `workforce.requirement_changed` with `retiredAt`), withdraws
  every proposed, offered or accepted assignment of their roles through the machine (one
  `workforce.assignment_changed` each; granted access ends as for any withdrawal; nothing is
  escalated) and resolves the open uncovered-slot exceptions of those roles; a repeat retires
  nothing. Retired requirements are skipped by `coverage`, `acceptedAssignees`,
  `isAcceptedOfficial`, `isAcceptedOnOffering`, readiness, the unqualified-assignee flagging,
  escalation, `GET /assignment-requirements` and so support's Today feed (which reads
  `RequirementsService.listForTargets`). A PATCH of a retired requirement answers `INVALID_TRANSITION`;
  proposing, offering, accepting or replacing on one answers `RESOURCE_CONFLICT`
  (`requirement_retired`). Every assignment command takes the requirement's shared key lock and
  row share lock before the assignment's row lock, the order a retirement takes them in. Tests:
  `__tests__/booking-staffing.spec.ts` (including an acceptance racing a retirement, run under
  PostgreSQL as well).
- **WRK-03 offering-level check** (SPK-UX-007, SPK-YOUTH-005, IF-34): `isAcceptedOnOffering` is
  true when the person holds an accepted or completed assignment of the kind on any session of the
  offering (`assignments.offering_id`), reading through the passed or active transaction;
  proposed and offered never count; retired requirements are skipped. Tests: same file.
- **WRK-04 assignment notices** (SPK-COMMS-002 assignment offer, schedule change and
  cancellation, SPK-COMMS-005, SPK-STAFF-002, IF-22): handler `workforce.assignment_offer_notice`
  on this module's own `workforce.assignment_changed` composes and queues, in the handler's
  transaction and under the assignment's row lock, at most one notice (operational, not
  protected, addressed to the assignee by id, subject `assignment`) with `sourceEventId` = the
  event id, and records it in `assignment_notices` (migration 0705) with the time it stated:
  - `assignment_offer` on a move into `offered` while the offer still stands;
  - `schedule_changed` when an offered or accepted assignment moves with its activity (a retime
    keeps the status): the text gives the new time and the time the assignee was **last told**,
    and `detailsBefore`/`detailsAfter` hold both. "Last told" is the newest recorded notice whose
    notification was dispatched, or is still unsent and not made obsolete by the new one (an
    unsent offer notice is never superseded); a move notice suppressed unsent is never the
    previous time. Nothing is composed when nothing was told yet (an offer notice still to come
    states the current time) or when the newest notice already states the current time (a late,
    repeated or reordered delivery). A move undone before its notice went out composes "time
    unchanged", which supersedes the unsent move notice;
  - `cancellation` on the withdrawal of an offered or accepted assignment by anyone but the
    assignee (staff, a replacement, a follow-up such as a canceled or postponed activity, a
    retirement, or a move into a conflict): named by the time the assignee was last told, plus the
    activity's current time when it moved since. An offer is only withdrawn-noticed when its offer
    notice was composed. The assignee's own decline or withdrawal composes a short confirmation
    only when an unsent move notice about the assignment is still waiting, to make it obsolete.
    Being a superseding kind, a cancellation suppresses an unsent move notice about the
    assignment and points a sent one at itself (SPK-COMMS-005), so "accept or decline it" or "you
    remain assigned" never arrives after the offer or the assignment is gone. An unsent
    `assignment_offer` notice is not a superseded kind in the communications policy, so it is
    still delivered, before the cancellation that follows it.

  The slot, facility and times are read from the assignment row in the handler's transaction,
  never from the payload, so a late delivery never states a time that no longer holds (§4.12).
  The status of earlier notices is read through `NotificationsService.load` (never the
  communications tables), and which kinds an unsent notice is superseded by comes from the
  injected `COMMUNICATIONS_POLICY`. Limit (verified by reading, not tested): the status read is
  not locked, so a move notice dispatched in the instant between that read and the new notice's
  queueing is pointed at the new notice, which then names the time told before it. The text
  names the role, slot, activity, facility and the facility-local time with its zone;
  `detailsBefore`/`detailsAfter` carry the fields clients read for schedule notices (`title`,
  `status`, `scheduledStart`, `scheduledEnd`, `timezone`, `facilityId`, `resources: []`) plus a
  facility-local `summary`, `role` and `slot`, so a client's "over already" expiry applies to
  them. A replay composes nothing (the dispatcher's consumption record; the notices' and
  `assignment_notices`' unique source-event keys). Offer deadlines and reminders are not added
  (pending DEC-011). Tests: `__tests__/assignment-notices.spec.ts`.

- **WRK-05 person merges** (SPK-IAM-007, SPK-STAFF-001, §4.2, IF-21, IF-09): no assignment,
  qualification or availability row is rewritten. Qualification checks (proposals, acceptance,
  readiness, unqualified flagging, replacement candidates) and availability reads expand the person
  with `personIdsResolvingTo`, so evidence or unavailability recorded for the merged person counts
  for the survivor; replacement candidates are the canonical persons. Handler
  `workforce.follow_person_merge` raises one `workforce.merged_person_overlap` exception (owner
  `scheduler`, severity high, deadline the earliest start, details: merge id, both persons, every
  overlapping pair of accepted assignments by held interval) per merge, idempotent by merge id.
  Tests: `__tests__/person-merge.spec.ts` (the tests read merges through identity's
  `personIdsResolvingTo` when ID-01 is present, otherwise through a test double following
  `persons.merged_into_person_id`).
- **WRK-06 policy settings**: see "Policy settings". Tests: `__tests__/policy-settings.spec.ts`;
  the other workforce test files run with the test configuration `CONFIGURED_POLICY_ENV`
  (`__tests__/support.ts`: 30/15 minutes, 48 hours, 24 hours), which is test data, not a default.

## Remaining

- **Pending (DEC-011 / POL-033):** every policy value above; offer deadlines (respond-by) and
  reminders (SCR-W-02); an access start some lead time before the activity (access begins at
  acceptance; identity can now end a membership before it starts, so the lead time is a proposed
  option); whether a revocation removes an accepted official's right to submit the result
  (`isAcceptedOfficial` still allows it; readiness is blocked and an exception is raised).
- **Pending (DEC-052, §5.2):** payroll or accounting file formats; exports are JSON lines in the
  batch, and nothing is paid.
- **Proposed:** the fee approval and export roles, the turnaround override authority and the
  temporary access roles (see "Policy settings").
- **Gap — uncovered-slot sweep:** with an escalation window configured, a slot left uncovered
  earlier than the window is not escalated later when the activity enters the window (no periodic
  job yet; K-06 provides the runner). Without a window it escalates at once.
- **Gap — slot required again by an edit:** a requirement edit that brings a slot back under the
  requirement (the count raised, or `mustBeAccepted` set back to true), including a slot whose
  `workforce.uncovered_assignment` exception an earlier edit resolved, raises no exception and
  enqueues no `workforce.assignment_uncovered` event for it, even inside the escalation window:
  escalation follows a decline or withdrawal only. The uncovered slot is still reported where
  coverage is derived at read time: the requirement's `coverage.uncoveredSlots`, the fixture's
  readiness (`workforce.required_officials`) and support's derived Today coverage card for the
  day's activities (`today.service.ts` `coverageItems`).
- **Gap — unqualified-assignment card after a withdrawal:** withdrawing or replacing an accepted
  assignee, by the person, by a replacement or by a follow-up (a retirement, a canceled
  activity), does not settle the assignment's open `workforce.unqualified_assignment` exception;
  an operator closes it on Today with a reason. Only a requirement edit resolves it (above).
  Settling it on withdrawal would need the revocation's flagging to lock the assignments it reads,
  so that a revocation and a withdrawal committing together cannot leave a card on a withdrawn
  assignment.
- **Gap — scheduling commitments:** accepted assignments are not written into scheduling's
  `event_commitments` (a session target may have no event, and a commitment moved with its event
  would lose the turnaround). Double-booking between workforce assignments is guaranteed by this
  module's exclusion constraint; overlap with person commitments held in scheduling is checked in
  both directions under the shared per-person advisory lock (an application-level guarantee, not
  one database constraint spanning both modules' tables). In the scheduling direction the
  assignment's held interval includes its turnaround and scheduling adds its own person rest on
  top (conservative; the combined rule is pending DEC-011 / POL-033).
- **Gap — merges:** the workspace (`GET /v1/me/assignments`) and `isAcceptedOnOffering` read the
  person id they are given; the survivor's workspace does not list the merged person's
  assignments (the merge exception names them for a scheduler).
- **Gap — directories and messaging:** no directory of officials and coaches (SCR-S-32/33 find
  people through qualifications, assignments or identity's person search), and no workspace
  message action (SCR-W-06, pending DEC-012 / DEC-062).
- Hours are submitted as rate-basis minutes; there is no clock-in/clock-out record (entry module)
  and no automatic computation from attendance.
- Requirements are declared per target; there is no template per season or offering yet.
