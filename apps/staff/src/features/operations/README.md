# Staff operations screens

Arrival and attendance (SCR-S-28 to SCR-S-31), staff and officials (SCR-S-32 to SCR-S-34),
communications (SCR-S-39, SCR-S-40) and the coach and referee workspace (SCR-W-01 to SCR-W-10,
inventory section 6) of `docs/package-a/screen-and-journey-inventory.md`.

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test here (with a fake
API; not staff acceptance on real devices, §6.3). **Proposed** = engineering handling awaiting
operator approval. **Pending decision** = the screen shows the pending state; owners are in
`docs/package-a/decision-register.md`.

## Screens

| Id       | Route                                                                                 | API                                                                                                                                                                                                                                                                                                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tests                                                                |
| -------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SCR-S-28 | `/arrival`                                                                            | `POST /passes/scan`, `POST /visits`, `POST /session-checkins`, `…/recheck`, `GET /facilities/{id}/occupancy`; lookup: `GET /people`, `GET /sessions`                                                                                                                                                                                                                    | **Verified** (SPK-AT-015, SPK-ENTRY-001/003/004/006, SPK-IAM-002): a person without a pass is found by the staff person search (as the role allows) and their arrival and check-in are recorded as separate, chosen commands; a held check-in is checked again in place                                                                                                                                                                              | `screens/arrival/__tests__/ArrivalScannerScreen.test.tsx`            |
| SCR-S-29 | `/arrival/attendance?type=…`                                                          | `GET /attendance` (names, ENT-01), `GET /enrollments`, `GET /session-bookings`, `GET /person-names`, `POST /attendance-observations`, `…/corrections`, `GET /sessions`, `GET /events`                                                                                                                                                                                   | **Verified** (SPK-ENTRY-005, SPK-ENTRY-008, conflicts kept); today's program sessions and events are listed to choose from in the facility time zone (SPK-SCHED-008)                                                                                                                                                                                                                                                                                 | `SessionAttendanceScreen.test.tsx`                                   |
| SCR-S-30 | `/arrival/release`                                                                    | `GET /sessions`, `GET /attendance`, `POST /releases/collector-checks`, `POST /releases`; on site without a session: `GET /visits`, `POST /passes/scan`                                                                                                                                                                                                                  | **Verified** (SPK-AT-016, SPK-ENTRY-007): from a session the collector is checked first (read-only, names nobody without authority) and the record names the grant relied on; records stay listed after the departure closes the visit; all times in the facility zone; procedure DEC-005, outage DEC-034, applicability DEC-075 **pending decision**                                                                                                | `SupervisedReleaseScreen.test.tsx`                                   |
| SCR-S-31 | `/arrival/offline` (also `/workspace/offline`)                                        | `POST /offline-sync`, `GET /offline-sync/{id}`                                                                                                                                                                                                                                                                                                                          | **Verified** (SPK-AT-018, ENT-01): synchronised batches read again with per-item outcomes, by this device's batch ids or a batch reference; device approval and a server-issued roster DEC-023, DEC-032, DEC-033 **pending decision**                                                                                                                                                                                                                | `OfflineQueueScreen.test.tsx`                                        |
| SCR-S-32 | `/staff/availability`                                                                 | `GET /staff-directory`, `GET/POST /qualifications`, `…/verify`, `…/reject`, `…/revoke`, `GET/POST /availability`, `…/withdraw`, `GET /facilities/{id}`                                                                                                                                                                                                                  | **Verified** (SPK-STAFF-001, ID-05): officials and coaches with their role scopes from the staff directory (one read per role, never filtered on the client); windows and validity shown in the facility zone they are entered in; required qualifications DEC-011 **pending decision**                                                                                                                                                              | `screens/staff/__tests__/AvailabilityQualificationsScreen.test.tsx`  |
| SCR-S-33 | `/staff`, `/staff/assignments/:assignmentId`                                          | `GET /reports/uncovered-assignments`, `GET/POST /assignments` (`availableActions`, WRK-01), `GET /staff-directory`, `GET /sessions`, `GET /events`, `GET /facilities/{id}`, `…/offer`, `…/withdraw`, `…/complete`, `GET/POST …/replacements`, `GET /assignment-requirements`                                                                                            | **Verified** (SPK-STAFF-002/003, SPK-AT-012): the person is chosen from the staff directory (officials or coaches by kind; the chosen person stays shown, Enter never submits); the target is the uncovered slot or a session, event or fixture chosen from the facility's lists (a record id only as a fallback); transitions only where the API lists them; times in the facility zone; offline read-only (every command disabled, nothing queued) | `AssignmentsScreen.test.tsx`                                         |
| SCR-S-34 | `/staff/fees`                                                                         | `GET /fee-submissions`, `…/approve`, `…/adjust`, `…/reject`, `POST /fee-export-batches`, `GET /assignments/{id}`                                                                                                                                                                                                                                                        | **Verified** (SPK-STAFF-006, §1.7); rates DEC-011, payroll boundary DEC-052, export target DEC-022 **pending decision**                                                                                                                                                                                                                                                                                                                              | `FeeApprovalsScreen.test.tsx`                                        |
| SCR-S-39 | `/communications/compose`, `/communications/notifications/:notificationId` (composed) | `POST /notifications`, `GET …/recipients`, `POST …/send`, `GET /people`, `GET /person-names`                                                                                                                                                                                                                                                                            | **Verified** (SPK-COMMS-003/006/007): participants and named people are added by the person search, shown by name; channels per kind DEC-012, DEC-062 **pending decision**                                                                                                                                                                                                                                                                           | `screens/communications/__tests__/Communications.test.tsx`           |
| SCR-S-40 | `/communications`, `/communications/notifications/:notificationId`                    | `GET /notifications`, `GET /notifications/{id}`, `GET …/deliveries` (recipient names), `POST /delivery-attempts/{id}/retry`, `GET /facilities/{id}`                                                                                                                                                                                                                     | **Verified** (SPK-COMMS-004, SPK-UX-006, COM-02): one failed delivery retried with a reason, offered only with the retry permission; times in the notice's facility zone; unknown-outcome escalation age DEC-041 **pending decision**                                                                                                                                                                                                                | same                                                                 |
| SCR-W-01 | `/workspace`                                                                          | `GET /me/assignments` (facility zone, WRK-01), `POST /assignments/{id}/accept`                                                                                                                                                                                                                                                                                          | **Verified**: offline the cached list with its age, "Accept" disabled and nothing queued; a lost answer reads as an unknown outcome                                                                                                                                                                                                                                                                                                                  | `screens/workspace/__tests__/WorkspaceScreen.test.tsx`               |
| SCR-W-02 | `/workspace/assignments/:assignmentId`                                                | `POST …/accept`, `…/decline`, `…/withdraw` (only where `availableActions` lists them)                                                                                                                                                                                                                                                                                   | **Verified**; respond-by deadline not shown (offer deadlines DEC-011, not built by the API)                                                                                                                                                                                                                                                                                                                                                          | `AssignmentWorkspaceScreen.test.tsx`                                 |
| SCR-W-03 | same                                                                                  | `GET /fixtures/{id}/readiness`, `GET /fixtures/{id}/match-sheet` (accepted officials), `GET /me/inbox`                                                                                                                                                                                                                                                                  | **Verified** (CMP-06): the field-limited player list for an accepted official                                                                                                                                                                                                                                                                                                                                                                        | same                                                                 |
| SCR-W-04 | `…/attendance`                                                                        | as SCR-S-29                                                                                                                                                                                                                                                                                                                                                             | **Verified**: children named by the attendance read (ENT-01)                                                                                                                                                                                                                                                                                                                                                                                         | `WorkspaceActivityScreens.test.tsx`                                  |
| SCR-W-05 | `…/report`                                                                            | `GET/POST /fixtures/{id}/results`, `GET /fixtures/{id}/match-sheet`                                                                                                                                                                                                                                                                                                     | **Verified** (SPK-STAFF-005, SPK-DISC-001): cards against match-sheet players (loading, error with its code and Try again, or not available when refused); publication DEC-065 and queued submission DEC-032 **pending decision**                                                                                                                                                                                                                    | same                                                                 |
| SCR-W-06 | `…/message`                                                                           | none                                                                                                                                                                                                                                                                                                                                                                    | Not available: the API offers no workspace message action; DEC-012, DEC-062 **pending decision**                                                                                                                                                                                                                                                                                                                                                     | same                                                                 |
| SCR-W-07 | `/workspace/assessments`                                                              | `GET /me/assignments`, `GET /attendance`, `GET /offerings`, `GET /programs`, `GET /programs/{id}`, `GET /people`, `GET /participants/{personId}/assessments`, `POST /assessments`, `PATCH /assessments/{id}`, `…/submit`, `…/withdraw`, `…/review`, `POST /progression-recommendations`, `…/share`, `…/withdraw`, `POST /assessment-templates`, `…/approve`, `…/retire` | **Verified** behind the `youth_progression` switch (DEC-016, off by default); programs chosen by name; templates and family visibility DEC-054, recommendation inputs DEC-055 **pending decision**                                                                                                                                                                                                                                                   | `screens/workspace/assessments/__tests__/AssessmentsScreen.test.tsx` |
| SCR-W-08 | `/workspace/fees`                                                                     | `GET /me/assignments`, `POST /fee-submissions`                                                                                                                                                                                                                                                                                                                          | **Verified** (SPK-STAFF-006, never "Paid")                                                                                                                                                                                                                                                                                                                                                                                                           | `WorkspaceActivityScreens.test.tsx`                                  |
| SCR-W-09 | `…/release`                                                                           | `GET /attendance`, `POST /releases/collector-checks`, `POST /releases`                                                                                                                                                                                                                                                                                                  | **Verified** (SPK-AT-016, ENT-02): the coach checks the collector by pass before recording; procedure DEC-005, DEC-034, DEC-075 **pending decision**                                                                                                                                                                                                                                                                                                 | same                                                                 |
| SCR-W-10 | queue status on every workspace and arrival screen                                    | `POST /offline-sync`                                                                                                                                                                                                                                                                                                                                                    | **Verified**                                                                                                                                                                                                                                                                                                                                                                                                                                         | `AssignmentWorkspaceScreen.test.tsx`                                 |

