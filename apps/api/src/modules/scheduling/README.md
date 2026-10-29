# scheduling module

**Owns:** Resources, configurations, conflict units, operating hours, closures, event series,
events, reservations, reservation units, party commitments, schedule drafts, publications

**Specification:** §3.7 (SPK-SCHED-001..009), §3.8 SPK-FIX-005 (fixture suggestions publish through
the normal scheduling command; the generator and SPK-FIX-001..004 data live in competition), §4.4
Scheduling, §4.5 "Resource must express physical overlap and configurations", §4.7 invariant 4,
SPK-AT-008/009/021, SPK-COMMS-005 (old and new practical details on every schedule notice)

**Migration range:** `packages/db/migrations/0300_scheduling_*.sql` … `0399`

**Status: implemented** (verified by `apps/api/src/modules/scheduling/__tests__` and
`time/recurrence.spec.ts`). Pending decisions are listed at the end. Labels follow §6.7:
**verified** (implemented and covered by the named test), **proposed** (implemented with a value or
reading that awaits a decision) and **pending** (not built until a decision is made).

**Capability switches:** none. Scheduling's own commands are core capabilities and are never behind
a per-organization switch. The Package G bookings that call the port's series methods (rentals
DEC-076, parties DEC-077) are switched off by default in the modules that own them (enrollment,
catalog; DEC-016); scheduling only accepts their `sourceType 'enrollment.booking'` events.

## Tables (migration `0300_scheduling_core.sql`; facility-scoped keys `0301`; closure withdrawal `0302`)

| Table                                    | Purpose                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources`                              | Pitches, subdivisions (always with a parent), rooms, other spaces: dimensions, formats, default buffers, equipment, staffing, status `active/restricted/closed`                                                                               |
| `resource_configurations` (+ `_members`) | A physical arrangement: the set of resources that may operate simultaneously ("full pitch", "two halves")                                                                                                                                     |
| `conflict_units`                         | Atomic physical areas; `resource_conflict_units` maps a whole pitch to all of its subdivisions' units and a subdivision to its own                                                                                                            |
| `operating_hours`                        | Local windows per weekday for a resource or (resource null) the whole facility                                                                                                                                                                |
| `closures`                               | Facility- or resource-level `tstzrange` closures with impact preview, resolution and lifecycle `pending → active → lifted` (`withdrawn` from pending, with `withdrawn_at`, `withdrawn_by`, `withdrawal_reason`, migration 0302)               |
| `event_series`                           | Recurrence rule in facility-local wall-clock time + IANA zone, DST policies, exceptions                                                                                                                                                       |
| `events`                                 | Scheduled instants in UTC with the facility zone, buffers, `dst_resolution`, lifecycle `draft → published → canceled`, `published_revision`, owning record                                                                                    |
| `reservations` / `reservation_units`     | Holds per resource / per conflict unit for the occupied interval (scheduled ± buffers). `EXCLUDE USING gist (organization_id, conflict_unit_id, occupied) WHERE status = 'active'` is invariant 4                                             |
| `event_commitments`                      | Teams, people (officials, coaches, participants) and equipment committed to an event; exclusion on `(organization_id, party_type, party_id, occupied)`                                                                                        |
| `schedule_drafts` / `draft_changes`      | Autosaved drafts with base revisions (autosave keeps the base a target already holds, so a draft never re-bases silently, SPK-SCHED-005), author, validation results, publication status; changes `create/move/cancel/resize/resource_change` |
| `publications`                           | Append-only publication groups: actor, committed events, enqueued notices, remaining fixture obligations                                                                                                                                      |

Every table carries `organization_id`; references use composite `(organization_id, id)` keys.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/scheduling.ts`)

