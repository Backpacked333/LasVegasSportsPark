# Discover, registration and checkout (SCR-C-07 to SCR-C-16)

Customer screens for journey A (discover, register, pay) and the household basket of journey C
(spec §2.2, §3.3, §3.15, §4.8 to §4.11, §4.13 to §4.15; SPK-AT-001, SPK-AT-004, SPK-AT-005,
SPK-AT-006, SPK-AT-023). Screen ids are from `docs/package-a/screen-and-journey-inventory.md`
section 4; status phrases are from `docs/package-a/journeys.md` section 3.

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a fake
API that follows the published OpenAPI contract. **Proposed** = engineering proposal awaiting
operator approval. **Pending decision** = waits on an operator answer
(`docs/package-a/decision-register.md`). No screen here has passed native acceptance on signed
builds or physical devices (§6.2).

## Screens and routes

Route parameters are opaque record ids only (§4.14). Route files under `app/registration/` only
re-export the `*Route` component of the screen.

| Screen                                         | Route                                                         | API                                                                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                  | Tests                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SCR-C-07 Discover                              | `/discover` (tab)                                             | `GET /offerings` (public, child-safe; `kind`, `format`, `from`, `to`), paged; `GET /me/permissions`; "In progress": `GET /me/baskets`, `/me/registration-checkouts`, `/me/waitlist-entries`                                                                                                                                                                       | **Verified**; age-band filter **Pending decision** DEC-003                                                                                                                              | `../discover/__tests__/DiscoverScreen.test.tsx`                                    |
| SCR-C-08 Offering detail                       | `/registration/offering/[offeringId]`                         | `GET /offerings/{id}`, `/offerings/{id}/sessions`, `/offerings/{id}/registration-options`, `GET /policy-versions/{id}` (signed in)                                                                                                                                                                                                                                | **Verified**; responsible manager not shown (staff-only in the API)                                                                                                                     | `__tests__/OfferingDetailScreen.test.tsx`                                          |
| SCR-C-09 Registration intent chooser           | `/registration/start/[offeringId]`                            | `GET /offerings/{id}/registration-options`, `GET /me`, `GET /person-names`, `GET /me/baskets`, `GET /me/permissions`, `POST /baskets`, `POST /baskets/{id}/lines`; trials and pickup: `GET /offerings/{id}/sessions`, `GET /me/package-entitlements`, `GET /me/memberships`, `POST /trial-participations`, `POST /session-bookings`, `GET /session-bookings/{id}` | **Verified** for basket intents, trial and pickup bookings that owe nothing, and the booking hand-over; a priced single session is not started in the app (no customer payment command) | `__tests__/RegistrationIntentScreen.test.tsx`, `__tests__/SessionBooking.test.tsx` |
| SCR-C-10 Participant and placement information | `/registration/placement/[lineId]?basketId=`                  | `GET /baskets/{id}`, `GET /offerings/{id}/registration-options` (season), `GET /competitions?status=active` (preferred competition), `POST /placement-requests`                                                                                                                                                                                                   | **Pending decision** DEC-051/DEC-031 for the field list; form **Verified** with configured fields                                                                                       | `__tests__/PlacementInformationScreen.test.tsx`                                    |
| SCR-C-11 Household basket                      | `/registration/basket/[basketId]`                             | `GET /baskets/{id}`, `GET /acknowledgments`, remove line, release, `POST /registration-quotes`, `POST /waitlist-entries`, `GET /me/registration-checkouts`                                                                                                                                                                                                        | **Verified**; partial fulfillment **Pending decision** DEC-026                                                                                                                          | `__tests__/BasketScreen.test.tsx`                                                  |
| SCR-C-12 Quote review                          | `/registration/quote/[quoteId]`                               | `GET /registration-quotes/{id}` (with `consumedByCheckoutId`), `GET /credits`, `POST /registration-quotes`                                                                                                                                                                                                                                                        | **Verified**; prices, taxes, discounts **Pending decision** DEC-007, DEC-057 (the API's values are shown)                                                                               | `__tests__/QuoteReviewScreen.test.tsx`                                             |
| SCR-C-13 Required forms and acknowledgments    | `/registration/forms?basketId=` or `?waitlistEntryId=`        | `GET /acknowledgments`, `GET /policy-versions/{id}`, `POST /acknowledgments`                                                                                                                                                                                                                                                                                      | **Verified**                                                                                                                                                                            | `__tests__/RequiredFormsScreen.test.tsx`                                           |
| SCR-C-14 Checkout and payment                  | `/registration/checkout/[quoteId]`                            | `POST /baskets/{id}/hold`, `POST /registration-checkouts`, `GET /me/registration-checkouts`                                                                                                                                                                                                                                                                       | **Verified** with the development fake provider; in-app payment **Pending decision** DEC-019                                                                                            | `__tests__/CheckoutScreen*.test.tsx`                                               |
| SCR-C-15 Checkout outcome                      | `/registration/outcome/[checkoutId]`                          | `GET /registration-checkouts/{id}`, `GET /operations/{id}`, `GET /enrollments/{id}`, `GET /placement-requests/{id}`, `POST /registration-checkouts/{id}/payments`                                                                                                                                                                                                 | **Verified**; provider customer action **Pending decision** DEC-019                                                                                                                     | `__tests__/CheckoutOutcomeScreen.test.tsx`                                         |
| SCR-C-16 Waitlist status and offer             | `/registration/waitlist/[entryId]`, `/registration/waitlists` | `GET /me/waitlist-entries` (paged), `GET /waitlist-entries/{id}`, `GET /offerings/{id}` (facility zone), accept, decline, withdraw                                                                                                                                                                                                                                | **Verified**; offer duration and priority are the API's (POL-006, DEC-006); offer notices arrive in the inbox (SCR-C-06)                                                                | `__tests__/WaitlistScreen.test.tsx`                                                |

`__tests__/registration-routes.test.tsx` renders the real Expo Router tree and checks that every
route above resolves to its screen.

## Behaviour asserted by the tests (Verified)

- **Intents are the API's** (SPK-REG-001, ENR-05): the chooser offers exactly
  `GET /v1/offerings/{id}/registration-options` `availableIntents`; there is no table of intents
  per offering kind in the app. Basket intents (individual league, team entry, youth, membership,
  session package) add basket lines; rentals and parties hand over to the Package G booking route
  `/bookings/new/{offeringId}` (`features/package-g/routes.ts`; not built here) and never send a
  basket line; a makeup opens the participant's makeup sessions (SCR-C-35); joining a team needs
  the team's invitation. The participants chosen belong to one intent: choosing another intent
  starts from nobody, and only people the API reports eligible for the current intent are sent.
- **Trials and pickup sessions** (SPK-YOUTH-003, SPK-PLACE-004, SPK-COND-001): one participant in
  one upcoming session (facility zone), then `POST /v1/trial-participations` (with the follow-up
  consent; a trial may also be recorded without a session, for the front desk to arrange) or
  `POST /v1/session-bookings`. A booking is offered only when nothing is owed: the offering's price
  owes nothing, or a package credit (`session_packages` on) or a membership (`memberships` on) pays
  for it. "Session booked" / "Trial booked" only for what the API confirmed; a pending booking reads
  "Booking pending: a payment is needed. The place is held until <expiry>." and never as booked.
  Pickup sessions sit behind `pickup_sessions` (DEC-082).
- **Eligibility before adding** (SPK-REG-002): the detail (SCR-C-08) and the chooser show, per
  person the account may register, the API's read-only eligibility for each intent: "Eligible",
  "Not eligible" with the API's reasons and permitted alternatives, "Eligible once the required
  forms are signed" (the API sends an outstanding form as a warning on a passing result, with
  "Complete the required acknowledgments"), or "Eligibility not known yet" (unknown evidence is
  never a pass). A person the API leaves out of the answer (the account may only view them) reads
  "not available to register" with no reason (SPK-IAM-003); a household of more than 20 is read in
  groups of 20, so nobody is left unasked. A participant with blocking reasons cannot be added;
  the API evaluates every line again.
