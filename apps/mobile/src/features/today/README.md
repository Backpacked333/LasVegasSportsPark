# Today, schedule, pass, inbox, youth feedback and support (SCR-C-03 to SCR-C-06, SCR-C-18 to SCR-C-20, SCR-C-37, SCR-C-38, SCR-C-40)

Customer screens for the next activity and what needs doing (spec §2.2, SPK-UX-002 to
SPK-UX-004, SPK-UX-008), the facility pass (SPK-ENTRY-002), notices (SPK-COMMS-004/005), the
schedule and family calendar (SPK-SCHED-008, SPK-YOUTH-007), fixture and activity detail
(SPK-CAP-003, SPK-RESULT-001), youth feedback (SPK-YOUTH-005/006) and support (SPK-SUPPORT-001 to
003). Screen ids are from `docs/package-a/screen-and-journey-inventory.md` section 4; status
phrases from `docs/package-a/journeys.md` section 3.

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a fake
API shaped like `docs/api/openapi.json`. **Proposed** = engineering proposal awaiting operator
approval. **Pending decision** = waits on an operator answer (`docs/package-a/decision-register.md`).
No screen here has passed native acceptance on signed builds or devices (§6.2).

Shared code lives here: time display and zones (`time.ts`), status vocabulary (`status.ts`),
notice placement (`notices.ts`), calendar windows (`calendar.ts`), sessions and fixtures in one
list (`entries.ts`), the fixture card (`fixture-model.ts`), the session card (`session-activity.ts`),
the next-activity card (`NextActivityCard.tsx`), RSVP (`RsvpControl.tsx`) and the reads
(`queries.ts`). Test fixtures shaped like the API are in `__tests__/fixtures.ts`.

## Screens

| Screen                               | Route                                                             | API                                                                                                                                                                                                                  | Status                                                                                                                                        | Tests                                                                             |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| SCR-C-03 Home                        | `/` (tab)                                                         | `GET /me`, `/me/family-calendar`, `/me/fixtures`, `/me/team-entries`, `/me/inbox`, `/enrollments?status=pending`, `/operations/{id}`, `/baskets/{id}`, `/orders/{id}`, `/me/registration-checkouts`, `/person-names` | **Verified**                                                                                                                                  | `src/screens/home/__tests__/HomeScreen.test.tsx`                                  |
| SCR-C-04 Next-activity card          | on Home, Schedule, detail                                         | the above, plus `GET /offerings/{id}`, `/offerings/{id}/sessions`, `/facilities/{id}`, `POST /fixtures/{id}/availability`                                                                                            | **Verified**; arrival guidance **Pending decision** POL-046                                                                                   | `HomeScreen.test.tsx`, `__tests__/today-helpers.test.ts`                          |
| SCR-C-05 Facility pass               | `/pass`                                                           | `POST /passes`, `GET /me/passes`, `POST /passes/{id}/revoke`                                                                                                                                                         | **Verified**; scannable symbol **Pending decision** DEC-023                                                                                   | `src/screens/pass/__tests__/PassScreen.test.tsx`                                  |
| SCR-C-06 Notification inbox          | `/inbox`, `/inbox?open=<attemptId>`                               | `GET /me/inbox`, `POST /me/inbox/{id}/read`, `POST /me/inbox/{id}/acknowledge`, `GET /person-names`                                                                                                                  | **Verified**                                                                                                                                  | `src/screens/inbox/__tests__/InboxScreen.test.tsx`                                |
| SCR-C-18 Schedule                    | `/schedule` (tab)                                                 | `GET /me/family-calendar`, `/me/fixtures` (same windows), `/me/team-entries`, `/me/inbox`                                                                                                                            | **Verified**                                                                                                                                  | `src/screens/schedule/__tests__/ScheduleScreen.test.tsx`                          |
| SCR-C-19 Family calendar             | `/family-calendar`                                                | `GET /me/family-calendar`, `/me/fixtures`, `/me/team-entries`, `/offerings/{id}` (pickup label), `/me/permissions` (`pickup_sessions`)                                                                               | **Verified**; pickup arrangements **Pending decision** DEC-075, DEC-005                                                                       | `src/screens/family-calendar/__tests__/FamilyCalendarScreen.test.tsx`             |
| SCR-C-20 Fixture detail              | `/fixtures/[id]`                                                  | `GET /fixtures/{id}` (venue, roster status, responses), `/readiness`, `/results`, `/team-entries/{id}`, `POST /fixtures/{id}/availability`                                                                           | **Verified**; "Tentative" **Pending decision** DEC-064; RSVP for a child **Pending decision** DEC-090; arrival guidance POL-046               | `src/screens/activity/__tests__/FixtureDetailScreen.test.tsx`                     |
| SCR-C-20 Activity detail             | `/sessions/[sessionId]?enrollmentId=` or `?bookingId=`            | `GET /enrollments/{id}` or `/session-bookings/{id}`, `/offerings/{id}`, `/offerings/{id}/sessions`, `/facilities/{id}`                                                                                               | **Verified**; arrival guidance **Pending decision** POL-046                                                                                   | `src/screens/activity/__tests__/SessionDetailScreen.test.tsx`                     |
| SCR-C-37 Youth feedback              | `/youth-feedback`                                                 | `GET /me/youth-feedback`, `/person-names`, `/offerings/{id}`, `/me/permissions` (`youth_progression`)                                                                                                                | **Verified**; what is parent-visible and what a recommendation may use **Pending decision** DEC-054, DEC-055 (the API decides what it serves) | `src/screens/youth-feedback/__tests__/YouthFeedbackScreen.test.tsx`               |
| SCR-C-38 Support request and history | `/support` (`?aboutType=&aboutId=` optional), `/support/[caseId]` | `POST /me/support-requests`, `GET /me/cases` (paged), `GET /me/cases/{id}`, `GET /me`, `/me/team-entries`, `/enrollments?participantPersonId=`                                                                       | **Verified**; contact details and service levels **Pending decision** DEC-015 unless configured                                               | `src/screens/support/__tests__/SupportScreen.test.tsx`, `support-routes.test.tsx` |
| SCR-C-40 Connectivity banner         | every screen                                                      | the query cache; recovery found on refresh is pinned on Home                                                                                                                                                         | **Verified**; stale threshold **Pending decision** DEC-032, DEC-033 (unset: age shown, never called stale)                                    | `src/connectivity/__tests__/ConnectivityBanner.test.tsx`                          |