| Method          | Path                                          | Action                                                                                     |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| POST/GET/PATCH  | `/resources`, `/resources/{id}`               | `scheduling.manage_inventory` / `read_inventory`                                           |
| GET             | `/resources/{id}/availability`                | `scheduling.read_schedule`                                                                 |
| POST/GET/PATCH  | `/resource-configurations[/{id}]`             | manage / read inventory                                                                    |
| POST/GET        | `/conflict-units`                             | manage / read inventory                                                                    |
| POST/GET/DELETE | `/operating-hours[/{id}]`                     | manage / read inventory                                                                    |
| POST/GET        | `/closures`, `/closures/{id}`                 | `scheduling.manage_closures` / read                                                        |
| POST            | `/closures/{id}/apply`, `/closures/{id}/lift` | `scheduling.manage_closures`                                                               |
| POST            | `/closures/{id}/withdraw`                     | `scheduling.manage_closures`; `{ reason, expectedRevision? }` (SCH-01)                     |
| GET             | `/closure-impact`                             | `scheduling.manage_closures`; `facilityId`, `resourceId?`, `start`, `end`; creates nothing |
| GET             | `/events`, `/events/{id}`, `/reservations`    | `read_schedule`; `read_event` allows a committed participant or a guardian with `view`     |
| POST/GET        | `/event-series`, `/event-series/{id}`         | `scheduling.manage_events`                                                                 |
| POST            | `/event-series/{id}/edits`                    | one / this and future / entire series, `preview: true` returns exactly which events change |
| POST/GET/PATCH  | `/schedule-drafts[/{id}]`                     | `scheduling.manage_drafts`                                                                 |
| POST            | `/schedule-drafts/{id}/validate`, `/discard`  | `scheduling.manage_drafts`                                                                 |
| POST            | `/schedule-drafts/{id}/publish`               | `scheduling.publish_schedule`                                                              |

Every POST/PATCH/DELETE is `@Idempotent()` and validated with zod; every write runs in
`UnitOfWork.run` with an audit record and outbox follow-ups. Publication creates an operation
(`scheduling.publish_schedule`) readable at `GET /v1/operations/{id}`.

## Ports (`ports.ts`, provided by `SchedulingModule`)

- `EVENT_SCHEDULING_PORT` (IF-31) → `EventsService.createEvent/moveEvent/cancelEvent/getEvent` for
  owning records (fixtures, sessions, rentals), plus `createEventSeries`, `cancelEventSeries`
  (`EventSeriesService`) and `importEvent` (`EventImportService`). Every method joins the caller's
  unit of work (IF-28), so an owning record and its events commit or roll back together. Conflicts
  are `RESOURCE_CONFLICT` with `details.conflicts[]` (code, resource/unit, `conflictingEventIds`) and
  `details.conflictingEventIds`. `status: 'draft'` creates a placeholder that holds no space until a
  schedule draft publishes it (SPK-FIX-005).
  - `createEventSeries` (SCH-02, SPK-COND-003): weekly only, `count <= 52` or an `until` that
    produces at most 52 occurrences, expanded in the facility zone with the SPK-SCHED-008
    resolution rules. Detection runs once over every occurrence; any conflict answers
    `RESOURCE_CONFLICT { conflicts: [{ occurrenceIndex, occurrenceStart, conflictingEventIds,
details }] }` and writes nothing. A concurrent winner fails a reservation (exclusion
    constraint) and the same grouped error rolls the whole joined unit back.
  - `cancelEventSeries` (SCH-02): cancels the occurrences starting at or after `fromInstant`
    (default the Clock's now), releases their holds, one `scheduling.event_changed` per published
    occurrence, and ends the series; a replay cancels nothing more.
  - `sourceType 'enrollment.booking'` (`BOOKING_SOURCE_TYPE`) is for kinds `rental` and `party`;
    enrollment calls with `systemPrincipal(org, 'enrollment.booking')`, which schedules booking
    events only; staff need `scheduling.manage_events`.
  - §5.6 (K-11, IF-42): `createEvent`, `createEventSeries`, `moveEvent`, `cancelEvent` and
    `cancelEventSeries` assert `RECORD_AUTHORITY_PORT 'future_schedule'` for the facility inside
    the unit (ACCESS_DENIED `LEGACY_AUTHORITY`); `importEvent` never does.
  - `importEvent` (SCH-04, IF-40): see "Import" below.
- `AVAILABILITY_PORT` → `findAvailableSlots(resource, interval, duration, buffers)`.
- `CLOSURE_PORT` → `previewImpact`, `createClosure`, `applyClosure`, `liftClosure`,
  `withdrawClosure` (facilities, SPK-FAC-003/004/005). `withdrawClosure` (IF-11) withdraws a pending
  closure of any source, including the `maintenance` closure of a withdrawn restriction, and joins
  the caller's unit of work.
- `ClosureLiftGuards`: a module that backs closures with its own authority registers a guard that
  `liftClosure` runs inside its transaction before the lift; facilities refuses lifting a closure
  that backs an unreleased restriction outside its release (SPK-FAC-004).
- `RESERVATION_QUERY_PORT` → `listReservations` by facility or resource and interval (reporting, facilities).
- `FIXTURE_OBLIGATION_PORT` (step 4 of publication). Competition registers its implementation under
  `FIXTURE_OBLIGATION_IMPL`; without one, no obligations exist. Blocking obligations fail the group,
  the rest are recorded as `remainingObligations` on the publication (SPK-FIX-002).
- `SCHEDULING_POLICY` (`scheduling.policy.ts`): required rest per party kind and series limits.
- `PartyCommitmentSources` (`conflicts/party-commitment-sources.ts`): a module that holds party
  commitments in its own tables registers a source (workforce registers `workforce.assignments`
  for persons, its accepted and completed assignments). Detection and the post-lock re-check in
  `EventWriter.reserve` report overlaps and too-short rest against them as `party_overlap` /
  `insufficient_rest` with `externalCommitments: [{ source, id }]`, so scheduling never commits a
  person another module already holds (SPK-SCHED-004 official and assigned-coach overlap,
  SPK-STAFF-003). The owning module takes the same per-party advisory lock (`lockParty`) before it
  writes; scheduling never reads its tables (§4.2).

Test fixtures for downstream modules: `testing/scheduling-fixtures.ts` (`seedPitchWithHalves`,
`seedResource`, `seedOperatingHours`, `createScheduledEvent`, `createAppliedClosure`, `at`).

## Events (`scheduling.events.ts`)

- `scheduling.event_changed` — one per changed event: `change` (created, published, moved, resized,
  resource_changed, updated, canceled), `before` and `after` practical details (title, kind,
  instants, zone, facility, resources, status), owning record, parties, publication or closure id,
  and the event's `revision` after the change, so consumers order changes exactly (the outbox does
  not order events per aggregate, §4.12).
