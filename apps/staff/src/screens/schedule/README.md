# Schedule and facilities screens

Staff dashboard screens SCR-S-03 to SCR-S-07 (Schedule area, `/schedule`) and SCR-S-41, SCR-S-42
(Facilities and maintenance area, `/facilities`), from
`docs/package-a/screen-and-journey-inventory.md` section 5. Shared pieces are in
`src/features/schedule-facilities/`; facilities screens are in `src/screens/facilities/`.

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test here (not staff
acceptance on real workstations, §6.3). **Proposed** = engineering choice awaiting operator
approval. **Pending decision** = needs an operator answer; the screen shows the pending state.

## Screens

| Screen                                         | Route                                                          | API                                                                                                                                                | Status                | Evidence                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| SCR-S-03 Calendar and resource view            | `/schedule/calendar`                                           | `GET /facilities`, `/resources`, `/events` (cursor pages), `/closures`, `/sessions` (cursor pages)                                                 | **Verified** in jsdom | `__tests__/ScheduleCalendarScreen.test.tsx`                                                                                              |
| SCR-S-04 Drafts list and draft editor          | `/schedule/drafts`, `/schedule/drafts/:id`                     | `GET/POST /schedule-drafts`, `PATCH /schedule-drafts/{id}`, `POST .../validate`, `.../discard`, `/event-series/{id}/edits`, `GET /me/permissions`  | **Verified** in jsdom | `__tests__/ScheduleDraftEditorScreen.test.tsx`, `__tests__/PublicationReviewScreen.test.tsx`                                             |
| SCR-S-05 Publication review                    | `/schedule/drafts/:id/publish`                                 | `POST /schedule-drafts/{id}/publish`, `GET /operations/{id}`, `GET /me/permissions`                                                                | **Verified** in jsdom | `__tests__/PublicationReviewScreen.test.tsx`                                                                                             |
| SCR-S-06 Closure impact and resolution         | `/schedule/closures`, `/schedule/closures/:id`                 | `GET /closure-impact`, `GET/POST /closures`, `POST /closures/{id}/apply`, `.../withdraw`, `.../lift`, `POST /schedule-drafts`, `GET /person-names` | **Verified** in jsdom | `__tests__/ClosureDetailScreen.test.tsx`                                                                                                 |
| SCR-S-07 Resource inventory and configurations | `/schedule/resources`                                          | `GET /facilities`, `/resources`, `/resource-configurations`, `/conflict-units`, `/operating-hours`                                                 | **Verified** in jsdom | `__tests__/ResourceInventoryScreen.test.tsx`                                                                                             |
| SCR-S-41 Assets and maintenance tasks          | `/facilities/maintenance`, `/facilities/maintenance/tasks/:id` | `/assets`, `/maintenance-tasks` (cursor pages), `.../inspections`, `/preventive-schedules`, `GET /staff-directory`, `GET /person-names`            | **Verified** in jsdom | `../facilities/__tests__/MaintenanceScreen.test.tsx`, `MaintenanceTaskScreen.test.tsx`                                                   |
| SCR-S-42 Operating restrictions and release    | `/facilities/restrictions`, `/facilities/restrictions/:id`     | `/maintenance-restrictions`, `.../approve`, `.../release`, `.../withdraw`, `/facilities/{id}/operating-status`                                     | **Verified** in jsdom | `../facilities/__tests__/RestrictionsScreen.test.tsx`                                                                                    |
| Permission restriction on all of the above     | every route above                                              | `GET /me/permissions` (role view per facility)                                                                                                     | **Verified** in jsdom | `../../features/schedule-facilities/__tests__/permissions.test.tsx`                                                                      |
| SCR-S-51 Rentals, SCR-S-52 Parties             | `/schedule/rentals/*`, `/schedule/parties/*`                   | `GET /v1/me/permissions` (capability switches)                                                                                                     | **Pending decision**  | Placeholders in `src/screens/package-g/{rentals,parties}/` behind `CapabilityGate` (DEC-016, DEC-076, DEC-077; Product owner); not built |

## Behaviour

