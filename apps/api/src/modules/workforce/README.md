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
(`OfferingsService`, `SessionsService`, `catalog.session_canceled`). It never reads or writes
those modules' tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/workforce/__tests__` and the unit
specs next to the code (`workforce.state-machines.spec.ts`, `workforce.shared.spec.ts`), under
PGlite and PostgreSQL (`TEST_DATABASE_URL`). Statements below are verified unless marked proposed,
pending or gap.

## Kernel and module registrations — verified

- Competition readiness check `workforce.required_officials` (SPK-READY-001, SPK-STAFF-002):
  every requirement of a fixture short of accepted (or completed) assignments is a `blocking`
  issue (`warning` when the requirement does not demand acceptance); proposed and offered
  assignments are named in the message but never counted. A fixture without a requirement gets
  an `info` issue (`officials_not_required`); the "officials unknown" verdict disappears.
- `ASSIGNMENT_CHECK_IMPL` → `CoverageService.isAcceptedOfficial`: an accepted or completed
  `official` assignment for the fixture (competition lets that official submit results,
  SPK-STAFF-005).
- Outbox handlers (idempotent under replay, writes through `ctx.trx`):
  `workforce.follow_fixture` (`competition.fixture_changed`: rescheduled → assignments retimed;
  canceled/postponed/unscheduled → live assignments withdrawn), `workforce.follow_event`
  (`scheduling.event_changed` for event targets: moved/resized → retimed, canceled → withdrawn),
  `workforce.follow_session` (`catalog.session_canceled` → withdrawn). A retime that would
  overlap another accepted assignment of the person withdraws the moved assignment and escalates
  the slot as uncovered (`schedule_conflict`), never double-books.

## Tables (migration `0700_workforce_core.sql`)

| Table                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability`            | Person, `starts_at/ends_at` and generated `during tstzrange`, kind `available/unavailable`, note, status `active → withdrawn` (reason kept), revision. Exclusion `availability_no_overlap`: one active statement per person per instant                                                                                                                                                                                                                                                                          |
| `qualifications`          | Person, kind (slug), level, evidence reference (never an upload), `valid_from/valid_to`, status `pending_verification → verified → revoked` or `rejected`, verifier and instant, reason, revision                                                                                                                                                                                                                                                                                                                |
| `assignment_requirements` | Target (`fixture/event/session` + the matching composite FK to `fixtures`, `events` or `offering_sessions`), kind, role, `required_count`, `must_be_accepted`, required qualification kinds; unique per (target, role)                                                                                                                                                                                                                                                                                           |
| `assignments`             | Person, kind `official/coach/supervisor/organizer`, target (+ FKs), copied title and interval, role, slot, engagement `regular/temporary/substitute`, status per `AssignmentMachine` (check lists exactly its states), every state's fact (offered/responded/accepted/declined/withdrawn/completed instants, reasons, actors), turnaround, `committed_end` and generated `committed` range, `replaces_assignment_id`, access status/window/`access_membership_id` (FK to identity `staff_memberships`), revision |
| `fee_submissions`         | Assignment, person, `rate_basis` jsonb, computed and submitted amounts (bigint minor units + currency), status `submitted → approved/adjusted/rejected → exported`, approver and instant, current approved amount, rejection reason, `export_batch_id`; one live submission per assignment                                                                                                                                                                                                                       |
| `fee_adjustments`         | Append-only (`forbid_mutation`): sequence, previous and adjusted amount, currency, reason, actor, instant                                                                                                                                                                                                                                                                                                                                                                                                        |
| `fee_export_batches`      | Append-only: currency, count, total, the exported lines, actor, operation                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Invariants enforced by the database (tests in `__tests__/workforce-schema.spec.ts`):

- `assignments_no_overlap` — GiST exclusion on `(organization_id, person_id, committed)` where
  `status = 'accepted'`; `committed = [scheduled_start, scheduled_end + turnaround)`, so both
  double-booking and too-short turnaround are refused (SPK-STAFF-003).
- `assignments_one_accepted_per_slot` — one accepted or completed assignment per (target, role,
  slot); `assignments_one_live_per_person_slot` — one live assignment per person per slot.
- Check constraints: machine states, each state's fact, `committed_end` equals scheduled end plus
  turnaround, access only for temporary/substitute work, target/FK agreement.
- Every workforce table refuses `DELETE` (SPK-STAFF-004: expiry never removes historical work
  records); `fee_adjustments` and `fee_export_batches` also refuse `UPDATE`.
- `fee_submissions (organization_id, export_batch_id, currency)` references the batch's
  `(organization_id, id, currency)`: a submission exports only in its own currency.
- Composite `(organization_id, …)` foreign keys on every reference (§4.3).

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/workforce.ts`)

