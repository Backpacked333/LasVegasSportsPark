# Staff operations screens

Arrival and attendance (SCR-S-28 to SCR-S-31), staff and officials (SCR-S-32 to SCR-S-34),
communications (SCR-S-39, SCR-S-40) and the coach and referee workspace (SCR-W-01 to SCR-W-10,
inventory section 6) of `docs/package-a/screen-and-journey-inventory.md`.

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test here (with a fake
API; not staff acceptance on real devices, §6.3). **Proposed** = engineering handling awaiting
operator approval. **Pending decision** = the screen shows the pending state; owners are in
`docs/package-a/decision-register.md`.

## Screens

| Id       | Route                                                                                 | API                                                                                                                                                             | Status                                                                                                                                                     | Tests                                                               |
| -------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| SCR-S-28 | `/arrival`                                                                            | `POST /passes/scan`, `POST /visits`, `POST /session-checkins`, `…/recheck`, `GET /facilities/{id}/occupancy`                                                    | **Verified** (SPK-AT-015, SPK-ENTRY-003/004); person lookup without a pass not available (no API)                                                          | `screens/arrival/__tests__/ArrivalScannerScreen.test.tsx`           |
| SCR-S-29 | `/arrival/attendance?type=…`                                                          | `GET /attendance`, `GET /enrollments`, `GET /session-bookings`, `POST /attendance-observations`, `…/corrections`, `GET /events`                                 | **Verified** (SPK-ENTRY-005, SPK-ENTRY-008, conflicts kept)                                                                                                | `SessionAttendanceScreen.test.tsx`                                  |
| SCR-S-30 | `/arrival/release`                                                                    | `GET /visits`, `POST /passes/scan`, `POST /releases`                                                                                                            | **Verified** (SPK-AT-016, SPK-ENTRY-007); procedure DEC-005, outage DEC-034, applicability DEC-075 **pending decision**                                    | `SupervisedReleaseScreen.test.tsx`                                  |
| SCR-S-31 | `/arrival/offline` (also `/workspace/offline`)                                        | `POST /offline-sync`                                                                                                                                            | **Verified** (SPK-AT-018); device approval and encrypted roster DEC-032 **pending decision**                                                               | `OfflineQueueScreen.test.tsx`                                       |
| SCR-S-32 | `/staff/availability`                                                                 | `GET/POST /qualifications`, `…/verify`, `…/reject`, `…/revoke`, `GET/POST /availability`, `…/withdraw`                                                          | **Verified** (SPK-STAFF-001); required qualifications DEC-011 **pending decision**                                                                         | `screens/staff/__tests__/AvailabilityQualificationsScreen.test.tsx` |
| SCR-S-33 | `/staff`, `/staff/assignments/:assignmentId`                                          | `GET /reports/uncovered-assignments`, `GET/POST /assignments`, `…/offer`, `…/withdraw`, `…/complete`, `GET/POST …/replacements`, `GET /assignment-requirements` | **Verified** (SPK-STAFF-002/003, SPK-AT-012)                                                                                                               | `AssignmentsScreen.test.tsx`                                        |
| SCR-S-34 | `/staff/fees`                                                                         | `GET /fee-submissions`, `…/approve`, `…/adjust`, `…/reject`, `POST /fee-export-batches`, `GET /assignments/{id}`                                                | **Verified** (SPK-STAFF-006, §1.7); rates DEC-011, payroll boundary DEC-052, export target DEC-022 **pending decision**                                    | `FeeApprovalsScreen.test.tsx`                                       |
| SCR-S-39 | `/communications/compose`, `/communications/notifications/:notificationId` (composed) | `POST /notifications`, `GET …/recipients`, `POST …/send`                                                                                                        | **Verified** (SPK-COMMS-003/006/007); channels per kind DEC-012, DEC-062 **pending decision**                                                              | `screens/communications/__tests__/Communications.test.tsx`          |
| SCR-S-40 | `/communications`, `/communications/notifications/:notificationId`                    | `GET /notifications`, `GET /notifications/{id}`, `GET …/deliveries`                                                                                             | **Verified** (SPK-COMMS-004); unknown-outcome escalation age DEC-041 **pending decision**; retrying one delivery not available (no API)                    | same                                                                |
| SCR-W-01 | `/workspace`                                                                          | `GET /me/assignments`, `POST /assignments/{id}/accept`                                                                                                          | **Verified** (foundation, now linking to each assignment)                                                                                                  | `screens/workspace/__tests__/WorkspaceScreen.test.tsx`              |
| SCR-W-02 | `/workspace/assignments/:assignmentId`                                                | `POST …/accept`, `…/decline`, `…/withdraw` (only where `availableActions` lists them)                                                                           | **Verified**; respond-by deadline not shown (no field in the API)                                                                                          | `AssignmentWorkspaceScreen.test.tsx`                                |
| SCR-W-03 | same                                                                                  | `GET /fixtures/{id}/readiness`, `GET /me/inbox` (changes old and new)                                                                                           | **Verified**; player list not shown (no field-limited roster read for the workspace)                                                                       | same                                                                |
| SCR-W-04 | `…/attendance`                                                                        | as SCR-S-29                                                                                                                                                     | **Verified**                                                                                                                                               | `WorkspaceActivityScreens.test.tsx`                                 |
| SCR-W-05 | `…/report`                                                                            | `GET/POST /fixtures/{id}/results`                                                                                                                               | **Verified** (SPK-STAFF-005); cards not available (no player ids in the workspace); publication DEC-065 and queued submission DEC-032 **pending decision** | same                                                                |
| SCR-W-06 | `…/message`                                                                           | none                                                                                                                                                            | Not available: the API offers no workspace message action; DEC-012, DEC-062 **pending decision**                                                           | same                                                                |
| SCR-W-07 | `/workspace/assessments`                                                              | none                                                                                                                                                            | **Pending decision** DEC-054 (Package G, no API)                                                                                                           | same                                                                |
| SCR-W-08 | `/workspace/fees`                                                                     | `GET /me/assignments`, `POST /fee-submissions`                                                                                                                  | **Verified** (SPK-STAFF-006, never "Paid")                                                                                                                 | same                                                                |
| SCR-W-09 | `…/release`                                                                           | `GET /attendance`, `POST /passes/scan`, `POST /releases`                                                                                                        | **Verified** (children from the session's attendance); identifying the collector depends on the desk-only pass scan (see gaps)                             | same                                                                |
| SCR-W-10 | queue status on every workspace and arrival screen                                    | `POST /offline-sync`                                                                                                                                            | **Verified**                                                                                                                                               | `AssignmentWorkspaceScreen.test.tsx`                                |

Phone width (SPK-UX-007) is CSS (`operations.css`, one column below 768 px, 44 px targets); it needs
the actual devices of §6.3.

## Offline queue (§4.15, SPK-AT-018) — Proposed

- `offline/queue.ts` keeps one queue per browser profile in `localStorage`
  (`sportspark.staff.offline-queue.v1`) holding identifiers, states and times only, never names or
  other personal details. Each item has the §4.15 fields: client observation id, actor (the account
  that queued it), event, observed time and roster snapshot (reference and time); the API stamps
  the received time.
- Arrivals (scanner) and first attendance observations (attendance panels) can be queued offline.
  Check-in, corrections, release, payments, capacity, guardian changes and roster transfers cannot.
- Synchronisation (`POST /offline-sync`) runs once when the connection returns and on request.
  Items are assigned to a client batch id before upload and keep it across retries, so a lost
  response never applies an item twice; the idempotency key is reused while the tab is open.
  Conflicting and rejected items are kept for review with the API's reason.
- Items queued by another account wait for that account, so the recorded actor is the observer.
- `VITE_OFFLINE_ROSTER_MAX_AGE_MINUTES` (StaffConfig `offlineRosterMaxAgeMs`) sets the maximum roster
  age for queuing; unset means not configured (DEC-033 **pending decision**, §4.15 proposes two
  hours) and the API flags stale snapshots for review.
- Device approval and an encrypted, scoped roster download are not implemented by the API
  (entry module known gaps, DEC-032 **pending decision**); the device id is generated per browser.

## API gaps rendered as not available — Proposed handling

- No person search: the scanner offers pass scanning only; forms take record ids.
- Program sessions are listed only per offering, and the expected-arrivals report omits the
  offering, so the attendance picker lists scheduling events; sessions open from links.
- `GET /people/{id}` is the only way to show a name and returns contact points the screens never
  render (§4.14 minimization).
- No list of offline synchronisation batches, no single-delivery retry, no respond-by deadline on
  an offer, no field-limited player list for officials, no workspace messaging command, no
  assessment endpoints.
- The pass scan is desk-only, so a coach (SCR-W-09) can identify a collector only by description,
  which the API cannot verify (denied or escalated).

## Conventions

- `commands.ts` `useKeyedCommands`: one intent (idempotency key) per record on a screen with
  several commands; outcomes kept per record for partial completion.
- `feedback.tsx` `CommandError`: ACCESS_DENIED as "Not available" with the API's message,
  NOT_FOUND without implying existence, timeouts as "outcome not known" with a same-key retry.
- `context.ts` `useOperatingFacility`: the selected facility, or the only one in scope.
- Request bodies send defaulted fields explicitly (for example `recordDeparture: true`): the
  generated client types mark fields with an OpenAPI default as required.
