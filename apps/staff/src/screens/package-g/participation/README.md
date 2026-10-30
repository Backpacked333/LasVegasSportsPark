# Package G participation screens (SCR-S-51 to SCR-S-54)

Staff screens for the conditional capabilities rentals, parties, memberships and session packages
(§3.16, §6.5 Package G; SPK-COND-001 to SPK-COND-003, SPK-AT-020) against the merged API
(`docs/api/openapi.json`, contracts in `packages/contracts/src/api/enrollment-package-g.ts` and
`catalog.ts`). Whether the complex uses each capability is **Pending decision** DEC-016 with
DEC-076 (rentals), DEC-077 (parties), DEC-072 (memberships) and DEC-074 (session packages); owner
Product owner. Every switch starts off.

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test in this app.
**Proposed** = engineering handling awaiting operator approval. **Pending decision** = needs an
operator answer (owners in `docs/package-a/decision-register.md`); the screen shows the pending
state and never invents the value. jsdom tests are not staff acceptance on real devices (§6.3).

## Layout

- `../bookings/`: SCR-S-51 and SCR-S-52 share one screen per kind (`BookingsArea`), nested in the
  Schedule area at `/schedule/rentals/*` and `/schedule/parties/*`: the list (index), `new`,
  `offerings` and `:bookingId`.
- `../memberships/`: SCR-S-53 at `/finance/memberships/*` (offerings and members; `:enrollmentId`).
- `../session-packages/`: SCR-S-54 at `/finance/session-packages/*`.
- Here, shared by the four: `names.tsx` (people through `GET /v1/person-names`, names only;
  offering, program, resource and equipment names from their owning APIs), `definition.ts` and
  `DefinitionView.tsx` (typed readers and the read-only view of entitlement definitions),
  `CommandProblem.tsx` (the command error presentation plus RESOURCE_CONFLICT detail codes,
  conflicting times and "Reload"), `permission.tsx` (which commands to offer from
  `GET /v1/me/permissions`), `PersonPicker.tsx` (`GET /v1/people` search), `DateField.tsx`,
  `BookCoveredSession.tsx` (a session a membership includes or a package covers), `format.ts`,
  `__tests__/fixtures.ts`.
- Route parameters are opaque ids only; a malformed id reads "Link not available" without a read
  (§4.14).

## Screens

| Screen                    | What is implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Status                                                                                                                                                                  | Evidence                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SCR-S-51 Rentals          | `GET /v1/bookings` in keyset pages (facility from the header, status filter; the rentals among the loaded pages, see API issue 1), booker names, times in the booking's facility zone, machine-state labels and what is outstanding. Detail `GET /v1/bookings/{id}`: occurrences and resources, equipment, terms, payment (held basket continued in assisted registration), staffing. Request-mode approval (`POST .../approve`, `expectedRevision`; RESOURCE_CONFLICT keeps it requested with the conflicting times and "Reload the booking") and decline (reason). Cancellation with its bound consequence (below). New rental for a customer: approved terms first, free start times from `GET /v1/offerings/{id}/booking-availability`, exactly the offering's resources, weekly repetition, `POST /v1/bookings`. Offerings with their approved booking terms (`GET /v1/policy-versions/{id}`) and definitions, read-only. | **Verified**; deposit before approval and whether approval reserves are **Pending decision** DEC-029, DEC-030; rental terms POL-040                                     | `../rentals/__tests__/RentalsScreen.test.tsx`                  |
| SCR-S-52 Parties          | As SCR-S-51 for parties: guests, equipment and the host reserved together; a paid party is `awaiting_staff` (never "confirmed") until every required assignment, including the host, is accepted, with the link to staff coverage; the party package's length, guest limit, equipment and host from its definition; GUEST_LIMIT_EXCEEDED shown at the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Verified**; as SCR-S-51 (DEC-029, DEC-030, POL-040)                                                                                                                   | `../parties/__tests__/PartiesScreen.test.tsx`                  |
| SCR-S-53 Memberships      | Membership offerings with what each includes as its definition states (none, so many sessions per week, month or term, or unlimited only when chosen), term and renewal notice, read-only; members of an offering (`GET /v1/enrollments?offeringId=`, pages). A member: suspension entered in facility time (`POST /v1/enrollments/{id}/membership-suspensions`; SUSPENSION_OVERLAP) and ended with its revision (`POST /v1/membership-suspensions/{id}/end`); an included session booked with `membershipEnrollmentId` (`POST /v1/session-bookings`; MEMBERSHIP_SESSIONS_USED and the other refusals in words); renewal into a chosen offering (`POST /v1/enrollments/{id}/renew`, none preselected) continued at checkout in assisted registration; cancellation through SCR-S-27.                                                                                                                                           | **Verified**; term dates, usage and earlier suspensions not readable by staff (API issue 2); member pricing and entitlement terms **Pending decision** POL-038, DEC-007 | `../memberships/__tests__/MembershipsScreen.test.tsx`          |
| SCR-S-54 Session packages | `GET /v1/package-entitlements` in pages, filtered by state, package and participant: whose it is, credits left of the purchase, expiry in the offering's facility zone ("No expiry" only when the package chose none), issue, expiry or revocation. Redemption history with each session and what a cancellation did with its credit (`GET /v1/session-bookings/{id}`, `creditDisposition`). Reversal with a reason (`POST /v1/package-redemptions/{id}/reverse`, ungated; REDEMPTION_ALREADY_REVERSED with "Reload"). Redemption: a covered session booked with `packageEntitlementId`; PACKAGE_CREDITS_EXHAUSTED when another booking took the last credit (SPK-AT-020). Package definitions read-only.                                                                                                                                                                                                                      | **Verified**; redemption and reversal terms **Pending decision** POL-039, POL-007                                                                                       | `../session-packages/__tests__/SessionPackagesScreen.test.tsx` |