| Method   | Path                                                                        | Who (action)                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET | `/availability`, POST `/availability/{id}/withdraw`                         | own (`workforce.manage_own_availability`); league/program/general managers for others; read: the person or coverage staff                                                                                                             |
| POST/GET | `/qualifications`, POST `/{id}/verify`, `/{id}/reject`, `/{id}/revoke`      | self-submission awaits verification; league/program/general managers and system administrators record and decide; nobody verifies their own                                                                                           |
| POST/GET | `/assignment-requirements`, PATCH `/{id}`                                   | league manager, program manager, scheduler, general manager (`workforce.manage_requirements`); GET returns coverage and uncovered slots                                                                                               |
| POST/GET | `/assignments`, GET `/assignments/{id}`                                     | propose (or propose and offer): the same assigners; temporary/substitute work also needs `workforce.grant_temporary_access` (league/program manager, system administrator); read: coverage staff or the assignee, otherwise NOT_FOUND |
| POST     | `/assignments/{id}/offer`                                                   | assigners                                                                                                                                                                                                                             |
| POST     | `/assignments/{id}/accept`, `/decline`                                      | only the assignee (§4.8); staff get `PARTICIPANT_AUTHORITY_REQUIRED`, others NOT_FOUND                                                                                                                                                |
| POST     | `/assignments/{id}/withdraw`                                                | league/program/general managers or the assignee (reason required)                                                                                                                                                                     |
| POST     | `/assignments/{id}/complete`                                                | league/program/general managers, once the activity has started                                                                                                                                                                        |
| GET/POST | `/assignments/{id}/replacements`                                            | front desk and assigners (`workforce.trigger_replacement`): explained candidates; POST offers the slot to a replacement, optionally withdrawing the original in the same command                                                      |
| POST/GET | `/fee-submissions`, GET `/{id}`, POST `/{id}/approve`, `/adjust`, `/reject` | submit: the assignee of a completed assignment; read: finance operator, general manager, the assignee; decide: finance operator, general manager — never their own fee                                                                |
| POST/GET | `/fee-export-batches`, GET `/{id}`                                          | finance operator                                                                                                                                                                                                                      |
| GET      | `/me/assignments`                                                           | the caller's own assignments (SPK-UX-007)                                                                                                                                                                                             |

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
  scheduling's `ConflictDetector`). Conflicts are `RESOURCE_CONFLICT` naming the assignment or
  event ids. Acceptance re-checks qualification and commitments; the database constraints decide
  races (tested under PostgreSQL concurrency: exactly one of two acceptances wins).
- **Uncovered slots** (SPK-STAFF-003, SPK-AT-012): declining an offered assignment, or withdrawing
  an accepted one, for a required slot that demands acceptance, with no other accepted assignment
  on the slot, less than the escalation window before the start, raises
  `workforce.uncovered_assignment` (severity high, owner `league_manager` for fixtures and
  `scheduler` otherwise, deadline = start, deduplicated per slot) and enqueues
  `workforce.assignment_uncovered`; the command's response carries the notice. Accepting an
  assignment for the slot resolves the exception (it stays as history).
- **Replacement candidates** (SPK-AT-012): holders of the kind's staff role at the facility plus
  holders of every required qualification; each candidate lists reasons with severity
  `blocking/warning/info/positive` and source ids (qualification held or missing, declared
  availability, conflicting assignments or events, earlier declines, already on the slot);
  eligible candidates sort first.