- `scheduling.schedule_published` — publication group with event ids, changes and remaining obligations.
- `scheduling.closure_applied` / `scheduling.closure_lifted`.
- `scheduling.closure_withdrawn` (IF-12) — closureId, facilityId, resourceId, interval, source,
  reason. No handler: a withdrawn closure never affected availability.

Draft events and drafts themselves never produce customer notices (SPK-SCHED-005).

## Behaviour notes

- Conflict detection (`conflicts/conflict-detector.ts`) gives early feedback: physical overlap on
  shared units including buffers, closures, operating hours, party overlap, required rest,
  compatible formats, resource status and configured arrangements, plus conflicts between changes
  of the same group (overlap and required rest). What holds under concurrent commands (§4.7):
  - physical overlap and party overlap: the exclusion constraints; a constraint failure inside a
    savepoint is converted to the same `RESOURCE_CONFLICT`;
  - closures (SPK-SCHED-009, SPK-FAC-003): closures hold no reservation rows, so
    `EventWriter.reserve` share-locks the event's conflict units and re-checks active closures
    after the lock, and `applyClosure` locks the closed area's units (every unit of the facility
    for a facility-wide closure) `FOR UPDATE` before reading the impact. A booking in flight is
    either in the impact (cancelled or left for resolution) or refused with a `closure` conflict;
  - configured arrangements (SPK-SCHED-002): detection locks the parent resource row of every
    requested subdivision (`FOR NO KEY UPDATE`) before reading sibling reservations, so bookings of
    sibling subdivisions are serialized;
  - required rest (SPK-SCHED-004): `EventWriter.reserve` takes a transaction-scoped advisory lock
    per committed party that needs rest (or that a registered `PartyCommitmentSources` source
    covers) and re-checks the gap, and the source's commitments, after it (`insufficient_rest`,
    `party_overlap`).
    Commands that reserve several events (publication, series edit) take these locks up front in
    one order (`EventWriter.lockHolds`); a deadlock that still occurs (40P01) is retried by
    `UnitOfWork`. Verified by `__tests__/concurrency.spec.ts` under PGlite and `TEST_DATABASE_URL`.
- Buffers (SPK-SCHED-001/003): each resource's default setup and cleanup is its turnover
  requirement. Every write path (create, move, series create and edit, draft changes, availability)
  holds at least the largest requirement among the resources it actually reserves; a larger
  requested value extends it, a smaller one is raised to it. An event keeps its own buffers only
  while it stays on the same resources.
- Inventory (SPK-SCHED-002, §4.7 invariant 4): on `PATCH /resources/{id}`, `conflictUnitIds` names
  the resource's own units; a whole space always keeps every unit of its subdivisions (the response
  lists the effective set). When a resource gains units (a new subdivision, or an update), they are
  added to its active reservations that have not ended, so an earlier whole-pitch booking still
  covers a half created later; if that space is already reserved by another event the inventory
  change is refused with `RESOURCE_CONFLICT`. Units a resource loses stay on its existing holds
  (they over-conflict, which is safe), and ancestors keep units of a former mapping.
