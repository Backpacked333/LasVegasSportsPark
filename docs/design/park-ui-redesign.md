# Park UI redesign: what is built and what the design still needs

Status legend (§6.7): **Verified** = implemented and asserted by tests in this repository. **Proposed** =
design intent that needs new API data or commands before it can be built. **Pending decision** = blocked on
an entry in `docs/package-a/decision-register.md`.

The redesign (SPK-UX-010: soccer-specific identity, clear hierarchy, readability in busy facilities,
restrained animation, dense staff views, simple customer choices) replaces the visual system of the staff
dashboard and the customer app. It changes no API, permission or offline behaviour. Status is still a
glyph plus text, never colour alone (SPK-UX-009).

## Verified

### Design system

- Staff palette and tokens in `apps/staff/src/ui/styles.css`: night pitch `#0c2219`, pitch green
  `#0b6b3a`, floodlight `#c6f36b`, desert sand `#f4f3ee`, tinted status tones, activity-kind colours
  (league, program, rental, party, basketball, drop-in).
- Type: Archivo variable, self-hosted (`@fontsource-variable/archivo`), condensed 800 uppercase for headings,
  spaces and scores, with tabular numbers.
- Icons: Material Symbols Rounded paths inlined (`ui/Icon.tsx`, `ui/icon-paths.ts`). There is no icon font
  and no network request.
- Shared building blocks: `ui/Page.tsx` (page header, KPI tiles, card header), plus card, list, table,
  segmented-tab, pill and form styles that every existing screen uses.
- Customer app: `apps/mobile/src/ui/theme.ts` with the same palette, Archivo / Archivo Narrow and Material
  Symbols through `expo-font`, with restyled shared components and navigation.

### Staff dashboard

| Area                      | Redesign                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                     | Dark sidebar grouped Operate / Compete / Grow / Business (areas still from `GET /v1/me/permissions`, SPK-UX-005); sticky header with facility switcher and live/offline pill; collapses below 900 px. |
| Today                     | KPI tiles; live field board (every space: now, progress, next, machine status, restrictions written out); day timeline; issues rail with severity edge; issues first on phones.                       |
| Exception detail          | Summary card with severity edge; lifecycle commands in the side rail.                                                                                                                                 |
| Schedule                  | Resource timeline (day and week) with now-line, kind colours, drafts dashed, closures hatched, keyboard-reachable blocks and a detail rail. The bookings-by-space list is kept.                       |
| Facilities                | Active restrictions first, with a release-to-service checklist taken from recorded facts; work orders and asset health.                                                                               |
| Arrival                   | Scan-first desk: big cleared / not-cleared answer, sessions-now fill, supervised-release shortcuts; tap-tile release; segmented attendance.                                                           |
| Workspace (coach/referee) | Dark "now" board, big Accept/Decline, match report scoreboard with steppers and one-tap incidents. Phone-first (SPK-UX-007).                                                                          |
| Leagues                   | Competition cards with season progress; season home with standings scoreboard and form from official results, next-24-hours readiness, "needs your call" queue.                                       |
| Teams                     | Placement board: select then place, buttons only (keyboard alternative to drag, SPK-UX-009).                                                                                                          |
| Staff & officials         | Coverage rows; ranked replacement candidates in a side rail; fee approvals card.                                                                                                                      |
| Programs                  | Capacity-first cards from capacity pools; readiness rail.                                                                                                                                             |
| Registrations             | Decision queue with eligibility reasons; waitlist offers with live expiry.                                                                                                                            |
| People                    | Person record summary with household and pickup authority, activities, money entries and timeline.                                                                                                    |
| Bookings & parties        | Request cards with outstanding items; slot grid for new bookings.                                                                                                                                     |
| Finance                   | Money moved but not fulfilled pinned first; unknown provider outcomes; past due; reconciliation and refunds in flight.                                                                                |
| Point of sale             | Product tiles with kind filter, ticket rail, large tender tiles.                                                                                                                                      |
| Communications            | Three-step composer (audience, message, channel) with a live side rail.                                                                                                                               |
| Reports, Admin, Support   | Report catalog and saved runs; admin overview of accounts, capabilities and integration gates.                                                                                                        |
| Sign-in, not found        | Night-pitch split sign-in; "Out of bounds" page.                                                                                                                                                      |

