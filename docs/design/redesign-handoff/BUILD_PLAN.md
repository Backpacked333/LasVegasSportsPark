# Build plan

Build in this order. Each phase ships on its own. Screen ids refer to `SCREENS.md` (M = Mobile board, S = Staff board). Behaviour per control is in `INTERACTIONS.md`.

## Phase 0 — Foundations (both apps)
- Put the tokens from README into `apps/mobile/src/ui/theme.ts` and `apps/staff/src/ui/styles.css` (one shared token source if the monorepo allows).
- Shared primitives: StatusBadge (6 tones, glyph + word), Avatar (photo → initials on person colour, optional ring), Toast with Undo, BottomSheet (drag / scrim / ✕, can be locked), OfflineBanner, Skeleton, SegmentedControl, the person-colour helper.
- Offline write queue (used by check-in and attendance) and a cached-read layer.
- **Done when:** a story/demo page shows every primitive in every state, and no screen hard-codes a hex value.

## Phase 1 — Parent core loop
M `1b` Home (Today first) · M `3a` the state after actions · M `2b` Pay sheet + M `3b` declined · M `2c` Sign sheet · M `1j` Pass · M `3f` offline Home · M `3g` cancelled game · child switcher + tab shell.
- **Done when:** the clickable prototype (`designs/Parent App Prototype.dc.html`) and the app behave the same for: answer Going (+ Undo), pay $120 (+ decline path), sign Leo's waiver (+ also Maya), show the pass offline.

## Phase 2 — Parent discover and register
M `1d` Explore · M `3d` Activity detail · M `1e` Who · M `2a` Options · M `1f` Review & pay · M `4e` last place went · M `1g` Done · M `2e` Waitlist offer · M `3c` Join a team.

## Phase 3 — Parent calendar, teams, account
M `1h` Calendar · M `1i` Game day · M `2d` Inbox · M `4d` Message the coach · M `2f` You · M `3e` Child profile · M `5c` Care notes · M `3h` Add a child · M `4a` Payments · M `4b` Receipt and refund · M `4c` Notification settings · M `5a`/`5b` Welcome and sign-in · M `5d` Legends (dark) mode.

## Phase 4 — Staff shell and Today
Staff shell (glass rail, facility switcher, keyboard G+T/S/R/A, role-filtered items) · S `1a` Today desktop · S `3a` Session drawer · S `1d` Today phone · S `3h` locked shared tablet.

## Phase 5 — Front desk
S `2a` Arrival desk · S `3c` parent signs on the tablet · S `3d` checked in + offline queue · S `4a` Front desk sale · S `4c` Household record · S `4b` Approve refund.
- **Done when:** with the network cut, two check-ins queue, show on the rail badge, and replay in order once it's back.

## Phase 6 — Schedule and registrations
S `1b` Day timeline · S `3e` drag / clash / notify · S `2b` Week + Find a free slot · S `5a` New booking from a hold · S `3b` Weather cancel · S `1c` Registrations queue (J/K/A/D, bulk) · S `3f` Decline with reason · S `2c` Waitlist offers.

## Phase 7 — Coach, manager, team
S `2d` Coach attendance · S `3g` Release at pickup · S `4d` Injury report · S `5c` Skills assessment · S `5b` Staff shifts + swap · S `4e` Manager week.

## Phase 8 — Specified, not yet drawn
These were planned for a staff "round 6", but the round was never added to the boards. Build them from this spec using the same shells and primitives. Ask for mockups if you'd rather have pixels first.
1. **Coach · My week** (new coach home tab; the coach tab bar becomes Week · Teams · Now · Messages · More). A "Needs you" card (no-answer nudge, unconfirmed result), a dark next-session card (countdown pill, going / no-answer / allergy counts, Lineup, Start game day), the rest of today as rows, then day chips for the week.
2. **Coach · Lineup:** a pitch with player photos in formation and a bench sorted by fewest minutes this season (▲ amber below the team average). Drag to place or swap. "Auto-fill fairly" fills it; "Share" sends the lineup to families. Only players who answered Going appear.
3. **Coach · Live game day** (dark): a big ± score per team, a timeline (goal with scorer and assist, sub, opponent goal), Sub / Half time / Injury (→ S `4d`), "End game · 3–1". The result posts to families only when it matches the referee's report.
4. **Coach · Team messages:** one thread per team, private parent replies labelled "to you only", event and poll attachments, read counts, and "Text them" as an SMS fallback. Phone numbers hidden both ways.
5. **Referee home:** requests with a reply-by time and Accept / Can't (a one-tap reason, then the request goes to the next match). Confirmed games with fees, Availability, Pay. Accept clears the manager's "no referee" issue at once.
6. **Referee match report:** score prefilled from the coach with a match check (a mismatch must be fixed or explained), cards, field and conduct chips (Field damage → a crew task, Injury → S `4d`), and the payout line.
7. **Field crew · Fields:** ordered by first use, each with a checklist (lines, goals anchored, nets, corner flags). "Mark ready" is enabled only when every item is ticked and drives the "Field ✓" check on S `1a`/`3a`. A field not ready 15 min before first use becomes a red manager issue. "Report a problem" takes a photo and creates a task.
8. **Maintenance tasks board** (tablet): To do / Doing / Done columns. Cards carry a photo, field, the bookings affected and an assignee. "Close field" offers to move or cancel the affected bookings (reuse S `3e` / `3b`).

## Not yet specified (needs design)
Admin set-up (seasons, programs, camps, prices, age rules, capacity), discounts and promo codes, roles and permissions, form templates, a bulk-message composer, the audit log, memberships and class packs, walk-in registration, closing the till, lost and found, adult captain/player flows, shared households and teen accounts, party booking, the customer web version, Spanish, and the email / SMS templates.
