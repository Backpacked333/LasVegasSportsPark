# entry module

**Owns:** passes (opaque references), visits (facility arrival), session check-ins, attendance
observations and corrections, departures, release records (supervised pickup), offline
synchronization batches, occupancy snapshots

**Specification:** §3.14 (SPK-ENTRY-001..008), §4.4 Arrival (Visit, AttendanceObservation,
Departure, ReleaseRecord), §4.5 "Attendance must preserve observations and corrections", §4.8
(`POST /v1/attendance-observations`, `POST /v1/releases`), §4.15 offline behaviour, SPK-COND-004,
SPK-AT-015, SPK-AT-016, SPK-AT-018

**Migration range:** `packages/db/migrations/0800_entry_*.sql` … `0899` (this module uses `0800`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`, `AUTHORITY_LOOKUP_PORT` for the online pickup
check, `HouseholdsService`, `PeopleService`, `RelationshipAuthority.authoritiesOf` for pass
scans), catalog (`OfferingsService`, `SessionsService`, `POLICY_PORT` acknowledgments),
scheduling (`EventsService`, local-time helpers), competition (`FIXTURE_PORT`, `ROSTER_PORT` for
fixture participation), enrollment (`ENROLLMENT_PORT.participationsOf`), workforce
(`ASSIGNMENT_COVERAGE_PORT` for coach and official scope). It never reads or writes those modules'
tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/entry/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs next to the code (`entry.shared.spec.ts`,
`entry.state-machines.spec.ts`, `providers/fake-access-control.provider.spec.ts`). Statements
below are verified unless marked proposed, pending or gap.

## Requirements

| Requirement                                         | Implementation                                                                                                                                                                                                                        | Evidence                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| SPK-ENTRY-001 separate records                      | `visits`, `session_checkins`, `attendance_observations`, `departures`, `release_records` are separate tables; no command writes another's record implicitly                                                                           | `arrival.spec.ts` (SPK-AT-015 counts each table), `occupancy-hardware.spec.ts`        |
| SPK-ENTRY-002 opaque pass                           | 256-bit random reference (`spp_…`), stored only as SHA-256; issue returns it once; no id, name or household in it, nor in audit or events                                                                                             | `arrival.spec.ts` ("a pass is an opaque random reference …"), `entry-schema.spec.ts`  |
| SPK-ENTRY-003 / SPK-AT-015 selection, nobody marked | `POST /passes/scan` returns the people and today's sessions (`recorded: "nothing"`); arrivals and check-ins are separate commands for the selected people and sessions                                                                | `arrival.spec.ts` ("SPK-AT-015 / SPK-ENTRY-003 …")                                    |
| SPK-ENTRY-004 actionable issues                     | every check is an issue with severity and next action; blocking issues hold the check-in (database refuses admission); unrelated balance informational unless the facility policy blocks (DEC-056)                                    | `arrival.spec.ts`, `balance-policy.spec.ts`, `entry-schema.spec.ts`                   |
| SPK-ENTRY-005 corrections keep actor, time, reason  | corrections are new rows (`corrects_observation_id`, `correction_reason`, own `recorded_by` and `received_at`); originals are append-only; one correction per observation (chains)                                                    | `attendance.spec.ts`, `entry-schema.spec.ts`                                          |
| SPK-ENTRY-006 visitor categories                    | participant, guardian, spectator, staff, contractor (and `unclassified` for hardware); unregistered visitors are described with a party size; a participant is always a person; check-in never creates an enrollment                  | `arrival.spec.ts`, `entry-schema.spec.ts`                                             |
| SPK-ENTRY-007 / SPK-AT-016 pickup                   | `collect` checked online at the moment of release; held permissions recorded as evidence; pay or view never authorize; denial or escalation raises an operational exception; every listed field is a column                           | `releases.spec.ts`, `entry-schema.spec.ts`                                            |
| SPK-ENTRY-008 occupancy                             | arrivals and departures counted separately; "verified" only from a reconciled snapshot (physical count) newer than the last arrival/departure/void                                                                                    | `occupancy-hardware.spec.ts`, `entry-schema.spec.ts`                                  |
| §4.15 / SPK-AT-018 offline                          | batches deduplicated by (device, client batch) and items by (device, client observation id); stale snapshot flagged and raised; conflicts preserved and raised; queued releases rejected unless an approved manual procedure is named | `offline-sync.spec.ts` (including a concurrent double upload), `entry-schema.spec.ts` |
| SPK-COND-004 hardware                               | signed provider events through the kernel inbox become visits only; denied → nothing; unknown → exception; never attendance, check-in or pickup                                                                                       | `occupancy-hardware.spec.ts`                                                          |
| §4.8 commands                                       | `POST /attendance-observations` (desk, or the coach/official with an accepted assignment), `POST /releases`                                                                                                                           | `attendance.spec.ts`, `releases.spec.ts`                                              |

## Tables (migration `0800_entry_core.sql`)

| Table                     | Purpose                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `passes`                  | Holder (person or household), `reference_hash` (unique), status `active → revoked` (trigger `passes_guard`: holder, hash and issue time immutable), revision                                                                                                                               |
| `visits`                  | Facility arrival: person or described visitor with party size, visitor category, source `desk/offline_sync/access_control`, pass, device + client observation id, access event reference, status `on_site → departed / voided` (trigger `visits_guard`), revision                          |
| `session_checkins`        | Person, activity (catalog session or scheduling event, interval copied), participation basis (enrollment, session booking, event commitment, roster membership), `issues` jsonb, status `held → admitted / withdrawn`, `admitted → withdrawn` (trigger `session_checkins_guard`), revision |
| `attendance_observations` | Append-only: person, activity, observed state `present/absent/late/left_early`, observed and received time, source `online/offline_sync`, device, client observation id, batch, snapshot reference and time, flags `stale_snapshot/conflict`, correction link and reason                   |
| `release_records`         | Append-only: child, collector person or description, activity, visit, verification method and outcome, authority basis and check time, collector permissions, denial reason, restriction and escalation notes, exception, manual procedure, post-sync authority, outcome, staff actor      |
| `departures`              | Append-only: one per visit, departed time, release record (must have released the same child), source `desk/offline_sync/release`                                                                                                                                                          |
| `offline_sync_batches`    | Append-only: device, client batch id (unique per device), snapshot reference, time and age at receipt, maximum roster age in force, per-item results, counts that must add up, stale flag, exceptions, operation                                                                           |
| `occupancy_snapshots`     | Append-only: facility day window, arrivals, departures, records on site, open from earlier days, reconciled flag, counted, verified occupancy, discrepancy                                                                                                                                 |

Every table carries `organization_id`; references use composite `(organization_id, …)` keys,
including references into identity, catalog, scheduling and enrollment tables; batch references
are deferrable so a batch row is written once, after its items.

### Database guarantees (tests in `__tests__/entry-schema.spec.ts`)

- Observations, departures, release records, batches and snapshots refuse UPDATE and DELETE
  (`forbid_mutation`); passes, visits and check-ins refuse DELETE.
- A correction names the same person and activity (composite self foreign key), carries a reason,
  and an observation is corrected at most once (partial unique index).
- One open visit per person and facility; one live check-in per person and activity; one departure
  per visit; one row per (device, client observation id) in every table an offline item lands in;
  one batch per (device, client batch id).
- A participant visit names a person; a check-in is admitted only with a participation basis and
  without a blocking issue (`jsonb_path_exists` check).
- A release is `released` only when verified (with `collect` recorded) or under the manual outage
  procedure; denials carry a reason and never release; online releases use the online check and
  offline ones only the procedure; a departure that names a release follows a release that
  released that child (trigger).
- Occupancy is verified only on a reconciled snapshot whose verified figure is the physical count.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/entry.ts`)

