# entry module

**Owns:** passes (opaque references), visits (facility arrival), session check-ins, attendance
observations and corrections, departures, release records (supervised pickup), offline
synchronization batches, occupancy snapshots, and (Package G, behind the `access_hardware`
capability) access devices, access policies and device commands

**Specification:** §3.14 (SPK-ENTRY-001..008), §4.4 Arrival (Visit, AttendanceObservation,
Departure, ReleaseRecord), §4.5 "Attendance must preserve observations and corrections", §4.8
(`POST /v1/attendance-observations`, `POST /v1/releases`), §4.15 offline behaviour, SPK-COND-004,
SPK-AT-015, SPK-AT-016, SPK-AT-018; stage 3: ENT-01 to ENT-05 (§3.16 Access hardware, SPK-IAM-007,
SPK-UX-002, SPK-UX-007, §4.12, DEC-016, DEC-080)

**Migration range:** `packages/db/migrations/0800_entry_*.sql` … `0899` (this module uses `0800`,
`0801` offline batch request fingerprint, `0802` departure records the visit's person, `0803`
activity reference checks, `0804` release grant, `0805` access hardware, `0880` organization-scoped
kernel keys)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`, `AUTHORITY_LOOKUP_PORT` for the online pickup
check, `HouseholdsService`, `PeopleService`, `RelationshipAuthority.authoritiesOf` for pass
scans), catalog (`OfferingsService`, `SessionsService`, `POLICY_PORT` acknowledgments),
scheduling (`EventsService`, local-time helpers), competition (`FIXTURE_PORT`, `ROSTER_PORT` for
fixture participation), enrollment (`ENROLLMENT_PORT.participationsOf`), workforce
(`ASSIGNMENT_COVERAGE_PORT` for coach and official scope). Stage 3 adds identity's
`PERSON_DIRECTORY_PORT.displayNames` / `personIdsResolvingTo` (IF-09) and
`AUTHORITY_LOOKUP_PORT.effectiveGrant` (IF-46), the events `catalog.session_canceled`,
`scheduling.event_changed` and `identity.persons_merged`, and the kernel's capability switches
(IF-30), periodic jobs (IF-24), integration register (IF-04), exception reads (IF-29) and module
settings (IF-43). It never reads or writes those modules' tables (§4.2).

**Status: implemented** — verified by `apps/api/src/modules/entry/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs next to the code (`entry.shared.spec.ts`,
`entry.state-machines.spec.ts`, `providers/fake-access-control.provider.spec.ts`). Statements
below are **verified** unless marked **proposed**, **pending** (an operator decision) or gap.

The stage-3 work (ENT-01 to ENT-05) calls identity's ID-01 and ID-09 members. On a branch without
the identity stage-3 work those members answer their declared `declaredNotImplemented` error, so
18 entry tests (names, merge expansion, verified releases, collector checks) need the identity work
merged; with it, the whole entry suite (17 files, 122 tests) passes on PGlite and on PostgreSQL.

## Requirements

