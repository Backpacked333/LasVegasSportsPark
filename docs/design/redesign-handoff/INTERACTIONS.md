# Interaction spec

What every control does. Columns: **Control · Gesture · Result · Data (API) · Edge cases**.

API tags: `✓ exists` = read in the repo on main · `◷ to build` = new or path to confirm with the API team · `local` = no network. Endpoint names marked ◷ are proposals.

Screen ids match the badges in `designs/Mobile Redesign.dc.html` and `designs/Staff Redesign.dc.html`.

## Global behaviours (apply everywhere unless a row says otherwise)

- **Writes are optimistic, with Undo.** Answers, approvals, attendance and marking read show the new state at once. A toast offers Undo for 5 s. If the call fails, the UI reverts and the toast says what didn't save, with Try again.
- **Money is never optimistic.** Payments and refunds wait for the server. The button shows a spinner and the sheet can't be dismissed. Every POST carries an idempotency key so a retry can't double-charge.
- **Loading.** Skeletons in the final layout, never a blank screen or a full-screen spinner. If a read takes over 8 s: "Still loading…" with Cancel.
- **Errors.** Plain sentence, what to do next, and the error code in small type for support ("Code SPK-PAY-003"). Try again re-runs only the failed call.
- **Offline.** Amber banner with the time of the last good data. Reads show cached data. Writes are disabled, except check-ins and attendance, which queue on the device and show a count.
- **Toasts.** Bottom, above the tab bar. 2.4 s, or 5 s when they carry Undo. One at a time; a new one replaces the old.
- **Sheets.** Slide up 320 ms. Close by drag down, scrim tap or ✕, except while processing. Focus moves into the sheet and returns to the control that opened it.
- **Hit targets and access.** Mobile 44 px minimum, desk tablet 52–56 px for scan-time controls. Every control has a label for screen readers. Status always uses glyph + word.
- **Times.** Always in the facility's time zone, with "today / tomorrow / Sat" for the next 6 days and dates after that.
- **Deep links.** Every push and email links to the exact screen (sportspark://pay/{feeId}, /sign/{formId}, /offer/{offerId}, /event/{id}). Signed out: log in first, then land there.

## Key flows

### Parent app · Pay a fee _(Dana, 30 s)_

`1b` Home › To do › Pay $120 → `2b` Choose plan, check card → `2b` Pay → "Paying…" → `3-D Secure` Only if the bank asks → `1b` Toast + row ✓ Paid

**Fails:** Declined: inline error, sheet stays open. Network: "You weren't charged. Try again." Same idempotency key on retry.

### Parent app · Sign a waiver and get cleared _(Dana, 20 s)_

`1b` Leo hero › ▲ Sign → `2c` Read summary, type name → `2c` Also sign for Maya? → `2c` Sign → `1b / 1j` Leo ✓ cleared everywhere

**Fails:** Form text fails to load: Sign disabled with Try again. Partial save: toast names who was signed.

### Parent app · Answer for a game _(Dana, 2 s)_

`1b or 1i` Going / Maybe / Not going → `Toast` Saved, Undo 5 s → `1h` Calendar badge updates

**Fails:** Save fails: selection reverts with an error toast. After kickoff: locked.

### Parent app · Register for camp weeks _(Dana, 2 min)_

`1d` Explore › camp card → `1e` Who: Maya → `2a` Pick weeks, extras → `1f` Review: quote, code, pay → `1g` Done: calendar, forms

**Fails:** Last place taken during payment: offer the waitlist in one tap. Quote changes: show the new total before Pay.

### Parent app · Take a waitlist place _(Dana, within 24 h)_

`Push` "A place opened for Maya" → `2e` Offer + countdown → `1f` Review & pay → `1g` Done

**Fails:** Offer ends during payment: "This offer ended before payment", no charge.

### Staff · Check in a family at the desk _(Desk, 15 s)_

`2a` Scan Dana's pass → `2a` Maya ✓, Leo ✕ waiver → `2a` Hand tablet: Dana signs → `2a` Check in Maya and Leo → `2a` Clears for next family

**Fails:** Offline: check-ins queue on the device with a visible count. Unknown pass: search by name.

### Staff · Fix a missing referee _(Manager, 10 s)_

`1a` Issue: no referee → `1a` Ranked list: free, on site → `1a` Assign or Ask → `1a` Issue ✓, Undo 5 s

**Fails:** Ask unanswered after 15 min: issue rises and turns red.

### Staff · Book a free slot for a caller _(Front desk, 1 min)_

`2b` Find a free slot → `2b` Set type, length, days → `2b` Hold 15 min → `1b` New booking prefilled → `1b` Confirm + payment link

**Fails:** Hold runs out: warning at 2 min, released at 0.

### Staff · Take attendance _(Coach, 1 min)_

`2d` Tap each child → `2d` Long-press absent → `2d` Pickup › release each child

**Fails:** Adult not authorised: blocked, "Call the desk". Offline: queued.

## Parent app, screen by screen

Order follows the tab bar, then sheets and flows opened from it.

### Shell · App shell: tab bar, header, child switcher

_Entry: Every customer screen_

| #   | Control                    | Gesture   | Result                                                                                                                                      | Data                                              | Edge cases                                                                       |
| --- | -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Tab bar item               | Tap       | Switches tab. Each tab keeps its own stack and scroll position. The active tab gets the floodlight pill.                                    | local                                             | Re-tapping the active tab pops to its root, then scrolls to top on a second tap. |
| 2   | Tab bar badge              | None      | Red count on Home when To do has items. Hidden at 0, shows "9+" above 9.                                                                    | local                                             | Updates after any pay, sign or answer without refresh.                           |
| 3   | Pass button (QR) in header | Tap       | Opens the Pass full-screen (1j), preselected to the next person with an activity today, otherwise the account holder.                       | local                                             | Works offline from the cached pass.                                              |
| 4   | Bell                       | Tap       | Pushes Inbox (2d). Badge is the unread count.                                                                                               | ◷ to build `GET /v1/me/notifications?unread=true` | Badge hidden if the count read fails. Never shows a stale number as current.     |
| 5   | Child switcher chips       | Tap       | Filters Home, Calendar and Explore to that child. "Everyone" shows all. Selected chip is night-filled. The choice is remembered per device. | local                                             | With one child the switcher is hidden. With 5+ children it scrolls sideways.     |
| 6   | Any list                   | Pull down | Refreshes the screen. Shows "Updated just now" under the title for 2 s.                                                                     | ◷ to build `Re-runs the screen's reads`           | Offline: spring back, and the offline banner stays.                              |

### 1b · Home

_Entry: Launch, Home tab_

| #   | Control                   | Gesture | Result                                                                                                                                      | Data                                                                  | Edge cases                                                                                                                                                                  |
| --- | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hero card photo           | Tap     | Pushes Game day (1i) for that event, or Activity detail for a class.                                                                        | local `(event already loaded)`                                        | If the event was cancelled, the hero becomes a red ✕ card "Cancelled: Desert Foxes vs Lions" with "See why" opening the Inbox message.                                      |
| 2   | "Today · in 14 min" pill  | None    | Live countdown, refreshed each minute. Under 60 min shows minutes. At start time it reads "Now".                                            | local                                                                 | Turns ✓ "Checked in" after a successful scan at the desk (push or refetch).                                                                                                 |
| 3   | Going / Maybe / Not going | Tap     | Selects at once (optimistic). Toast: "Saved: Maya is going. Coach Ana can see it." with Undo for 5 s. The "x of 12 answered" count updates. | ◷ to build `PUT /v1/events/{id}/attendance-intent {personId, answer}` | Fails: revert the selection and show the error toast with Try again. Locked at kickoff: control greyed, caption "Answers closed at kickoff". "Maybe" is proposed (DEC-021). |
| 4   | Directions                | Tap     | Opens the device maps app with the gate pin (not the street address). On iOS with several maps apps, an action sheet asks which.            | local `(facility.gates[])`                                            | No gate set for the facility: uses the facility address.                                                                                                                    |
| 5   | Show pass                 | Tap     | Opens Pass (1j) for this child.                                                                                                             | local                                                                 |                                                                                                                                                                             |
| 6   | To do: Pay $120           | Tap     | Opens the Pay sheet (2b) over Home.                                                                                                         | local                                                                 | On success the row shows ✓ Paid for 3 s, then leaves the list. The header count drops.                                                                                      |
| 7   | To do: Sign               | Tap     | Opens the Sign sheet (2c).                                                                                                                  | local                                                                 | Same success treatment as Pay.                                                                                                                                              |
| 8   | To do: Join               | Tap     | Opens a small confirm sheet: team, night, first game, fee if any. "Join team" confirms. "Not now" hides the row for 7 days.                 | ◷ to build `POST /v1/team-invitations/{id}/accept`                    | Invite expired: row turns ● "Invite ended", tap removes it.                                                                                                                 |
| 9   | "Calendar" link           | Tap     | Switches to the Calendar tab with the same child filter.                                                                                    | local                                                                 |                                                                                                                                                                             |
| 10  | Later today row           | Tap     | Pushes the event detail (same layout as Game day for games, Activity detail for classes).                                                   | local                                                                 |                                                                                                                                                                             |

**Screen states:** Loading: skeleton hero + 3 grey rows, never a spinner over a blank screen. Nothing today: hero becomes "Next up" with the next event and its day. No activities at all: Explore prompt "Find something for Maya". Offline: amber banner "Offline. Showing what was saved at 8:41." All actions that write are disabled with that caption.

### 2b · Pay sheet

_Entry: Home To do · You › Due now · Inbox reminder_

| #   | Control                    | Gesture                   | Result                                                                                                                                                           | Data                                                                 | Edge cases                                                                                                                                                                                                                     |
| --- | -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sheet                      | Drag down / tap scrim / ✕ | Closes. No charge made.                                                                                                                                          | local                                                                | Blocked while a payment is processing (handle hidden, ✕ disabled).                                                                                                                                                             |
| 2   | Pay in full / 3 × $40      | Tap                       | Switches the plan. Amount, label and button update: "Today, then 2 monthly" / "Pay $40.00 today".                                                                | ✓ exists `POST /v1/registration-quotes (re-quote with plan)`         | Instalments only appear when the price rule allows them (proposed). Otherwise the control is hidden.                                                                                                                           |
| 3   | Card row · Change          | Tap                       | Pushes saved methods inside the sheet. "Add card" opens the processor's hosted card fields.                                                                      | ◷ to build `GET /v1/me/payment-methods`                              | No saved card: the row is "Add a card" and Pay is disabled until one is added.                                                                                                                                                 |
| 4   | Pay $120.00                | Tap                       | Button shows a spinner and "Paying…". On success: sheet closes, toast "Paid $120. Receipt sent to dana@…", Home row updates, receipt saved under You › Payments. | ◷ to build `POST /v1/payments {quoteId, methodId} + Idempotency-Key` | Card declined: inline red text under the button, sheet stays open. 3-D Secure: processor challenge in a web view, then continues. Network lost: "You weren't charged. Try again." (same idempotency key, so no double charge). |
| 5   | "Or pay at the front desk" | None                      | Plain text. Always shown (DEC-019).                                                                                                                              | local                                                                |                                                                                                                                                                                                                                |

### 2c · Sign a form sheet

_Entry: Home To do · Home hero (Leo) · You › Forms · desk "sign on tablet"_

| #   | Control            | Gesture  | Result                                                                                                                                                         | Data                                                                           | Edge cases                                                                                                                        |
| --- | ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sheet              | Drag / ✕ | Closes. Typed name is kept until the app is closed.                                                                                                            | local                                                                          |                                                                                                                                   |
| 2   | Full form text     | Scroll   | Scrolls inside the box. The version shown is the one recorded.                                                                                                 | ✓ exists `waiver policy (ADR-004) · text version hash`                         | Text fails to load: Sign disabled with "Couldn't load the form. Try again."                                                       |
| 3   | Type your name     | Type     | Prefilled with the account holder's name. Button label updates live.                                                                                           | local                                                                          | Fewer than 3 characters: button grey, label "Type your name to sign".                                                             |
| 4   | Also sign for Maya | Tap      | Toggles. Only shown when a sibling's same form ends within 30 days. Label changes to "Sign for Leo and Maya".                                                  | local                                                                          | Hidden if the sibling has no form, or a different one.                                                                            |
| 5   | Sign for Leo       | Tap      | Saves one acceptance per person. Sheet closes, toast "Signed. Leo is cleared to check in." Leo's hero, Calendar badge, pass status and You › Forms all update. | ◷ to build `POST /v1/waiver-acceptances [{personId, versionHash, signedName}]` | Fails: stays open with an inline error. Partial success (one of two): toast names who was signed and the row stays for the other. |

### 1j · Pass

_Entry: Header QR · Show pass on any card_

| #   | Control           | Gesture     | Result                                                                                     | Data                                                    | Edge cases                                              |
| --- | ----------------- | ----------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Screen            | Open        | Full-screen night view. Screen brightness goes to maximum while open and returns on close. | local                                                   | Brightness change is skipped if the OS denies it.       |
| 2   | Dana / Maya / Leo | Tap         | Switches whose pass shows. Code, name, line and status update.                             | local                                                   | Only household members the account can act for appear.  |
| 3   | Status pill       | None        | ✓ "Cleared to play" or ▲ "Waiver needed first" from the person's arrival check.            | ◷ to build `GET /v1/people/{id}/arrival-readiness`      | Offline: shows the last known status with "as of 8:41". |
| 4   | Add to Wallet     | Tap         | Adds an Apple / Google Wallet pass for the selected person.                                | ◷ to build `GET /v1/passes/{personId}.pkpass (DEC-023)` | Proposed. Hidden until the wallet decision is made.     |
| 5   | ✕ / swipe down    | Tap / swipe | Closes and returns to the screen it came from.                                             | local                                                   |                                                         |

**Screen states:** The pass works offline from a signed token cached at login and refreshed daily. If the token is older than 7 days the pass shows ▲ "Connect once to refresh your pass".

### 1d · Explore

_Entry: Explore tab_

| #   | Control            | Gesture | Result                                                                                                         | Data                                                | Edge cases                                                                          |
| --- | ------------------ | ------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Search field       | Type    | Results update as you type (250 ms pause). Matches names, sport and coach.                                     | ✓ exists `GET /v1/offerings?q=`                     | No results: "Nothing matches. Try a sport or a day." with chips for popular sports. |
| 2   | Maya · 8 / Leo · 5 | Tap     | Shows only activities that child is eligible for (age, level). The hint line changes to say so.                | ✓ exists `GET /v1/offerings?eligibleFor={personId}` |                                                                                     |
| 3   | Clash badge        | None    | ▲ "Clashes with Desert Foxes" when the schedule overlaps the child's calendar. ✓ "Fits Maya's week" otherwise. | local `(compare to calendar)`                       |                                                                                     |
| 4   | Places badge       | None    | "3 left" amber at 5 or fewer, "Full · waitlist" red.                                                           | ✓ exists `GET /v1/offering-availability`            | Read fails: badge hidden, never guessed.                                            |
| 5   | Activity card      | Tap     | Pushes Activity detail. Its main button starts Register (1e) with the selected child pre-ticked.               | local                                               |                                                                                     |

### 1e–1g · Register: Who → Options (2a) → Review & pay → Done

_Entry: Activity detail › Register · Waitlist offer › Take the place_

| #   | Control                     | Gesture            | Result                                                                                                  | Data                                            | Edge cases                                                                                                           |
| --- | --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Who: person rows            | Tap                | Ticks or unticks. Ineligible people are greyed with the reason ("Ages 6–9").                            | local                                           | Already registered: ✓ "Already in", not tickable.                                                                    |
| 2   | Who: Continue               | Tap                | Goes to Options. Disabled until one person is ticked.                                                   | local                                           |                                                                                                                      |
| 3   | Options: week rows (camps)  | Tap                | Toggles a week. Price bar total re-evaluates.                                                           | ✓ exists `POST /v1/discounts/evaluate`          | Full week stays choosable and says it joins the waitlist. Closed week is disabled with its opening date.             |
| 4   | Options: extras switches    | Tap                | Adds or removes early drop-off / lunch. Total updates.                                                  | ◷ to build `extras on offering (no API yet)`    | Proposed.                                                                                                            |
| 5   | Options: price bar · Review | Tap                | Goes to Review & pay with a binding quote.                                                              | ✓ exists `POST /v1/registration-quotes`         | Disabled with no week chosen. Total shows "Estimate" until the quote returns.                                        |
| 6   | Review: promo code          | Tap › type › Apply | Re-quotes. Applied code shows as a green line with −$ amount and ✕ to remove.                           | ✓ exists `POST /v1/registration-quotes {codes}` | Invalid code: inline "That code isn't valid for this activity."                                                      |
| 7   | Review: Pay                 | Tap                | Same behavior as Pay sheet (2b). Places are held only from here until payment completes or 10 min pass. | ◷ to build `POST /v1/payments`                  | Place taken meanwhile: "The last place just went. Join the waitlist?" with one-tap waitlist.                         |
| 8   | Done: Add to calendar       | Tap                | Adds all sessions to the device calendar.                                                               | local `(.ics)`                                  |                                                                                                                      |
| 9   | Done: Sign forms now        | Tap                | Opens the Sign sheet (2c) for any form the new activity needs.                                          | local                                           | Hidden if nothing to sign.                                                                                           |
| 10  | Back arrow (any step)       | Tap                | Goes back one step, choices kept.                                                                       | local                                           | Leaving the flow from step 1 asks nothing. From later steps: "Leave registration? Your choices are kept for 30 min." |

### 1h · Calendar

_Entry: Calendar tab · Home › Calendar_

| #   | Control                  | Gesture | Result                                                                                                                                            | Data                   | Edge cases                                              |
| --- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------- |
| 1   | Child chips              | Tap     | Same as the shell switcher. Each child's events keep their colour stripe.                                                                         | local                  |                                                         |
| 2   | Back-to-back banner      | None    | Appears when one child's event ends less than 45 min before another family event starts at a different space. Says both places and the walk time. | local                  | Overlap (true clash) shows ✕ in red instead of ▲ amber. |
| 3   | Event row                | Tap     | Pushes event detail / Game day.                                                                                                                   | local                  |                                                         |
| 4   | Answer badge on a game   | None    | Mirrors the Going / Maybe / Not going answer from Home or Game day.                                                                               | local `(shared state)` |                                                         |
| 5   | Today button (top right) | Tap     | Scrolls back to today.                                                                                                                            | local                  | Hidden while today is on screen.                        |

**Screen states:** Empty week: "Nothing scheduled for Maya this week" with Explore link. Loading: grey day headers with 2 placeholder rows each.

### 1i · Game day (Teams)

_Entry: Teams tab · Home hero · Calendar game_

| #   | Control                   | Gesture | Result                                              | Data                                                | Edge cases                                                                           |
| --- | ------------------------- | ------- | --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Field card · Map          | Tap     | Same as Directions on Home.                         | local                                               |                                                                                      |
| 2   | Who's playing bar         | None    | Going / maybe / not going / no answer, live.        | ◷ to build `GET /v1/events/{id}/attendance-summary` | "Enough to play" needs players-needed per game (not in API). Hidden until it exists. |
| 3   | Going / Maybe / Not going | Tap     | Same as Home. Both screens share one answer.        | ◷ to build `PUT attendance-intent`                  |                                                                                      |
| 4   | Check in with Maya's pass | Tap     | Opens Pass (1j) for Maya.                           | local                                               |                                                                                      |
| 5   | Standings row             | Tap     | Pushes full standings and results for the division. | ◷ to build `GET /v1/divisions/{id}/standings`       |                                                                                      |

### 2d · Inbox

_Entry: Bell on Home_

| #   | Control                         | Gesture    | Result                                                                                                                                                          | Data                                             | Edge cases                                                |
| --- | ------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| 1   | All / To do / Changes / Results | Tap        | Filters the list. Count badge on To do.                                                                                                                         | local                                            |                                                           |
| 2   | Message row                     | Tap        | Marks read and opens the thing it's about: a change opens the event, a result opens Game day, a place opened opens the offer (2e), a receipt opens the receipt. | ◷ to build `POST /v1/me/notifications/{id}/read` | Target gone (event deleted): opens the message text only. |
| 3   | Message row                     | Swipe left | Reveals "Mark read". Full swipe marks it read.                                                                                                                  | ◷ to build `same as above`                       |                                                           |
| 4   | Mark all read                   | Tap        | Clears every unread dot and the bell badge.                                                                                                                     | ◷ to build `POST /v1/me/notifications/read-all`  |                                                           |
| 5   | See offer (inline)              | Tap        | Opens Waitlist offer (2e).                                                                                                                                      | local                                            |                                                           |

### 2e · Waitlist offer

_Entry: Push notification · Inbox_

| #   | Control                 | Gesture | Result                                                                                                                         | Data                                               | Edge cases                                                                        |
| --- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Countdown               | None    | Ticks every minute, every second under 1 hour. Shows the exact deadline in the facility's time zone.                           | local                                              | At 0 the screen becomes ● "This offer ended at 9:41" with "Stay on the waitlist". |
| 2   | Take the place · $60    | Tap     | Goes to Review & pay (1f) with this activity and child. The place stays held until the offer's end.                            | ◷ to build `POST /v1/waitlist-offers/{id}/accept`  | Paying after the deadline fails gracefully: "This offer ended before payment."    |
| 3   | Pass to the next family | Tap     | Confirm dialog: "Pass on this place? It goes to the next family. Maya stays on the waitlist for later places." Pass / Keep it. | ◷ to build `POST /v1/waitlist-offers/{id}/decline` |                                                                                   |
| 4   | ✕                       | Tap     | Closes. The offer remains in Inbox and on Home To do until it ends.                                                            | local                                              |                                                                                   |

### 2f · You

_Entry: You tab_

| #   | Control                 | Gesture | Result                                                                         | Data                                         | Edge cases                                                |
| --- | ----------------------- | ------- | ------------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------- |
| 1   | Child avatar            | Tap     | Opens the child profile: activities, forms, care notes, photo.                 | ◷ to build `GET /v1/people/{id}`             | In the prototype it jumps to Home filtered to that child. |
| 2   | Add                     | Tap     | Starts Add a child: name, birth date, photo (optional), care notes.            | ◷ to build `POST /v1/households/{id}/people` |                                                           |
| 3   | Due now · Pay           | Tap     | One fee: Pay sheet (2b). Several: Payments list.                               | local                                        | Nothing due: "✓ All paid".                                |
| 4   | Forms row               | Tap     | Opens the Forms list. With one form to sign it opens that sign sheet directly. | local                                        |                                                           |
| 5   | Legends mode            | Toggle  | Switches to the dark Legends theme at once. Saved per device.                  | local                                        |                                                           |
| 6   | Help & contact the desk | Tap     | Sheet with Call the desk, Email, Opening hours.                                | local                                        |                                                           |

## Staff, screen by screen

Desktop and desk tablet first, then coach and manager phones.

### Shell · Staff shell: rail, facility, sign-out

_Entry: Every staff screen_

| #   | Control                        | Gesture     | Result                                                                                       | Data                                  | Edge cases                                                                                             |
| --- | ------------------------------ | ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Rail item                      | Click / tap | Opens that area. Current area gets the green tint. Tooltip with the name on hover (desktop). | local                                 | Items the role can't use are not shown.                                                                |
| 2   | Keyboard: G then T / S / R / A | Key         | Go to Today / Schedule / Registrations / Arrival.                                            | local                                 | Disabled while typing in a field.                                                                      |
| 3   | Facility switcher (header)     | Click       | Menu of facilities the user works at. Changing it reloads the current area for that site.    | ✓ exists `facility list from session` | Single facility: hidden.                                                                               |
| 4   | User footer (Jordan Reyes)     | Click       | Menu: Profile, Switch user, Sign out.                                                        | local                                 | Shared tablets lock after 10 min idle to a PIN screen; the scan field stays usable for check-ins only. |

### 1a · Today (desktop)

_Entry: Sign-in landing · rail Today_

| #   | Control                                  | Gesture | Result                                                                                                          | Data                                                  | Edge cases                                                                                          |
| --- | ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Next-hour card                           | Click   | Opens the session drawer on the right: roster, checks, notes.                                                   | ◷ to build `GET /v1/sessions/{id}`                    |                                                                                                     |
| 2   | Check chip on a card (Ref, Forms, Field) | Click   | ▲ chips open their fix: assign a referee, list missing forms, mark the field ready.                             | ◷ to build `see Issues rows`                          | ✓ chips are not clickable.                                                                          |
| 3   | Field board block                        | Click   | Opens the booking drawer.                                                                                       | ◷ to build `GET /v1/bookings/{id}`                    |                                                                                                     |
| 4   | Field board block                        | Drag    | Moves to another time or field. Drop target turns green if free, red if it clashes. Dropping on red is refused. | ◷ to build `PATCH /v1/bookings/{id} {start, spaceId}` | Families affected get the change message only after "Notify 14 families" is confirmed in the toast. |
| 5   | Issue: Assign (referee)                  | Click   | Assigns at once. Issue turns ✓ and slides out after 2 s, with Undo.                                             | ◷ to build `POST /v1/sessions/{id}/officials`         | Clash for that person: refused with their other booking named.                                      |
| 6   | Issue: Ask                               | Click   | Sends a request to that person's phone. Row shows ◷ "Asked 8:12".                                               | ◷ to build `POST /v1/official-requests`               | No answer in 15 min: the issue rises to the top and turns red.                                      |
| 7   | Issue: Snooze                            | Click   | Hides it for 30 min.                                                                                            | local                                                 | Blocking issues can't be snoozed in the last 15 min before start.                                   |

**Screen states:** Refreshes on focus and every 60 s. A changed number flashes floodlight for 1 s so desk staff notice it.

### 1b · Schedule: day timeline (tablet)

_Entry: Rail Schedule · Week cell (2b)_

| #   | Control               | Gesture          | Result                                           | Data                                        | Edge cases                                                                   |
| --- | --------------------- | ---------------- | ------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Empty time            | Tap              | Opens New booking with space and time filled in. | ◷ to build `POST /v1/bookings`              |                                                                              |
| 2   | "Free 12–2 · book"    | Tap              | Same as empty time, using the whole free gap.    | ◷ to build `same`                           |                                                                              |
| 3   | Booking block         | Tap              | Booking drawer.                                  | local                                       |                                                                              |
| 4   | Booking block         | Long-press, drag | Moves it (tablet). Same rules as desktop drag.   | ◷ to build `PATCH /v1/bookings/{id}`        |                                                                              |
| 5   | Block edge            | Drag             | Resizes in 15-min steps.                         | ◷ to build `PATCH`                          | Can't shrink below the booked length of a paid rental without a refund note. |
| 6   | Draft block (Make-up) | Tap              | Opens the draft with Publish / Delete.           | ◷ to build `POST /v1/bookings/{id}/publish` |                                                                              |
| 7   | Day / Week            | Tap              | Switches to Week (2b), keeping the date.         | local                                       |                                                                              |

### 2b · Schedule: week + Find a free slot

_Entry: Day / Week toggle_

| #   | Control                                     | Gesture | Result                                                                                       | Data                                      | Edge cases                                                     |
| --- | ------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| 1   | Heat cell                                   | Click   | Opens that space and day in the day timeline (1b).                                           | local                                     |                                                                |
| 2   | Find a free slot (panel)                    | Open    | Panel slides in from the right.                                                              | local                                     |                                                                |
| 3   | Filters (space type, length, days, between) | Change  | Results and the dashed outlines on the grid update at once.                                  | ◷ to build `GET /v1/availability/slots?…` | No matches: "No free 90-min 7v7 slot. Try 60 min or weekdays." |
| 4   | Result · Hold                               | Click   | Holds the slot for 15 min, then opens New booking prefilled. Countdown in the drawer header. | ◷ to build `POST /v1/slot-holds`          | Proposed. Hold expires: drawer warns at 2 min, releases at 0.  |
| 5   | Panel ✕                                     | Click   | Closes and clears outlines.                                                                  | local                                     |                                                                |

### 1c · Registrations: decision queue

_Entry: Rail Registrations_

| #   | Control                                                  | Gesture     | Result                                                                         | Data                                             | Edge cases                                                        |
| --- | -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | Tabs: Needs a decision / Waitlist offers / Forms missing | Click       | Switches the list. Counts are live.                                            | ◷ to build `GET /v1/registrations?status=…`      |                                                                   |
| 2   | Row checkbox                                             | Click / X   | Selects. Bulk bar appears: "Approve 3", "Decline…".                            | local                                            |                                                                   |
| 3   | Row                                                      | Click / J K | Opens it in the right panel. J and K move down and up.                         | local                                            |                                                                   |
| 4   | Approve                                                  | Click / A   | Approves, row slides out, Undo for 5 s, family notified after the undo window. | ◷ to build `POST /v1/registrations/{id}/approve` | Over capacity: offers "Approve and over-fill by 1" or "Waitlist". |
| 5   | Decline                                                  | Click / D   | Asks for a reason (list + note). Family sees the reason.                       | ◷ to build `POST /v1/registrations/{id}/decline` | Reason is required.                                               |

### 2c · Registrations: waitlist offers

_Entry: Tab in Registrations_

| #   | Control                         | Gesture | Result                                                                         | Data                                                    | Edge cases                                                               |
| --- | ------------------------------- | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Extend                          | Click   | Menu +12 h / +24 h. Family gets "More time to decide".                         | ◷ to build `PATCH /v1/waitlist-offers/{id} {expiresAt}` |                                                                          |
| 2   | Withdraw                        | Click   | Confirm, then the offer ends and the place returns.                            | ◷ to build `POST /v1/waitlist-offers/{id}/withdraw`     |                                                                          |
| 3   | Call family                     | Click   | Shows the phone number and logs "Called 8:52" on the row.                      | ◷ to build `POST /v1/contact-log`                       | Shown only when the offer hasn't been opened and less than 2 h are left. |
| 4   | Offer to next                   | Click   | Sends a new 24 h offer to the next family in line. Row resets with their name. | ◷ to build `POST /v1/waitlist-offers`                   |                                                                          |
| 5   | Offer the next family by itself | Toggle  | Facility setting. Admins only. Others see it read-only.                        | ◷ to build `PATCH /v1/facility-settings`                | Proposed.                                                                |

### 2a · Arrival desk (tablet)

_Entry: Rail Arrival_

| #   | Control                   | Gesture | Result                                                                                                                             | Data                                                    | Edge cases                                                                                              |
| --- | ------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Scanner                   | Scan    | Reads the pass and shows the whole household with a verdict per person.                                                            | ◷ to build `POST /v1/arrival-scans {token}`             | Unknown or expired pass: red "Pass not recognised. Search by name instead."                             |
| 2   | Search field              | Type    | Name, phone or pass reference. Picking a result does the same as a scan.                                                           | ◷ to build `GET /v1/people?q=`                          |                                                                                                         |
| 3   | Dana signs on this tablet | Tap     | Hands the tablet to the parent: full-screen form, staff navigation hidden, then "Hand back to staff". Verdict re-checks by itself. | ◷ to build `POST /v1/waiver-acceptances`                | Parent closes without signing: returns with the verdict unchanged.                                      |
| 4   | Check in Maya (primary)   | Tap     | Checks in everyone cleared. Toast "Checked in: Maya". Screen clears 3 s later for the next family.                                 | ◷ to build `POST /v1/check-ins [{personId, sessionId}]` | Offline: saved to the device queue, amber "1 check-in waiting to sync". Sent in order when back online. |
| 5   | Clear                     | Tap     | Resets to the scanner without checking anyone in.                                                                                  | local                                                   |                                                                                                         |
| 6   | Still expected row        | Tap     | Menu: Mark not coming · Call parent.                                                                                               | ◷ to build `PUT attendance-intent (staff)`              |                                                                                                         |
| 7   | Care flag pill            | Tap     | Opens the care note. The read is logged.                                                                                           | ◷ to build `GET /v1/people/{id}/care-notes (audited)`   | Only for roles allowed to read care notes.                                                              |

### 2d · Coach: attendance (phone)

_Entry: Coach workspace › Now_

| #   | Control               | Gesture          | Result                                                                                    | Data                                                     | Edge cases                                                                                |
| --- | --------------------- | ---------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Child tile            | Tap              | Cycles Unmarked → ✓ Here → ◷ Late (time stamped) → Unmarked. Counts in the header update. | ◷ to build `PUT /v1/sessions/{id}/attendance/{personId}` | Queued offline like check-ins.                                                            |
| 2   | Child tile            | Long-press 0.5 s | Marks ✕ Absent with a light haptic.                                                       | ◷ to build `same`                                        |                                                                                           |
| 3   | Flag (form / allergy) | Tap              | Bottom sheet with the detail. Allergy reads are logged.                                   | ◷ to build `care notes (audited)`                        |                                                                                           |
| 4   | Show all 14           | Tap              | Expands the grid.                                                                         | local                                                    |                                                                                           |
| 5   | Pickup at 10:00       | Tap              | Release flow: pick a child, pick an authorised adult from photos, confirm.                | ◷ to build `POST /v1/releases`                           | Adult not on the list: "Not authorised. Call the desk." No override from the coach phone. |

### 1d · Today (staff phone)

_Entry: Rail Today on a phone_

| #   | Control       | Gesture | Result                                                     | Data                | Edge cases |
| --- | ------------- | ------- | ---------------------------------------------------------- | ------------------- | ---------- |
| 1   | Issue card    | Tap     | Opens its fix as a bottom sheet (same actions as desktop). | ◷ to build `see 1a` |            |
| 2   | Next-hour row | Tap     | Opens the session as a full screen.                        | local               |            |
