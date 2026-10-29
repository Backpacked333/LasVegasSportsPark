# Package G customer flows (rentals and parties, memberships, receipts)

Conditional capabilities of §3.16 in the customer app, each behind its organization switch
(DEC-016 and the capability's own decision; every switch starts off). The inventory has no SCR-C
ids for these flows (§6.5); the nearest are SCR-C-07 (rentals in Discover), SCR-C-09 (the intent
chooser hands rentals and parties to the booking flow), SCR-C-32 (a membership enrollment links to
`/memberships`), SCR-C-34 (payment receipts) and SCR-C-35 (credits and packages).

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here. **Proposed** =
engineering proposal awaiting operator approval (the status phrases below, journeys.md section 3
has no booking row). **Pending decision** = needs an operator answer (owners in
`docs/package-a/decision-register.md`). Nothing here has passed native acceptance (§6.2).

| Route                        | Screen                                                           | API                                                                                                                                                                                             | Switch (decisions)                        | State                                                                     | Tests                                                        |
| ---------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/bookings`                  | `screens/bookings/MyBookingsScreen.tsx`                          | `GET /me/bookings` (paged)                                                                                                                                                                      | `rentals` or `parties` (DEC-076, DEC-077) | **Verified**; readable while off (`whenOff="notice"`)                     | `screens/bookings/__tests__/MyBookingsScreen.test.tsx`       |
| `/bookings/[id]`             | `screens/bookings/BookingDetailScreen.tsx`, `CancelBooking`      | `GET /bookings/{id}`, `GET /baskets/{id}`, `GET /enrollments/{id}/cancellation-preview`, `POST /bookings/{id}/cancel`                                                                           | never gated (cancellation)                | **Verified**                                                              | `BookingDetailScreen.test.tsx`, `booking-routes.test.tsx`    |
| `/bookings/new/[offeringId]` | `screens/bookings/BookingFlowScreen.tsx`, `BookingForms`         | `GET /offerings/{id}`, `GET /policy-versions/{id}` (booking terms, form wording), `GET /offerings/{id}/booking-availability`, `GET /acknowledgments`, `POST /acknowledgments`, `POST /bookings` | the offering's kind (DEC-076 or DEC-077)  | **Verified**; deposit or reservation before approval **Pending decision** | `BookingFlowScreen.test.tsx`                                 |
| `/memberships`               | `screens/memberships/MyMembershipsScreen.tsx`, `RenewMembership` | `GET /me/memberships` (paged), `GET /offerings/{id}` (facility zone), `GET /offerings?kind=membership` (paged), `POST /enrollments/{id}/renew`, `GET /person-names`                             | `memberships` (DEC-072)                   | **Verified**; readable while off, renewal only while on                   | `screens/memberships/__tests__/MyMembershipsScreen.test.tsx` |
| `/pos-receipts`              | `screens/pos-receipts/PosReceiptsScreen.tsx`                     | `GET /me/pos-receipts` (paged), `GET /facilities/{id}`                                                                                                                                          | `point_of_sale` (DEC-079)                 | **Verified**; readable while off                                          | `screens/pos-receipts/__tests__/PosReceiptsScreen.test.tsx`  |
| `/session-packages`          | `screens/session-packages/MySessionPackagesScreen.tsx`           | `GET /me/package-entitlements`                                                                                                                                                                  | `session_packages` (DEC-074)              | Built by the money screen group (see `screens/payments/README.md`)        |                                                              |

Shared pieces here: `booking-model.ts` (booking status and outstanding wording, cancel basis, the
approved-terms reader, bookable times from availability), `membership-model.ts` (attendance,
usage periods, suspensions), `receipt-model.ts` (receipt status, tenders, returns), `time.ts`
(facility zones of offerings and facilities), `people.ts` ("You" or the given name),
`routes.ts` (`packageGRoutes`, `routeId`). `PackageGPlaceholder.tsx` and `testing.tsx` remain for
any screen still a placeholder.

## Behaviour

- **Rentals and parties** (ENR-13, SPK-COND-003). Statuses (**Proposed** wording): "Request
  awaiting approval", "Held for you: pay to confirm", "Paid: staff still being arranged",
  "Confirmed", "Not approved", "Expired", "Canceled", "Completed"; each with its own glyph, and a
  paid booking waiting for staff is never "Confirmed". What is outstanding is listed in words.
  Times are in `Booking.timezone` (SPK-SCHED-008); the device zone is named when it is missing.
- **Booking flow.** The approved booking terms (`bookingTermsPolicyVersionId` of the offering) are
  shown before anything is sent: confirmed at once or by request, deposit or full payment at
  checkout, access conditions, host responsibilities. An offering without approved terms is "Not
  bookable yet (POL-040)". Free times come from the API for one facility-local day at a time; a
  rental's length is typed by the customer (the API's 15 to 1440 minutes, no default), a party's
  is the API's. Only start times with the offering's number of free resources are offered, and
  the customer picks exactly that many. Forms the offering requires are signed by the booker
  first (`BookingForms`, `POST /v1/acknowledgments`; MISSING_ACKNOWLEDGMENT shows its code). A
  party states its guests (the guest limit is the API's:
  GUEST_LIMIT_EXCEEDED is shown at the field). A rental may repeat weekly for 2 to 52 weeks; the
  API checks every week and RESOURCE_CONFLICT conflicts are listed. Request mode holds nothing;
  instant mode returns a held booking with its basket, paid through basket, quote and checkout.
  One idempotency key per booking intent.
- **Cancellation** shows its consequence first: a request holds nothing; a hold releases its
  basket (not offered while the basket is in checkout, a payment may be on its way); a paid booking
  shows the enrollment's cancellation preview, which the customer acknowledges and which is sent as
  `acceptedConsequence`, read again at confirm time (CONSEQUENCE_CHANGED is shown to acknowledge
  again). Reason, `expectedRevision`, one key per intent ("Check again" reuses it).
- **Memberships** (ENR-12, SPK-COND-001): attendance exactly as the entitlement states
  ("Unlimited sessions" only for `unlimited`; nothing assumed when the API cannot read it), sessions
  used per period with its limit, suspensions with their dates and reason (arranged by the front
  desk; there is no customer command), the term in the facility's zone, whose it is. Renewal adds
  the chosen membership offering that is open for registration to a new basket; nothing is charged
  until checkout, no target is preselected, no price is shown.
- **Point-of-sale receipts** (SPK-PAY-002): lines with quantity and unit price, subtotal, the
  approved taxes and fees the sale applied, total, settled tenders and returns, in the receipt's
  currency from minor units; the facility's name and zone. A card return never reads as refunded.
- **Turned off** (DEC-016): lists of what the customer already has stay readable under the notice;
  new commitments (booking, renewal) are not offered while off, and a CAPABILITY_DISABLED answer
  shows "turned off" with its code and reads the switches again.

## Pending decisions and open gaps

| Item                                                                                     | State                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Whether a request reserves time or takes a deposit before approval                       | **Pending decision** DEC-029, DEC-030 (shown on the booking flow in request mode)               |
| Rental and party terms (POL-040), membership terms and member pricing (POL-038, DEC-007) | The API's approved versions are shown; nothing is invented                                      |
| Taxes and fees that may appear on receipts                                               | DEC-057 (Finance); the API applies only approved charge policies                                |
| Party extras, automatic renewal, POS inventory, gift cards, tipping                      | Not built: unspecified or unapproved (stage 3 left them out)                                    |
| A party package's guest limit before booking                                             | Not readable by a customer (entitlement definitions are staff reads); the API's answer is shown |
| Whether a card refund on a point-of-sale return has arrived                              | `PosReceipt.returns` carries no refund status; the receipt says so                              |