| Requirement                                         | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPK-ENTRY-001 separate records                      | `visits`, `session_checkins`, `attendance_observations`, `departures`, `release_records` are separate tables; no command writes another's record implicitly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `arrival.spec.ts` (SPK-AT-015 counts each table), `occupancy-hardware.spec.ts`                                                                    |
| SPK-ENTRY-002 opaque pass                           | 256-bit random reference (`spp_…`), stored only as SHA-256; issue returns it once; no id, name or household in it, nor in audit or events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `arrival.spec.ts` ("a pass is an opaque random reference …"), `entry-schema.spec.ts`                                                              |
| SPK-ENTRY-003 / SPK-AT-015 selection, nobody marked | `POST /passes/scan` returns the people and today's sessions (`recorded: "nothing"`); arrivals and check-ins are separate commands for the selected people and sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `arrival.spec.ts` ("SPK-AT-015 / SPK-ENTRY-003 …")                                                                                                |
| SPK-ENTRY-004 actionable issues                     | every check is an issue with severity and next action; blocking issues hold the check-in (database refuses admission); unrelated balance informational unless the facility policy blocks (DEC-056); balance issues and their obligation reach staff only: the assigned coach or official and a customer get no balance issue, and `desk_review_required` (no reference) for a blocking one (AUTHZ-PRIVACY-01, SPK-UX-007, §4.14)                                                                                                                                                                                                                                                                                                                      | `arrival.spec.ts`, `balance-policy.spec.ts`, `entry-schema.spec.ts`                                                                               |
| SPK-ENTRY-005 corrections keep actor, time, reason  | corrections are new rows (`corrects_observation_id`, `correction_reason`, own `recorded_by` and `received_at`); originals are append-only; one correction per observation (chains)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `attendance.spec.ts`, `entry-schema.spec.ts`                                                                                                      |
| SPK-ENTRY-006 visitor categories                    | participant, guardian, spectator, staff, contractor (and `unclassified` for hardware); unregistered visitors are described with a party size; a participant is always a person; check-in never creates an enrollment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `arrival.spec.ts`, `entry-schema.spec.ts`                                                                                                         |
| SPK-ENTRY-007 / SPK-AT-016 pickup                   | `collect` checked online at the moment of release; held permissions recorded as evidence; pay or view never authorize; denial or escalation raises an operational exception; every listed field is a column. A child on a participant visit, or with a live session check-in, leaves only through a release whatever the visit category (a turnstile `unclassified` or a `spectator` arrival included; DEC-075 pending); an assigned coach releases only a child taking part in the activity (else NOT_FOUND) and is told only whether `collect` is held                                                                                                                                                                                              | `releases.spec.ts`, `entry-schema.spec.ts`                                                                                                        |
| SPK-ENTRY-008 occupancy                             | arrivals and departures counted separately; "verified" only from a reconciled snapshot (physical count) newer than the last arrival/departure/void                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `occupancy-hardware.spec.ts`, `entry-schema.spec.ts`                                                                                              |
| §4.15 / SPK-AT-018 offline                          | batches deduplicated by (device, client batch) — a reused client batch id with other contents is RESOURCE_CONFLICT `batch_id_reused` (request fingerprint) — and items by (device, client observation id); stale snapshot flagged and raised; conflicts preserved and raised, also under concurrent uploads (per-subject advisory locks); a departure synchronized before its arrival is held for review and closes the visit when the arrival arrives (a release likewise); queued releases rejected unless an approved manual procedure is named and the principal holds the online release authority, re-checked at sync for `collect` now and at the handover time; every rejected queued release and child departure raises a critical follow-up | `offline-sync.spec.ts`, `offline-reconciliation.spec.ts`, `entry-concurrency.spec.ts` (true concurrency under PostgreSQL), `entry-schema.spec.ts` |
| SPK-COND-004 hardware                               | signed provider events through the kernel inbox become visits only; denied → nothing; unknown → exception; never attendance, check-in or pickup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `occupancy-hardware.spec.ts`                                                                                                                      |
| §4.8 commands                                       | `POST /attendance-observations` (desk, or the coach/official with an accepted assignment), `POST /releases`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `attendance.spec.ts`, `releases.spec.ts`                                                                                                          |

### Stage 3 (ENT-01 to ENT-05)

