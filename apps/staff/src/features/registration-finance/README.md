# Programs, registrations and finance screens

Staff dashboard screens SCR-S-14, SCR-S-15 (Programs and camps), SCR-S-24 to SCR-S-27
(Registrations and waitlists) and SCR-S-35 to SCR-S-38 (Finance) from
`docs/package-a/screen-and-journey-inventory.md` section 5, against the merged API
(`docs/api/openapi.json`).

Status legend (§6.7): **Verified** = implemented and asserted by a jsdom test in this app.
**Proposed** = engineering handling awaiting operator approval. **Pending decision** = needs an
operator answer (owners in `docs/package-a/decision-register.md`); the screen shows the pending
state and never invents the value. jsdom tests are not staff acceptance on real devices (§6.3).

## Layout

- Routes: `routes.tsx` (`registrationFinanceRoutes()`, registered once in `src/App.tsx` ahead of
  the area placeholders, so they win for `/programs`, `/registrations` and `/finance`: React
  Router ranks equal routes by order). The three areas are also marked `ownRoutes` in
  `src/navigation/areas.ts` for the shell's area filter. Route parameters are opaque ids only
  (§4.14).
- Screens: `src/screens/programs/`, `src/screens/registrations/`, `src/screens/finance/`, tests in
  each `__tests__/`. Shared pieces here: `CommandError` (the §4.10 error presentation), `fields`
  (labelled controls), `format` (minor units, facility-local time), `labels` (machine state names
  as staff labels, with the §4.6 transitions worth offering), `pending` (DEC references),
  `names` (participant, offering and team names read from their owning APIs), `facilities`,
  `OfferingPicker`, `Eligibility`, `RefundView`, `ObligationFigures`, `offline`.

## Screens

| Screen                                         | What is implemented                                                                                                                                                                                                     | Status                                                                                     | Evidence                                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| SCR-S-14 Program, offering and session setup   | Programs (list, create, edit with `expectedRevision`); offerings with every SPK-CAT-001 field; sessions (add, cancel with reason); price rule versions in minor units with taxes and fees; copy as draft (SPK-CAT-003). | **Verified**                                                                               | `ProgramsScreen.test.tsx`, `ProgramScreen.test.tsx`, `OfferingSetupScreen.test.tsx` |
| SCR-S-15 Offering publication                  | Publication, registration and schedule as separate states; configuration checklist (informational); publish, open, pause, resume, close, archive per state; the server's publication report on VALIDATION_FAILED.       | **Verified**                                                                               | `OfferingPublicationScreen.test.tsx`                                                |
| SCR-S-24 Registration queue and approvals      | Queue by status with age, submitter, eligibility reasons and required actions; approve, decline (reason), override eligibility (reason).                                                                                | **Verified**; deadline and resolver not available from the API                             | `RegistrationQueueScreen.test.tsx`                                                  |
| SCR-S-25 Assisted registration                 | Basket for a named household adult (all or nothing), lines, hold, quote (every SPK-PAY-002 field), cash or external tender with evidence, checkout outcome; staff never sign forms.                                     | **Verified**; card payment **Pending decision** DEC-019; cash procedure DEC-009            | `AssistedRegistrationScreen.test.tsx`                                               |
| SCR-S-26 Waitlist management                   | Entries with priority basis, rank, position, preferences, status and offer history; capacity pools; removal with reason.                                                                                                | **Verified**; issuing an offer by hand is not available (no API command)                   | `WaitlistScreen.test.tsx`                                                           |
| SCR-S-27 Cancellation and transfer             | Enrollment lookup; cancellation preview and cancel (reason); transfer preview, acceptance of a non-`none` consequence, commit; old and new enrollments linked.                                                          | **Verified**                                                                               | `EnrollmentChangeScreen.test.tsx`                                                   |
| SCR-S-35 Obligations and orders                | Obligations per customer or team with the four figures and any excess; contributions; order lines; installment plan with failed installments as a financial state.                                                      | **Verified** (read-only by design)                                                         | `ObligationsScreen.test.tsx`                                                        |
| SCR-S-36 Payment attempts and unknown outcomes | Finance operator exceptions grouped by kind; payment attempt with "Reconcile from provider evidence" (same key on retry, never a payment retry); checkout recovery (retry fulfillment, compensate, abort, with reason). | **Verified**; listing attempts by state and provider events are not available from the API | `PaymentExceptionsScreen.test.tsx`                                                  |
| SCR-S-37 Refunds and credits                   | Refund request reserving the amount; over-refund and REFUND_PENDING answers; unknown refunds keep the reservation and reconcile; credits by owner with history, approve, redeem, issue.                                 | **Verified**; refund and credit rules **Pending decision** DEC-009/DEC-058                 | `RefundsScreen.test.tsx`                                                            |
| SCR-S-38 Reconciliation                        | Report by period and currency with every SPK-PAY-011 category apart and the subledger as posted; settlement or cash drawer reconciliation; cash or external tender with evidence.                                       | **Verified**; accounting export **Pending decision** DEC-022                               | `ReconciliationScreen.test.tsx`                                                     |
| Money and time helpers, area homes, a11y       | Minor units without floating point; facility-local input across daylight saving; area homes; every control named.                                                                                                       | **Verified**                                                                               | `__tests__/format.test.ts`, `__tests__/areas.test.tsx`                              |

## Proposed handling of API gaps

These are **Proposed** client behaviours for parts of the inventory the API does not serve yet;
each is also reported to the backend owners.

- No list of payment attempts or refunds by state: SCR-S-36 is built from the finance operator
  exceptions (`GET /v1/exceptions?queue=finance_operator`), and attempts and refunds open by
  reference.
- No inbox read: provider events and their signature verification state show as not available.
- No staff directory or person search: people are entered by reference and their names shown once
  the API resolves them.
- No dry-run publication validation: the checklist only says what is set; publishing is the
  validation.
- No manual waitlist offer command: offers are issued by the service on released capacity.
- No review deadline or resolver on applications: shown as not available.
- No facility list with time zones: names and zones come from the Today feed; without a zone,
  times are entered and shown in UTC and the label says so.
- The OpenAPI document marks some components nullable (`PaymentAttempt`, `FinancialConsequence`,
  `Receipt`, `Person`, ...) and encodes nullable references as `allOf` with a null type, which the
  generated types read as non-nullable; screens guard both at runtime.
