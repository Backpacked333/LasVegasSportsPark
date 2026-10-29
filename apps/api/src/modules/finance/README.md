# finance module

**Owns:** quotes and quote lines, orders and order lines, obligations, contribution requests,
payment attempts, receipts, refundable funds and refund attempts, credits and their redemption
history, the journal subledger (journals and journal entries), payment allocations, installment
plans and installments, cash and external tenders, settlement reconciliations, checkouts; behind
capability switches (Package G): point-of-sale products, registers, register sessions, sales,
lines, tenders and returns; accounting mappings and export batches

**Specification:** §3.15 (SPK-PAY-001..012), §4.4 Finance (Quote, Order, OrderLine, Obligation,
PaymentAttempt, RefundAttempt, Credit) and Accounting support (Journal, JournalEntry,
PaymentAllocation, SettlementReconciliation), §4.5 ("Payment must not reduce provider outcomes to
only paid/refunded", `Offering.priceCents` → versioned price rules and quotes), §4.6
PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7, §4.8
(`POST /v1/registration-quotes`, `POST /v1/registration-checkouts`, `POST /v1/payments/{id}/refunds`),
§4.11 (all ten steps), §4.12, SPK-AT-006, SPK-AT-007, SPK-AT-022, SPK-AT-023 (financial parts)

**Migration range:** `packages/db/migrations/0600_finance_*.sql` … `0699` (this module uses
`0600`–`0608` and `0680`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`; relationship authority through the kernel),
catalog (`PRICING_PORT` for price rules, discount evaluation and redemption; `POLICY_PORT`;
`OFFERING_LOOKUP_PORT`), competition (`TEAM_ENTRY_QUERY_PORT` for team obligations and
contribution requests; team roles through the kernel), enrollment (`BASKET_PORT`,
`ENROLLMENT_PORT`, and its exported `BasketsService.hold` command for §4.11 step 3),
communications (`NotificationsService.composeAndQueueIn` for finance notices, FIN-05). It
registers `FINANCIAL_STANDING_IMPL` (entry's `FinancialStandingPort`, FIN-03) and never writes
another module's tables (§4.2); composite foreign keys reference their rows read-only.

**Status: implemented** — verified by `apps/api/src/modules/finance/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs next to the code
(`pricing/quote-calculator.spec.ts`, `ledger/ledger.service.spec.ts`,
`providers/fake-payment.provider.spec.ts`, `providers/fake-accounting.provider.spec.ts`,
`services/pos/pos-charges.spec.ts`, `services/customer-scope.spec.ts`). Statements below are
verified unless marked proposed or pending. Stage-3 work items FIN-01..FIN-07 are summarized in
[Stage 3 (FIN-01..FIN-07)](#stage-3-fin-01fin-07).

## Tables (migration `0600_finance_core.sql`, indexes added in `0601`)

| Table                          | Purpose                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quotes`                       | Basket, payer, subtotal/discount/tax/fee/included tax/total, credits applied, due now, future obligations, payment plan, applied credits, discounts with explanations, finance policy references, expiry, `active/expired/consumed`                                                             |
| `quote_lines`                  | Participant, offering, quantity, price rule, unit and base amount, discount, tax, fee, total, currency, discount and charge lines, line policies, equivalence key, enrollment — append-only                                                                                                     |
| `orders` / `order_lines`       | The purchase with its price and policy basis (lines append-only); `payment_status` (`awaiting_payment/paid/canceled`) and `fulfillment_status` (`pending/fulfilled/recovery_required/compensated/canceled`) are independent facts                                                               |
| `obligations`                  | Debtor person or team entry; mode `individual/single_team_payer/team_with_contributions`; responsible payer; source; amount, allocated, currency, due date; `open/settled/written_off/canceled`                                                                                                 |
| `contribution_requests`        | A player asked to contribute toward ONE team obligation (composite key carries the obligation's mode); amount asked, status `requested/paid/canceled`, paying receipt                                                                                                                           |
| `installment_plans`            | Order, payer, total, count, payment authorization (opaque method reference, never returned), retry policy, notice policy, policy version, `active/completed/defaulted/canceled`                                                                                                                 |
| `installments`                 | One obligation each; amount, due date and original due date, `scheduled/paid/failed/canceled`, attempts, failure reason, next retry, extensions, notice sent                                                                                                                                    |
| `checkouts`                    | CheckoutMachine status, payment kind (`provider/cash/none`), holds, enrollments, current payment attempt or tender, operation, failure and recovery details (plan, refund, credit, exception)                                                                                                   |
| `payment_attempts`             | PaymentAttemptMachine status, purpose (`checkout/obligation/contribution/installment`), provider, opaque payment-method reference, provider reference, action payload, failure reason, fee, evidence source/inbox event/sequence, submitted, unknown                                            |
| `receipts`                     | Money actually received (one per payment attempt or tender): amount = allocated + visible excess, processor fee, journal — append-only                                                                                                                                                          |
| `payment_refundables`          | Per captured payment: captured, refunded, reserved                                                                                                                                                                                                                                              |
| `refund_attempts`              | RefundMachine status, reservation status (`reserved/settled/released`), purpose (`customer_refund/compensation`), provider reference, evidence, operation                                                                                                                                       |
| `credits`                      | Owner, currency, original and remaining, permitted uses, source (`overpayment/compensation/goodwill/adjustment`), expiry, `pending_approval/active/exhausted/expired/revoked`                                                                                                                   |
| `credit_redemptions`           | Append-only `redeem` and `reversal` rows per consuming reference                                                                                                                                                                                                                                |
| `journals` / `journal_entries` | Append-only subledger: one journal per fact and purpose; entries debit or credit one of eight accounts (`customer_receivable`, `cash_processor`, `deferred_revenue`, `credits_payable`, `processor_fees`, `refunds`, `cash_on_hand`, `overpayment_liability`); reversals name what they reverse |
| `payment_allocations`          | Append-only: receipts and credit redemptions → obligations                                                                                                                                                                                                                                      |
| `cash_tenders`                 | Facility, tender kind, payer, amount, obligation or checkout, evidence (a reference at least), recorder, `recorded/reconciled` with its reconciliation                                                                                                                                          |
| `settlement_reconciliations`   | Processor settlement or cash drawer: period, expected, reported, difference, breakdown, `balanced/discrepancy`, external reference — append-only                                                                                                                                                |

Every table carries `organization_id`; references use composite `(organization_id, …)` keys
(including references into identity, catalog, competition and enrollment tables); editable records
carry `revision` and `touch_updated_at`.

### Database guarantees (tests in `__tests__/finance-schema.spec.ts`)

- **§4.7 invariant 5 (no duplicate financial effect from replay):** one receipt per payment
  attempt and per tender; one journal per `(source, purpose)`; one obligation per source fact and
  debtor; one checkout per quote and one live checkout per basket; one live payment attempt per
  checkout, per installment and per payer and obligation; one live checkout or installment charge
  per obligation (`0601`: the checkout charge names the obligation it pays, so the installment
  worker can never charge the same debt beside it); one succeeded attempt per checkout; one
  credit per source fact (an in-process caller may name the source of an adjustment credit —
  migration passes the imported balance's mapping id — and a second credit for it is refused with
  `CREDIT_ALREADY_ISSUED_FOR_SOURCE`; `POST /credits` never takes one); one redemption per credit
  and reference; one reversal per journal, entry and redemption.
- **§4.7 invariant 6 / SPK-PAY-008:** `payment_refundables_within_captured`
  (`refunded + reserved <= captured`); captured is fixed and refunded only accumulates.
- **§4.7 invariant 7 / SPK-PAY-009:** `remaining_minor >= 0`, `remaining <= original`, and a
  deferred constraint trigger keeps `remaining = original - redeemed + reversed`, so a balance is
  never overwritten.
- **SPK-PAY-010:** journals, entries, receipts, allocations, redemptions, quote lines, order lines
  and settlement reconciliations are append-only (`forbid_mutation`); a deferred constraint trigger
  refuses a journal that does not balance in one currency with at least two lines; an entry is a
  debit or a credit.
- **SPK-PAY-004:** `allocated <= amount`, a deferred trigger keeps `allocated` equal to the
  allocation rows, allocations only accumulate, a settled obligation is fully allocated; a
  receipt's allocations always equal its allocated part in its currency (checked on every
  allocation that names it, migration 0602, so received money is never allocated twice); a
  contribution request can only reference a `team_with_contributions` obligation.
- **SPK-PAY-001 (`0603`):** a quote or order line, installment, contribution request, credit
  redemption or refund attempt names its quote, order, plan, obligation, credit or payment attempt
  together with that record's currency (composite foreign keys), so amounts in different
  currencies never mix.
- **§4.3 (`0604`):** journal entry attribution (person, order, obligation) and a quote's consuming
  checkout are organization-scoped composite foreign keys; a payment or refund attempt's provider
  evidence must be an inbox event of its own organization (`*_evidence_inbox_scope` triggers,
  until the kernel inbox has an `(organization_id, id)` key). `0605` indexes receipts and
  obligations by order and obligation, and credit redemptions by consuming record.
- **§4.6:** transition guards refuse every change the PaymentAttempt, Refund and Checkout machines
  do not allow (a `failed` attempt never becomes `succeeded`); quotes, orders, obligations,
  credits, installments and tenders keep their money basis immutable.
- **§4.14:** a payment-method reference containing 12–19 consecutive digits is refused.

## Endpoints (`/v1`, contracts in `packages/contracts/src/api/finance.ts`)

| Method   | Path                                                                                        | Who (action)                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| POST/GET | `/registration-quotes`, `/registration-quotes/{id}`                                         | the payer holding `pay` over every participant (adult self) or desk staff (`finance.create_quote`)            |
| POST/GET | `/registration-checkouts`, `/registration-checkouts/{id}`                                   | same (`finance.checkout`); cash tenders only by desk/finance staff (`finance.record_tender`)                  |
| POST     | `/registration-checkouts/{id}/payments`, `/abort`                                           | the payer or desk staff                                                                                       |
| POST     | `/registration-checkouts/{id}/recover`, `/compensate`                                       | finance operator, general manager, system administrator (`finance.recover_checkout`)                          |
| GET      | `/orders/{id}`, `/payments/{id}`, `/refunds/{id}`, `/installment-plans/{id}`                | the payer or finance readers (`finance.read_checkout`)                                                        |
| POST     | `/payments/{id}/refunds`, `/payments/{id}/reconcile`, `/refunds/{id}/reconcile`             | finance roles (`finance.refund`, `finance.reconcile_payment`)                                                 |
| POST/GET | `/obligations`, `/obligations/{id}`                                                         | create: finance operator, league manager, GM; read: debtor (`view`), team captain, responsible payer, readers |
| POST     | `/obligations/{id}/payments`                                                                | debtor with `pay` (individual), the responsible payer (single payer), the captain (contributions)             |
| POST/GET | `/obligations/{id}/contribution-requests`, `/contribution-requests/{id}`, `/{id}/pay`       | request: captain or finance staff; read: the requested player, captain, staff; pay: the requested player      |
| POST/GET | `/credits`, `/credits/{id}`, `/credits/{id}/redeem`, `/credits/{id}/approve`                | issue/approve: finance roles; redeem: the owner (and entitled to pay the obligation) or desk staff            |
| POST     | `/installments/{id}/collect`, `/installments/{id}/extend`                                   | finance roles (`finance.manage_installments`)                                                                 |
| POST     | `/cash-tenders`                                                                             | front desk, finance operator, GM, sysadmin within their facility scope (`finance.record_tender`)              |
| POST/GET | `/settlement-reconciliations`, `/finance/reconciliation-report`, `/finance/ledger-balances` | finance roles (`finance.reconcile`)                                                                           |
| POST     | `/webhooks/payments/{provider}`                                                             | public; signature verified; recorded in the kernel inbox                                                      |

Every consequential POST is `@Idempotent()` and zod-validated; quote and checkout bodies are
strict and carry no amounts. Customer-private records (quotes, checkouts, orders, payments,
refunds, credits, obligations, contribution requests, plans) answer `NOT_FOUND` to anyone without
authority (§4.10); organization scope comes from the token. Finance-only commands (refund,
reconcile, approve a credit, collect or extend an installment, recover or compensate a checkout)
are authorized before the record is read, so a caller without the role gets `ACCESS_DENIED`
whether or not the record exists. A captain sees a team obligation's totals and each requested
contribution's amount and status, never a player's payment or method.

## Ports

- `PAYMENT_PROVIDER_PORT` (`PaymentProviderPort`, `finance.ports.ts`): `createPayment`,
  `retrievePayment`, `cancelPayment` (abandoned challenges), `createRefund`, `retrieveRefund`,
  `verifyWebhook`; every call carries the
  attempt id as idempotency key; a thrown error is an unknown outcome. Only
  `FakePaymentProvider` exists (deterministic by payment-method token: succeed, require action,
  decline, asynchronous processing, timeout after capture, timeout after decline, unreachable;
  scriptable payments, cancels and refunds; signed webhooks for duplicates and reordering). An
  adapter must bound `createRefund` below the reconciliation threshold. The port refuses
  to start in production (DEC-019 pending).
- Registers `FINANCE_POLICY_IMPL` for enrollment (`FinancePolicyAdapter`): cancellation
  consequences from the approved cancellation policy content (`refundBasisPoints` /
  `creditBasisPoints`, else `review_required`); transfers charge a higher price and credit a lower
  one (proposed, DEC-009).
- Fixtures for downstream tests: `testing/finance-fixtures.ts` (`createObligationFixture`,
  `createCreditFixture`, `createCapturedPaymentFixture`).

## Durable work

- Outbox handlers: `finance.finalize_checkout` on `finance.checkout_payment_received` (§4.11 step 8,
  SPK-AT-023), `finance.abort_expired_checkout` on its timer `finance.checkout_expiry_due`,
  `finance.complete_compensation` on `finance.refund_settled`, `finance.record_installment_notice`
  on its timer `finance.installment_notice_due`. All are idempotent under replay.
- Inbox handler `finance.apply_payment_event` for provider `fake-payments`.
- `FinanceWorker` (outside any transaction; started in non-test processes, `runOnce()` in tests):
  executes requested refunds (customer and compensation), cancels abandoned payment challenges at
  the provider, reconciles stale or unknown payment and refund attempts with the provider, collects
  due installments and retries (only for plans whose checkout was paid and fulfilled).

## Events (`finance.events.ts`)

`finance.quote_created`, `checkout_started`, `checkout_expiry_due`, `checkout_payment_received`,
`payment_received`, `payment_failed`, `payment_outcome_unknown`, `order_paid`,
`enrollment_fulfilled`, `checkout_recovery_required`, `checkout_compensated`, `checkout_aborted`,
`refund_requested`, `refund_settled`, `credit_issued`, `credit_redeemed`, `overpayment_recorded`,
`obligation_created`, `obligation_settled`, `contribution_requested`, `installment_paid`,
`installment_failed`, `installment_notice_due`, `installment_notice`, `cash_tender_recorded`,
`settlement_reconciled`. Payloads carry identifiers and amounts only (§4.14).

## Behaviour notes — verified

- **Quotes (SPK-PAY-001/002/003):** prices come from catalog's price rule effective now (never the
  client), discounts from catalog's explainable evaluation, approved taxes and fees from the rule's
  charge lines (exclusive ones added, inclusive ones shown), credits the payer owns; the quote shows
  every line, totals, due now, future obligations, expiry and policies. Unknown discount codes are
  refused. A quote expires at the earlier of its validity and the basket's hold expiry.
- **Checkout (§4.11):** steps 1–10 as in `services/checkout.service.ts`. One checkout per quote: a
  replay (same or different key) never charges again. The provider is never called inside a
  transaction (`PaymentsService.execute` refuses). A decline leaves the checkout awaiting payment
  for a retry while the hold lasts; after the hold expires with no live payment the timer aborts it
  and reverses every financial effect (obligations, credit redemptions, discount redemptions,
  installments, basket).
- **Payment uncertainty (SPK-PAY-007):** a timeout is `unknown` with a critical exception owned by
  the finance operator; retries and aborts are refused until a webhook, staff reconciliation or the
  worker sweep resolves it. A record the provider has is applied at once; "no provider record" is
  authoritative absence only for an attempt never handed to the provider (decided under the row
  lock) or one submitted or gone unknown at least the reconciliation threshold ago, also when staff
  force the reconciliation. Every live attempt, an unsubmitted `created` one included, blocks abort
  and the abandonment timer until provider evidence resolves it (the stranded-attempt sweep looks it
  up), so a restored database never cancels a capture by assumption (SPK-AT-028). A payment
  challenge still open an hour after submission is treated as abandoned and canceled at the
  provider (proposed, DEC-019 pending); a cancel without an answer keeps the attempt live with an
  exception `finance.payment_action_abandoned`.
- **Webhooks (§4.11):** authenticated, recorded once in the inbox, applied through the state
  machine: duplicates do nothing, an older non-terminal event never moves a resolved attempt back,
  and a contradiction raises `finance.payment_evidence_conflict` without changing the recorded
  state. A capture reported after `failed` or `canceled` is still received money: it is recorded
  once (receipt, journal, refundable funds) and follows the capture path (a checkout still awaiting
  payment finalizes on it instead of charging again; money for a resolved checkout is held as
  visible excess), and it can be refunded. Unmatched events raise `finance.unmatched_provider_event`.
- **Finalization (SPK-AT-023):** confirmations go through enrollment's `EnrollmentPort` in one
  transaction with the order and checkout; an unexpected failure leaves the checkout `finalizing`
  for the durable follow-up; replays confirm nothing twice and post no journal.
- **Recovery (§4.11, SPK-AT-006):** a refused finalization after payment is `recovery_required`
  (checkout, order fulfillment, operation) with exception `finance.fulfillment_incomplete`; a place
  taken by a waitlist offer is never displaced; definitive failures are compensated per the refund
  policy the order recorded (refund by default; a version approved after the quote does not
  apply, SPK-PAY-002), others wait for staff `recover` or `compensate`. Completing a compensation
  restores the credits redeemed at checkout (booked refunds → credits payable, the receivable is
  not reopened) and cancels the installment plan, its scheduled installments and open obligations.
- **Refunds (SPK-PAY-008, SPK-AT-007):** reserved by conditional UPDATE before execution; of two
  concurrent 60% refunds exactly one reserves (also under PostgreSQL); an unknown or in-flight
  result keeps the reservation (REFUND_PENDING) until evidence settles or releases it; "no provider
  record" releases it only once the refund was submitted at least the reconciliation threshold
  ago.
- **Team billing (SPK-PAY-004/005, SPK-AT-022):** contribution payments that together exceed the
  remaining balance allocate exactly the remaining amount; the excess stays visible on the receipt
  and the obligation (`excessMinor`), sits in `overpayment_liability`, and is held as a credit
  pending finance approval with an exception (POL-015 proposed default). A contribution request is
  payable only while its obligation is open. Redeeming a credit into a team obligation needs the
  same authority as paying it (responsible payer, or the captain in the contributions model).
- **Installments (SPK-PAY-006):** explicit authorization at checkout; due now is the first
  installment; notices three days before; collection by the worker with the authorized method; a
  failure is a financial state plus exception `finance.installment_failed` and event
  `finance.installment_failed` — the enrollment stays as it is (participation consequences are
  evaluated separately, POL-017); extensions reset the attempts and the notice, which goes out the
  plan's lead time before the new date; nothing is collected while the checkout's own payment is
  pending or its registration is not fulfilled; retry and notice terms come from the policy the
  quote recorded.
- **Cash (SPK-PAY-012):** permitted staff only, facility-scoped, with evidence; against an existing
  obligation or through the checkout (holds and capacity apply); reconciled per cash drawer.
- **Reconciliation (SPK-PAY-010/011):** balances are computed from journal entries; the report
  keeps orders, obligations, receipts, refunds, credits, processor fees, disputes, settlements and
  cash apart; revenue stays deferred (payment volume is not revenue).

## Policy defaults (proposed, pending operator decisions §6.6)

`finance.policy.ts` (`DEFAULT_FINANCE_POLICY`), overridable by approved catalog policy versions of
kind `installment` / `overpayment` / `refund` with key `finance` (the quote records which applied):
quote validity 15 minutes, never past the hold (POL-013, DEC-007); abandoned checkout aborted five
minutes after its hold expiry; overpayment held as credit pending approval (POL-015, DEC-008);
compensation of an unfulfillable paid checkout by refund (POL-009, DEC-009); installments enabled,
at most three, every 30 days, three attempts 72 hours apart, notice three days before (POL-016,
DEC-008); finance-issued credits without expiry (POL-010); unknown outcomes reconciled after 15
minutes; a payment challenge abandoned 60 minutes after submission is canceled at the provider
(DEC-019); a credit is applied to a given obligation once, with the amount chosen in that one
application (whether repeated partial use is allowed is pending, POL-010 / DEC-058); percentage
taxes and fees rounded half up per line (DEC-007).

## Journey fixes (review stage 2) — verified

- SPK-AT-001, SPK-IAM-003, §4.10: the basket owner who may register but not pay a participant gets
  403 `PARTICIPANT_AUTHORITY_REQUIRED` (`details { permission: 'pay', participantPersonIds }`) from
  `POST /registration-quotes`, and the quote's payer whose pay authority lapsed gets it from
  `POST /registration-checkouts`; an owner who named another payer gets `ACCESS_DENIED`; everyone else
  still gets `NOT_FOUND`. `apps/api/src/__tests__/journeys/spk-at-001.spec.ts`.
- SPK-AT-028, §5.8: money commands are `@RefusedDuringRecovery()` (503 `INTEGRATION_UNAVAILABLE`
  `recovery_mode` while the organization recovers from a restore); payment and refund reconcile and
  settlement reconciliation stay allowed; installment collection starts no new charge; the
  `finance.provider_facts` recovery check blocks resuming until no payment or refund outcome is
  unresolved and a processor settlement since the restore balances.
  `apps/api/src/__tests__/journeys/spk-at-028.spec.ts`. A provider feed that recreates post-backup
  facts is **Pending decision** (DEC-019).

## Stage 3 (FIN-01..FIN-07)

Verified by `__tests__/money-reads.spec.ts`, `standing-notices.spec.ts`, `point-of-sale.spec.ts`,
`accounting-export.spec.ts`, `services/pos/pos-charges.spec.ts` and
`services/customer-scope.spec.ts` (PGlite and `TEST_DATABASE_URL` PostgreSQL) unless marked
**Proposed** or **Pending decision**.

### Customer and staff money reads (FIN-01, FIN-02) — verified

| Method | Path                                                                       | Who                                                                                            |
| ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/me/orders`, `/me/registration-checkouts`, `/me/payments`, `/me/receipts` | the caller as payer: themselves and every person they hold `pay` over (customerSubjects, K-05) |
| GET    | `/me/contribution-requests`                                                | the requested player (customerSubjects of `finance.pay_contribution`)                          |
| GET    | `/orders`, `/payments`, `/refunds`                                         | finance readers only (`finance.read_checkout` staff roles); a customer gets `ACCESS_DENIED`    |
| GET    | `/payments/{id}`                                                           | as before; now `PaymentDetail`: the attempt plus `refundableMinor` and its earlier `refunds`   |
| GET    | `/obligations`, `/credits`                                                 | as before; now keyset-paged with a stable cursor (`nextCursor`)                                |

- Every list is keyset-paged (`created_at desc, id desc`; obligations `due_at asc, id asc`), so
  a row inserted between pages is neither repeated nor skipped. Payer ids are expanded with
  identity's `personIdsResolvingTo` (ID-01), so a merged duplicate's history shows under the
  survivor without rewriting a financial row. `/me/registration-checkouts` covers checkouts the
  caller pays or started, and shows `recovery_required` ones (SPK-PAY-007, §4.11).
- `GET /obligations/{id}` carries `liveAttempt` (`id`, `status` `created`/`action_required`/
  `processing`/`unknown`, amount, currency, `unknownSince`, `createdAt`) or `null`: staff see any
  live charge; a customer sees the one they started (contributions model) or any live charge of a
  debt they may pay, so the payer is told not to pay again (SPK-PAY-007).
- `PAYMENT_OUTCOME_UNKNOWN` carries `details { attemptId, paymentAttemptId, purpose, status }` for
  the attempt's payer and staff, and only `{ purpose, status }` for anyone else (§4.10). Starting a
  second charge while one is live is refused with it (`code: PAYMENT_IN_PROGRESS`).
- Wording (mobile registration review, the API wins): `created` and `processing` answer
  `nextAction` `await_payment_confirmation` ("Payment processing"); only `action_required` asks
  the payer to act (`complete_payment_action`, "Payment needs your action"); `unknown` answers
  `await_reconciliation`. The `PaymentAttemptStatus` schema description states this mapping.
  **Pending:** `docs/package-a/journeys.md` §3 still groups `created` with `action_required`
  under "Payment needs your action"; the correction is outside this module's files and is left
  to the documentation refresh.
- `CashTendersService.listForPersons` (IF-08, without evidence) for other modules' reads; the
  fake payment adapter is listed in the integration register as `finance.payment_provider`
  (gate `payments`, production not allowed).
- Migration `0606_finance_customer_read_indexes.sql`: payer indexes on checkouts, payment
  attempts and receipts; `(requested_person_id, status)` on contribution requests; created-at
  indexes for the staff lists.

### Financial standing, checkout operation, notices (FIN-03, FIN-04, FIN-05) — verified

- `FinancialStandingService` is registered as entry's `FINANCIAL_STANDING_IMPL` (IF-39): the
  open obligations due by the arrival time that the person owes, is responsible payer of, or that
  belong to an order registering them as participant; `outstanding` names the earliest-due one and
  whether it is `related` to the activity's offering; a failed read is `unknown`, never a guess.
  Whether a balance blocks arrival is entry's decision (POL-017 / DEC-056 **Pending decision**:
  informational by default). `ParticipationStandingService` (competition's
  `FINANCIAL_CONDITIONS_IMPL`) reads through the same service.
- The checkout passes its operation id to enrollment's `BASKET_PORT.startCheckout`,
  `finishCheckout` and `failConfirmation` (IF-30), so an enrollment names the checkout operation
  (SPK-UX-001). Verified at the port boundary; the enrollment side (ENR-06) is merged separately.
- Finance notices through communications' `NotificationsService.composeAndQueueIn` in the
  handler's transaction: contribution requested (to the requested player), payment failed (to the
  payer; not for POS or installment attempts), installment failed and installment due. Each is
  keyed by its source event, so a replay queues nothing new. Kind `payment_attention`; the wording
  is not a policy value (communication policy DEC-012 **Pending decision**).

### Point of sale (FIN-06) — verified, behind capability `point_of_sale`

Enabled per organization by its capability switch (default off), naming its applicability
decision: DEC-079 "Point of sale" within DEC-016 "Conditional capability applicability", both
**Pending decision**. Disabled: creating or changing products, creating registers, opening a
session, starting a sale, adding a line or a tender are refused (`ACCESS_DENIED`,
`details.code: CAPABILITY_DISABLED`); retiring, closing a session, voids, returns and reads are
never gated (DEC-016).

| Method   | Path                                                                                                             | Who (action)                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| POST/GET | `/pos-products`, PATCH `/pos-products/{id}`, POST `/pos-products/{id}/retire`                                    | finance operator, GM (`finance.manage_pos_products`); read `finance.read_pos`   |
| POST/GET | `/pos-registers`, POST `/pos-registers/{id}/retire`                                                              | finance operator, GM (`finance.manage_pos_registers`) within facility scope     |
| POST/GET | `/pos-registers/{id}/sessions`, GET `/pos-register-sessions/{id}`, POST `/pos-register-sessions/{id}/close`      | front desk, finance operator (`finance.operate_register`) within facility scope |
| POST/GET | `/pos-sales`, `/pos-sales/{id}`, POST `/pos-sales/{id}/lines`, `/pos-sales/{id}/tenders`, `/pos-sales/{id}/void` | `finance.operate_register`; read `finance.read_pos`                             |
| POST     | `/pos-sales/{id}/returns`                                                                                        | finance operator, GM (`finance.approve_pos_return`)                             |
| GET      | `/pos-sales/{id}/receipt`, `/me/pos-receipts`                                                                    | facility staff, or the customer the sale names (`finance.read_pos_receipt`)     |

- Reads: finance operator, GM, system administrator and support operator hold
  `finance.read_pos` / `finance.read_pos_receipt`; the front desk reads the sales, sessions,
  products and receipts at its facility through `finance.operate_register`
  (`services/pos/pos-access.ts`), so it holds no finance-area read and `GET /v1/me/permissions`
  shows it no finance area while POS is off (SPK-UX-005). Whether a desk running a register sees
  a finance area once POS is enabled follows the kernel's **Proposed** navigation mapping.
- Migration `0607_finance_point_of_sale.sql`: `pos_products` (merchandise, concession or
  service; SKU unique per organization; never a registration, SPK-PAY-012), `pos_product_charges`
  (the approved `tax_fee` policy keys of a product), `pos_registers`, `pos_register_sessions` (one
  open per register; facility-local business date; counted cash and variance once closed),
  `pos_sales`, `pos_sale_lines` and `pos_returns` (append-only), `pos_tenders`; payment attempts
  gain purpose `pos_sale`, refundable funds can name a POS card tender, and the ledger gains
  `pos_revenue`, `taxes_payable` and `fees_payable`.
- Database guarantees: a sale's total is subtotal plus charges and is recomputed by the line
  trigger only while the sale is open; tenders never exceed the total and attach only to an open
  sale; a card tender names its payment attempt, an external one its evidence (SPK-PAY-012); a
  return never exceeds a line's sold quantity or the paid amount (constraint trigger, two
  concurrent returns cannot both pass, also under PostgreSQL); a cash return names an open drawer
  session; machine guards refuse every transition the `PosSale`, `PosTender`, `PosRegisterSession`
  machines (`finance.state-machines.ts`) do not allow.