- **Facility directory and local time (SPK-SCHED-008).** Facility names, IANA zones and status
  come from `GET /v1/facilities` (K-04); the facilities offered are those the API marks
  `inStaffScope`, and a record's own facility outside the default listing (archived) is read with
  `GET /v1/facilities/{id}`. Today's local date is the injected clock in the facility's zone. When
  the directory cannot be read, the facilities of the viewer's scope (`GET /v1/me`) are still
  offered in UTC, with the error code and "Load facilities again". A closed facility is marked by
  its status in text. The resource inventory shows the facility as the directory states it (name,
  zone, status, address or "Not set yet"); changing it is not offered (no settings command). Instants
  are entered in the facility zone: a local time that happens twice asks which occurrence, one that
  does not exist is refused with the time after the change offered (`time.ts`,
  `LocalDateTimeField.tsx`, tested in `features/schedule-facilities/__tests__/time.test.ts`).
- **Calendar paging (SPK-UX-008, §4.5).** Events load in cursor pages of 200 with "Load more
  events"; while more exist, the screen says how many are loaded and no space reads as free. A
  loaded page is added without a "Schedule changed" banner; a refresh that changes a published
  revision still shows the banner. Whether more exist is kept with the events shown, so while a
  changed refresh is held back no space reads as free on the strength of the newer read; "Load
  more events" during a held-back change shows the latest first, then adds its next page.
- **Program sessions (CAT-01).** The sessions at the facility in the calendar's window are listed
  with the offering, sequence or title, the time in the zone the API states and their state, with
  "Load more sessions" and a link to the offering. Without catalog.read_catalog the section says
  they are not available and the rest of the calendar is unchanged. Sessions are not used to mark a
  space busy or free (see API issue 3).
- **Shared space (SPK-SCHED-002, SPK-SCHED-003).** Two spaces conflict when they share a conflict
  unit, as the API derives it; the calendar shows what blocks a space through shared space and the
  occupied interval with setup and cleanup buffers. The bars are decorative; each space's list
  carries the same information as text.
- **Drafts (SPK-SCHED-005).** Every edit autosaves the whole change list with the draft's
  `expectedRevision`, one save at a time; a retry reuses its idempotency key. Offline, edits stay
  on the page and save on reconnect. STALE_REVISION keeps the edits and offers "load latest" or
  "save my edits on the latest version". The API keeps the base revision each target captured when
  it entered the draft, so autosave never rebases: a target whose event changed is flagged "Rebase
  required" and publishing waits for it. "Rebase onto the current event" is one save without that
  event's changes and one with them again (the API's documented way to capture the current
  revision); an interrupted rebase is never shown as saved and resumes on retry. A rebase that captured
  a newer revision than the one shown when the user pressed it is flagged again.
- **Series edits (SPK-SCHED-007).** A wider scope is previewed (`preview: true`, nothing is
  committed) and the exact listed events are added to the draft as individual changes, so nothing
  is published or announced before the draft (see API issue 1).
- **Publication (SPK-SCHED-006, SPK-FIX-002).** The group publishes whole or not at all;
  STALE_REVISION, RESOURCE_CONFLICT and unmet fixture obligations read "Nothing was published".
  Remaining obligations of a successful publication are listed with owner and deadline. The
  operation is read back; `recovery_required` reads "Needs attention".
- **Closures (SPK-SCHED-009, SPK-FAC-003, SPK-AT-009).** A new closure is previewed first with
  `GET /v1/closure-impact`, which creates nothing; a change to the area or times after the preview
  asks for a new preview before "Create pending closure". The impact lists affected events with
  their commitments and owning records, and the customers (names on request through
  `GET /v1/person-names`), financial obligations and unsent messages; an adjustment for the
  obligations is pending (POL-041, DEC-009). Applying needs an explicit choice for affected events
  (no preselected default); an affected set that changed since the preview is reported. A pending
  closure is withdrawn with a reason and its revision; one held by a maintenance restriction
  (`source: maintenance`, or RESOURCE_CONFLICT `OWNED_BY_RESTRICTION`) links to its restriction
  instead. The resolution (relocate, reschedule, cancel) becomes one schedule draft.
- **Restrictions (SPK-FAC-003, SPK-FAC-004, SPK-AT-021).** The affected area is chosen from the
  inventory; release requires a reason and is refused by the API without a passed inspection when
  one is required; the screen explains the gate. A proposed restriction, or an approved one whose
  closure is still pending, is withdrawn with a reason (with its closure, in one command). An
  approved restriction whose closure is already applied (a stalled activation) offers no
  withdrawal and says to resume activation, then release it. A withdrawal the API refuses with
  INVALID_TRANSITION reads "Already in effect: release it instead" for a proposed restriction and
  "Already in effect: resume activation, then release it" for an approved one. An open closure
  resolution reads "Recovery required" and links to the closure.