## Behaviour common to the four

- **Turned off (DEC-016).** Each screen is behind `CapabilityGate` with `whenOff="notice"`: the
  records the API keeps readable stay listed, and so do the commands it never gates (decline,
  cancel, suspend, end a suspension, reverse a redemption). New commitments (a booking, an
  approval, a renewal, a redemption or included-session booking) are not offered while off; if
  the switch changes meanwhile, the command's CAPABILITY_DISABLED answer reads "turned off" with
  its code and the switches are read again.
- **Permissions.** A command is offered unless `GET /v1/me/permissions` says the viewer's roles do
  not allow it at the record's facility; then it reads "Not available to you" naming the
  permission (`enrollment.decide_booking`, `enrollment.request_booking`,
  `enrollment.manage_membership_suspension`, `enrollment.renew_membership`,
  `enrollment.book_session`, `enrollment.reverse_package_redemption`,
  `enrollment.read_package_entitlement`). The API still decides; ACCESS_DENIED and protected
  NOT_FOUND read "not available" without implying a record exists.
- **Commands.** One idempotency key per intent ("Try again" after no answer reuses it; a refusal
  starts a new intent), `expectedRevision` wherever the API takes it, reasons required where the
  API requires them, input kept on failure. Offline, commands are disabled and say they need a
  connection; lists show their age.
- **Money, terms and time.** Prices are shown only as the catalog states them, in minor units with
  their currency; no price, term, deposit, length, repetition or offering is preset. Times are in
  the facility's IANA zone named on screen (UTC, said so, when unknown).
- **Payments.** A held booking or a renewal is paid at checkout in assisted registration
  (SCR-S-25), where an unknown outcome is recovered and never shown as paid; a held booking whose
  checkout is in progress is not offered for cancellation.

## API issues found (not fixed here)

1. `GET /v1/bookings` has no `kind` filter, so Rentals and Parties page through both kinds and show
   theirs among the loaded pages (`ListBookingsQuery` in
   `packages/contracts/src/api/enrollment-package-g.ts`, `BookingsService.list`).
2. No staff read of a membership: term dates (`membership_starts_at`/`ends_at`), sessions used per
   period and suspensions are only in the customer's `GET /v1/me/memberships`; `Enrollment` carries
   none of them. Staff can suspend and end suspensions they recorded in the page, but cannot list
   earlier ones or see the usage (`MembershipsService.listMine`, `MembershipSchema`).
3. `Booking` does not expose its staffing requirements or which are covered; the screen shows
   `outstanding: staffing` and the definition's requirements, not who accepted.
4. `GET /v1/entitlement-definitions` returns every definition unpaged and without a kind filter;
   these screens read definitions one by one through the offerings instead.

## Pending decisions shown here

| Decision                                                        | Where                                     | Owner                                                  |
| --------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| DEC-016 with DEC-076, DEC-077, DEC-072, DEC-074 (applicability) | every screen's turned-off state           | Product owner                                          |
| POL-040, DEC-029, DEC-030 (terms; reserve or deposit first)     | SCR-S-51, SCR-S-52 offerings and requests | Product owner; Finance for deposits and refund rules   |
| DEC-009, DEC-030 (refund, credit and deposit rules)             | cancellation consequence                  | Finance                                                |
| POL-038, DEC-007 (membership terms, member pricing)             | SCR-S-53                                  | Product owner; Finance for pricing (DEC-007)           |
| POL-039, POL-007 (redemption and reversal terms)                | SCR-S-54                                  | Product owner (POL-039); Finance (POL-007 consequence) |