- Taxes and fees come only from approved catalog `tax_fee` policy versions (CAT-02, DEC-057):
  a product key with no approved, effective version refuses the line
  (`CHARGE_POLICY_NOT_APPROVED`; malformed content `CHARGE_POLICY_INVALID`; another currency
  `CHARGE_POLICY_CURRENCY_MISMATCH`), and each line snapshots the version id. **Proposed** reading of the
  content (pending DEC-057): a rate in basis points applied once per line to its base and rounded
  as the version says, or a fixed amount per unit; the charge is added on top of the price.
- Tenders: cash (into the open session's drawer), external with evidence, or card through
  `PaymentsService` (§4.11: unit of work, provider call outside it, outcome recorded; an unknown
  outcome stays `pending`). A sale is `paid` when settled tenders cover the total; it posts
  `cash_on_hand` (cash and external tenders) and `cash_processor` (card tenders, less processor
  fees) against `pos_revenue`, `taxes_payable` and `fees_payable`. A void
  is only for an open sale without card tenders (`SALE_HAS_CARD_TENDER`).
- Returns post a reversing journal; returned amounts are split per unit by largest remainder, so
  returning every unit returns exactly what was paid (SPK-PAY-010); a card return reserves and
  executes a provider refund against the card tender (SPK-PAY-008); a cash return pays out of an
  open drawer session.
- Closing a session computes expected cash (float plus settled cash of the session's sales minus
  cash returns) and records the variance; a non-zero variance raises
  `finance.pos_register_variance` for the finance operator (POL-018 **Pending decision** for any
  tolerance; none is assumed).
- Events `finance.pos_sale_changed`, `finance.pos_register_session_closed` (IF-49).

### Accounting export (FIN-07) — verified, behind capability `accounting`

Enabled per organization by its capability switch (default off), naming DEC-081 "Accounting
integrations" within DEC-016, both **Pending decision**; the connection itself is DEC-022
(**Pending decision**). Disabled: proposing or approving a mapping, preparing or submitting a
batch are refused (`CAPABILITY_DISABLED`); retiring a mapping, canceling a prepared batch, reads,
outcome recording and reconciliation are never gated.

| Method   | Path                                                                                                 | Who (action)                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| POST/GET | `/accounting-mappings`, POST `/accounting-mappings/{id}/approve`, `/accounting-mappings/{id}/retire` | propose/retire: finance operator; approve: finance operator or GM other than the proposer |
| POST/GET | `/accounting-export-batches`, GET `/{id}`, POST `/{id}/submit`, `/{id}/cancel`                       | finance operator (`finance.export_accounting`); read `finance.read_accounting`            |

- Migration `0608_finance_accounting_export.sql`: `accounting_mappings` (four eyes enforced by
  the database: the approver is not the proposer; one approved mapping per ledger account),
  `accounting_export_batches` (status machine guard, idempotency key unique per organization,
  `sha256:` checksum of the exported lines), `accounting_export_lines` (one side per line; a
  journal entry has at most one live export line; lines never change except leaving the live set
  when their batch is rejected or canceled).
- No default mapping exists: a batch is prepared only when every account of its entries has an
  approved mapping, else `ACCOUNTING_MAPPING_REQUIRED` naming the accounts (SPK-PAY-011, DEC-022).
  Corrections are later journals exported in a later batch; an exported batch never changes
  (SPK-PAY-010).
- Submission follows §4.11 (unit of work 1 records `submitted`, the connection is called outside a
  transaction with the batch's idempotency key, unit of work 2 records accepted, rejected or
  unknown). The periodic job `finance.reconcile_accounting_exports` (every 60 s, failure owner
  finance operator) asks about `unknown` batches and `submitted` ones older than
  `FINANCE_ACCOUNTING_SUBMIT_STALE_SECONDS` (technical setting, default 300) and resubmits with
  the same key when the connection has no record. Exceptions:
  `finance.accounting_export_unknown`, `_rejected`, `_conflict`.
- `ACCOUNTING_EXPORT_PORT` has only `FakeAccountingProvider` (success, rejection, timeout/unknown,
  duplicate submission), refused in production; registered as integration
  `finance.accounting_export` (gate `accounting`). Events `finance.accounting_mapping_changed`,
  `finance.accounting_batch_changed` (IF-37).

### Stage-3 gaps and dependencies

- Tests use doubles (`__tests__/stage3-doubles.ts`) for port members other work items implement:
  identity's `personIdsResolvingTo` (ID-01) and `subjectsWithPermission` (ID-09), and catalog's
  `tax_fee` policy kind (CAT-02). Each double answers only while the real member is still
  declared but not implemented, so the tests exercise the real implementation once those merge.
  In production code, `personIdsOf` (`services/customer-scope.ts`) answers the person's own id
  while `personIdsResolvingTo` is still declared but not implemented, so the `/me` lists and the
  arrival standing read the person's own records (as before merges were resolvable) instead of
  failing; once ID-01 is merged a survivor also sees the records of the people merged into it.
- A POS card tender needs a sale customer (`CARD_TENDER_NEEDS_CUSTOMER`): a payment attempt always
  has a payer; anonymous card sales depend on the processor (DEC-019 **Pending decision**). A
  zero-total sale cannot be paid. Refunding a cash or external POS tender is a drawer payout or an
  external fact, not a provider refund.
- The accounting export sends journal entries as booked; revenue recognition, payroll and
  account-level summaries are not exported (DEC-022, DEC-052 **Pending decision**).
- `docs/api/openapi.json` and the generated API client are regenerated at integration (outside
  this module's files), so their parity tests stay stale until then.

## Known gaps

- Disputes and chargebacks are not modelled: the fake provider reports none and the dispute flow
  depends on the processor (DEC-019); the report shows zero with that note.
- A refund released after the reconciliation threshold ("no provider record") that the provider
  later reports as succeeded is not re-reserved or re-booked: it stays visible as the critical
  exception `finance.refund_evidence_conflict` (a design decision against the refundable check is
  pending).
- Compensation does not yet release the order's discount redemptions (per-person discount limits),
  and an open future installment obligation partly paid before compensation is canceled for its
  full amount (the same as abort).
- `written_off` obligations, credit revocation and the accounting of credit expiry (breakage) have
  states but no commands yet; expired credits read as `expired` and cannot be redeemed.
- Revenue recognition (deferred → earned) is not implemented (DEC-022); the accounting export
  (FIN-07) exports journal entries as booked, behind the `accounting` capability.
- Refunds go through the provider only; refunding a cash tender is not supported. Returning an
  overpayment by refund (instead of approving the held credit) has no dedicated command.
- Finalization is all-or-nothing per checkout: one refused line sends the whole checkout to
  recovery (partial-fulfillment baskets, DEC-026, are not split at payment time).
- A plan whose installment failed its final attempt is not marked `defaulted` automatically; the
  owned exception asks the finance operator to decide.
- `FINANCIAL_CONDITIONS_IMPL` (competition match readiness, `ParticipationStandingService`) reports
  an open team obligation as `unknown`: whether a team balance blocks play is undecided (POL-017,
  DEC-056), so it is never a pass or a block until the policy is approved.
- The money side of transfers and cancellations is answered (consequence) but not executed
  automatically (no automatic refund, credit or charge from enrollment's commands).
- Point of sale and accounting export: see [Stage 3](#stage-3-fin-01fin-07) for their own gaps.

## Kernel limitations worked around here

- Outbox and inbox handlers receive the transaction but not the kernel's transaction context; the
  module binds it with `runWithTransaction` so every port read goes through it.
- Catalog's and competition's ports read through their root database when no transaction is
  passed; finance always passes the active transaction inside a unit of work (and reads before the
  transaction otherwise).
- Enrollment's `BasketsService.hold` opens its own unit of work, so §4.11 step 3 (holds) commits
  before step 4 (order, operation, checkout); a failure in between leaves held capacity that the
  hold expiry releases.

## Stage-3 integration fixes — verified 2026-10-29

- Booking deposits (§3.16, POL-040; DEC-073 **Pending decision**): a quote for a rental or party
  whose approved booking terms name an `installmentPolicyKey` is quoted on that approved
  `installment` policy version (`installments` 2 to 24 and `intervalDays`, recorded as the quote's
  `installmentPolicyVersionId`); asking for another count is refused (`BOOKING_DEPOSIT_PLAN_FIXED`),
  mixing bookings with different plans is refused (`BOOKING_DEPOSIT_PLANS_DIFFER`), and a missing
  or incomplete policy refuses the quote (`BOOKING_DEPOSIT_POLICY_MISSING`,
  `BOOKING_DEPOSIT_POLICY_INCOMPLETE`) instead of assuming a default. Whether such a booking may be
  paid in full instead is not answered by the terms (**Pending decision**, POL-040). Found and
  verified by `apps/api/src/__tests__/journeys/spk-cond-003-rentals.spec.ts`.
- `docs/api/openapi.json` and the API client are regenerated (the parity test passes); the
  `stage3-doubles.ts` test doubles remain for module tests, while the journeys run the real
  identity and catalog members (`pos-to-accounting-export.spec.ts` approves a real `tax_fee`).
