# Payments, receipts, orders, credits and packages (SCR-C-34, SCR-C-35; SCR-C-25 player list)

Customer screens for what a family owes, has paid and holds (spec §2.2, §3.15, §3.16, §4.5,
§4.9 to §4.11, §4.14, §4.15; journeys B3, B5 and C4 in `docs/package-a/journeys.md`). Screen ids
are from `docs/package-a/screen-and-journey-inventory.md` section 4; status phrases are from
`docs/package-a/journeys.md` section 3. Shared wording lives in
`src/features/money/payment-lists.ts`; the older money screens of the group are described in
`src/features/money/README.md`.

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a fake
API that follows the published OpenAPI contract. **Proposed** = engineering proposal awaiting
operator approval. **Pending decision** = waits on an operator answer
(`docs/package-a/decision-register.md`). Nothing here has passed native acceptance on signed
builds or devices (§6.2), including VoiceOver, TalkBack and large text.

## Screens and routes

Route parameters are opaque record ids only (§4.14); a malformed id is "Link not available" and
sends no request. Route files under `app/` only re-export the screen's `*Route` component.

| Screen                                         | Route                            | API                                                                                                                                                                                                              | Status                                                              | Tests                                               |
| ---------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| SCR-C-34 Payments and obligations              | `/payments`                      | `GET /obligations?debtorPersonId=` (paged), `GET /me/payments`, `GET /me/receipts`, `GET /me/orders`, `GET /me/contribution-requests`, `GET /me/registration-checkouts?status=`                                  | **Verified**                                                        | `__tests__/PaymentsScreen.test.tsx`                 |
| SCR-C-34 One balance                           | `/payments/[obligationId]`       | `GET /obligations/{id}` (with `liveAttempt`), `GET /orders/{id}`, `GET /installment-plans/{id}`, `POST /obligations/{id}/payments`, `GET /payments/{id}`                                                         | **Verified**; paying in release builds **Pending decision** DEC-019 | `__tests__/ObligationScreen*.test.tsx`              |
| SCR-C-34 One payment                           | `/payments/attempt/[paymentId]`  | `GET /payments/{id}` (attempt with its refunds)                                                                                                                                                                  | **Verified**                                                        | `__tests__/PaymentAttemptScreen.test.tsx`           |
| SCR-C-34 One order                             | `/payments/order/[orderId]`      | `GET /orders/{id}`, `GET /obligations/{id}` per `obligationIds`, `GET /installment-plans/{id}`, `GET /me/payments?purpose=checkout` (unpaid orders)                                                              | **Verified**                                                        | `__tests__/OrderScreen.test.tsx`                    |
| SCR-C-25 Contributions asked of me             | `/team/contributions`            | `GET /me/contribution-requests` (paged), `GET /me/payments?purpose=contribution`                                                                                                                                 | **Verified**                                                        | `../teams/__tests__/MyContributionsScreen.test.tsx` |
| SCR-C-25 One contribution (player)             | `/team/contribution/[requestId]` | adds `GET /me/payments?purpose=contribution` to find a payment on its way                                                                                                                                        | **Verified**; paying in release builds **Pending decision** DEC-019 | `../teams/__tests__/ContributionScreen*.test.tsx`   |
| SCR-C-35 Credits, makeups and session packages | `/credits`                       | `GET /credits?ownerPersonId=` (paged), `GET /makeup-entitlements?participantPersonId=`, `GET /me/package-entitlements` (paged), `GET /offerings/{id}` (facility time zone)                                       | **Verified**                                                        | `../credits/__tests__/CreditsScreen.test.tsx`       |
| Session packages (Package G, next to SCR-C-35) | `/session-packages`              | `GET /me/package-entitlements` (paged), `GET /offerings/{id}`, `GET /me/permissions`; booking: `GET /offerings?programId=`, `GET /offerings/{id}/sessions`, `POST /session-bookings` with `packageEntitlementId` | **Verified** behind `session_packages` (DEC-016, DEC-074)           | `../session-packages/__tests__/`                    |

`__tests__/payments-routes.test.tsx` renders the real Expo Router tree for the routes added here
(`/payments/attempt/[paymentId]`, `/payments/order/[orderId]`, `/team/contributions`,
`/session-packages`); `src/features/money/__tests__/money-routes.test.tsx` covers the older ones.

## Behaviour asserted by the tests (Verified)

- **Payments views** (SCR-C-34): "Show" is a radio group (Balances due, Payments, Receipts, Orders,
  Team contributions); only the chosen view is read. The account lists (`/me/...`) are the API's
  own scope, computed from the account's authority: the app sends no person id, and a refused read
  is "Not available" with nothing of another payer.
- **Unknown outcomes stay explicit** (SPK-PAY-007, SPK-UX-004): an `unknown` attempt reads
  "Payment outcome being confirmed. Do not pay again." and `created` or `processing` reads
  "Payment processing" on every row, on the payment detail and on the balance or contribution it
  pays; neither is ever shown as received or failed. Only `action_required` reads "Payment needs
  your action" (with the DEC-019 pending state for the provider's step), as the API's
  PaymentAttemptStatus states; a live attempt on a balance row and the same attempt on its detail
  read the same words (SPK-UX-010). "Check again" only reads; no test sees a command from it.