- **Capabilities** (DEC-016, DEC-072, DEC-074, DEC-076, DEC-077, DEC-082): a Package G intent
  whose switch `GET /v1/me/permissions` reports off is not offered and reads "<Capability> turned
  off (decisions)"; until that read answers such an intent is not usable ("Checking whether …"),
  and a failed read shows its code and "Try again"; a command refused with ACCESS_DENIED
  `CAPABILITY_DISABLED` shows the turned-off state, not a failure. Discover offers a filter for pickup sessions, rentals, parties,
  packages and memberships only while their switch is on.
- **Resume after a restart or reinstall** (SPK-UX-001, SPK-AT-023): "In progress" on Discover,
  the intent chooser (which adds to the newest open basket), the basket, the quote and the
  checkout read the customer's own lists: `GET /v1/me/baskets`, `GET /v1/me/registration-checkouts`
  (a `recovery_required` checkout reads "Payment received. We are completing your registration.",
  an unknown payment "Payment outcome being confirmed. Do not pay again.") and
  `GET /v1/me/waitlist-entries?status=offered` (open offers with the server's deadline). A quote
  used for a checkout links to it through `consumedByCheckoutId`. Each list has its own error
  state with the code and "Try again". The intent chooser never opens a second basket while the
  list of open baskets is unread.
- **One idempotency key per intent** (§4.9): every command goes through `useApiCommand`; a retry
  of the same input reuses the key (basket lines, checkout), a new input gets a new key. Bodies
  carry `expectedRevision` wherever the API takes it (basket lines, remove, hold, release, waitlist
  accept, decline and withdraw).
- **No client prices** (SPK-PAY-001): quote and checkout bodies carry ids, codes and a provider
  token only; every amount shown is the API's integer minor units (`formatMinorUnits`).
- **Payment uncertainty** (SPK-PAY-007, SPK-UX-001): a checkout request that gets no answer reads
  "Payment outcome being confirmed. Do not pay again.", hides the Pay button, and is re-sent with
  the same key when the app returns to the foreground, when the connection returns, or on "Check
  now". The outcome screen re-reads an in-flight checkout every 5 seconds (display refresh, not a
  policy) and on foreground; "Confirmed" appears only for enrollments the API reports confirmed,
  and "Confirmed: <team>" once the placement names a team.