- Publication (`ScheduleDraftsService.publish`) performs the seven SPK-SCHED-006 steps inside one
  transaction after creating the operation; a stale base revision (`STALE_REVISION`), any conflict
  or blocking obligation rolls everything back, the draft is marked `failed` with the reasons, and
  nothing is partially published.
- Series store local time + zone; nonexistent local times shift forward (or skip) and ambiguous ones
  take the first occurrence (or second) per the series, recorded as `dst_resolution` on the event.
  SPK-SCHED-008 "require resolution": when the rule's local start time falls in a gap or an overlap
  on some date and the matching `nonexistentPolicy` / `ambiguousPolicy` was not sent, the series is
  refused (`VALIDATION_FAILED`, `details.code = dst_resolution_required` with the local dates); the
  defaults are never applied silently (`event-series.spec.ts`).
- Operating hours (SPK-SCHED-001/008) compare the local wall-clock start and end
  (`localMinuteSpan`), never the start plus elapsed minutes: a fall-back event 00:30 PDT to
  01:30 PST fits a 00:00-02:00 window, a spring-forward event 01:30 PST to 03:30 PDT does not fit
  one closing at 03:00. An event may end at 24:00 of its start day; one that runs past local
  midnight never fits (windows never span midnight). Conflict detection and the slot search share
  the rule (`events.spec.ts`).
- A revision-matched event write that matches no row (another command changed the event after it
  was read) answers `STALE_REVISION`, never an internal error (`EventWriter.cancel`, series edit).
- Facility boundaries (§4.3, migration `0301`): resources, events and closures carry
  `unique (organization_id, facility_id, id)`; a subdivision's parent, a closure's resource, an
  operating-hours window's resource, and a reservation's event and resource (reservations carry
  `facility_id`) belong to the row's own facility (`schema-invariants.spec.ts`).
- Concurrent publication (SPK-AT-008): drafts racing for the same pitch and halves commit a
  non-overlapping set (the whole pitch alone, or at most one booking of each half) with one event,
  publication and succeeded operation per committed draft and every other draft `failed`
  (`concurrency.spec.ts`, under PGlite and `TEST_DATABASE_URL`).
  Occurrence indexes are stable, and occurrences that already ended are never changed by an edit.
- Closure application either cancels affected published events (notices carry the closure id) or
  leaves them for staff resolution as an operational exception in the `scheduler` queue.

### Closure withdrawal and preview (SCH-01: SPK-FAC-003, SPK-SCHED-009) — verified

- `POST /v1/closures/{id}/withdraw` moves a pending closure to `withdrawn` (ClosureMachine
  `withdraw`) with the reason, actor and instant (the injected Clock), audit
  `scheduling.closure_withdrawn` and the `scheduling.closure_withdrawn` event. An active closure is
  `INVALID_TRANSITION` (it is lifted instead); a withdrawn closure is never applied, lifted or
  withdrawn again. A `maintenance` closure answers `RESOURCE_CONFLICT` `OWNED_BY_RESTRICTION` over
  HTTP: facilities withdraws it with its restriction through `CLOSURE_PORT` (§4.2). The route is
  classified `@RecordAuthority('future_schedule', 'unproven')`, like apply and lift.
- Database (migration 0302): a closure is `withdrawn` exactly when `withdrawn_at` is set; a
  withdrawn closure names its actor and a 1..2000-character reason and was never applied; the
  `closures_terminal_guard` trigger refuses any rewrite of a `lifted` or `withdrawn` closure
  (status, interval, area, facts, impact, resolution, revision).
- `GET /v1/closure-impact?facilityId&resourceId&start&end` returns the `ClosureImpact` that
  `POST /closures` stores (affected events, owning records, parties, and the customers, obligations
  and messages the contributors add) and writes nothing (no closure, audit or outbox row).
