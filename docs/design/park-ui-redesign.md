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

## Proposed: design elements that need API work

Each item names what the API would have to provide. None of these is shown with invented data today.

### Operate

- **Sport on events**, so basketball gets its own kind colour on Today and in the schedule.
- **Event detail extras** (teams, officials, readiness and attendee counts on the event read) for the
  timeline detail rail.
- **Direct move, cancel and message-attendees commands** from the timeline. Today these go through
  schedule drafts.
- **Facility-scoped day summary** for page-header counts ("41 activities · 1 restriction").
- **Live counts in the sidebar** (open issues, approvals waiting). There is no cheap summary read for these.
- **Per-restriction checklist items** and the task owner's name on the release panel.
- **Arrival**: care and medical notes on a scan result (protected, with access rules); session location
  and coach; session capacity; waiver commands ("send link", "sign on this tablet", "override with
  reason"); camera scanning.
- **Field-side "report a problem"** screen and a phone bottom tab bar for the workspace.
- **Match sheet player check-in** (fixture attendance).

### Compete

- **Player position and skill rating**, so the placement board can check keepers and skill balance;
  friend-request flags.
- **Playoff line in standings** (playoff team count on the standings read).
- **Per-check readiness in the season summary**, to avoid one readiness read per game.
- **Inline result decisions** (accept referee report, record forfeit, nudge captains).
- **Replacement candidates for an unassigned slot**, plus referee grade and SafeSport status in the
  candidate reasons.

### Grow

- **Program enrollment by age group, form completion and waitlist counts** across offerings.
- **Organization-wide waitlist list** for the registrations home.
- **Protected care notes, account balance, make-up credits and "paid this year"** on the person record,
  plus waiver/form status and recent attendance.
- **Booking prices and cross-resource availability** (week grid by resource type).

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