### Customer app

Home, facility pass, discover, offering detail and registration start, family schedule, team workspace
and book-a-space all use the new heroes, cards, pills and time tiles. Fonts are verified by tests only, not
yet on a device.

### API gaps closed for Operate (scheduling and facilities)

**Verified** by `apps/api/src/modules/scheduling/__tests__/timeline-commands.spec.ts`,
`apps/api/src/modules/facilities/__tests__/release-checklist.spec.ts` and the staff tests
`TimelineExtras`, `ReleaseChecks`, `TodayDayCounts` and `WeekAvailability`:

- Sport on events and series (migration 0304); basketball league play has its own kind colour on
  Today and the schedule, and the sport is written as text. The sport list is **proposed
  (engineering placeholder only)** until the operator names the sports offered.
- The timeline detail rail reads `GET /v1/events/{id}/detail` (teams with roster sizes, staff by
  name, attendee counts) and, for a fixture, competition's readiness by check.
- "Move now" and "Cancel event" publish a single-change draft at once
  (`POST /v1/events/{id}/move`, `/cancel`) with every publication check and notice; "Message
  attendees" opens the communications composer with the event's audience (channel policy pending
  DEC-012, DEC-062).
- Page headers on Schedule and Facilities and each facility on Today show the facility-local day
  counts (`GET /v1/facilities/{id}/day-summary`); sections a role may not read are left out.
- Restrictions carry their own release checks (confirm, reopen, remove; a release is refused while
  one is open) and the task owner's name (migration 0909).
- The new-booking form has a week grid of free blocks by space type
  (`GET /v1/resource-availability`). Prices are still not in the API.

### Compete API gaps closed (verified 2026-11-06)

API in `apps/api/src/modules/competition` (migrations 0464 to 0466) and `apps/api/src/modules/workforce`,
tested in `competition/__tests__/placement-field.spec.ts`, `workforce/__tests__/open-slot-candidates.spec.ts`
and the staff screen tests named below.

- **Placement board** keeper and skill balance from staff player profiles
  (`GET`/`POST /v1/seasons/{id}/player-profiles`; position and a 1 to 5 skill rating, staff-only); the
  entrant's friend request from the placement request's requested teammates
  (`PlacementBoardScreen.test.tsx`). The rating scale is an engineering placeholder; the placement model
  stays **pending DEC-031 / DEC-051**.
- **Playoff line** on standings from the division's fixture specification (`StandingsScreen.test.tsx`).
- **Per-check readiness** in the season readiness summary; the season home reads it once for the next
  24 hours (`compete-redesign.test.tsx`).
- **Inline result decisions** in "Needs your call": accept a submitted report (publish), record the
  suggested forfeit (submit then publish), nudge captains (`POST /v1/fixtures/{id}/result-reminders`)
  (`compete-redesign.test.tsx`). Reminder delivery is **proposed**: communications does not yet subscribe
  to `competition.result_reminder_requested`, so a reminder is recorded and not sent.
- **Match sheet player check-in** (`GET`/`POST /v1/fixtures/{id}/attendance`; attendance on the match
  sheet) (`AssignmentWorkspaceScreen.test.tsx`).
- **Replacement candidates for an unassigned slot** (`GET /v1/assignment-requirements/{id}/candidates`)
  with the official's grade and safeguarding certification in the reasons (`ReplacementRail.test.tsx`).
  Which qualification kinds are the grade and the safeguarding certification is configuration
  (`WORKFORCE_OFFICIAL_GRADE_QUALIFICATION_KIND`, `WORKFORCE_SAFEGUARDING_QUALIFICATION_KIND`), unset by
  default (**pending DEC-011**).
- **Session coach for the arrival screen**: `GET /v1/assigned-staff` (API only; the arrival screen is not
  wired yet, **proposed**).