## Behaviour that is verified

- **Facility clock (SPK-SCHED-008).** Each time is shown on the clock of the facility the API names
  for that record: the newest schedule notice's zone, the calendar item's `timezone`, the
  fixture's `venue.timezone`, the enrollment's `offering.timezone`, then `GET /v1/facilities/{id}`.
  Only a record the API gives no zone for falls back to the device clock, and the screen says so
  ("The facility's time zone was not given for this."). Days are grouped on each record's own
  clock; the family calendar lays the week out on the facility clock when every activity shares
  one (`sharedZone`, `daysInWindow`), so nothing near midnight is hidden. "Where" names the
  facility and the pitches (`venue.facilityName`, `GET /facilities/{id}` name, notice resources).
- **Fixtures on Home, Schedule and the family calendar (CMP-02).** `GET /v1/me/fixtures` is read for
  the same windows as the calendar; `GET /v1/me/team-entries` says whose team it is ("Sam (Lions)")
  and who the opponent is. The next activity is the earliest unfinished session, booking or
  still-to-play fixture. A fixture read that is not available is left out silently; any other
  failure shows its code and "Try again" without hiding the rest. Fixture overlaps with another
  commitment of the same person are marked in the family calendar (the API compares sessions and
  bookings; the client compares fixtures the same half-open way, display only).
- **RSVP (SPK-CAP-003, CMP-04).** The answer is the viewer's entry in `responses`; changing it
  sends that revision (then the one the last answer returned) as `expectedRevision`; STALE_REVISION
  offers "Reload"; `INVALID_TRANSITION` with `details.code: AVAILABILITY_CLOSED` reads
  "Availability closed at kickoff". A viewer whose `rosterStatus` is null is not offered choices.
  Answers the API lists for children are shown read-only (answering for a child is DEC-090).
