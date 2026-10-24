# scheduling module

**Owns:** Resources, configurations, conflict units, operating hours, closures, event series,
events, reservations, reservation units, party commitments, schedule drafts, publications

**Specification:** §3.7 (SPK-SCHED-001..009), §3.8 SPK-FIX-005 (fixture suggestions publish through
the normal scheduling command; the generator and SPK-FIX-001..004 data live in competition), §4.4
Scheduling, §4.5 "Resource must express physical overlap and configurations", §4.7 invariant 4,
SPK-AT-008/009/021, SPK-COMMS-005 (old and new practical details on every schedule notice)

**Migration range:** `packages/db/migrations/0300_scheduling_*.sql` … `0399`

**Status: implemented** (verified by `apps/api/src/modules/scheduling/__tests__` and
`time/recurrence.spec.ts`). Pending decisions are listed at the end.

## Tables (migration `0300_scheduling_core.sql`)

| Table                                    | Purpose                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resources`                              | Pitches, subdivisions (always with a parent), rooms, other spaces: dimensions, formats, default buffers, equipment, staffing, status `active/restricted/closed`                                   |
| `resource_configurations` (+ `_members`) | A physical arrangement: the set of resources that may operate simultaneously ("full pitch", "two halves")                                                                                         |
| `conflict_units`                         | Atomic physical areas; `resource_conflict_units` maps a whole pitch to all of its subdivisions' units and a subdivision to its own                                                                |
| `operating_hours`                        | Local windows per weekday for a resource or (resource null) the whole facility                                                                                                                    |
| `closures`                               | Facility- or resource-level `tstzrange` closures with impact preview, resolution and lifecycle `pending → active → lifted` (`withdrawn` from pending)                                             |
| `event_series`                           | Recurrence rule in facility-local wall-clock time + IANA zone, DST policies, exceptions                                                                                                           |
| `events`                                 | Scheduled instants in UTC with the facility zone, buffers, `dst_resolution`, lifecycle `draft → published → canceled`, `published_revision`, owning record                                        |
| `reservations` / `reservation_units`     | Holds per resource / per conflict unit for the occupied interval (scheduled ± buffers). `EXCLUDE USING gist (organization_id, conflict_unit_id, occupied) WHERE status = 'active'` is invariant 4 |
| `event_commitments`                      | Teams, people (officials, coaches, participants) and equipment committed to an event; exclusion on `(organization_id, party_type, party_id, occupied)`                                            |
| `schedule_drafts` / `draft_changes`      | Autosaved drafts with base revisions, author, validation results, publication status; changes `create/move/cancel/resize/resource_change`                                                         |
| `publications`                           | Append-only publication groups: actor, committed events, enqueued notices, remaining fixture obligations                                                                                          |

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

- `EVENT_SCHEDULING_PORT` → `EventsService.createEvent/moveEvent/cancelEvent/getEvent` for owning
  records (fixtures, sessions, rentals). Conflicts are `RESOURCE_CONFLICT` with
  `details.conflicts[]` (code, resource/unit, `conflictingEventIds`) and `details.conflictingEventIds`.
  `status: 'draft'` creates a placeholder that holds no space until a schedule draft publishes it
  (SPK-FIX-005).
- `AVAILABILITY_PORT` → `findAvailableSlots(resource, interval, duration, buffers)`.
- `CLOSURE_PORT` → `previewImpact`, `createClosure`, `applyClosure`, `liftClosure` (facilities, SPK-FAC-003/004/005).
- `RESERVATION_QUERY_PORT` → `listReservations` by facility or resource and interval (reporting, facilities).
- `FIXTURE_OBLIGATION_PORT` (step 4 of publication). Competition registers its implementation under
  `FIXTURE_OBLIGATION_IMPL`; without one, no obligations exist. Blocking obligations fail the group,
  the rest are recorded as `remainingObligations` on the publication (SPK-FIX-002).
- `SCHEDULING_POLICY` (`scheduling.policy.ts`): required rest per party kind and series limits.

Test fixtures for downstream modules: `testing/scheduling-fixtures.ts` (`seedPitchWithHalves`,
`seedResource`, `seedOperatingHours`, `createScheduledEvent`, `createAppliedClosure`, `at`).

## Events (`scheduling.events.ts`)

- `scheduling.event_changed` — one per changed event: `change` (created, published, moved, resized,
  resource_changed, updated, canceled), `before` and `after` practical details (title, kind,
  instants, zone, facility, resources, status), owning record, parties, publication or closure id.
- `scheduling.schedule_published` — publication group with event ids, changes and remaining obligations.
- `scheduling.closure_applied` / `scheduling.closure_lifted`.

Draft events and drafts themselves never produce customer notices (SPK-SCHED-005).

## Behaviour notes

- Conflict detection (`conflicts/conflict-detector.ts`) gives early feedback: physical overlap on
  shared units including buffers, closures, operating hours, party overlap, required rest,
  compatible formats, resource status and configured arrangements, plus conflicts between changes
  of the same group. The exclusion constraints remain the guarantee; a constraint failure inside a
  savepoint is converted to the same `RESOURCE_CONFLICT`.
- Publication (`ScheduleDraftsService.publish`) performs the seven SPK-SCHED-006 steps inside one
  transaction after creating the operation; a stale base revision (`STALE_REVISION`), any conflict
  or blocking obligation rolls everything back, the draft is marked `failed` with the reasons, and
  nothing is partially published.
- Series store local time + zone; nonexistent local times shift forward (or skip) and ambiguous ones
  take the first occurrence (or second) per the series, recorded as `dst_resolution` on the event.
  Occurrence indexes are stable, and occurrences that already ended are never changed by an edit.
- Closure application either cancels affected published events (notices carry the closure id) or
  leaves them for staff resolution as an operational exception in the `scheduler` queue.

## Known gaps / pending decisions

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