| Work item / requirement                      | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ENT-01 SPK-ENTRY-002, SCR-C-05               | `GET /me/passes` (`entry.read_pass`, self): the caller's person passes, newest first, `referenceAvailable: false` (only the hash is stored, so a holder who lost a reference revokes and self-issues), the staff revocation reason withheld from customers; household passes are staff-managed and not listed                                                                                                                                                                                                                                                        | `holder-reads.spec.ts` ("SPK-ENTRY-002 / SCR-C-05 …", "§4.14: the pass reference is never returned after issue")                          |
| ENT-01 SPK-ENTRY-004                         | a scan's `activities[].checkin` carries `revision`, so a held check-in found by a scan is re-checked directly                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `holder-reads.spec.ts`                                                                                                                    |
| ENT-01 SPK-UX-002, SPK-UX-007, §4.14         | `PersonAttendance` gains `givenName`, `familyName`, `displayName` (identity `displayNames`, names only), read after the attendance read is authorized                                                                                                                                                                                                                                                                                                                                                                                                                | `holder-reads.spec.ts` ("SPK-UX-007 / SPK-UX-002 …")                                                                                      |
| ENT-01 §4.15, SPK-UX-008                     | `GET /offline-sync/{id}`: the stored batch and per-item outcomes, for its submitter (while they may still synchronize at the facility) and desk readers (`entry.read_offline_batch`: desk roles and support); anyone else NOT_FOUND; `replayed: false`                                                                                                                                                                                                                                                                                                               | `holder-reads.spec.ts`                                                                                                                    |
| ENT-01 §5.1, §5.2, DEC-023                   | the fake access-control adapter is registered in `INTEGRATION_REGISTRY` as `entry.access_device` (gate hardware, `productionAllowed: false`, all four scenarios, reconciled by the facilities operator)                                                                                                                                                                                                                                                                                                                                                              | `holder-reads.spec.ts` ("§5.2 / DEC-023 …")                                                                                               |
| ENT-02 SPK-ENTRY-007, SCR-W-09, SPK-COND-004 | `POST /releases/collector-checks` (read-only, no idempotency key, no audit row, `@NoRecordAuthority`): the assigned coach (`entry.record_assigned_release` + accepted assignment) or the pickup desk identifies the collecting adult by pass; the collector is named only when the pass is active, its holder (resolved through merges) holds `collect` now and the participant takes part in the activity; every other case is the same `mayCollect: false` with no collector                                                                                       | `collector-checks.spec.ts` ("SPK-ENTRY-007: an assigned coach identifies …", "a pass holder without collect is not named")                |
| ENT-02 SPK-ENTRY-007, IF-46                  | a verified online release records `authority_grant_id` from `effectiveGrant` (and is verified only when that grant exists); staff read `authorityGrantId`, customers and the assigned coach do not; database: a new verified release names a grant, only a verified one does, never another organization's (0804)                                                                                                                                                                                                                                                    | `collector-checks.spec.ts` ("… records the grant id it relied on"), `entry-schema.spec.ts` (0804)                                         |
| ENT-03 §4.6, §4.12, SPK-AT-009               | handlers `entry.withdraw_on_session_canceled` (`catalog.session_canceled`) and `entry.withdraw_on_event_canceled` (`scheduling.event_changed` `canceled`) withdraw every held or admitted check-in of the activity (`SessionCheckinMachine` `withdraw`, reason `activity_canceled`, system audit, `entry.session_checkin_changed`); visits stay open; replay changes nothing                                                                                                                                                                                         | `follow-ups.spec.ts` ("a canceled session withdraws …", "a replayed cancellation event changes nothing", "a canceled scheduling event …") |
| ENT-03 SPK-ENTRY-005, §4.15                  | a correction that leaves the current heads agreeing resolves the open `entry.attendance_conflict` exception (system, through `OperationalExceptions.transition`); an arrival that closes an offline-departure gap resolves its `entry.offline_departure_unmatched`                                                                                                                                                                                                                                                                                                   | `follow-ups.spec.ts`                                                                                                                      |
| ENT-04 SPK-IAM-007, SPK-ENTRY-002            | handler `entry.follow_person_merge` (`identity.persons_merged`, idempotent by `mergeId`): when the survivor and the merged person each hold an active person pass, one `entry.merged_duplicate_pass` exception (front desk); nothing is revoked. Person reads expand with `personIdsResolvingTo` (only for the canonical person): `GET /me/passes`, `GET /attendance?personId`, `GET /visits?personId` (whole history at the facility unless `date` is given); rows keep their original person id; a scanned or turnstile pass of a merged person opens the survivor | `follow-ups.spec.ts` ("SPK-IAM-007: a merge leaving two active passes …", "the survivor's visit history …")                               |
| ENT-05 §3.16 Access hardware, SPK-COND-004   | devices, policies (four eyes, one active per device, active passes only), deny-all by default, credential revocation on every active device, delivery outside transactions with retries and escalation, receipts, heartbeats and outages; access events name the registered device                                                                                                                                                                                                                                                                                   | `access-hardware.spec.ts`, `entry.state-machines.spec.ts`, `providers/fake-device-commands.spec.ts`                                       |

## Tables (migration `0800_entry_core.sql`)

