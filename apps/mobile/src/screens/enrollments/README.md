# Enrollments, cancellation and transfer (SCR-C-32, SCR-C-33)

Customer screens for each participant's records and for changing a registration (spec §3.3
SPK-REG-001, SPK-REG-003, SPK-REG-010; §3.13 SPK-YOUTH-003; §3.16 memberships; §4.6, §4.9, §4.11;
journeys C5, C8, C11). They share the participation, money and support helpers of
`src/features/money/` (see its README for SCR-C-34 to SCR-C-38).

Status legend (§6.7): **Verified** = implemented and asserted by a jest test here, against a fake
API that follows the published OpenAPI contract. **Proposed** = engineering proposal awaiting
operator approval. **Pending decision** = waits on an operator answer
(`docs/package-a/decision-register.md`). No screen here has passed native acceptance (§6.2).

## Screens and routes

| Screen                                 | Route                        | API                                                                                                                                                                                                                                                                        | Status                                                                       | Tests                                                                               |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| SCR-C-32 Enrollments and participation | `/enrollments`               | `GET /enrollments?participantPersonId=` (paged), `GET /me/applications`, `GET /me/trial-participations`, `GET /session-bookings?participantPersonId=`, `GET /me/registration-checkouts`, `GET /placement-requests/{id}`, `GET /offerings/{id}` (fallback)                  | **Verified**                                                                 | `__tests__/EnrollmentsScreen.test.tsx`, `__tests__/Participation.test.tsx`          |
| SCR-C-32 One enrollment                | `/enrollments/{id}`          | `GET /enrollments/{id}`, `GET /placement-requests/{id}`, `GET /orders/{id}`, `GET /installment-plans/{id}`, `GET /operations/{id}`, `GET /me/registration-checkouts`; memberships: `GET /me/memberships`, `GET /offerings?kind=membership`, `POST /enrollments/{id}/renew` | **Verified**; renewal behind the `memberships` switch (DEC-016, DEC-072)     | `__tests__/EnrollmentDetailScreen.test.tsx`, `__tests__/MembershipSection.test.tsx` |
| SCR-C-33 Cancellation preview          | `/enrollments/{id}/cancel`   | `GET /enrollments/{id}/cancellation-preview`, `POST /enrollments/{id}/cancel` (`acceptedConsequence`)                                                                                                                                                                      | **Verified**; carrying out the refund or credit **Pending decision** DEC-009 | `__tests__/CancelEnrollmentScreen.test.tsx`                                         |
| SCR-C-33 Transfer preview              | `/enrollments/{id}/transfer` | `GET /offerings?programId=`, `GET /enrollments/{id}/transfer-preview?targetOfferingId=`, `POST /enrollments/{id}/transfer` (`commit: true`, `acceptedConsequence`)                                                                                                         | **Verified**; carrying out the money **Pending decision** DEC-009            | `__tests__/TransferEnrollmentScreen.test.tsx`                                       |

## Behaviour asserted by the tests (Verified)

- **Each record keeps its own state** (SPK-REG-003): enrollments (current, then history), the
  person's applications ("Awaiting approval", "Not approved: <reason>"), trial participations
  ("Trial booked", never an enrollment, SPK-YOUTH-003) and session bookings (pickup, trial,
  makeup; opening one shows its session). The household lists (`/me/applications`,
  `/me/trial-participations`) are read once and shown for the chosen person, with "Load more"
  reaching older pages. Each section has its own error with the code and "Try again"; a list the
  API does not show this account is simply absent (§4.10).
- **What a record is for** (ENR-02): the offering name and dates come from the enrollment itself,
  also for a closed or archived season; the public offering is read only when the enrollment does
  not carry it. Times use the facility zone the API names (SPK-SCHED-008).
- **Status words** (journeys.md section 3, SPK-UX-004): "Registration pending: <reason>" from
  `pendingReason` (approval, payment, a form, placement); "Confirmed in <offering>. Awaiting
  placement."; "Confirmed: <team>" with the team the placement names; "Payment received. We are
  completing your registration." when the operation or the customer's checkout list
  (`GET /v1/me/registration-checkouts`) reports `recovery_required`; "Confirmed. Next payment due
  <date>." for a future installment.
- **Memberships** (ENR-12): term, included sessions, usage and suspensions from
  `GET /v1/me/memberships`. A confirmed membership can be renewed into a membership offering open
  for registration (`POST /v1/enrollments/{id}/renew`, added to the open basket the API lists, or
  a new one); nothing is charged until checkout. While the `memberships` switch is off the
  renewal reads "Membership renewal turned off"; a CAPABILITY_DISABLED answer shows the same
  state. Suspending is a staff command in the API: the screen says the front desk arranges it.
- **Previews are reads** (SPK-REG-010, ENR-03): the transfer preview is the read-only
  `GET /v1/enrollments/{id}/transfer-preview` (no command is sent to preview); the cancellation
  preview is `GET /v1/enrollments/{id}/cancellation-preview`. Both are read again at confirm
  time; a changed consequence is never committed unseen.
- **The acceptance is bound** (ENR-03): cancel and transfer send `acceptedConsequence` (kind,
  amount, currency, as previewed). If the API answers RESOURCE_CONFLICT `CONSEQUENCE_CHANGED` or
  `CONSEQUENCE_ACCEPTANCE_REQUIRED`, nothing changed: the screen shows the current consequence
  (the API's own) and asks for it to be accepted again.
- **One idempotency key per intent** (§4.9): a commit with no answer is checked again with the
  same key; `expectedRevision` is sent with every command.
- **Approval and waitlist** (DEC-006, DEC-028): a transfer that needs staff approval is not
  committed in the app (RESOURCE_CONFLICT `APPROVAL_REQUIRED` reads "Staff approval needed");
  others waiting for the target come first.
- **Privacy** (§4.14): the person shown is screen state, never in a route; only given names.

## Not built here, and why

- Whether a refund or credit from a cancellation or transfer was carried out (`REFUND_PENDING`):
  executing that money is **Pending decision** DEC-009; the recorded consequence is shown.
- A customer list of placement requests on their own: a placement is shown through the
  enrollment that links it.
- Membership suspension by the customer: the API has no customer command (staff only).