- Tests: `__tests__/closure-withdrawal.spec.ts` ("SPK-FAC-003: a pending closure is withdrawn and
  can never be applied", "the database rejects a withdrawn closure without withdrawal facts and a
  status change out of withdrawn", the preview and the `OWNED_BY_RESTRICTION` cases), under PGlite
  and `TEST_DATABASE_URL`.

### Port series, cancellation and authority (SCH-02, SCH-03) — verified

`__tests__/event-scheduling-port.spec.ts`: "SPK-COND-003: a series with one conflicting occurrence
writes nothing and lists that occurrence", "SPK-SCHED-008: weekly occurrences keep their local start
time across a daylight-saving change", "§5.6: a port reservation at a facility whose schedule
authority is legacy answers LEGACY_AUTHORITY" (with a deterministic `RECORD_AUTHORITY_IMPL` fake;
the migration module provides the real one), the joined-unit rollback, cancellation, the booking
rules, two racing series (one wins, the other writes nothing; PGlite and `TEST_DATABASE_URL`) and
"reservation and event created_at follow FixedClock". SCH-03: `EventWriter.insertEvent`,
`EventWriter.reserve` and series creation stamp `created_at`/`updated_at` of events, event series,
reservations, reservation units and event commitments from the injected Clock (the column defaults
remain for other writers; later updates still use the `touch_updated_at` trigger's `now()`).

### Import of future schedules (SCH-04: §5.3, §5.4, SPK-AT-024) — verified

`EventSchedulingPort.importEvent` runs only for `systemPrincipal(org, 'migration.import:<batchId>')`
(`assertImportPrincipal`). It creates the event if absent with `id = recordId` as a `draft`, with
`source_type 'import'` and `source_id = batchId` (the owning record type of the legacy row is not
kept on the event), audited `scheduling.event_imported` with the import actor. The same record and
content returns the existing event with no effect; different content is `RESOURCE_CONFLICT`
`IMPORT_CONTENT_MISMATCH`. A draft holds no space, so the import runs conflict detection for its
interval, resources and buffers against current reservations, closures and conflict units and
refuses with `RESOURCE_CONFLICT { code: 'IMPORT_SCHEDULE_CONFLICT', conflicts }`, writing nothing
(the migration module records the import exception, MIG-02). Importing publishes nothing (no
reservation, commitment or notice); the draft is published only through a schedule draft whose
`create` change names it, whose validation and publication re-detect later conflicts. Tests:
`__tests__/event-import.spec.ts` ("SPK-AT-024: importing the same event twice creates one draft
event", "an import that conflicts with an existing reservation or closure answers
IMPORT_SCHEDULE_CONFLICT and writes nothing", "§5.6: importing publishes nothing").

### Closure impact contributors (SPK-SCHED-009, SPK-AT-009) — verified

`ClosureImpactContributors` (exported) lets the modules that own participation, money and messages
complete a closure preview: `impact.customers` (enrollment: participants of the catalog sessions
linked to the affected events; competition: rostered players of committed teams; committed persons),
`impact.obligations` (orders those enrollments were paid through) and `impact.messages` (unsent
notices about the events), with counts in `impact.summary`. Contributors read through the preview's
executor. **Verified**: `apps/api/src/__tests__/journeys/spk-at-009.spec.ts`. Any financial
adjustment of an affected obligation stays a staff resolution (DEC-003, DEC-009).

## Known gaps / pending decisions

- Pending (DEC-001): the roles allowed to create, apply, lift and withdraw closures
  (`scheduling.manage_closures`: scheduler, facilities operator, general manager, system
  administrator) are placeholders until the physical-inventory and approval decision.
- Proposed: a series through the scheduling port holds at most 52 occurrences
  (`PORT_SERIES_MAX_OCCURRENCES`); longer bookings are split by the owning module. The HTTP series
  keeps `maxSeriesOccurrences` (366).
- Proposed: an imported event keeps only its batch as `source_id`; linking it back to the owning
  module's imported record (fixture, session) is that module's mapping (external mappings, MIG).
- Integration (not this module): the committed `docs/api/openapi.json` and the generated
  `packages/api-client` paths need regeneration for `POST /closures/{id}/withdraw` and
  `GET /closure-impact`, and the migration module's authority classification test must count the
  `@RecordAuthority` decorator on the withdraw route (MIG-00).

- Required rest minutes (team/person 60, equipment 0) and the availability step are proposed
  defaults pending the league-manager and operations decisions (§6.6); facilities override them via
  `facilities.settings.scheduling.requiredRestMinutes`.
- Equipment conflicts are modelled as `equipment` party commitments; `required_equipment` on a
  resource is descriptive until the facilities module owns equipment assets.
- Staffing constraints are stored but not validated here; workforce assignments are checked by
  the workforce module and are not written back as scheduling commitments (workforce README,
  "Known gaps").
- SPK-SCHED-009 financial obligations and messages are resolved by finance and communications from
  the `source_records` in the closure impact; this module names the affected events and parties only.
- Operating-hours overlap between windows is not constrained (only duplicate start times are).
- Pending decision: an authorized, audited override that books with less than a resource's
  turnover requirement is not implemented (it would need an action, a contract field and a reason);
  today a smaller requested buffer is always raised to the requirement. Raising a resource's
  default buffer later does not change events already booked on it.
