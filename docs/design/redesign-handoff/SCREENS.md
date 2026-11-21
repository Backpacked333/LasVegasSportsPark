# Screen inventory

Every screen in the two design boards, by id, with the designer's behaviour notes. The full per-control spec (gesture → result → API → edge cases) is in `INTERACTIONS.md`.

# Parent (customer) app — mobile

Source file: `designs/Mobile Redesign.dc.html` (open in a browser; each screen has an id badge)

## Round 1 — Customer app — refine the ADR-008 system for parents (classic theme)

### 1a · Home today on main (recreated, full scroll)

- About 2.6 screens tall before Family. The game's time and field are below the fold.
- Facts are repeated three times: the hero's meta, the warning card and the RSVP head.
- The quick actions repeat the pass button in the header and two tabs.
- The Needs you rows only link away. Paying or signing takes 3 to 5 taps.

### 1b · Home · "Today first" (recommended)

- The greeting band is gone, so the next game's time, field and arrival are on the first screen.
- Person chips filter the whole page. "Everyone" is the default.
- RSVP is one segmented control (Maybe is proposed, DEC-064). Directions and the pass sit on the card.
- To do acts in place: Pay opens a payment sheet, Sign opens the form sheet. No page change.
- Quick actions are removed. A week strip with one dot per child replaces Family this week.

### 1c · Home · "One card per child" variant

- The whole family fits on one screen: each person's next activity and the one thing they need.
- The night slab marks the soonest activity, and the walk time flags back-to-back events.
- Simplest for parents with 2–3 kids. Weaker for a player who only plays on teams.

### 1d · Explore · shop for one child

- "Looking for" sets the age and calendar context once, so results never offer something Maya can't join.
- Each card shows its price and one fit answer: fits, clashes, or waitlist.
- Promotions are a floodlight tag on the picture, not a separate section.

### 1e · Register 1/3 · Who (sheet over the offering)

_Frame: 390×844px_

- A sheet keeps the activity behind it, so parents never lose track of what they're buying.
- The eligibility sentence from eligibility-words.ts sits inline and points to an activity that fits.
- Three steps (Who, Options, Review) replace the separate start, forms, quote and checkout screens.

### 1f · Register 3/3 · Review and pay on one screen

_Frame: 390×844px_

- The hold timer comes first, so parents know the clock is running.
- Add-ons such as uniform size are chosen on the line itself, not on a separate step.
- Missing forms are signed here in a sheet, so the Pay button never sends anyone to another screen.

### 1g · Register · Confirmation that sets up the season

_Frame: 390×844px_

- Says what happens next instead of only "Confirmed": calendar, placement date, uniform pickup.
- One follow-on suggestion, for a sibling at the same time and place.

### 1h · Calendar · color per child, clashes called out

- Each child gets their avatar tone everywhere (chips, dots, rows), always shown with their name.
- Back-to-back events and clashes get one plain sentence with the walking time.
- Empty days collapse into one line, and each row shows its status (going, waiver needed).

### 1i · Teams · Game day

- A scoreboard hero on the team's pitch band: who, when, the countdown, and where to go.
- "Who's playing" turns RSVPs into one answer: are there enough players? The threshold needs API data.
- Standings show recent form and the playoff line together. Team chat is proposed.

### 1j · Facility pass · switch who's checking in

_Frame: 390×844px_

- One pass, with a switch for whose pass to show. "All" shows the family's codes for one scan.
- Keeps the finish-pass reference style: groups of four, monospace, digits in floodlight.
- The scannable code and Wallet are proposed, DEC-023. The code shown here is a placeholder.

## Round 2 — More screens: the steps that 1b opens in place, and the rest of a parent's month

### 2a · Register 2/3 · Options (camp weeks, live total)

_Frame: 390×844px_

- CampWeeks.tsx as a checklist with live "places left". A full week stays choosable and says it will join the waitlist.
- The night price bar (CampPriceBar) becomes a sticky footer, so the total updates under the parent's thumb.

### 2b · Pay from Home · sheet, no page change