Phone width (SPK-UX-007) is CSS (`operations.css`, one column below 768 px, 44 px targets); it needs
the actual devices of §6.3.

## SCR-W-07 Assessments (Package G, youth_progression)

- **Who.** A coach picks one of their accepted coach sessions and a participant from its
  attendance; a program manager may also pick an offering of the facility and find the child by
  name. Children are named only; ids never enter a route.
- **Assessments.** `GET /v1/participants/{personId}/assessments` lists what the viewer may read
  (paged). The API answers a coach NOT_FOUND until an assessment they may read exists (reported as
  an API issue); for a participant taken from the coach's own accepted session the page says
  nothing is visible yet and still offers recording (**Proposed**), without implying a record
  exists. Authors whose names the viewer may not read are "Staff member", never "Participant". Recording uses an approved template: skill area, observation date, scale value,
  visibility (chosen, nothing preselected), feedback comments and a separate private coaching note
  (never shown to a family). Edit and submit are the author's, withdraw the author's or a program
  manager's (reason; never gated), review a program manager's other than the author (a return says
  why); a published or recorded assessment is corrected by a new one naming it, with a required reason (§4.9), the corrected assessment's skill area and visibility (locked, also when the correction's draft is edited) and only templates of its program offered (CORRECTION_MISMATCH otherwise, §4.7 invariant 9); the reason is shown on the correction. Every command sends
  `expectedRevision` where the API takes it and its own idempotency key.
