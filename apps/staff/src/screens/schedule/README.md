# Schedule and facilities screens

Staff dashboard screens SCR-S-03 to SCR-S-07 (Schedule area, `/schedule`) and SCR-S-41, SCR-S-42
(Facilities and maintenance area, `/facilities`), from
`docs/package-a/screen-and-journey-inventory.md` section 5. Shared pieces are in
`src/features/schedule-facilities/`; facilities screens are in `src/screens/facilities/`.

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test here (not staff
acceptance on real workstations, §6.3). **Proposed** = engineering choice awaiting operator
approval. **Pending decision** = needs an operator answer; the screen shows the pending state.

## Screens

| Screen                                         | Route                                                          | API                                                                                                                        | Status                | Evidence                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| SCR-S-03 Calendar and resource view            | `/schedule/calendar`                                           | `GET /resources`, `/events`, `/closures`                                                                                   | **Verified** in jsdom | `__tests__/ScheduleCalendarScreen.test.tsx`                                                  |
| SCR-S-04 Drafts list and draft editor          | `/schedule/drafts`, `/schedule/drafts/:id`                     | `GET/POST /schedule-drafts`, `PATCH /schedule-drafts/{id}`, `POST .../validate`, `.../discard`, `/event-series/{id}/edits` | **Verified** in jsdom | `__tests__/ScheduleDraftEditorScreen.test.tsx`, `__tests__/PublicationReviewScreen.test.tsx` |
| SCR-S-05 Publication review                    | `/schedule/drafts/:id/publish`                                 | `POST /schedule-drafts/{id}/publish`, `GET /operations/{id}`                                                               | **Verified** in jsdom | `__tests__/PublicationReviewScreen.test.tsx`                                                 |
| SCR-S-06 Closure impact and resolution         | `/schedule/closures`, `/schedule/closures/:id`                 | `GET/POST /closures`, `POST /closures/{id}/apply`, `.../lift`, `POST /schedule-drafts`                                     | **Verified** in jsdom | `__tests__/ClosureDetailScreen.test.tsx`                                                     |
| SCR-S-07 Resource inventory and configurations | `/schedule/resources`                                          | `/resources`, `/resource-configurations`, `/conflict-units`, `/operating-hours`                                            | **Verified** in jsdom | `__tests__/ResourceInventoryScreen.test.tsx`                                                 |
| SCR-S-41 Assets and maintenance tasks          | `/facilities/maintenance`, `/facilities/maintenance/tasks/:id` | `/assets`, `/maintenance-tasks`, `.../inspections`, `/preventive-schedules`                                                | **Verified** in jsdom | `../facilities/__tests__/MaintenanceScreen.test.tsx`, `MaintenanceTaskScreen.test.tsx`       |
| SCR-S-42 Operating restrictions and release    | `/facilities/restrictions`, `/facilities/restrictions/:id`     | `/maintenance-restrictions`, `.../approve`, `.../release`, `/facilities/{id}/operating-status`                             | **Verified** in jsdom | `../facilities/__tests__/RestrictionsScreen.test.tsx`                                        |
| SCR-S-51 Rentals, SCR-S-52 Parties             | `/schedule/rentals`, `/schedule/parties`                       | none                                                                                                                       | **Pending decision**  | DEC-076, DEC-077, DEC-016, DEC-047 (Product owner); shown as pending, not built              |

## Behaviour

- **Facility local time (SPK-SCHED-008).** Instants are shown and entered in the facility's IANA
  zone, which comes from `GET /v1/today` (the API has no facility read endpoint). A local time
  that happens twice asks which occurrence; one that does not exist is refused with the time after
  the change offered (`features/schedule-facilities/time.ts`, `LocalDateTimeField.tsx`, tested in
  `features/schedule-facilities/__tests__/time.test.ts`). When the zone is not readable the
  screens say so and show UTC.
- **Shared space (SPK-SCHED-002, SPK-SCHED-003).** Two spaces conflict when they share a conflict
  unit, as the API derives it; the calendar shows what blocks a space through shared space and the
  occupied interval with setup and cleanup buffers. The bars are decorative; each space's list
  carries the same information as text.