- **Final place and late payment** (SPK-AT-005, SPK-AT-006): CAPACITY_UNAVAILABLE on hold charges
  nothing and offers the waitlist per line; holds and offers show only the server's expiry, with an
  informational countdown that re-reads the record when it lapses.
- **Two guardians, one entitlement** (SPK-AT-004): DUPLICATE_ENTITLEMENT is shown with the API's
  message only; nothing names the other registrant or payer.
- **Signer rules** (SPK-REG-009): the app never sends `signedByPersonId`; the API records the
  signed-in customer. Children the account may not complete forms for read "Needs a guardian who
  can complete forms".
- **Facility time zone** (SPK-SCHED-008): registration windows, sessions and waitlist offer
  deadlines are shown in the offering's `facility.timezone`, with the zone named; a list row that
  carries only an offering id (`GET /me/waitlist-entries`) reads that offering for its zone, and
  shows the device zone, named, while the offering is not readable. Holds and quote expiries
  carry no facility and use the device zone, named.
- **Filters** (CAT-01): Discover sends `format`, `from` and `to` to the API; a date that is not a
  real `YYYY-MM-DD` date or a range that ends before it starts is a field message and nothing is
  sent. The fields always show the filter that is applied ("Show all activities" empties them).
- **Names** (§4.14): participant names come from the names-only `GET /v1/person-names` (no date
  of birth or contact); a person it omits is not listed, or reads "Name not available".