- **Offered from permissions.** Assessments carry no per-record actions, so commands are offered
  from the assessment state, the author and `GET /v1/me/permissions` (role view); the API decides
  and its refusal (NOT_AUTHOR, REVIEWER_IS_AUTHOR, NOT_OFFERING_STAFF, TEMPLATE_MISMATCH) is shown
  with its code.
- **Switch.** While `youth_progression` is off the page says "turned off" (DEC-016) and offers no
  authoring, review, sharing or template approval; existing assessments stay readable and drafts
  can be withdrawn. A command refused with CAPABILITY_DISABLED shows the same state.
- **Recommendations.** An offering (from the facility's published offerings) or a program, with
  the suitability in words; the API's eligibility evaluation is shown with unknown kept unknown; a
  recommendation reserves nothing. Programs are chosen by name from `GET /v1/programs`. Shared
  and withdrawn (with a reason) with `expectedRevision`.
- **Templates (program managers).** Drafted with program (chosen by name, the offering's program
  by default), name, version, skill areas (key and label) and an ordinal scale; approved and
  retired (with a reason) with `expectedRevision`.
- **Proposed handling of API gaps.** Templates and recommendations cannot be listed or read, so
  those made on the page are the ones shown and offered; otherwise a template is given by reference
  with the skill area key and scale value, and the API checks them. A STALE_REVISION answer on
  them cannot be reloaded here: it is shown with its code and a note.

## Offline queue (§4.15, SPK-AT-018) — Proposed

- `offline/queue.ts` keeps one queue per browser profile in `localStorage`
  (`sportspark.staff.offline-queue.v1`) holding identifiers, states and times only, never names or
  other personal details. Each item has the §4.15 fields: client observation id, actor (the account
  that queued it), event, observed time and roster snapshot (reference and time); the API stamps
  the received time.
- Arrivals (scanner) and first attendance observations (attendance panels) can be queued offline.
  Check-in, corrections, release, payments, capacity, guardian changes, roster transfers and
  recording for a person found by search cannot.
- Nothing else is queued, not even implicitly: every command (a TanStack mutation) runs when it is
  submitted (`MUTATION_DEFAULTS` in `providers/AppProviders.tsx`: `networkMode: 'always'`, no
  retry), so a command is never paused offline and sent by itself on reconnection. Assignment,
  acceptance, fee and qualification commands (SCR-S-32 to SCR-S-34, SCR-W-01) and message sends
  (SCR-S-40) are disabled offline with "Needs a connection" (`ui/CommandButton`), and their
  failures without a definite answer read as an unknown outcome (`feedback.tsx` `CommandError`).
  **Verified** in jsdom (`api/__tests__/commands.test.tsx`, `WorkspaceScreen.test.tsx`,
  `AssignmentsScreen.test.tsx`, `FeeApprovalsScreen.test.tsx`).
- Synchronisation (`POST /offline-sync`) runs once when the connection returns and on request.
  Items are assigned to a client batch id before upload and keep it across retries, so a lost
  response never applies an item twice; the idempotency key is reused while the tab is open and
  the outcome is unknown. Every prepared batch is sent in the run, a full one (500 items, the
  API's limit) included. Conflicting and rejected items are kept for review with the API's reason.
- A batch the API refuses outright (a definitive 4xx such as VALIDATION_FAILED
  `snapshot_in_future` or ACCESS_DENIED after a role ended: nothing in it was recorded) ends its
  intent and its items move to "Kept for review" as "Not recorded" with the API's code and message;
  "Queue again" sends them under a new client batch id (a new key) and "Discard (not recorded)"
  removes them. The run goes on with the other batches. Only an unknown outcome (no answer, a 5xx,
  the same key still running) stops the run and keeps the batch and its key; a signed-out session
  or a turned-off capability keeps the items queued. **Verified** in jsdom
  (`offline/__tests__/queue.test.ts`, `screens/arrival/__tests__/OfflineQueueScreen.test.tsx`).
- IDEMPOTENCY_OUTCOME_UNAVAILABLE for a batch (it committed under its key, the answer was lost) is
  answered the same way for that key for ever, so the batch is sent once more at once under a new
  key with the same client batch id and items; the API finds the stored batch by device and client
  batch id before running anything and answers its per-item outcome (`batchSender`). The run goes
  on and later batches are sent. **Verified** (`queue.test.ts`).
- "Queue again" sends a refused item with the times it was queued with (snapshot and observed
  times are never rewritten on the device). For `snapshot_in_future` the review says so: correcting
  the clock does not fix them; queue it again only after the stored roster time by the service's
  clock, or discard it and record the observation again online. **Verified**
  (`OfflineQueueScreen.test.tsx`).
- Tabs of one browser profile share the queue: every change is applied to the queue as last
  stored, never to a stale copy of the tab, the other tabs follow it through the `storage` event,
  and where the browser has Web Locks one tab at a time synchronises. **Verified** for two stores
  over one storage (`queue.test.ts`); the Web Locks path is not exercised in jsdom.
- The API's id and counts of the last 20 synchronised batches are kept (ids and numbers only); the
  stored per-item outcome is read again with `GET /offline-sync/{id}` (ENT-01). Desk readers may
  open any batch by its full reference (validated before the request); a refused one reads "not
  available".
- Items queued by another account wait for that account, so the recorded actor is the observer.
- `VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES` (StaffConfig `offlineRosterMaxAgeMs`) sets the maximum roster
  age for queuing; unset means not configured (DEC-033 **pending decision**, §4.15 proposes two
  hours) and the API flags stale snapshots for review.
- Device approval and an encrypted, scoped roster download are not implemented by the API
  (DEC-023, DEC-032 **pending decision**): the snapshot reference is the device's own label of the
  read it queued against; the device id is generated per browser.
- Queued times are on one clock (`offline/clock.ts`). The API compares a batch's snapshot time and
  every observed time with its own clock (clock-skew tolerance 5 minutes: `snapshot_in_future`,
  `observed_in_future`, `observed_before_snapshot`). The offset between the service's time of the
  roster read (the attendance response's `Date` header; a scan's `scannedAt`) and the device's
  receipt time dates the snapshot and every observation queued against it, so a device clock that
  runs slow or fast by more than the tolerance moves neither. **Verified** for an attendance roster
  with the device 10 minutes slow and 10 minutes fast, sent through a fake that applies the API's
  checks (`SessionAttendanceScreen.test.tsx`), and for a scan (`ArrivalScannerScreen.test.tsx`).
  The roster's age is measured on the device clock it was received by.
- Without a readable `Date` header the offset is zero and the snapshot and observations stay on the
  device clock together (as before this correction). A cross-origin deployment can read the header
  only once the API lists `Date` in Access-Control-Expose-Headers, which `CORS_EXPOSED_HEADERS`
  (apps/api kernel app-setup.ts) does not do today; the development server proxies `/v1`, so the
  header is readable there. Recorded as a follow-up for the API kernel; the origin model is DEC-021
  (**pending decision**).

## API gaps rendered as not available — Proposed handling

- Assessment templates and progression recommendations have no read or list; submitted
  assessments awaiting review are found per participant (no review queue). A coach's first read of
  a participant's assessments answers NOT_FOUND rather than an empty page.
- `GET /assignments/{id}` carries no `availableActions`: the detail screen reads them from the staff
  list for the assignment's target.
- The collector check needs a session: a child on site without one is released with the collector
  identified by the desk pass scan, authority checked at release.
- No list of every device's offline batches; no workspace messaging command; no respond-by deadline
  on an offer; team entries in a message audience are named by record id.

## Conventions

- `context.ts`: `useOperatingFacility` (the selected facility, or the only one in scope; name,
  zone and scope from the facility directory `GET /facilities` with `inStaffScope`, or
  `GET /facilities/{id}` for a facility the listing leaves out; the facility-local date and day
  window derived from that zone and the injected clock; never the Today feed, which only the Today
  screen reads, §4.5), `useFacilityZone` (the zone of the facility a record names, same reads and
  cache; null means the device zone, labelled) and `usePersonNames` / `nameOf`
  (`GET /person-names`, names and kind only, one read per set of up to 100 ids; a person left out
  is "<noun>, name not available" with a short reference).
- `StaffPicker.tsx`: the staff directory picker (`GET /staff-directory`, role and facility filters,
  name prefix, "Load more staff"); a chosen person stays in the options ("chosen") when a search
  leaves them out, and Enter in the name search never submits the enclosing form; not available
  without the directory permission.
- `PersonSearch.tsx`: the staff person search (`GET /people`, at least two characters, on request,
  inside or outside a form); not available when the role may not search.
- `sessions.ts`: today's sessions at a facility (`GET /sessions`, the facility-local day).
- `commands.ts` `useKeyedCommands`: one intent (idempotency key) per record on a screen with
  several commands; outcomes kept per record for partial completion. The key is kept after an
  unknown outcome, after IDEMPOTENCY_OUTCOME_UNAVAILABLE and after a failure that is not the
  client's typed error.
- `feedback.tsx` `CommandError`: ACCESS_DENIED as "Not available" with the API's message,
  NOT_FOUND without implying existence, any answer that may have taken effect (a timeout, a
  connection lost after sending, IDEMPOTENCY_IN_PROGRESS, a 5xx, a 2xx whose answer could not be
  read) as "Outcome not known yet" with a same-key retry, a guard's refusal before running
  (restore recovery, assistant off) with the API's message and "Nothing was changed",
  IDEMPOTENCY_OUTCOME_UNAVAILABLE as "This may already have been done", a legacy-authority refusal
  as "Make this change in the system of record" (`ui/CommandOutcome.tsx`), CAPABILITY_DISABLED as
  "turned off".
- Request bodies send defaulted fields explicitly (for example `recordDeparture: true`): the
  generated client types mark fields with an OpenAPI default as required.
- Tests: `testing.ts` has `nameEntry` / `personNames` for `GET /person-names`; await the read a
  step depends on (`findBy…`, `waitFor`), never a single `act()` flush.