- **Drafts (SPK-SCHED-005).** Every edit autosaves the whole change list with the draft's
  `expectedRevision`, one save at a time; a retry reuses its idempotency key. Offline, edits stay
  on the page and save on reconnect. STALE_REVISION keeps the edits and offers "load latest" or
  "save my edits on the latest version". A changed target event is flagged "rebase required" and
  autosave pauses until the user rebases (see API issue 1).
- **Series edits (SPK-SCHED-007).** A wider scope is previewed (`preview: true`, nothing is
  committed) and the exact listed events are added to the draft as individual changes, so nothing
  is published or announced before the draft (see API issue 2).
- **Publication (SPK-SCHED-006, SPK-FIX-002).** The group publishes whole or not at all;
  STALE_REVISION, RESOURCE_CONFLICT and unmet fixture obligations read "Nothing was published".
  Remaining obligations of a successful publication are listed with owner and deadline. The
  operation is read back; `recovery_required` reads "Needs attention".
- **Closures (SPK-SCHED-009, SPK-AT-009).** Applying needs an explicit choice for affected
  events (no preselected default); an affected set that changed since the preview is reported.
  The resolution (relocate, reschedule, cancel) becomes one schedule draft.
- **Restrictions (SPK-FAC-003, SPK-FAC-004, SPK-AT-021).** The affected area is chosen from the
  inventory; release requires a reason and is refused by the API without a passed inspection when
  one is required; the screen explains the gate. An open closure resolution reads "Recovery
  required" and links to the closure.
- **Authorization.** Actions follow the record's state; whether the viewer may do them is the
  API's answer. ACCESS_DENIED reads "Not available to you" and names the missing permission;
  NOT_FOUND reads "not available" without implying the record exists.
- **No drag.** Events are moved with date and time fields, so keyboard and pointer users have the
  same path (SPK-UX-009).

## Pending decisions shown on these screens

| Decision                             | Where                                      | Owner                                               |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------- |
| DEC-001 actual inventory and hours   | SCR-S-07; restriction approval on SCR-S-42 | Operations                                          |
| DEC-050 participant conflicts        | SCR-S-04 validation                        | Operations (scheduling acceptance); Program manager |
| DEC-012, DEC-062 notice policy       | SCR-S-05                                   | Operator/privacy owner                              |
| POL-041, DEC-009 closure resolution  | SCR-S-06                                   | Operations; Finance                                 |
| DEC-076, DEC-077 rentals and parties | SCR-S-51, SCR-S-52                         | Product owner                                       |

Due lead times per severity and the preventive lead time are left to the API's configured
defaults (proposed, pending operations decisions); the screens never state their values.

## API issues found (not fixed here)

1. `PATCH /schedule-drafts/{id}` re-captures every change's base event revision on each save, so
   a save after an event changed silently rebases the draft and publication cannot detect the
   stale base (SPK-SCHED-005). The editor pauses autosave when it can see the change.
2. Series edits (`POST /event-series/{id}/edits`) commit outside drafts and drafts have no
   series-scoped change; the editor converts a previewed series edit into per-event changes, so
   the series definition itself is not updated on publication.
3. No facility read endpoint (name, IANA zone); names and zones come from `GET /today`.
4. No `availableActions` on drafts, closures, tasks or restrictions, and no draft ownership rule
   ("draft owned by another author: read-only" cannot be shown).
5. Closure impact does not list customers, financial obligations or messages (SPK-SCHED-009); the
   screen says so. There is no endpoint to withdraw a pending closure or a proposed restriction.
6. No staff directory, so a task can only be assigned to the viewer ("Assign to me").
7. `overdue` and `includeRetired` use `z.coerce.boolean()`: `?overdue=false` filters as true. The
   screens only ever send `true`.
8. OpenAPI: 38 components are declared nullable at the component level (`Inspection`,
   `ClosureImpact`, `ValidationResult`, `TaskResolution`, ...), and 27 nullable `$ref` fields are
   `allOf: [$ref, {type: [object, null]}]` (for example `Restriction.approvedBy`), which the
   generated client types as `T & (Record<string, never> | null)`.
