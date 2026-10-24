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
  `workforce.follow_session` (`catalog.session_canceled` → withdrawn). A retime of an accepted
  assignment is checked against every commitment of the person (accepted or completed
  assignments, and person commitments held in scheduling); a conflict withdraws the moved
  assignment with the activity's new time recorded on it and escalates the slot as uncovered
  (`schedule_conflict`), evaluated against the new start (window, deadline, notice), never
  double-books. A canceled, postponed or unscheduled fixture, a canceled event and a canceled
  session also close the target's open `workforce.uncovered_assignment` exceptions (SPK-UX-006).
- Scheduling party commitment source `workforce.assignments` (`PartyCommitmentSources`,
  registered in `onModuleInit`): scheduling's conflict detection and its post-lock re-check see
  accepted and completed assignments, so scheduling refuses to commit a person an assignment holds
  (`party_overlap` / `insufficient_rest` naming `externalCommitments`, SPK-SCHED-004 official and
  assigned-coach overlap, SPK-STAFF-003). `CommitmentChecker` takes the same per-person advisory
  lock (`lockParty`) before it reads, so an acceptance and a scheduling command for one person are
  serialized (tested under PostgreSQL concurrency in `__tests__/commitments-retime.spec.ts`).

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
  `status in ('accepted', 'completed')` (migration `0701_workforce_completed_holds_commitment.sql`:
  completion is allowed once the activity starts, so a completed assignment keeps holding its
  interval); `committed = [scheduled_start, scheduled_end + turnaround)`, so both double-booking
  and too-short turnaround are refused (SPK-STAFF-003).
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

| Method   | Path                                                                        | Who (action)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST/GET | `/availability`, POST `/availability/{id}/withdraw`                         | own (`workforce.manage_own_availability`); league/program/general managers for others; read: the person or coverage staff                                                                                                                                                                                                                                                                                                       |
| POST/GET | `/qualifications`, POST `/{id}/verify`, `/{id}/reject`, `/{id}/revoke`      | self-submission awaits verification; league/program/general managers and system administrators record and decide; nobody verifies their own                                                                                                                                                                                                                                                                                     |
| POST/GET | `/assignment-requirements`, PATCH `/{id}`                                   | league manager, program manager, scheduler, general manager (`workforce.manage_requirements`); GET returns coverage and uncovered slots                                                                                                                                                                                                                                                                                         |
| POST/GET | `/assignments`, GET `/assignments/{id}`                                     | propose (or propose and offer): the same assigners; temporary/substitute work also needs `workforce.grant_temporary_access` (league/program manager, system administrator); a `turnaroundMinutes` below the facility policy needs `workforce.override_turnaround` (league/program/general managers, POL-033 pending) and a reason, and the audit records both values; read: coverage staff or the assignee, otherwise NOT_FOUND |
| POST     | `/assignments/{id}/offer`                                                   | assigners                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST     | `/assignments/{id}/accept`, `/decline`                                      | only the assignee (§4.8); staff get `PARTICIPANT_AUTHORITY_REQUIRED`, others NOT_FOUND                                                                                                                                                                                                                                                                                                                                          |
| POST     | `/assignments/{id}/withdraw`                                                | league/program/general managers or the assignee (reason required)                                                                                                                                                                                                                                                                                                                                                               |
| POST     | `/assignments/{id}/complete`                                                | league/program/general managers, once the activity has started                                                                                                                                                                                                                                                                                                                                                                  |
| GET/POST | `/assignments/{id}/replacements`                                            | front desk and assigners (`workforce.trigger_replacement`): explained candidates; POST offers the slot to a replacement, optionally withdrawing the original in the same command                                                                                                                                                                                                                                                |
| POST/GET | `/fee-submissions`, GET `/{id}`, POST `/{id}/approve`, `/adjust`, `/reject` | submit: the assignee of a completed assignment; read: finance operator, general manager, the assignee; decide: finance operator, general manager — never their own fee; staff act only on fees of their facilities' assignments (others NOT_FOUND, absent from lists)                                                                                                                                                           |
| POST/GET | `/fee-export-batches`, GET `/{id}`                                          | finance operator, exporting only fees of their facilities; reading a batch needs the authority at every facility its lines belong to                                                                                                                                                                                                                                                                                            |
| GET      | `/me/assignments`                                                           | the caller's own assignments (SPK-UX-007)                                                                                                                                                                                                                                                                                                                                                                                       |

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
  on the slot, less than the escalation window before the start, raises
  `workforce.uncovered_assignment` (severity high, owner `league_manager` for fixtures and
  `scheduler` otherwise, deadline = start, deduplicated per slot) and enqueues
  `workforce.assignment_uncovered`; the command's response carries the notice. Accepting an
  assignment for the slot resolves the exception (it stays as history). Escalation and resolution
  take a per-slot advisory lock, so a decline racing an acceptance of the same slot never leaves
  an open exception on a covered slot (tested under PostgreSQL in
  `__tests__/replacement-target.spec.ts`).
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
  facility-scoped roles to that facility, §2.1, §4.14) from acceptance
  until the activity's end plus the trailing hours. The principal resolver drops the roles when
  the window closes; the assignment, its audit trail, its fee records and the membership row
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
- **Qualification lapses after acceptance** (SPK-STAFF-001): revoking a qualification, or editing
  a requirement's qualifications, raises `workforce.unqualified_assignment` (severity high, owner
  `league_manager` for fixtures and `scheduler` otherwise, deadline = start, one per assignment)
  for every accepted, unfinished assignment whose assignee no longer holds the requirement's
  qualifications. Nothing is withdrawn automatically: an operator decides (POL-033 pending).
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