- **Pass (ENT-01).** `GET /v1/me/passes` tells whether the pass on the device is active, revoked
  (its reference is no longer offered; "Get a new pass" issues one without revoking anything) or not
  listed ("Not confirmed"). Active passes whose reference is not on the device (a reinstall) are
  listed and can be withdrawn with a reason and the listed revision. Replacing uses the revision
  the API lists now. Offline: the last known state with its age and "may refuse it if it was
  revoked". The reference is never sent anywhere and never shown again by the API.
- **Inbox (SPK-COMMS-004).** Read and acknowledge send the attempt's `revision` (the newest the
  screen knows); a stale read reloads the list; a stale acknowledgment shows the code with
  "Reload". Each notice names the participants it concerns (`subjectPersonIds`), also on Home.
- **Registrations on Home (ENR-02, FIN-01).** A pending registration says what is outstanding
  ("Registration pending: a form to complete", approval, payment, placement); a checkout in
  `recovery_required` from `GET /v1/me/registration-checkouts` is pinned first with "Do not pay
  again" and opens its outcome screen (SCR-C-15).
- **Pickup sessions (SPK-PLACE-004, DEC-082).** Booked pickup sessions are on the family calendar,
  labelled from their offering's kind. "Find pickup sessions" is offered only while
  `pickup_sessions` is on; while it is off the section shows the turned-off state and booked ones
  stay listed.
- **Youth feedback (ENR-14).** Exactly what `GET /v1/me/youth-feedback` serves, by participant:
  skill area, observation date, "Level 3 of 5: Confident" from the template, comments, offering,
  when shared; recommendations as offers that never register or charge. Turned off while
  `youth_progression` is off, with what was shared still readable.
- **Support (SUP-01).** A request about the person, a child they view or a team they captain,
  with category, title and description checked next to each field before sending, optional
  registrations of that person or the record a link named; one idempotency key per request intent;
  NOT_FOUND and ACCESS_DENIED shown as not available without the code; the draft is kept on every
  failure and offline. History from `GET /v1/me/cases` with "Load more requests"; one request from
  `GET /v1/me/cases/{id}` (re-read on return to the app). No notes, owner or queue is shown.
- **Names (§4.14).** Every participant name comes from `GET /v1/person-names` (names only, never a
  date of birth or contact): "You" for the signed-in person, given names for others, "Family
  member" when the API leaves someone out.

## Pending decisions shown as pending

| Item                                           | Decision                                             |
| ---------------------------------------------- | ---------------------------------------------------- |
| Arrival guidance (SCR-C-04, SCR-C-20)          | POL-046 (Operations)                                 |
| Scannable pass symbol                          | DEC-023 (Technical lead/account owners)              |
| "Tentative" RSVP                               | DEC-064 (Product and operations)                     |
| RSVP for a child by a guardian                 | DEC-090 (Product and operations)                     |
| Pickup arrangements per supervised session     | DEC-075 (Product owner), DEC-005 (Operations)        |
| Parent-visible feedback, recommendation inputs | DEC-054, DEC-055 (Program manager)                   |
| Support contact details and service levels     | DEC-015 (Technical lead/operator), unless configured |
| Stale-data threshold                           | DEC-032, DEC-033 (Operations), unset by default      |
| Capability switches (pickup sessions, youth)   | DEC-016 with DEC-082 (Product owner)                 |

## API issues found while building these screens

- `FamilyCalendarItem` does not say a session booking's kind (pickup, trial, makeup), so the
  calendar reads each booked offering to label pickup sessions.
- `GET /v1/me/family-calendar` `overlaps` covers sessions and bookings only; fixtures of the same
  people are compared by the client.
- `YouthFeedback` assessments carry no author (the inventory row lists one), so none is shown.
- `CustomerCase` carries neither who nor what a request is about, and there is no customer command
  to answer a request that is "Waiting for you"; the screen says the team will make contact.
- `POST /v1/fixtures/{id}/availability` and the inbox read/acknowledge accept a change without
  `expectedRevision` (the check runs only when one is sent); this app always sends it.
- `POST /v1/me/inbox/{id}/read` answers STALE_REVISION for a notice already read elsewhere,
  although reading twice is otherwise not an error; the app re-reads the list.
- `POST /v1/fixtures/{id}/availability` accepts a child's `personId` with `register` while DEC-090
  is pending; the app does not offer it.