- **Placement season** (SPK-PLACE-001): the season a placement request names is the API's
  `seasonId` from the registration options; an offering with none reads "not available". A
  configured preferred competition is chosen from `GET /v1/competitions?status=active` ("No
  preference" sends nothing).
- **Not available** (§4.10): NOT_FOUND, ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED read as
  not available, never as "exists but denied".
- **Offline** (§4.15): cached data stays with its age; commands are disabled and input is kept.
- **Release builds**: the development payment method (`src/features/registration/dev`) is required
  only under `__DEV__`; `scripts/check-release-bundle.mjs` fails a release bundle that contains it.

## Proposed (engineering choices awaiting approval)

- Baskets are opened with the proposed default all-or-nothing fulfillment; partial fulfillment is
  never offered (DEC-026, Product and operations).
- The device remembers one thing, in the platform secure store, scoped to the account
  (`src/features/registration/progress.tsx`): the quote of a checkout request whose answer never
  arrived. That request may never have reached the API, so no list can show it; the checkout
  screen asks again for that quote (the API keeps one checkout per quote). It is forgotten once
  the API reports the checkout or refuses the request. A value stored by an earlier build (basket,
  checkout and waitlist ids) is ignored.

## Pending decisions shown as pending

| Decision                                                      | Owner                                          | Where                                                           |
| ------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| DEC-019 payment processor (in-app payment)                    | Technical lead/account owners                  | SCR-C-14 pay step, SCR-C-15 retry and provider action           |
| DEC-051, DEC-031 placement fields and model                   | Product and operations; Operator/privacy owner | SCR-C-10 (fields come from `SPORTSPARK_PLACEMENT_FIELDS`)       |
| DEC-003 age bands (age-band filter)                           | Product and operations                         | SCR-C-07 (no age filter; each item shows its age band)          |
| DEC-016, DEC-072 to DEC-082 conditional capabilities          | Product owner                                  | SCR-C-07 filters, SCR-C-09 intents (from `GET /me/permissions`) |
| DEC-006, DEC-026 to DEC-030 holds, waitlist, approval, basket | Product and operations                         | Only server values are shown (expiry, approval flags)           |
| DEC-007, DEC-057 prices, taxes, discounts                     | Finance                                        | SCR-C-12 shows the API's prices and its stated defaults         |

## Configuration

| Variable                       | Meaning                                                                                                                            | Default                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `SPORTSPARK_ORGANIZATION_SLUG` | Organization whose public catalog a signed-out visitor browses (deployment)                                                        | unset: signed-out Discover asks to sign in |
| `SPORTSPARK_PLACEMENT_FIELDS`  | Comma-separated approved placement fields: `availability`, `preferredCompetition`, `declaredLevel`, `positionPreferences`, `notes` | unset: pending DEC-051                     |

## Not built here

- A single session that owes a payment (a priced trial session, a priced pickup session without a
  package or membership credit): the API leaves such a booking pending until the front desk takes
  the payment and has no customer command to pay for one (reported), so the app does not start it.
  Makeups are booked from SCR-C-35.
- Signing an offering's required forms from a trial or pickup booking: the forms screen works from
  a basket or a waitlist entry; a booking the API refuses with MISSING_ACKNOWLEDGMENT shows the
  API's message and code.
- The rental and party booking flow (`/bookings/new/{offeringId}`, Package G): the chooser hands
  over to the foundation's route; its screen group builds it.
- Joining a known team from the chooser: it needs the team's invitation (SCR-C-17, Teams).
- Completing a provider's customer action (`action_required`) and in-app card entry: DEC-019.
- The responsible manager on SCR-C-08: the API gives it to staff only (`Offering.staff`).
- Requested teammates on SCR-C-10: other players' identities are never exposed (SPK-PLACE-005).
  A preferred division is not collected: DEC-051 names the preferred competition only.