### API added for the redesign: catalog and enrollment

Verified by API tests (`catalog/__tests__/park-ui-gaps.spec.ts`,
`enrollment/__tests__/park-ui-overview.spec.ts`) and, where wired, staff UI tests. These close the
matching items in "Proposed" below.

| Gap                                                 | API                                                                                                                      | Staff UI                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Enrollment by age, form completion, waitlist counts | `GET /v1/offering-enrollment-summaries` (ages in whole years on the reference date; bands pending DEC-003)               | Programs cards and readiness rail      |
| Organization-wide waitlist                          | `GET /v1/waitlist-queue`                                                                                                 | Registrations home "Waitlists" card    |
| Session location and capacity                       | `GET /v1/sessions` rows carry `location` and `capacity`; a session may record its own location (migration 0210)          | Arrival "Sessions now"                 |
| Recent attendance on the person record              | `GET /v1/participants/{personId}/activities` (last 8 sessions, through entry's attendance port)                          | Person record "Activities" card        |
| Discover text search, promotions                    | `GET /v1/offerings?q=`; `PublicOffering.promotions` (automatic discounts only, never promo codes)                        | Customer app: proposed (not wired yet) |
| "Picked for <child>"                                | `GET /v1/me/offering-suggestions` (age band on the reference date only)                                                  | Customer app: proposed (not wired yet) |
| Camp week picker with live total                    | `GET /v1/offerings?programId=&kind=camp`, `GET /v1/offering-availability`, `POST /v1/discounts/evaluate` (informational) | Customer app: proposed (not wired yet) |

Still proposed from these areas: the session's coach on the arrival panel (workforce), editing a
session's location after it is created, and a binding multi-week quote without a basket (the binding
quote stays finance's `POST /v1/registration-quotes`).

## Proposed: design elements that need API work

Each item names what the API would have to provide. None of these is shown with invented data today.

### Operate

- **Season context on the event detail** ("Fall 2026 Adult Indoor · Div B · Wk 7"), and readiness
  composed into the event read itself (today the rail reads competition's readiness separately).
- **Live counts in the sidebar** (open issues, approvals waiting). There is no cheap summary read for these.
- **Arrival**: care and medical notes on a scan result (protected, with access rules); session location
  and coach; session capacity; waiver commands ("send link", "sign on this tablet", "override with
  reason"); camera scanning.
- **Field-side "report a problem"** screen and a phone bottom tab bar for the workspace.

### Compete

- Delivery of result reminders through communications (see "Compete API gaps closed").

### Grow

- **Protected care notes, account balance, make-up credits and "paid this year"** on the person record,
  plus waiver/form status and recent attendance.
- **Booking prices** and prime/off-peak labels on the week grid (availability by resource type is
  verified above).

### Business

- **Utilization by hour and weekday** (heatmap) and **revenue by product line**.
- **Payment reminder command** for past-due obligations.
- **Organization default currency.**
- **Live recipient count with channel and opt-out breakdown** while composing. Channel policy is pending
  DEC-012 and DEC-062.
- **Account "last seen", access-review dates and staff invitations.**
- **POS**: a household account on the ticket, a command to change line quantity, and configured tax lines.

### Customer app

- **Scannable pass QR code** (pending DEC-023), choosing whose pass to show, and Add to Wallet.
- **Discover**: text search, "picked for <child>" suggestions, promotions.
- **Camp week picker with a live price total.**
- **Team**: form guide, mini standings, RSVP progress and minimum-players warning, "Maybe" RSVP (DEC-064).
- **Booking**: space-type tiles with prices, prime and off-peak labels, temporary holds.
- **Directions and arrival notes** on the next-up card (POL-046), and an unread badge on the inbox.

## Not yet verified

- Staff acceptance on real workstations, tablets and scanners (§6.3).
- Customer app fonts and layout on iOS and Android devices; the release export check (`export:ios`).
- Bundle size: the inlined icon set adds about 200 KB unminified to the staff bundle. The customer app's
  Material Symbols font adds about 950 KB.