- Turnaround: official 30 minutes, coach 15, supervisor and organizer 0. Shortening it for one
  assignment is an override (`workforce.override_turnaround`, reason required); who may hold that
  authority is pending POL-033.
- Uncovered escalation window: 48 hours before the start.
- Temporary access: roles `official` for officials and `coach` for coaches (supervisors and
  organizers get none automatically); ends 24 hours after the activity.
- Who approves fees: finance operator and general manager; export: finance operator (permission
  matrix C.8 proposal; the scheduler is added to `workforce.trigger_replacement` because it owns
  uncovered event and session slots).

## Known gaps

- **Scheduling commitments:** accepted assignments are not written into scheduling's
  `event_commitments` (a session target may have no event, and a commitment moved with its event
  would lose the turnaround). Double-booking between workforce assignments is guaranteed by this
  module's exclusion constraint; overlap with person commitments held in scheduling is checked in
  both directions under the shared per-person advisory lock (an application-level guarantee, not
  one database constraint spanning both modules' tables). In the scheduling direction the
  assignment's held interval includes its turnaround and scheduling adds its own person rest on
  top (conservative; the combined rule is pending DEC-011 / POL-033). A single exclusion
  constraint would need scheduling to hold party commitments that are not tied to an event.
- **Result submission after a revocation:** `isAcceptedOfficial` still lets an accepted official
  whose qualification was revoked submit the result (readiness is blocked and an exception is
  raised). Whether a revocation removes that right depends on its effective instant, which a
  status-only revocation does not carry: pending POL-033.
- **Access start:** access begins at acceptance rather than shortly before the activity. Identity
  can now end a membership before it starts (an empty window), so starting access a policy lead
  time before the activity is possible; the lead time is a proposed option pending DEC-011.
- Offers do not expire automatically (no offer deadline or reminder sweep); communications does
  not yet notify assignees from `workforce.assignment_changed`.
- Hours are submitted as rate-basis minutes; there is no clock-in/clock-out record (entry module)
  and no automatic computation from attendance. Exports are JSON lines in the batch; file formats
  for a payroll or accounting provider are pending integration decisions (§5.2, DEC-052).
- Requirements are declared per target; there is no template per season or offering yet.