- **Task owners (SPK-FAC-002).** An owner is chosen from the staff directory of the task's facility
  (`GET /v1/staff-directory`, names and roles only, cursor pages and a name-prefix search) or with
  "Assign to me". A new search clears the choice, so "Assign to the chosen staff member" sends only
  the person shown as chosen. Owners are named from the same staff directory, which the facilities
  operator may read (identity.read_person, behind `GET /v1/person-names`, is not theirs); only an
  owner the loaded directory does not list is read through `GET /v1/person-names` (see API issue
  8). A name the API leaves out reads "assigned (name not available)"; a failed read reads "name
  could not be loaded", and on the task with its code and "Try again". Without the staff directory
  permission, only "Assign to me" is offered (no assign command for a choice not offered). Tasks
  load in cursor pages with "Load more tasks".
- **Authorization.** Commands are offered from the role view of `GET /v1/me/permissions` at the
  record's facility (`features/schedule-facilities/permission.tsx`): an action the roles do not
  include reads "Not available to you" and names the permission; records stay readable, and the
  per-row commands go with the form (asset Edit and Retire with facilities.manage_asset;
  preventive generate, pause, resume and end with facilities.schedule_preventive_maintenance). While the
  permission read is unknown or failed nothing is hidden, and the command's own ACCESS_DENIED still
  decides. NOT_FOUND reads "not available" without implying the record exists; CAPABILITY_DISABLED
  reads as turned off.
- **No drag.** Events are moved with date and time fields, so keyboard and pointer users have the
  same path (SPK-UX-009).

## Pending decisions shown on these screens

| Decision                             | Where                                                                 | Owner                                               |
| ------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| DEC-001 actual inventory and hours   | SCR-S-07 (inventory, facility details); restriction approval SCR-S-42 | Operations                                          |
| DEC-001, DEC-003 staffing rules      | SCR-S-07 staffing constraints (shown, not validated)                  | Operations; Program manager                         |
| DEC-050 participant conflicts        | SCR-S-04 validation                                                   | Operations (scheduling acceptance); Program manager |
| DEC-012, DEC-062 notice policy       | SCR-S-05                                                              | Operator/privacy owner                              |
| POL-041, DEC-009 closure resolution  | SCR-S-06 (resolution and financial adjustment)                        | Operations; Finance                                 |
| DEC-076, DEC-077 rentals and parties | SCR-S-51, SCR-S-52                                                    | Product owner                                       |

Due lead times per severity and the preventive lead time are left to the API's configured
defaults (proposed, pending operations decisions); the screens never state their values.

## API issues found (not fixed here)

1. Series edits (`POST /event-series/{id}/edits`) commit outside drafts and drafts have no
   series-scoped change; the editor converts a previewed series edit into per-event changes, so
   the series definition itself is not updated on publication (stage 3 kept this open,
   SPK-SCHED-007).
2. No explicit draft rebase command: a target is rebased by one save without it and one with it
   (two revisions, two audit records); the API calls an explicit rebase a pending design choice.
3. `GET /v1/sessions` (`FacilitySession`) does not carry the session's scheduling event id, so the
   calendar cannot say which listed session holds a reservation on which space.
4. No per-record `availableActions` on drafts, closures, tasks or restrictions and no draft
   ownership rule ("draft owned by another author: read-only" cannot be shown); the role view of
   `GET /v1/me/permissions` decides what is offered (stage 3: the permission read gives the role
   view).
5. Free-form `staffingConstraints` on resources are stored but not validated or defined (DEC-001,
   DEC-003); the inventory shows them read-only and does not offer editing them.
6. `ReportMaintenanceTaskBody` takes no owner, so an owner is chosen after reporting.
7. `GET /v1/closures` (stage 3 kept it unpaged) and `GET /v1/maintenance-restrictions` are
   bounded arrays without cursors.
8. `MaintenanceTask` carries only `assignedOwnerPersonId`, and `GET /v1/staff-directory` has no
   lookup by person id. Owners are named from the loaded directory pages of the facility; an owner
   it does not list (a former staff member, or one on a page not loaded) is named only where
   `GET /v1/person-names` allows, which for a facilities operator is nobody else.

Closed since the previous version: the API no longer re-captures base revisions on autosave; the
facility directory exists (`GET /v1/facilities`); the closure impact lists customers, obligations
and messages and can be previewed without a record; pending closures and proposed restrictions
can be withdrawn; the staff directory exists; `overdue` and `includeRetired` are string flags; the
OpenAPI document no longer declares nullable components or `allOf` nullable references.