_Frame: 390×844px_

- Opened from "Pay $120" in To do. The parent stays on Home, and the row turns into "✓ Paid" when done.
- Instalments appear only when the price rule allows them (proposed). The desk fallback is always shown (DEC-019).

### 2c · Sign a form · sheet, signed for a child

_Frame: 390×844px_

- A plain-words summary comes first. The full text is still there to scroll and is recorded with the signature.
- Signing for one child offers to renew siblings' forms that end soon. Validity comes from the waiver policy key (ADR-004).

### 2d · Inbox · sorted by what to do

_Frame: 390×844px_

- The segments follow Home's sections (To do, Changes, Results). Changes show the old value struck through and the new one in bold (SPK-COMMS-005).
- Swipe left to mark read, with "Mark all read" as the non-gesture alternative.

### 2e · Waitlist offer · decide before the clock runs out

_Frame: 390×844px_

- The time limit is big and in plain words, with the exact deadline on the facility's clock.
- Passing is a plain, kind action, so places move on faster instead of waiting to expire.

### 2f · You · one family hub

- The family comes first, with a flag on whoever needs something. Tapping a child opens their profile (activities, forms, care notes).
- Money is two tiles (due now, credits). Everything else is one grouped list instead of separate cards.

## Round 3 — What happens when you press things: results, errors, confirmations, and the screens buttons lead to

### 3a · Home · right after tapping Going and paying

_Frame: 390×844px_

- Going: fills green at once, the count goes 7 → 8, and a toast offers Undo for 5 s. If saving fails, the selection reverts.
- Pay: the paid row flashes green with ✓ Paid for 3 s, then leaves the list. The count in the header drops to "1 left".

### 3b · Pay sheet · card declined (from 2b › Pay)

_Frame: 390×844px_

- The sheet stays open. The failed card turns red, the next saved card is picked for you, and the button names the new card.
- The first line always says whether money moved ("You weren't charged"), and the support code is in small type.

### 3c · Join a team · confirm sheet (from To do › Join)

_Frame: 390×844px_

- Everything you'd ask before saying yes: who's on the team, when and where, what you owe, and whether it clashes.
- Join: sheet closes, toast "You joined FC Neon. Added to Calendar." Not now: hides the invite for 7 days.

### 3d · Activity detail (from Explore card 1d)

_Frame: 390×844px_

- The page answers for this family: fits the calendar, which child qualifies, and that the coach is one they know.
- Register Maya opens Who (1e) with Maya ticked. The label uses the child picked in Explore. Share sends a link to the page.

### 3e · Child profile (from You 2f › Maya)

_Frame: 390×844px_

- The photo ring is the child's colour from the switcher and Calendar. The camera badge opens camera or library, with a square crop.
- "Who can pick up" feeds the coach's release screen (staff 3g). Care notes are shown to staff only where needed, and every read is logged.

### 3f · Home · offline at the field

_Frame: 390×844px_

- The most common real-world state at a sports park. What still works stays bold: time, field and the pass.
- Anything that writes is greyed with a one-line reason, never hidden. The banner clears by itself when the connection is back.

### 3g · Game cancelled · lightning hold → push → Home

_Frame: 390×844px_

- Staff cancel on their side (staff 3b). Families get a push within a minute, with the decision in the first line.
- The Home hero turns into a red card: struck-through game, reason, what happens next. Tapping the push opens this card. "See what's next" moves to the next event.

### 3h · Add a child (from You › Add)

_Frame: 390×844px_

- The button stays grey until first name and birth date are filled, and its label uses the typed name.
- Done: back to You with the new avatar sliding into the family row, and a new chip in the child switcher everywhere.

## Round 4 — Money, messages and settings: what's behind the rows on You and the buttons on cards

### 4a · Payments & receipts (from You › Payments)

_Frame: 390×844px_

- What's coming next sits on top with Pay now and Manage plan (change card, pay off early). Every row shows the child's photo, so the family sees who each charge was for.
- Tapping a row opens 4b. Refunds are green with a + sign. "Tax summary" downloads a PDF for the year.

