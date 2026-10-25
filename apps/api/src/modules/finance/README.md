# finance module

**Owns:** quotes and quote lines, orders and order lines, obligations, contribution requests,
payment attempts, receipts, refundable funds and refund attempts, credits and their redemption
history, the journal subledger (journals and journal entries), payment allocations, installment
plans and installments, cash and external tenders, settlement reconciliations, checkouts

**Specification:** §3.15 (SPK-PAY-001..012), §4.4 Finance (Quote, Order, OrderLine, Obligation,
PaymentAttempt, RefundAttempt, Credit) and Accounting support (Journal, JournalEntry,
PaymentAllocation, SettlementReconciliation), §4.5 ("Payment must not reduce provider outcomes to
only paid/refunded", `Offering.priceCents` → versioned price rules and quotes), §4.6
PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7, §4.8
(`POST /v1/registration-quotes`, `POST /v1/registration-checkouts`, `POST /v1/payments/{id}/refunds`),
§4.11 (all ten steps), §4.12, SPK-AT-006, SPK-AT-007, SPK-AT-022, SPK-AT-023 (financial parts)

**Migration range:** `packages/db/migrations/0600_finance_*.sql` … `0699` (this module uses `0600`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`; relationship authority through the kernel),
catalog (`PRICING_PORT` for price rules, discount evaluation and redemption; `POLICY_PORT`;
`OFFERING_LOOKUP_PORT`), competition (`TEAM_ENTRY_QUERY_PORT` for team obligations and
contribution requests; team roles through the kernel), enrollment (`BASKET_PORT`,
`ENROLLMENT_PORT`, and its exported `BasketsService.hold` command for §4.11 step 3). It never
writes another module's tables (§4.2); composite foreign keys reference their rows read-only.

**Status: implemented** — verified by `apps/api/src/modules/finance/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL) and the unit specs next to the code
(`pricing/quote-calculator.spec.ts`, `ledger/ledger.service.spec.ts`,
`providers/fake-payment.provider.spec.ts`). Statements below are verified unless marked proposed
or pending.

## Tables (migration `0600_finance_core.sql`)

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
  checkout, per installment and per payer and obligation; one succeeded attempt per checkout; one
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
  contribution request can only reference a `team_with_contributions` obligation.
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
authority (§4.10); organization scope comes from the token. A captain sees a team obligation's
totals and each requested contribution's amount and status, never a player's payment or method.

## Ports

- `PAYMENT_PROVIDER_PORT` (`PaymentProviderPort`, `finance.ports.ts`): `createPayment`,
  `retrievePayment`, `createRefund`, `retrieveRefund`, `verifyWebhook`; every call carries the
  attempt id as idempotency key; a thrown error is an unknown outcome. Only
  `FakePaymentProvider` exists (deterministic by payment-method token: succeed, require action,
  decline, asynchronous processing, timeout after capture, timeout after decline, unreachable;
  scriptable payments and refunds; signed webhooks for duplicates and reordering). The port refuses
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
  executes requested refunds (customer and compensation), reconciles stale or unknown payment and
  refund attempts with the provider, collects due installments and retries.

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
  worker sweep resolves it; "no provider record" for a submitted attempt is authoritative absence.
- **Webhooks (§4.11):** authenticated, recorded once in the inbox, applied through the state
  machine: duplicates do nothing, an older non-terminal event never moves a resolved attempt back,
  and a contradiction (`succeeded` after `failed`) raises `finance.payment_evidence_conflict` and
  changes nothing. Unmatched events raise `finance.unmatched_provider_event`.
- **Finalization (SPK-AT-023):** confirmations go through enrollment's `EnrollmentPort` in one
  transaction with the order and checkout; an unexpected failure leaves the checkout `finalizing`
  for the durable follow-up; replays confirm nothing twice and post no journal.
- **Recovery (§4.11, SPK-AT-006):** a refused finalization after payment is `recovery_required`
  (checkout, order fulfillment, operation) with exception `finance.fulfillment_incomplete`; a place
  taken by a waitlist offer is never displaced; definitive failures are compensated per policy
  (refund by default), others wait for staff `recover` or `compensate`.
- **Refunds (SPK-PAY-008, SPK-AT-007):** reserved by conditional UPDATE before execution; of two
  concurrent 60% refunds exactly one reserves (also under PostgreSQL); an unknown result keeps the
  reservation (REFUND_PENDING) until evidence settles or releases it.
- **Team billing (SPK-PAY-004/005, SPK-AT-022):** contribution payments that together exceed the
  remaining balance allocate exactly the remaining amount; the excess stays visible on the receipt
  and the obligation (`excessMinor`), sits in `overpayment_liability`, and is held as a credit
  pending finance approval with an exception (POL-015 proposed default).
- **Installments (SPK-PAY-006):** explicit authorization at checkout; due now is the first
  installment; notices three days before; collection by the worker with the authorized method; a
  failure is a financial state plus exception `finance.installment_failed` and event
  `finance.installment_failed` — the enrollment stays as it is (participation consequences are
  evaluated separately, POL-017); extensions reset the attempts.
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
minutes; percentage taxes and fees rounded half up per line (DEC-007).

## Known gaps

- Disputes and chargebacks are not modelled: the fake provider reports none and the dispute flow
  depends on the processor (DEC-019); the report shows zero with that note.
- `written_off` obligations, credit revocation and the accounting of credit expiry (breakage) have
  states but no commands yet; expired credits read as `expired` and cannot be redeemed.
- Revenue recognition (deferred → earned) and the accounting export are not implemented (DEC-022).
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
- List endpoints return one page (`nextCursor: null`).

## Kernel limitations worked around here

- Outbox and inbox handlers receive the transaction but not the kernel's transaction context; the
  module binds it with `runWithTransaction` so every port read goes through it.
- Catalog's and competition's ports read through their root database when no transaction is
  passed; finance always passes the active transaction inside a unit of work (and reads before the
  transaction otherwise).
- Enrollment's `BasketsService.hold` opens its own unit of work, so §4.11 step 3 (holds) commits
  before step 4 (order, operation, checkout); a failure in between leaves held capacity that the
  hold expiry releases.