| Table                     | Purpose                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `passes`                  | Holder (person or household), `reference_hash` (unique), status `active → revoked` (trigger `passes_guard`: holder, hash and issue time immutable), revision                                                                                                                               |
| `visits`                  | Facility arrival: person or described visitor with party size, visitor category, source `desk/offline_sync/access_control`, pass, device + client observation id, access event reference, status `on_site → departed / voided` (trigger `visits_guard`), revision                          |
| `session_checkins`        | Person, activity (catalog session or scheduling event, interval copied), participation basis (enrollment, session booking, event commitment, roster membership), `issues` jsonb, status `held → admitted / withdrawn`, `admitted → withdrawn` (trigger `session_checkins_guard`), revision |
| `attendance_observations` | Append-only: person, activity, observed state `present/absent/late/left_early`, observed and received time, source `online/offline_sync`, device, client observation id, batch, snapshot reference and time, flags `stale_snapshot/conflict`, correction link and reason                   |
| `release_records`         | Append-only: child, collector person or description, activity, visit, verification method and outcome, authority basis and check time, collector permissions, denial reason, restriction and escalation notes, exception, manual procedure, post-sync authority, outcome, staff actor      |
| `departures`              | Append-only: one per visit, the visit's person (trigger `departures_visit_person_guard`, 0802), departed time, release record (must have released the same child), source `desk/offline_sync/release`                                                                                      |
| `offline_sync_batches`    | Append-only: device, client batch id (unique per device), request fingerprint (SHA-256 of facility, snapshot and items, 0801), snapshot reference, time and age at receipt, maximum roster age in force, per-item results, counts that must add up, stale flag, exceptions, operation      |
| `occupancy_snapshots`     | Append-only: facility day window, arrivals, departures, records on site, open from earlier days, reconciled flag, counted, verified occupancy, discrepancy                                                                                                                                 |

Stage 3 (migrations `0804`, `0805`):

| Table / column                       | Purpose                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release_records.authority_grant_id` | 0804: the identity access grant a verified online check relied on (composite key to `access_grants`); `NOT VALID` check so every new verified release names one (append-only rows before 0804 keep null)                                                                                                                                      |
| `access_devices`                     | 0805: facility, kind `door/turnstile/gate/scanner`, name, provider device reference (unique in the organization, never reassigned), status `active → retired` (trigger `access_devices_guard`), health `online/offline/unknown` (default unknown), heartbeat timeout (> 0, null = not judged; no default), last heartbeat, revision           |
| `access_policies`                    | 0805: device, holder kinds, pass statuses (`<@ {active}`), weekly schedule (facility-local), status `draft → active / retired`, `active → retired` (trigger `access_policies_guard`; content immutable), author, approver (`access_policies_four_eyes`), one active per device (partial unique index), revision                               |
| `device_commands`                    | 0805: device, kind `revoke_credential` (names the pass) / `sync_policy` (policy snapshot, or none for deny-all), status `pending/delivered/failed/unknown/superseded` (trigger `device_commands_guard`), attempts, last error, settled by adapter or receipt, escalation exception; one revocation per device and pass (partial unique index) |
| `visits.access_device_id`            | 0805: the registered device of an `access_control` arrival (composite key with the visit's facility; only access-control arrivals; immutable like the other arrival facts)                                                                                                                                                                    |

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
  released that child (trigger), and every departure records the person of the visit it closes,
  so child X's visit can never be closed with child Y's release (trigger, migration 0802).
- Occupancy is verified only on a reconciled snapshot whose verified figure is the physical count.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/entry.ts` and `entry-hardware.ts`)