### 4b · Receipt · with refund request (tap a payment)

_Frame: 390×844px_

- Itemised like the review screen, with the reference staff need. The refund rule is in plain words, with the date it changes.
- Cancel a week shows a sheet listing the weeks and what you'd get back. Confirming sends a request that staff approve (staff 4b).

### 4c · Notification settings (You › Notifications)

_Frame: 390×844px_

- Grouped by what parents care about, not by channel. Changes and cancellations are locked on, so no one misses a moved game.
- Each switch saves at once. Turning off a child mutes everything for them except changes. Quiet hours hold non-urgent ones until 7 AM.

### 4d · Message the coach (from "Message coach" in 3g or Game day)

_Frame: 390×844px_

- One-to-one with the coach, through the park (the coach's number stays private). The thread starts with the event it's about.
- Coaches can send an event card; tapping Going answers right there. Quick replies cover the common texts. Proposed: chat isn't in the API yet.

### 4e · Register · last place went during payment (from Pay in 1f)

_Frame: 390×844px_

- Happens when the place-hold step fails. "You weren't charged" comes first, then the choices with prices already worked out again.
- The best option is pre-selected. Any discount that drops out is explained, so the new total isn't a surprise.

## Round 5 — First run, care notes and Legends (dark) mode

### 5a · Welcome and sign in (first launch)

_Frame: 390×844px_

- One field for phone or email, no password. Sign-in and sign-up are the same path, so nobody picks the wrong one.
- The button is active once the entry looks like a phone or an email. It leads to 5b. Apple and Google skip the code.

### 5b · Enter the code, then "is this your family?"

_Frame: 390×844px_

- The code fills itself from the SMS on both iPhone and Android, and it checks itself on the 6th digit, with no button to press. A wrong code shakes the boxes and clears them.
- When the desk already knows the family, it's claimed in one tap and lands on Home, already filled in. "Something's wrong" opens a message to the desk. A new family goes to Add a child (3h).

### 5c · Care notes editor (from the child profile 3e)

_Frame: 390×844px_

- Allergies are chips with severity, which become the red flags staff see (staff 2a, 2d). "If it happens" is the instruction a coach reads in an emergency.
- The blue box says who can read the notes and when, in plain words. Closing with unsaved changes asks "Save changes?" first.

### 5d · Home in Legends mode (You › Legends mode)

_Frame: 390×844px_

- The same layout and parts as the light Home, only with night surfaces and floodlight accents. Status tones keep their glyph and word.
- Here it's an adult player's evening game. The theme follows the switch in You, or can follow the phone's dark mode.

# Staff app — desktop, tablet, phone

Source file: `designs/Staff Redesign.dc.html` (open in a browser; each screen has an id badge)

## Round 1 — Staff dashboard: Today, Schedule and Registrations (glass-forward shell, classic theme)

### 1a · Today · desktop 1440 · readiness strip, a full-day board, issues you can act on

_Frame: 1440×1010px_

- Readiness strip: every start in the next hour with its checks (referee, field, rosters, waivers), built from the per-check readiness the API already has. A failed check gets a red top edge.
- Field board: a day-long mini timeline replaces the single "Next" column, with a now-line, closures hatched and a red ring on the slot that needs a person.
- Needs action resolves in place: the ranked replacement candidates (GET /assignment-requirements/{id}/candidates) sit inside the issue with Assign.
- KPI tiles now carry a second line that answers "is that bad?" (1 blocks a start, peak hours full).

### 1b · Schedule timeline · front-desk tablet 1180 (rail sidebar)

_Frame: 1180×820px_

- The sidebar collapses to the icon rail at tablet width, so the timeline gets the room. Rows are 68 px for touch targets.
- Kind filters show counts. Conflicts and drafts are chips that filter the grid to just those blocks.
- Free time shows as dashed "book" blocks, and "Find a free slot" searches by space type and length.
- The detail rail lists the readiness checks with the fix as the primary action.

### 1c · Registrations · triage queue with keyboard and bulk actions

_Frame: 1440×880px_

- Tabs carry counts, and the "why it needs you" column shows eligibility reasons as plain sentences with glyph badges.
- Selected rows with the same reason get a night bulk bar: approve all three in one decision, each one audited.
- The detail rail puts the reason, capacity and outstanding forms together, so the decision is made where the facts are.
- J/K/X/A/O/D shortcuts for the office. On a tablet the same rail opens as a sheet.

### 1d · Today · phone on the field (issues first)

- Issues come first, as today.css already does below 900 px, and the top one can be fixed with one 44 px tap.
- Managers get a glass tab bar like the workspace's (proposed), so Scan and Report are a thumb away.

## Round 2 — More screens: arrival desk, week planning, waitlist offers, and the coach's phone

### 2a · Arrival desk · tablet 1180 · scan a family, check in everyone at once

_Frame: 1180×820px_

- Scanning a parent's pass brings up the whole household with one cleared / not cleared answer per person, each with its session.
- Fixing a blocker (sign on the tablet) sits in the red card. The primary button checks in everyone already cleared.
- Care notes show as a red pill on the cleared card (the protected read is already on arrival scans).

### 2b · Schedule · week by use, with "Find a free slot" open

_Frame: 1440×820px_

- Week view as a use heatmap (reporting's utilization read), with closures hatched and issues written in each cell. Selecting a cell opens 1b for that day.
- "Find a free slot" outlines matching cells on the grid and lists them with a Hold action, replacing the hunt across days.

### 2c · Registrations · Waitlist offers tab

_Frame: 1440×700px_

- Every offer in flight shows its status and time left. An offer that hasn't been opened and is running out turns amber and suggests a call.
- The next family in line is always visible, and "offer the next family" can run by itself (a setting, proposed).

### 2d · Coach workspace · take attendance by tapping

- Big tap tiles replace the segmented row per child, with the state written on each tile as well as coloured.
- Form and allergy flags show on the tile, so the coach sees them without opening a record. The workspace tab bar is unchanged.

## Round 3 — What happens when staff press things: drawers, confirmations, hand-offs, offline and locked states

### 3a · Today · session drawer (click a next-hour card in 1a)

_Frame: 1440×820px_

- Clicking a card dims the page and slides this drawer in from the right (Esc or ✕ closes). The open card keeps a green outline so you can see which one it is.
- Blocking checks go to the top with their fix inline. Players show photo, answer and care flags. Cancel game opens 3b, Open check-in opens Arrival filtered to this session.

### 3b · Cancel for weather · confirm and preview the message (from Cancel game)

_Frame: 1180×820px_

- Opened from one game, it offers every outdoor game in the same window, since lightning never hits just one field. Indoor ones are unticked.
- The right side shows the exact push families get (mobile 3g). The red button states the count. After it: toast "4 games cancelled · Undo (2:00)".

### 3c · Arrival · tablet handed to the parent (from "Dana signs on this tablet" in 2a)

_Frame: 1180×820px_

- The same form as the app (mobile 2c), at tablet size with a finger signature. The rail and every staff action are gone, so a parent can't wander into the desk tools.
- After signing: "Thanks, Dana. Please hand the tablet back." Staff tap it to return to 3d, where Leo has turned ✓ Cleared.

### 3d · Arrival · checked in, Wi-Fi dropped (after Check in)

_Frame: 1180×820px_

- Success is one big green answer with faces, readable from a step back. It clears itself in 3 s so the line keeps moving; a tap holds it.
- Offline never blocks the desk: check-ins queue with a count on the rail and a list, and are replayed in order.

### 3e · Schedule · dragging a booking, clash and the toast after (from 1b)

_Frame: 1180×620px_

- While dragging, the block tilts and its old spot shows "was here". Over a clash it turns red and names what it hits; dropping there snaps it back. Free gaps that fit glow green.
- After a valid drop, families aren't told yet. The toast asks to Notify (sends the change message, like mobile 2d) or Undo. It stays until one is chosen.

### 3f · Registrations · decline with a reason (D key or Decline in 1c)

_Frame: 820×620px_

- A reason is required and shown to the family; the message is prefilled per reason and editable. The button text changes with the choices.
- When a fitting alternative has places, offering it is ticked by default, so a "no" comes with a next step.

### 3g · Coach · release a child at pickup (from "Pickup at 10:00" in 2d)

_Frame: 390×844px_

- Big photo tiles of only the authorised adults; the confirm button names both people. Release is logged with time and coach.
- "Someone else" is a dead end on purpose: the coach must call the desk, which can verify ID and override.

### 3h · Shared desk tablet · locked after 10 min idle

_Frame: 1180×620px_

- The left half keeps the line moving: a cleared pass checks in by itself, anything else shows "Please wait for staff".
- 4-digit PIN unlocks back to where Jordan was. Five wrong tries lock it for a minute. "Switch user" lets another staff member sign in.

## Round 4 — Front desk money, household records, incidents and the manager's week

### 4a · Front desk sale · tablet (rail › Sell, or "Take payment" on a household)

_Frame: 1180×820px_

- With a family chosen, "Owed by this family" comes first: their real instalments and fees, each with the child's photo. Tapping a tile adds it; tapping again removes it.
- Credit is applied by itself and shown as a line. The main button names the card and the amount. After paying: receipt sent, the instalment is marked paid in the family's app (mobile 4a).

### 4b · Approve a refund request (from the family's "Cancel a week")

_Frame: 820×640px_

- The amount is worked out for staff: the item, any discount that drops out, and whether the policy allows it. Credit with a 10% bonus is one tap away.
- Refund sends the money back, tells the family and offers the freed place to the next on the waitlist. "Change amount" requires a note, and amounts over $200 need a manager.

### 4c · Household record (rail › People, or click any name)

_Frame: 1440×820px_

- Everything the desk is asked about on one page: money, forms, each child's activities and flags, who can pick up, and a log of what happened today.
- Each tile opens its detail. Take payment opens the sale screen (4a) with this family already chosen. The log is the same timeline the family sees as receipts and messages.

### 4d · Coach · report an injury (Issues tab in the coach workspace)

_Frame: 390×844px_

- Three taps-first steps (who → what → review) that a coach can finish on the sideline. A voice note stands in for typing.
- Sending texts the parent, puts the report on the manager's Today issues, and saves it to the child's record. Head injuries add a concussion checklist step.

### 4e · Manager · this week at a glance (rail › Reports)

_Frame: 1440×820px_

- Four numbers with a plain-words reason under each, a revenue chart where clicking a day opens its bookings, and a "Worth a look" list where each item has its next action.
- "Promote" opens a message to past players, and "Add a session" opens New booking on a free Court 1 slot. Export gives CSV or PDF for the chosen range.

## Round 5 — Booking a held slot, staff shifts and coach assessments

### 5a · New booking from a held slot (Hold in 2b)

_Frame: 1180×820px_

- The hold countdown sits in the header. At 2:00 it turns amber with "Keep holding". Customer search suggests regulars with what they usually book. Enter picks the top match.
- Two ways to finish: charge the card on file now, or text a pay link (for phone bookings), which extends the hold. Either way, the block appears on the schedule as booked or pending.

### 5b · Staff shifts · week, with a swap request (rail › Team)

_Frame: 1440×720px_

- One row per person with photo, colour by role (manager blue, coach green, referee amber). Open shifts are a red dashed row; clicking one lists who's free and qualified.
- Swaps are checked for you (free, qualified, hours) before you approve. Approving updates the session's coach and tells the families.

### 5c · Coach · skills assessment (Assess tab)

_Frame: 390×844px_

- Three plain-word levels per skill instead of numbers, a short note, and a suggested next class. Save moves straight to the next child; swipe or the arrows skip.
- Nothing is sent until the coach taps "Send all to families" at the end. Families get a report card in the child's profile with a "Register for Junior Skills 2" button.