- **A payment on its way blocks paying again** wherever it was started: a balance's `liveAttempt`
  (FIN-01) and, for a contribution, an unresolved attempt in `GET /me/payments?purpose=contribution`
  hide or disable paying until the API stops reporting it; in a release build the line still says
  "Do not pay again" above the DEC-019 pending state. "Open the payment" is offered only for an
  attempt the account's own payments list (`GET /me/payments?status=`): a co-guardian's payment on a
  shared balance says it may have been started by someone else, without a link that would end at
  "Not available". When the check for a contribution's payment fails, the list and the line say
  so with the code and "Try again".
- **Needs attention** (SPK-PAY-007, §4.11): a payment with an unknown outcome and a registration
  checkout in `recovery_required` ("Payment received. We are completing your registration.") are
  listed above every view, each in cursor pages ("Load more payments being confirmed", "Load more
  registrations being completed"), and open the payment or the registration outcome; a failed read
  of them shows its code and "Try again" there without hiding the rest.
- **Receipts and overpayments** (SPK-PAY-005): each receipt shows what was received, what was
  applied and any amount paid beyond the balance; a front-desk (cash) receipt is not a button.
- **Refunds** (SPK-PAY-008): a payment lists its refunds with their own states; one being confirmed
  reads "Refund outcome being confirmed", never "Refunded". What can still be refunded is a finance
  figure and is not shown.
- **Orders** (SPK-PAY-002, §4.11): lines per participant, total, credits applied, due at checkout,
  payment and fulfillment state; the order lists the balances it created, each with its own state.
  An unpaid order reads "Not paid yet" and asks nothing of the payer; while its checkout payment is
  on its way (`GET /me/payments?purpose=checkout`) the row and the order show that payment's state
  ("Payment outcome being confirmed. Do not pay again.") and the order offers "Open the payment"; a
  failed check says so with its code.
- **Contribution payments** (SPK-PAY-004): the payment detail of a contribution links to the
  contribution only, never to the team obligation behind it (which a player may not read).
- **Settled payments** refresh what they change: balances, installments, orders, credits,
  contributions and the account lists (one key list, `src/features/money/payment-effects.ts`).
- **Contributions** (SPK-PAY-004, SPK-CAP-002): a player sees only their own lines (and those of
  the people they pay for, named), with the team's description and totals only.
- **Session packages** (ENR-11, SPK-COND-002): sessions left, used and bought; expiry as the API
  states it ("No expiry set for this package" when the definition chose none, POL-039; no rule is
  invented); purchase date; redemption history newest first, with reversals and their reason. A
  package is a separate list from credits and makeups, never added to them (SPK-PAY-009).
- **Booking with a package** (ENR-11, SPK-COND-002, §3.16 "reservation, redemption"): an active
  package with sessions left and before its expiry offers "Book a session with this package" while
  the switch is on; the eligible activities (named offerings and the published offerings of named
  programs) and their upcoming sessions, in the facility's zone; `POST /session-bookings` with
  `packageEntitlementId` and one idempotency key per intent ("Check again" after no answer reuses
  it). The last session taken at the same time reads "Not available: no sessions left on this
  package"; an uncovered session shows the API's reasons; CAPABILITY_DISABLED shows the turned-off
  state; ACCESS_DENIED "Not available"; offline disables booking.
- **Turned off** (DEC-016, DEC-074): while `session_packages` is off the turned-off state names the
  decisions and the owner, packages already held stay listed under it and no booking is offered;
  credits and makeups are not affected. While the switch itself is unknown (its read loading,
  failed with a code, or offline) that state is shown above the packages, which follow their own
  read and are never hidden by it.
- **Time zones** (SPK-SCHED-008): package dates are in the facility's zone when the package's
  offering states it; otherwise the device's zone, said on the card.
- **Paging** (§4.5): balances, credits, payments, receipts, orders, contributions, packages and
  both "Needs attention" lists load in cursor pages with "Load more <label>"; nothing is silently
  cut off. Each has a test that loads the second page with the API's cursor.
- **SPK-UX-008 states**: loading, empty (with what would appear), error with the API code,
  reference and "Try again", not available (§4.10), offline with the data's age (§4.15), and
  signed out ("Sign in", no request). Payments, receipts and orders each have an error-code test
  and a not-available test.

## Values that are not the app's

- Paying in the app: the payment provider is not selected (DEC-019, Technical lead/account
  owners). Release builds show the pending decision; development builds use the API's fake
  provider.
- Retrying a failed installment or changing the payment method from the app: not built by the API
  (DEC-019 and a retry policy); the screen says the facility collects it.
- Credit expiry and permitted uses (DEC-058, POL-010, POL-035), overpayment handling (DEC-008,
  POL-015), installment notices and retries (DEC-073, POL-016), package redemption and reversal
  terms (POL-039, POL-007): shown as the API sends them, never decided here.

## Not available from the API (reported)

- Payment attempts, receipts and orders carry no facility, so their times are in the device's zone
  with the zone named ("facility zone on money records" stays open in the API).
- A contribution request and an order carry no `liveAttempt` (an obligation does); the app finds a
  payment on its way from the newest 50 contribution or checkout payments of `GET /me/payments`
  (`src/features/money/live-payments.ts`).
- A balance's `liveAttempt` names no payer and no "readable" flag, although for an individual
  balance it may be another household member's payment that this account cannot open; the app
  offers "Open the payment" only for an attempt its own `GET /me/payments?status=` lists.
- A receipt names neither its payer nor the balance it paid; it links to its payment attempt when it
  has one.

## Not built here

- Point-of-sale receipts (`/pos-receipts`, `GET /me/pos-receipts`): the Package G customer screen
  group (`src/features/package-g/`).