| Method   | Path                                                                                                              | Who (action)                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST     | `/passes`, `/passes/{id}/revoke`                                                                                  | desk staff; a customer for their own person pass (`entry.issue_pass`, `entry.revoke_pass`); others NOT_FOUND                                                                                                                                                                                                                                                                 |
| POST     | `/passes/scan`                                                                                                    | desk roles in facility scope (`entry.scan_pass`); not idempotent (writes only an audit record)                                                                                                                                                                                                                                                                               |
| POST/GET | `/visits`, `/visits/{id}/void`                                                                                    | desk roles (`entry.record_arrival`, `entry.void_visit`); listing also support and facilities (`entry.read_visits`)                                                                                                                                                                                                                                                           |
| POST     | `/departures`                                                                                                     | desk roles (`entry.record_departure`); a child on a participant visit or with a live check-in gets `release_required`                                                                                                                                                                                                                                                        |
| POST/GET | `/session-checkins`, `/{id}/recheck`, `/{id}/withdraw`, `GET /{id}`                                               | desk roles, or coach/official with an accepted assignment (reads too: `entry.read_assigned_checkin`); customers with `view` read without staff identifiers; only desk and support staff see balance issues and obligation ids                                                                                                                                                |
| POST     | `/attendance-observations`, `/attendance-observations/{id}/corrections`                                           | desk roles, or the assigned coach/official (`entry.record_*attendance`, `entry.correct_*attendance`)                                                                                                                                                                                                                                                                         |
| GET      | `/attendance?activityType&activityId&offeringId&personId`                                                         | desk/support readers and the assigned coach/official; a customer only one person they hold `view` over (else NOT_FOUND), without staff or device identifiers                                                                                                                                                                                                                 |
| POST/GET | `/releases`, `/releases/{id}`                                                                                     | front desk, program manager, GM, or the assigned coach for a child checked into or taking part in that activity (the coach's response carries only whether `collect` is held); reads: pickup staff the full record, `view` over the child a minimized projection (no staff notes, denial details, other adults' permissions, exception or staff identifiers), else NOT_FOUND |
| POST     | `/offline-sync`                                                                                                   | desk and field roles (`entry.sync_offline`); field staff only for assigned activities; arrivals/departures desk only; a queued release needs `entry.record_release`, or `entry.record_assigned_release` for a child of the assigned activity                                                                                                                                 |
| GET/POST | `/facilities/{id}/occupancy`, `/facilities/{id}/occupancy-snapshots`                                              | readers incl. facilities operator and scheduler; counts: front desk, GM, facilities operator                                                                                                                                                                                                                                                                                 |
| POST     | `/webhooks/access-control/{provider}`                                                                             | public, signature-verified (`fake-access-control` only; NOT_FOUND in production), recorded in the kernel inbox; access events, `device.heartbeat` and `device.command_receipt` (ENT-05)                                                                                                                                                                                      |
| GET      | `/me/passes`                                                                                                      | the caller (`entry.read_pass`, self) — ENT-01                                                                                                                                                                                                                                                                                                                                |
| GET      | `/offline-sync/{id}`                                                                                              | the submitter, desk roles and support (`entry.read_offline_batch`) — ENT-01                                                                                                                                                                                                                                                                                                  |
| POST     | `/releases/collector-checks`                                                                                      | the assigned coach or the pickup desk; read-only, not idempotent — ENT-02                                                                                                                                                                                                                                                                                                    |
| POST     | `/access-devices`, `PATCH /access-devices/{id}`, `/access-devices/{id}/policies`, `/access-policies/{id}/approve` | facilities operator, general manager (proposed roles); capability `access_hardware` (CAPABILITY_DISABLED otherwise) — ENT-05                                                                                                                                                                                                                                                 |
| POST     | `/access-devices/{id}/retire`, `/access-policies/{id}/retire`                                                     | facilities operator, general manager; never gated — ENT-05                                                                                                                                                                                                                                                                                                                   |
| GET      | `/access-devices?facilityId`, `/access-devices/{id}/policies`, `/access-devices/{id}/commands`                    | facilities operator, general manager, front desk (`entry.read_access_devices`) — ENT-05                                                                                                                                                                                                                                                                                      |

The stage-3 write routes carry `@NoRecordAuthority` (§5.6, K-11): the collector check records
nothing, and device inventory and access policies are not a §5.3 record category. The migration
module's static route lists (MIG-00) count these decorators once that work item lands.

Every consequential POST is `@Idempotent()` and zod-validated; every write runs in
`UnitOfWork.run` with an audit record and an outbox event; offline synchronization creates an
operation (`entry.offline_sync`). Cross-organization ids answer NOT_FOUND; facility scope is
enforced by the kernel for every command.

## Ports

- Provided: `ATTENDANCE_PORT` (`effectiveAttendance`, `openVisitOf`) for reporting, trials and the
  Today workspace.