| Method   | Path                                                                    | Who (action)                                                                                                            |
| -------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST     | `/passes`, `/passes/{id}/revoke`                                        | desk staff; a customer for their own person pass (`entry.issue_pass`, `entry.revoke_pass`); others NOT_FOUND            |
| POST     | `/passes/scan`                                                          | desk roles in facility scope (`entry.scan_pass`); not idempotent (writes only an audit record)                          |
| POST/GET | `/visits`, `/visits/{id}/void`                                          | desk roles (`entry.record_arrival`, `entry.void_visit`); listing also support and facilities (`entry.read_visits`)      |
| POST     | `/departures`                                                           | desk roles (`entry.record_departure`); a child participant gets RESOURCE_CONFLICT `release_required`                    |
| POST/GET | `/session-checkins`, `/{id}/recheck`, `/{id}/withdraw`, `GET /{id}`     | desk roles, or coach/official with an accepted assignment; reads protected (`view` over the person)                     |
| POST     | `/attendance-observations`, `/attendance-observations/{id}/corrections` | desk roles, or the assigned coach/official (`entry.record_*attendance`, `entry.correct_*attendance`)                    |
| GET      | `/attendance?activityType&activityId&offeringId&personId`               | desk/support readers and the assigned coach/official; a customer only one person they hold `view` over (else NOT_FOUND) |
| POST/GET | `/releases`, `/releases/{id}`                                           | front desk, program manager, GM, or the assigned coach; reads: pickup staff or `view` over the child (else NOT_FOUND)   |
| POST     | `/offline-sync`                                                         | desk and field roles (`entry.sync_offline`); field staff only for assigned activities; arrivals/departures desk only    |
| GET/POST | `/facilities/{id}/occupancy`, `/facilities/{id}/occupancy-snapshots`    | readers incl. facilities operator and scheduler; counts: front desk, GM, facilities operator                            |
| POST     | `/webhooks/access-control/{provider}`                                   | public, signature-verified (`fake-access-control` only), recorded in the kernel inbox                                   |

