# Participation, money and support screens (SCR-C-32 to SCR-C-38)

Customer screens for enrollments and participation, cancellation and transfer previews, payments
and obligations, credits and makeup sessions, youth feedback and support
(`docs/package-a/screen-and-journey-inventory.md` section 4).

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here. **Proposed** =
engineering proposal awaiting operator approval. **Pending decision** = needs an operator answer
(owners in `docs/package-a/decision-register.md`). A passing jest test is not native acceptance
(§6.2): VoiceOver, TalkBack, large text and signed builds are still to be accepted on devices.

## Screens

| Screen                                    | Route                                   | API                                                                                                                                                                                                | Status                                                                                                                                 |
| ----------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SCR-C-32 Enrollments and participation    | `/enrollments`, `/enrollments/{id}`     | `GET /enrollments?participantPersonId=`, `GET /me/applications`, `GET /me/trial-participations`, `GET /session-bookings`, `GET /me/memberships`; full list in: `src/screens/enrollments/README.md` | **Verified** (`src/screens/enrollments/__tests__/`)                                                                                    |
| SCR-C-33 Cancellation preview             | `/enrollments/{id}/cancel`              | `GET /enrollments/{id}/cancellation-preview`, `POST /enrollments/{id}/cancel` with `acceptedConsequence`                                                                                           | **Verified** (`CancelEnrollmentScreen.test.tsx`)                                                                                       |
| SCR-C-33 Transfer preview                 | `/enrollments/{id}/transfer`            | `GET /offerings?programId=`, `GET /enrollments/{id}/transfer-preview`, `POST /enrollments/{id}/transfer` with `acceptedConsequence`                                                                | **Verified** (`TransferEnrollmentScreen.test.tsx`)                                                                                     |
| SCR-C-34 Payments and obligations         | `/payments`, `/payments/{obligationId}` | `GET /obligations?debtorPersonId=`, `GET /obligations/{id}`, `GET /orders/{id}`, `GET /installment-plans/{id}`, `POST /obligations/{id}/payments`, `GET /payments/{id}`                            | **Verified** (`src/screens/payments/__tests__/`); paying in release builds **Pending decision** DEC-019                                |
| SCR-C-35 Credits and makeup entitlements  | `/credits`, `/credits/makeup/{id}`      | `GET /credits?ownerPersonId=`, `GET /makeup-entitlements?participantPersonId=`, `GET /makeup-entitlements/{id}`, `GET /offerings/{id}/sessions`, `POST /makeup-entitlements/{id}/redeem`           | **Verified** (`src/screens/credits/__tests__/`)                                                                                        |
| SCR-C-37 Youth feedback and development   | `/youth-feedback`                       | `GET /me/youth-feedback` (stage 4; see [`../today/README.md`](../today/README.md))                                                                                                                 | **Verified**; turned off while `youth_progression` is off (DEC-016); DEC-054, DEC-055 **Pending decision**       |
| SCR-C-38 Support request and case history | `/support`, `/support/{caseId}`         | `POST /me/support-requests`, `GET /me/cases`, `GET /me/cases/{id}` (stage 4; see [`../today/README.md`](../today/README.md))                                                                       | **Verified**; contact details and service levels **Pending decision** DEC-015 unless configured                  |

Route wiring is asserted in `__tests__/money-routes.test.tsx`; the vocabulary in
`__tests__/status.test.ts`.

SCR-C-34 and SCR-C-35 also read the stage-3 customer lists (`GET /me/payments`, `/me/receipts`,
`/me/orders`, `/me/registration-checkouts`, `/me/contribution-requests`,
`/me/package-entitlements`), a balance's `liveAttempt`, one payment (`/payments/attempt/{id}`)
and one order (`/payments/order/{id}`); session packages are a third list next to credits and
makeups. Those screens, their states and what stays open are in
[`src/screens/payments/README.md`](../../screens/payments/README.md); their wording is in
`payment-lists.ts` (`__tests__/payment-lists.test.ts`).

## Behaviour that is verified

- Every money consequence (refund, credit, additional charge, none, review by the facility) is
  shown with the API's own explanation before a cancellation or transfer is committed, and must be
  acknowledged. The preview is asked again at confirm time; a changed consequence is not
  committed and must be acknowledged again (SPK-REG-010, SPK-UX-008 stale version).
- Commands send `expectedRevision` where the API takes it and one idempotency key per intent: a
  retry after no answer reuses the key; a re-preview or a new payment is a new intent (§4.9).
- A payment whose outcome is unknown, or still processing, reads "Payment outcome being confirmed.
  Do not pay again." or "Payment processing", never success or failure; paying is blocked and
  "Check again" asks about the same payment (SPK-PAY-007, SPK-UX-004). PAYMENT_OUTCOME_UNKNOWN from
  the API blocks a second payment.
- A future installment never makes an enrollment look unconfirmed ("Confirmed. Next payment due
  <date>."); a failed installment reads "Payment attention needed" (SPK-PAY-006).
- Credits and makeup entitlements are separate sections with separate empties, never added
  together; a concurrent makeup redemption refused by the database reads "Not available: already
  redeemed" (SPK-PAY-009, SPK-YOUTH-004, SPK-AT-020).
- Protected NOT_FOUND and permission restrictions read "Not available" with no hint that a record
  exists (§4.10); each section of SCR-C-35 fails on its own.
- Person ids never appear in a route; the person shown is screen state (§4.14). Only given names
  are displayed; nothing is logged.
- Offline: cached data with its age, and the actions that need a connection are disabled (§4.15).

## Values that are not the app's

- Refund, credit and charge amounts, installment notice days, retry attempts and intervals, credit
  expiry and permitted uses, makeup limits and expiry: the API's values, shown as sent (DEC-008,
  DEC-009, DEC-056, DEC-058, DEC-073; POL-007 to POL-010, POL-016, POL-035).
- Payment method collection: the provider is not selected (DEC-019, Technical lead/account
  owners). Release builds show the pending decision; development builds use the API's fake
  provider through `dev/` (dropped from release bundles; `scripts/check-release-bundle.mjs`).
- Support contact: `SPORTSPARK_SUPPORT_PHONE`, `SPORTSPARK_SUPPORT_EMAIL`,
  `SPORTSPARK_SUPPORT_HOURS` (`app.config.ts` `extra.supportContact`). Unset, SCR-C-38 shows DEC-015
  (Technical lead/operator) and never invents a number or hours.

## Integration notes

- The Account hub (SCR-C-30) links its sections through `ACCOUNT_SECTION_ROUTES` in `routes.ts`
  (`SCR-C-32` `/enrollments`, `SCR-C-34` `/payments`, `SCR-C-35` `/credits`, `SCR-C-37`
  `/youth-feedback`, `SCR-C-38` `/support`). The hub itself belongs to the account screen group.
- `ConnectivityBanner` subscribes to the query cache through `notifyManager.batchCalls`, as
  TanStack's own hooks do: without it, a query created while another component renders updates the
  banner during that render (React warning). Any other direct `cache.subscribe` in a
  `useSyncExternalStore` needs the same.
- Tests use `testing/money-test-app.ts` (`createMoneyTestApp`, `afterEach(settleApps)`) so late
  answers land inside `act`.