- Consumed: `FINANCIAL_STANDING_PORT` — resolves `FINANCIAL_STANDING_IMPL` first, which finance
  registers as `FinancialStandingService` (FIN-03, IF-39), so in the assembled application the
  standing is finance's real answer (`standingOf(person, {offeringId, at})`: due, open obligations
  of the participant and of everyone merged into them, `related` when one belongs to the
  activity's offering; `unknown` only on a failed read). A test may register its own
  `FINANCIAL_STANDING_IMPL` instead. Without it, finance's `ParticipationStandingService` answers
  when it is in the container; without either, every standing is `unknown`, shown as an `info`
  issue that never blocks. Blocking on an unrelated balance stays governed by
  `blockOnUnrelatedBalance: false` (POL-017, DEC-056). Evidence:
  `apps/api/src/__tests__/cross-module-ports.spec.ts` ("SPK-ENTRY-004: the arrival standing comes
  from finance (clear, or an outstanding unrelated balance)"). The standing covers every
  obligation the person owes, pays for or participates in (possibly another adult's order), so
  its issues are projected per reader at read time (`issuesFor`): staff see them with the
  obligation id; the assigned coach or official and a customer do not (AUTHZ-PRIVACY-01).
- Provider port (§5.2): `FakeAccessControlProvider` is the deterministic hardware adapter —
  `granted` (success), `denied` (failure), `unknown` (timeout), duplicate deliveries; HMAC-signed.
  It is also the only `ACCESS_DEVICE_PORT` adapter (IF-38, refused in production): `sendCommand`
  scripted per call (`deliver`, `fail`, `timeout` with an unknown outcome; a repeated command id
  answers its first outcome) and the device signals `heartbeat()` and `commandReceipt()` for the
  inbox (a re-posted receipt is the duplicate scenario). Registered in `INTEGRATION_REGISTRY` as
  `entry.access_device` (gate hardware, DEC-023 pending).
- Provided for finance: `FINANCIAL_STANDING_IMPL` stays declared in `entry.ports.ts` (finance binds
  it, IF-39).
- Fixtures for downstream tests: `testing/entry-fixtures.ts` (`createPassFixture`,
  `createVisitFixture`, `createAttendanceObservationFixture`).

## Events (`entry.events.ts`) and handlers

`entry.pass_issued`, `entry.pass_revoked`, `entry.visit_recorded`, `entry.visit_closed`,
`entry.session_checkin_changed`, `entry.attendance_observed`, `entry.departure_recorded`,
`entry.release_recorded`, `entry.offline_batch_synced`, `entry.occupancy_snapshot_taken`. Payloads
carry identifiers and states only (§4.14).

`entry.access_device_changed` (ENT-05, IF-38: `registered`, `updated`, `retired`,
`policy_drafted`, `policy_activated`, `policy_retired`, `policy_withdrawn`, `online`, `offline`).

Inbox handler `entry.access_event` (provider `fake-access-control`): idempotent under replay
(inbox consumption plus the unique access-event reference on visits). Inbox handler
`entry.access_device_signal`: heartbeats and command receipts (ENT-05).

Outbox handlers (stage 3, each idempotent and writing only through the handler's transaction):
`entry.withdraw_on_session_canceled` (`catalog.session_canceled`), `entry.withdraw_on_event_canceled`
(`scheduling.event_changed`), `entry.follow_person_merge` (`identity.persons_merged`) — failure owner
front desk; `entry.queue_device_revocations` (`entry.pass_revoked`) — failure owner facilities
operator.

Periodic jobs (K-06): `entry.deliver_device_commands` and `entry.detect_device_outages` (60 s,
failure owner facilities operator).

Operational exceptions raised (Today workspace, SPK-UX-006): `entry.attendance_conflict`
(program manager), `entry.stale_offline_snapshot` (program manager),
`entry.offline_departure_unmatched` (program manager: a departure synchronized while the person had
no open visit; it closes the visit when the arrival synchronizes, staff close the exception),
`entry.pickup_denied`, `entry.pickup_escalated`, `entry.release_withheld`,
`entry.offline_release_unverified` (critical: released offline without `collect` now or at the
handover time), `entry.merged_duplicate_pass` (front desk, ENT-04), `entry.device_offline`,
`entry.device_command_undelivered`, `entry.unregistered_access_device` (facilities operator, ENT-05),
`entry.offline_release_unrecorded` (critical: a queued release, or a child
departure that needed one, that could not be recorded — confirm where the child is) (general
manager), `entry.access_outcome_unknown` (front desk). Queue owners are proposals pending DEC-015.

Concurrency: writes about one person's attendance in one activity, and about one person's
presence (visits, departures, releases), are serialized by transaction-scoped advisory locks
(`services/subject-locks.ts`); an offline batch takes every lock it needs up front in sorted
order. Proven under true concurrency by `__tests__/entry-concurrency.spec.ts` with
`TEST_DATABASE_URL`.

## Policy defaults (proposed, pending operator decisions §6.6)

`entry.policy.ts` (`DEFAULT_ENTRY_POLICY`, overridable per facility under
`facilities.settings.entry`; an invalid override block is ignored as a whole):

- Maximum roster age 120 minutes (§4.15 proposal; DEC-033, Operations).
- Unrelated balance does not block (`blockOnUnrelatedBalance: false`; DEC-056).
- No approved manual outage procedure (`approvedOutageProcedures: []`; DEC-005, DEC-034): every
  queued release is rejected until Operations approves one, and each rejected queued release (and
  each child departure rejected because a release was required) raises a critical
  `entry.offline_release_unrecorded` exception. Whether such a handover may later be recorded as a
  fact is pending (DEC-034, DEC-005); no authority is ever asserted for it.
- A child on a participant visit, or with a live (held or admitted) session check-in on the visit
  or at the facility, leaves through a release (`childParticipantDepartureRequiresRelease: true`;
  supervised pickup applicability is DEC-075, pending).
- Denied pickups are recorded `denied` unless staff escalate (`escalateDeniedPickups: false`;
  DEC-005); every denial still raises an exception.
- Device clock tolerance 5 minutes (engineering proposal).
- Technical settings (K-15, `entry.settings.ts`): `ENTRY_DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS`
  (default 3), `ENTRY_DEVICE_COMMAND_RETRY_BASE_SECONDS` (default 30) and
  `ENTRY_DEVICE_COMMAND_RETRY_MAX_SECONDS` (default 300), engineering proposals. No policy value of the access hardware work has a default: a device's heartbeat
  timeout, a policy's holder kinds and schedule are configuration entered by staff, and nothing is
  admitted until a policy is approved (deny-all).

## Capability switch: access hardware (ENT-05)

Access hardware is part of the complete design (§3.16, Package G); whether the complex uses it is
**pending** (DEC-080, Product owner; DEC-016). The organization's `access_hardware` capability
(kernel K-12; no row means disabled) is changed only by a system administrator through
`POST /v1/admin/capabilities/access_hardware/enable|disable`, naming DEC-016 or DEC-080, with audit.

- **Gated** (ACCESS_DENIED `details.code CAPABILITY_DISABLED` while disabled; the actions name the
  capability, so `GET /v1/me/permissions` hides them): registering a device, editing a device,
  drafting a policy, approving a policy.
- **Never gated**: retiring devices and policies, credential revocation on `entry.pass_revoked`,
  command delivery and receipts, heartbeats and outage detection, access-event ingestion, reads.
- The hardware vendor and its interfaces are **pending** (DEC-023): the deterministic fake is the
  only adapter and the API refuses to start in production with it. Hardware policy (inventory,
  access policy, revocation, outage behaviour) is **pending** (POL-043); offline behaviour DEC-032.

Behaviour (**verified**, `access-hardware.spec.ts`): a device is sent deny-all when registered; an
approved policy (never by its author; database check `access_policies_four_eyes`) retires the
active one and is sent; retiring the active policy without a replacement sends deny-all; a newer
synchronization supersedes an undelivered older one (`supersede`, an engineering addition to the
ENT-05 plan so a retried older sync never overwrites a newer policy, **proposed**). A revoked pass
is queued for every active device (passes carry no facility), and only its reference hash is sent.
Delivery runs outside transactions; failed and unknown commands retry with a backoff (the first
retry has no delay and goes out on the next pass that reaches it, which is a later pass of the same
run when the run makes more than one pass, otherwise the next run; the retry after attempt n ≥ 2
waits `ENTRY_DEVICE_COMMAND_RETRY_BASE_SECONDS`·2^(n−2) seconds, at most
`ENTRY_DEVICE_COMMAND_RETRY_MAX_SECONDS`; every pass reads the clock afresh, so a run whose passes
take longer than the base delay can send a command a third time), and due commands are taken in
turns per device (never-attempted first), so an unreachable device with any backlog never keeps
another device's revocations from being sent and is not re-sent every pass (ASYNC-02); after
`ENTRY_DEVICE_COMMAND_ESCALATE_AFTER_ATTEMPTS` undelivered attempts (technical setting, default 3)
one `entry.device_command_undelivered` exception is raised and resolved when the command is later
delivered; a receipt settles a pending or unknown command once. Heartbeats mark a device online;
it is marked offline (and `entry.device_offline` raised, resolved by the next heartbeat) only when
its heartbeat timeout is configured and exceeded — the timeout has no default, so without one the
health is never judged. An access event names the registered device when its reference matches an
active device of the facility; an unregistered or retired reference still yields the arrival and,
once the organization keeps an inventory, one `entry.unregistered_access_device` exception per
reference. Access events are never attendance, check-in or pickup authority (SPK-COND-004).

## Known gaps

- Device approval and roster snapshot issuance (§4.15 "approved staff devices", "encrypted,
  scoped roster"; the runbook's proposed `entry.download_offline_roster`) are not implemented: the
  device id and snapshot reference are recorded as supplied by an authorized staff principal, and
  items are checked against the facility scope, the observed time and the snapshot time only
  (DEC-023, DEC-032 pending). Past batches are read one at a time (`GET /offline-sync/{id}`); there
  is no batch list.
- Event check-ins recognise person commitments on the scheduling event and effective rosters of
  the fixture it schedules; other event kinds have no participation basis yet.
- Pass scans list sessions from enrollments and session bookings; league fixtures are not listed.
- The collector check and releases by field staff are for coaches only
  (`entry.record_assigned_release` is held by `coach`); officials are refused, as for releases.
- `GET /me/passes` lists person passes only; household passes are staff-managed.
- A merge with two active passes is raised for staff; whether one pass should be revoked
  automatically is not assumed (nothing is revoked).
- The as-of authority check of an offline release trusts the grant's recorded effective dates:
  identity accepts a past `effectiveFrom` on relationship and grant creation (audited), so a
  deliberately backdated grant would satisfy it. Offline releases record no grant id (only online
  verified releases do, 0804).
- Hardware exits (departure events) are not modelled; offline departure items are accepted like
  arrivals although §4.15 names only arrivals and attendance (DEC-032 pending). How a device
  enforces the policy schedule, and whether it keeps a credential list, depend on the vendor
  (DEC-023); entry sends the policy (holder kinds, active passes only, facility-local weekly
  windows) and revocations, nothing more.
- Device commands of a retired device are not delivered and stay in their last state.
- No exception names a device command that waits without a first attempt; with the per-device
  turns this happens only while more commands are due than one delivery run sends
  (`PERIODIC_JOBS_MAX_PASSES` × 50 per minute), and escalation starts at the third attempt.
- `GET /attendance` returns one page; `GET /visits` is cursor-paginated.

## Cross-branch notes (stage 3)

- **Pending (other modules):** ENT-01 names, ENT-04 merge expansion and ENT-02 grant recording
  call identity's ID-01 (`displayNames`, `personIdsResolvingTo`) and ID-09 (`effectiveGrant`); the
  suite passes with the identity work merged (see Status).
- The new write routes are classified with `@NoRecordAuthority`; the migration module's
  classification test counts decorators once MIG-00 lands (until then it lists them as
  unclassified). `docs/api/openapi.json` and `docs/package-a/permission-matrix.generated.md` are
  regenerated by the integrator (`pnpm build && pnpm openapi`, `pnpm --filter @sportspark/api
permission-matrix`).

## Kernel and cross-module constraints worked around here

- Inbox and outbox handlers bind the handler transaction with `runWithTransaction` so port reads
  go through it (the access-event, device-signal and follow-up handlers).
- Catalog's `SessionsService`/`OfferingsService` and scheduling's `EventsService` read through the
  root database, so `ActivityResolver` resolves activities before or after a command's transaction
  (it refuses to run inside one).