- **Time-bounded access** (SPK-STAFF-004): accepting temporary or substitute work creates an
  identity staff membership (roles per kind, scoped to the activity's facility) from acceptance
  until the activity's end plus the trailing hours. The principal resolver drops the roles when
  the window closes; the assignment, its audit trail, its fee records and the membership row
  remain. Withdrawal ends the membership immediately. If identity refuses (for example a youth
  referee, identity grants staff memberships to adults only) the acceptance stands, access is
  `failed`, the operation is `recovery_required` and `workforce.temporary_access_failed` is raised
  for the system administrator.
- **Fees** (SPK-STAFF-006, §1.7): the computed amount comes from the rate basis (per assignment,
  hourly with half-up rounding, flat) next to the submitted amount; approval records the approver;
  every adjustment appends a history row; export batches are immutable records handed to payment
  administration — nothing is paid or sent to a payroll system.
- **Workspace** (SPK-UX-007): own assignments only, the activity's practical details, team names
  for fixtures while the person is offered/accepted/completed (no dates of birth, contacts or
  payment data), the fee record and the commands available now.

## Ports (`ports.ts`)

- `ASSIGNMENT_COVERAGE_PORT` (`AssignmentCoveragePort`): `coverage(organizationId, targetType,
targetId)` per requirement and `acceptedAssignees(...)` for communications (notify the crew),
  entry (coach attendance) and reporting.
- Exported services: `AvailabilityService`, `QualificationsService` (`check`, `holdersOfAll`),
  `CoverageService`, `RequirementsService`, `AssignmentsService`, `ReplacementsService`,
  `FeesService`, `WorkspaceService`; policy `WORKFORCE_POLICY`.
- Fixtures for downstream tests: `testing/workforce-fixtures.ts` (`createQualificationFixture`,
  `createAvailabilityFixture`, `createRequirementFixture`, `createAssignmentFixture`), written
  directly so the constraints apply.

## Events (`workforce.events.ts`)

`workforce.assignment_changed` (every transition and retime), `workforce.assignment_uncovered`,
`workforce.temporary_access_changed`, `workforce.availability_changed`,
`workforce.qualification_changed`, `workforce.requirement_changed`, `workforce.fee_submitted`,
`workforce.fee_decided`, `workforce.fees_exported`. Payloads carry identifiers and instants only.

## Policy defaults (proposed, pending DEC-011 / POL-033 and DEC-052)

`workforce.policy.ts`; a facility overrides through `facilities.settings.workforce`.

- Turnaround: official 30 minutes, coach 15, supervisor and organizer 0.
- Uncovered escalation window: 48 hours before the start.
- Temporary access: roles `official` for officials and `coach` for coaches (supervisors and
  organizers get none automatically); ends 24 hours after the activity.
- Who approves fees: finance operator and general manager; export: finance operator (permission
  matrix C.8 proposal; the scheduler is added to `workforce.trigger_replacement` because it owns
  uncovered event and session slots).

## Known gaps

- **Scheduling commitments:** scheduling exposes no port to add or release a single party
  commitment on an existing event, so accepted assignments are not written into scheduling's
  `event_commitments`. Double-booking between workforce assignments is guaranteed by this
  module's own exclusion constraint; overlap with person commitments held in scheduling is
  checked through scheduling's `ConflictDetector` (early feedback, not a cross-table database
  guarantee). Scheduling would need `addCommitment/releaseCommitment` on `EVENT_SCHEDULING_PORT`
  for one exclusion constraint to cover both.
- **Access after follow-up changes:** withdrawals decided by outbox handlers (target canceled,
  rescheduled into a conflict) do not end granted access early, and a retime does not move the
  access window — identity commands run their own transaction and cannot be called inside a
  handler's transaction. The access still expires at its originally granted end.
- **Access start:** access begins at acceptance rather than shortly before the activity, because
  identity's `end` of a membership that has not started yet would violate identity's own
  `effective_to >= effective_from` check (an identity defect to fix there).
- Offers do not expire automatically (no offer deadline or reminder sweep); communications does
  not yet notify assignees from `workforce.assignment_changed`.
- Hours are submitted as rate-basis minutes; there is no clock-in/clock-out record (entry module)
  and no automatic computation from attendance. Exports are JSON lines in the batch; file formats
  for a payroll or accounting provider are pending integration decisions (§5.2, DEC-052).
- Requirements are declared per target; there is no template per season or offering yet.