Every consequential POST is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and an outbox event; offline synchronization creates an
operation (`entry.offline_sync`). Cross-organization ids answer NOT_FOUND; facility scope is
enforced by the kernel for every command.

## Ports

- Provided: `ATTENDANCE_PORT` (`effectiveAttendance`, `openVisitOf`) for reporting, trials and the
  Today workspace.
- Consumed: `FINANCIAL_STANDING_PORT` — answered by finance's `ParticipationStandingService`
  (`standingOf(person, {offeringId, at})`: due, open obligations of the participant, `related` when
  one belongs to the activity's offering) when the finance module is part of the application. An
  explicit `FINANCIAL_STANDING_IMPL` takes precedence (tests script it); without either, every
  standing is `unknown`, shown as an `info` issue that never blocks. Blocking on an unrelated
  balance stays governed by `blockOnUnrelatedBalance: false` (DEC-056).
- Provider port (§5.2): `FakeAccessControlProvider` is the deterministic hardware adapter —
  `granted` (success), `denied` (failure), `unknown` (timeout), duplicate deliveries; HMAC-signed.
- Fixtures for downstream tests: `testing/entry-fixtures.ts` (`createPassFixture`,
  `createVisitFixture`, `createAttendanceObservationFixture`).

## Events (`entry.events.ts`) and handlers

`entry.pass_issued`, `entry.pass_revoked`, `entry.visit_recorded`, `entry.visit_closed`,
`entry.session_checkin_changed`, `entry.attendance_observed`, `entry.departure_recorded`,
`entry.release_recorded`, `entry.offline_batch_synced`, `entry.occupancy_snapshot_taken`. Payloads
carry identifiers and states only (§4.14).

Inbox handler `entry.access_event` (provider `fake-access-control`): idempotent under replay
(inbox consumption plus the unique access-event reference on visits).

Operational exceptions raised (Today workspace, SPK-UX-006): `entry.attendance_conflict`
(program manager), `entry.stale_offline_snapshot` (program manager), `entry.pickup_denied`,
`entry.pickup_escalated`, `entry.release_withheld`, `entry.offline_release_unverified` (critical)
(general manager), `entry.access_outcome_unknown` (front desk). Queue owners are proposals pending
DEC-015.

## Policy defaults (proposed, pending operator decisions §6.6)

`entry.policy.ts` (`DEFAULT_ENTRY_POLICY`, overridable per facility under
`facilities.settings.entry`; an invalid override block is ignored as a whole):

- Maximum roster age 120 minutes (§4.15 proposal; DEC-033, Operations).
- Unrelated balance does not block (`blockOnUnrelatedBalance: false`; DEC-056).
- No approved manual outage procedure (`approvedOutageProcedures: []`; DEC-005, DEC-034): every
  queued release is rejected until Operations approves one.
- A child participant leaves through a release (`childParticipantDepartureRequiresRelease: true`;
  supervised pickup applicability is DEC-075).
- Denied pickups are recorded `denied` unless staff escalate (`escalateDeniedPickups: false`;
  DEC-005); every denial still raises an exception.
- Device clock tolerance 5 minutes (engineering proposal).

## Known gaps

- Device approval and roster snapshot issuance (§4.15 "approved staff devices", "encrypted,
  scoped roster"; the runbook's proposed `entry.download_offline_roster`) are not implemented: the
  device id and snapshot reference are recorded as supplied by an authorized staff principal, and
  items are checked against the facility scope, the observed time and the snapshot time only
  (DEC-023, DEC-032 pending).
- The authority basis of a verified release is recorded as `relationship_permission:collect`
  with the check time and the collector's permissions, not the grant id: identity's
  `AUTHORITY_LOOKUP_PORT` answers with a boolean. Identity restrictions are honoured because a
  suspended grant is not effective, but the release does not name the access review; restriction
  notes are entered by staff.
- Event check-ins recognise person commitments on the scheduling event and effective rosters of
  the fixture it schedules; other event kinds have no participation basis yet.
- Pass scans list sessions from enrollments and session bookings; league fixtures are not listed.
- Live check-ins are not withdrawn automatically when catalog cancels a session or scheduling
  cancels an event (a re-check reports `activity_canceled`); `identity.persons_merged` is not
  consumed (append-only rows keep the original person id; readers can resolve the survivor through
  `PERSON_DIRECTORY_PORT`).
- An attendance-conflict exception is not closed automatically when a correction resolves it.
- Hardware exits (departure events) and device credential revocation are not modelled; offline
  departure items are accepted like arrivals although §4.15 names only arrivals and attendance
  (DEC-032 pending).
- `GET /attendance` returns one page; `GET /visits` is cursor-paginated.

## Kernel and cross-module constraints worked around here

- Inbox handlers receive the inbox transaction but not the kernel's transaction context; the
  access-event handler binds it with `runWithTransaction` so port reads go through it.
- Catalog's `SessionsService`/`OfferingsService` and scheduling's `EventsService` read through the
  root database, so `ActivityResolver` resolves activities before or after a command's transaction
  (it refuses to run inside one).
