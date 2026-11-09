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
`0600`–`0617` and `0680`)

**Depends on:** identity (`PERSON_DIRECTORY_PORT`; relationship authority through the kernel),
catalog (`PRICING_PORT` for price rules, discount evaluation and redemption; `POLICY_PORT`;
`OFFERING_LOOKUP_PORT`), competition (`TEAM_ENTRY_QUERY_PORT` for team obligations and
contribution requests; team roles through the kernel), enrollment (`BASKET_PORT`,
`ENROLLMENT_PORT`, and its exported `BasketsService.hold` command for §4.11 step 3),
communications (`NotificationsService.composeAndQueueIn` for finance notices, FIN-05). It
registers `FINANCIAL_STANDING_IMPL` (entry's `FinancialStandingPort`, FIN-03) and never writes
another module's tables (§4.2); composite foreign keys reference their rows read-only.

**Status: implemented** — verified by `apps/api/src/modules/finance/__tests__` (PGlite and
`TEST_DATABASE_URL` PostgreSQL; stage-5 review fixes in `money-guards.spec.ts`,
`pos-money.spec.ts` and the specs named in each note) and the unit specs next to the code
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
| `installment_plans`            | Order, payer, total, count, payment authorization (opaque method reference, never returned), retry policy, notice policy, policy version, `active/completed/defaulted/canceled`; hold time and reason (`0613`, MONEY-04)                                                                        |
| `installments`                 | One obligation each; amount, due date and original due date, `scheduled/paid/failed/canceled`, attempts, failure reason, next retry, extensions, notice sent                                                                                                                                    |
| `checkouts`                    | CheckoutMachine status, payment kind (`provider/cash/none`), holds, enrollments, current payment attempt or tender, operation, failure and recovery details (plan, refund, credit, exception)                                                                                                   |
| `payment_attempts`             | PaymentAttemptMachine status, purpose (`checkout/obligation/contribution/installment`), provider, opaque payment-method reference, provider reference, action payload, failure reason, fee, evidence source/inbox event/sequence, submitted, unknown                                            |
| `receipts`                     | Money actually received (one per payment attempt or tender): amount = allocated + visible excess, processor fee, journal — append-only                                                                                                                                                          |
| `payment_refundables`          | Per captured payment: captured, refunded, reserved, compensated (`0612`)                                                                                                                                                                                                                        |
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
  worker can never charge the same debt beside it; `0611`: one live checkout, installment or
  direct-payment charge per obligation, so a collection and a payer's own payment of the same
  installment cannot both charge, MONEY-07); one succeeded attempt per checkout
  (`payment_attempts_one_success_idx`) and one live or succeeded compensation refund per checkout
  (`refund_attempts_live_compensation_idx`; both proven refused, R4-DB-INVARIANTS-11); one
  credit per source fact (an in-process caller may name the source of an adjustment credit —
  migration passes the imported balance's mapping id — and a second credit for it is refused with
  `CREDIT_ALREADY_ISSUED_FOR_SOURCE`; `POST /credits` never takes one); one redemption per credit
  and reference; one reversal per journal, entry and redemption.
- **SPK-PAY-006, §4.11 step 10 (`0613`, MONEY-04):** a plan's hold is a time and a reason set
  together, recorded once and never changed or cleared (`installment_plans_hold_recorded`), and no
  installment payment attempt can name an installment of a held plan
  (`payment_attempts_installment_plan_held`).
- **SPK-PAY-006 / SPK-PAY-004 (`0617`, R3-TIME-MONEY-08):** a plan's installments add up to its
  total, checked at commit when a plan is created or its total changes and when an installment is
  created, removed or its amount or plan changes (`installment_plans_total_matches_installments`;
  `__tests__/credits-installments.spec.ts`). `0617` also gave every earlier plan the sum of its
  installments as total.
- **§4.7 invariant 6 / SPK-PAY-008:** `payment_refundables_within_captured`
  (`refunded - reversed + reserved + compensated <= captured`, `0612`, `0681`); captured is
  fixed, refunded, compensated (what a compensation credit took, MONEY-02) and reversed (refunds
  the provider reported failed after success, R4-PROVIDER-OUTCOMES-02) only accumulate; reversed
  never exceeds refunded and always equals the payment's refunds marked reversed (checked at
  commit on every insert, update and delete of either side: `0681` for updates, `0684` for
  inserts and deletes), and a refund is reversed once and only when it succeeded.
- **§4.7 invariant 7 / SPK-PAY-009:** `remaining_minor >= 0`, `remaining <= original`, and a
  deferred constraint trigger keeps `remaining = original - redeemed + reversed`, so a balance is
  never overwritten. A reversal gives back only a `redeem` row of the same credit (composite key
  `credit_redemptions_reversal_same_credit_fk`), the same reference, currency and amount
  (`credit_redemptions_reversal_matches`, `0683`, R4-DB-INVARIANTS-02).
- **SPK-PAY-010:** journals, entries, receipts, allocations, redemptions, quote lines, order lines
  and settlement reconciliations are append-only (`forbid_mutation`); a deferred constraint trigger
  refuses a journal that does not balance in one currency with at least two lines; an entry is a
  debit or a credit.
- **SPK-PAY-004:** `allocated <= amount`, a deferred trigger keeps `allocated` equal to the
  allocation rows, allocations only accumulate, a settled obligation is fully allocated; a
  receipt's allocations always equal its allocated part in its currency (checked on every
  allocation that names it, migration 0602, so received money is never allocated twice); an
  allocation funded by a credit redemption names an unreversed `redeem` row in its currency and a
  redemption's allocations never exceed what it consumed (checked under a lock on the redemption,
  `payment_allocations_credit_redemption_consistent`, `0682`, R4-DB-INVARIANTS-01); a
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

| Method   | Path                                                                                        | Who (action)                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST/GET | `/registration-quotes`, `/registration-quotes/{id}`                                         | the payer holding `pay` over every participant (adult self) or desk staff (`finance.create_quote`)                                               |
| POST/GET | `/registration-checkouts`, `/registration-checkouts/{id}`                                   | same (`finance.checkout`); cash tenders only by desk/finance staff (`finance.record_tender`)                                                     |
| POST     | `/registration-checkouts/{id}/payments`, `/abort`                                           | the payer or desk staff                                                                                                                          |
| POST     | `/registration-checkouts/{id}/recover`, `/compensate`                                       | finance operator, general manager, system administrator (`finance.recover_checkout`)                                                             |
| GET      | `/orders/{id}`, `/payments/{id}`, `/refunds/{id}`, `/installment-plans/{id}`                | the payer or finance readers (`finance.read_checkout`)                                                                                           |
| POST     | `/payments/{id}/refunds`, `/payments/{id}/reconcile`, `/refunds/{id}/reconcile`             | finance roles (`finance.refund`, `finance.reconcile_payment`)                                                                                    |
| POST/GET | `/obligations`, `/obligations/{id}`                                                         | create: finance operator, league manager, GM; read: debtor (`view`), team captain, responsible payer, readers                                    |
| POST     | `/obligations/{id}/payments`                                                                | debtor with `pay` (individual), the responsible payer (single payer), the captain (contributions)                                                |
| POST/GET | `/obligations/{id}/contribution-requests`, `/contribution-requests/{id}`, `/{id}/pay`       | request: captain or finance staff; read: the requested player, captain, staff; pay: the requested player                                         |
| POST/GET | `/credits`, `/credits/{id}`, `/credits/{id}/redeem`, `/credits/{id}/approve`                | issue/approve: finance roles; redeem: the owner (and entitled to pay the obligation) or desk staff                                               |
| POST     | `/installments/{id}/collect`, `/installments/{id}/extend`                                   | finance roles (`finance.manage_installments`)                                                                                                    |
| POST     | `/cash-tenders`                                                                             | front desk, finance operator, GM, sysadmin within their facility scope (`finance.record_tender`)                                                 |
| POST/GET | `/settlement-reconciliations`, `/finance/reconciliation-report`, `/finance/ledger-balances` | finance roles (`finance.reconcile`)                                                                                                              |
| POST     | `/webhooks/payments/{provider}`                                                             | public; signature verified with the host's `FINANCE_FAKE_WEBHOOK_SECRET`, else the published test constant (§4.14); recorded in the kernel inbox |

Every consequential POST is `@Idempotent()` and zod-validated; quote and checkout bodies are
strict and carry no amounts. Customer-private records (quotes, checkouts, orders, payments,
refunds, credits, obligations, contribution requests, plans) answer `NOT_FOUND` to anyone without
authority (§4.10); organization scope comes from the token. Finance-only commands (refund,
reconcile, approve a credit, collect or extend an installment, recover or compensate a checkout)
are authorized before the record is read, so a caller without the role gets `ACCESS_DENIED`
whether or not the record exists. A captain sees a team obligation's totals and each requested
contribution's amount and status, never a player's payment or method.

Staff powers come from the kernel, never from the principal's kind (R4-AUTHZ-TARGETS-01, §2.1,
SPK-IAM-001/003): `staffAuthority` (`finance.shared.ts`) asks the kernel for the action on a target
with no subject persons, so it passes only for a staff role that holds the action (or the
system actor). Quoting or checking out another payer's basket (`finance.create_quote`,
`finance.checkout`), redeeming a credit into any obligation (`finance.redeem_credit`), the
organization-wide obligation list, seeing every live payment on an obligation
(`finance.read_obligation`) and the attempt named in a `PAYMENT_OUTCOME_UNKNOWN` refusal
(`finance.read_checkout`) all go through it. A coach, official, scheduler or facilities operator
acting for their own family is a customer there: a co-guardian with that role gets `NOT_FOUND` for
another payer's quote or checkout, as a customer co-guardian does
(`__tests__/checkout.spec.ts`, `__tests__/obligations.spec.ts`). A responsible payer reads the
obligation they pay whatever staff roles they also hold (R4-AUTHZ-TARGETS-05).

## Ports

- `PAYMENT_PROVIDER_PORT` (`PaymentProviderPort`, `finance.ports.ts`): `createPayment`,
  `retrievePayment`, `cancelPayment` (abandoned challenges), `createRefund`, `retrieveRefund`,
  `verifyWebhook`; every call carries the
  attempt id as idempotency key; a thrown error is an unknown outcome. Only
  `FakePaymentProvider` exists (deterministic by payment-method token: succeed, require action,
  decline, asynchronous processing, timeout after capture, timeout after decline, timeout after
  opening a challenge, unreachable;
  scriptable payments, cancels and refunds; signed webhooks for duplicates and reordering). It
  signs and verifies webhooks with `FINANCE_FAKE_WEBHOOK_SECRET` when set (a staging host), else
  the published constant (`finance.settings.ts`; `__tests__/webhook-secret.spec.ts`). An
  adapter must bound `createRefund` below the reconciliation threshold. The port refuses
  to start in production (DEC-019 pending).
- Registers `FINANCE_POLICY_IMPL` for enrollment (`FinancePolicyAdapter`): cancellation
  consequences from the approved cancellation policy content (`refundBasisPoints` /
  `creditBasisPoints`, else `review_required`); transfers charge a higher price and credit a lower
  one (proposed, DEC-009).
- Fixtures for downstream tests: `testing/finance-fixtures.ts` (`createObligationFixture`,
  `createCreditFixture`, `createCapturedPaymentFixture`).

## Durable work

- Outbox handlers (all thirteen registered in `finance.module.ts`; the cross-module consumer
  inventory is `docs/architecture/overview.md` §7.1; R3-DOCS-TRUTH-3-08):
  - `finance.finalize_checkout` on `finance.checkout_payment_received` (§4.11 step 8, SPK-AT-023);
  - `finance.abort_expired_checkout` on its timer `finance.checkout_expiry_due`;
  - `finance.complete_compensation` on `finance.refund_settled`;
  - `finance.pos_return_refund_outcome` on `finance.refund_settled` (a failed card refund of a
    point-of-sale return is owned by the finance operator, FIN-06);
  - `finance.record_installment_notice` on its timer `finance.installment_notice_due`;
  - finance notices (FIN-05, R2-JOURNEYS-04): `finance.notify_contribution_requested` on
    `finance.contribution_requested`, `finance.notify_payment_reminder` on
    `finance.payment_reminder_requested` (park UI redesign payment reminders), `finance.notify_checkout_recovery` on
    `finance.checkout_recovery_required`, `finance.notify_checkout_compensated` on
    `finance.checkout_compensated`, `finance.notify_payment_failed` on `finance.payment_failed`,
    `finance.notify_installment_failed` on `finance.installment_failed`,
    `finance.notify_installment_due` on `finance.installment_notice`,
    `finance.notify_refund_reversed` on `finance.refund_reversed` (R4-PROVIDER-OUTCOMES-02: the
    payer of a compensation refund the provider reported failed after success is told it did not
    go through);
  - `finance.follow_person_merge` on `identity.persons_merged` (R2-LIFECYCLES-02, below).

  All are idempotent under replay. A change to the payload of `finance.refund_settled` reaches two
  of them (compensation and POS returns).

- Inbox handler `finance.apply_payment_event` for provider `fake-payments`.
- `FinanceWorker` (outside any transaction; started in non-test processes, `runOnce()` in tests):
  executes requested refunds (customer and compensation), cancels abandoned payment challenges at
  the provider, reconciles stale or unknown payment and refund attempts with the provider, collects
  due installments and retries (only for plans whose checkout was paid and fulfilled).

## Events (`finance.events.ts`)

`finance.quote_created`, `checkout_started`, `checkout_expiry_due`, `checkout_payment_received`,
`payment_received`, `payment_failed`, `payment_outcome_unknown`, `order_paid`,
`enrollment_fulfilled`, `checkout_recovery_required`, `checkout_compensated`, `checkout_aborted`,
`refund_requested`, `refund_settled`, `refund_reversed`, `credit_issued`, `credit_redeemed`, `overpayment_recorded`,
`obligation_created`, `obligation_settled`, `contribution_requested`, `installment_paid`,
`installment_failed`, `installment_notice_due`, `installment_notice`, `cash_tender_recorded`,
`settlement_reconciled`. Payloads carry identifiers and amounts only (§4.14).

## Behaviour notes — verified

- **Quotes (SPK-PAY-001/002/003):** prices come from catalog's price rule effective now (never the
  client), discounts from catalog's explainable evaluation, approved taxes and fees from the rule's
  charge lines (exclusive ones added, inclusive ones shown; several inclusive rates are extracted
  together, so a price of 10800 including 5% and 3% shows 500 and 300 included, R3-TIME-MONEY-09),
  credits the payer owns; the quote shows
  every line, totals, due now, future obligations, expiry and policies. Unknown discount codes are
  refused. A quote expires at the earlier of its validity and the basket's hold expiry.
- **Checkout (§4.11):** steps 1–10 as in `services/checkout.service.ts`. One checkout per quote: a
  replay (same or different key) never charges again. The provider is never called inside a
  transaction (`PaymentsService.execute` refuses). A decline leaves the checkout awaiting payment
  for a retry while the hold lasts; after the hold expires with no live payment the timer aborts it
  and reverses every financial effect (obligations, credit redemptions, discount redemptions,
  installments, basket). While a checkout awaits payment its order's obligations are paid only
  through it: a direct payment, a cash tender or a credit redemption into them is refused with
  `CHECKOUT_PAYMENT_PENDING` naming the checkout (MONEY-01). Money that reached such an order by
  another path is never charged again (a retry answers `CHECKOUT_MONEY_RECEIVED`) and an abort with
  it raises the critical exception `finance.aborted_order_money_received` for the finance
  operator.
- **Discount redemptions (SPK-PAY-003, R3-TIME-MONEY-01):** checkout redeems each applied
  discount once per participant whose lines it reduced, in that participant's name (never the
  payer's), referenced by the participant's first discounted order line (reference type
  `order_line`) and with the part of the discount allocated to their lines
  (`pricing/discount-redemptions.ts`); an abort releases exactly those references. A per-person
  limit therefore counts the participant both when catalog evaluates the quote and when its
  database guard (0207/0208) counts the redemption: a guardian paying for two children uses each
  child's allowance once, and two guardians paying for the same child share that child's one
  allowance (`__tests__/discount-redemption.spec.ts`). **Proposed engineering default, pending
  POL-011 / DEC-007:** every redemption also takes one unit of the discount's organization-wide
  `redemption_limit` (catalog counts one per redeem), so that limit counts discounted
  participants, not orders; catalog's quote evaluation discounts only as many participants, in
  line order, as the limit has redemptions left, and checks `minLines` again on them
  (**Verified**, R3-TIME-MONEY-01b: `catalog/pricing/discount-evaluator.spec.ts`; test "with one
  redemption left, two children are quoted the discount on the first child only and checkout
  completes"). A checkout prepared before this change recorded one redemption
  per discount for the whole order (reference `order`, the order id, in the payer's name); its
  abort, whenever it happens, releases that reference instead
  (`LEGACY_ORDER_REDEMPTION_REFERENCE`; test "a checkout prepared before per-participant
  redemption aborts and gives the redemption back").
- **Payment uncertainty (SPK-PAY-007):** a timeout is `unknown` with a critical exception owned by
  the finance operator; retries and aborts are refused until a webhook, staff reconciliation or the
  worker sweep resolves it. A direct payment, a cash or external tender and a credit redemption
  into an obligation are refused (`PAYMENT_OUTCOME_UNKNOWN`) while a checkout, installment or
  direct-payment charge of that obligation is in flight or unknown (MONEY-06). A record the provider has is applied at once; "no provider record" is
  authoritative absence only for an attempt never handed to the provider (decided under the row
  lock) or one submitted or gone unknown at least the reconciliation threshold ago, also when staff
  force the reconciliation. Every live attempt, an unsubmitted `created` one included, blocks abort
  and the abandonment timer until provider evidence resolves it (the stranded-attempt sweep looks it
  up), so a restored database never cancels a capture by assumption (SPK-AT-028). A payment
  challenge still open an hour after submission is treated as abandoned and canceled at the
  provider (proposed, DEC-019 pending); a cancel without an answer keeps the attempt live with an
  exception `finance.payment_action_abandoned`. The same applies to a challenge the payer never
  saw because the call that opened it timed out (R4-PROVIDER-OUTCOMES-01): non-terminal evidence
  never moves an `unknown` attempt, so when reconciliation (the sweep, or staff forcing it) finds
  the provider holding it in `requires_action` an hour after submission, it asks the provider to
  cancel it and applies the answer (canceled, or a capture that won the race), and the checkout,
  holds and payer are released (`__tests__/payment-evidence.spec.ts`; the fake's
  `timeoutRequiresAction` token reproduces it). Once evidence settles such an outcome its
  exception is resolved in the same transaction by the finance system actor, with the evidence as
  resolution (R4-PROVIDER-OUTCOMES-04, §5.11): `finance.unknown_payment_outcome` when the attempt
  leaves `unknown`, `finance.payment_action_abandoned` when it leaves `action_required` (or
  `unknown`), `finance.unknown_refund_outcome` when a refund leaves `unknown`; the finance
  operator's queue keeps only outcomes still unresolved. Conflict exceptions
  (`*_evidence_conflict`) stay open for review.
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
  apply, SPK-PAY-002), others wait for staff `recover` or `compensate`. A compensation credit is
  what was received and not already returned (per captured payment: captured less refunded; a cash
  tender in full) and consumes those refundable funds, so a later refund is refused beyond what is
  left; while a refund of the payment is still reserved staff get `REFUND_PENDING` and the
  automatic credit path leaves the checkout in recovery (MONEY-02). What a compensation credit took
  is shown beside what was captured, refunded and reserved (`compensatedMinor` on a refund's
  `refundable`, on `GET /payments/{id}` and in the `REFUND_EXCEEDS_REFUNDABLE` and
  `REFUND_PENDING` details), so an operator sees the money went back as credit. Completing a compensation
  restores the credits redeemed at checkout (booked refunds → credits payable, the receivable is
  not reopened) and cancels the installment plan, its scheduled installments and open obligations.
- **Refunds (SPK-PAY-008, SPK-AT-007):** reserved by conditional UPDATE before execution; of two
  concurrent 60% refunds exactly one reserves (also under PostgreSQL); an unknown or in-flight
  result keeps the reservation (REFUND_PENDING) until evidence settles or releases it; "no provider
  record" releases it only once the refund was submitted at least the reconciliation threshold
  ago. Refund evidence (synchronous answer, webhook, reconciliation) is compared with the refund
  attempt: another amount, currency or provider reference changes nothing and raises the critical
  exception `finance.refund_evidence_conflict` (MONEY-09). A refund recorded `succeeded` that the
  provider later reports `failed` returned no money (R4-PROVIDER-OUTCOMES-02, §4.11, SPK-PAY-010):
  the refund keeps its recorded state (the Refund machine forbids the flip) with `reversedAt`,
  the reversal is booked once (the reversing journal of its `refund_settled` posting, purpose
  `refund_reversed`), its amount is refundable again (`reversedMinor` on the refundable funds,
  `refundedMinor` is what was actually returned), settlement reconciliation counts it back in
  the period it was reversed, and the critical `finance.refund_evidence_conflict` stays open for
  the finance operator; a reversed compensation refund is not retried automatically. A later
  success report of a reversed refund books nothing and raises the conflict again. The reversal
  is read where the refund is: `reversedAt` on the refund, on each refund listed on
  `GET /payments/{id}` (the payer's and staff's payment detail) and as `refundReversedAt` on a
  point-of-sale return, so a reversed refund (status still `succeeded`) is never shown as money
  returned; event `finance.refund_reversed` names it once. The payer of a compensation refund
  whose checkout it compensated (and who was told "Your refund was made") is told it did not go
  through and that the facility will contact them (`finance.notify_refund_reversed`, once per
  reversal); a compensation refund already reversed when its `finance.refund_settled` is handled
  does not compensate the checkout (it stays `recovery_required`, plan `manual`, with the
  critical `finance.compensation_failed`), and the "refund made" notice is not sent for a refund
  reversed by then (`__tests__/finalization.spec.ts`, `__tests__/refunds.spec.ts`). Nothing is
  sent for a reversed customer refund: finance sent no "refund made" notice for it, and the
  finance operator owns the open conflict.
- **Team billing (SPK-PAY-004/005, SPK-AT-022):** contribution payments that together exceed the
  remaining balance allocate exactly the remaining amount; the excess stays visible on the receipt
  and the obligation (`excessMinor`), sits in `overpayment_liability`, and is held as a credit
  pending finance approval with an exception (POL-015 proposed default). A contribution request is
  payable only while its obligation is open. Redeeming a credit into a team obligation needs the
  same authority as paying it (responsible payer, or the captain in the contributions model).
- **Installments (SPK-PAY-006):** explicit authorization at checkout; due now is the first
  installment; the plan total is the order total, which its installments add up to, and credits
  applied in the quote are allocations against installment 1 (so installment 1 is due now plus
  the credits, and `outstandingMinor` counts what is still owed after them; R3-TIME-MONEY-08);
  notices three days before; collection by the worker with the authorized method; a
  failure is a financial state plus exception `finance.installment_failed` and event
  `finance.installment_failed` — the enrollment stays as it is (participation consequences are
  evaluated separately, POL-017); extensions reset the attempts and the notice, which goes out the
  plan's lead time before the new date; nothing is collected while the checkout's own payment is
  pending or its registration is not fulfilled; retry and notice terms come from the policy the
  quote recorded. Once every registration the order made is canceled, the plan is held (MONEY-04):
  a registration that was transferred counts as the enrollment it was transferred to, followed
  along `transferredToEnrollmentId` to the end of its chain (the order line keeps naming the
  source, R2-LIFECYCLES-01), so a transfer followed by a cancellation holds the plan while a
  transferred registration that still stands keeps collecting. The first collection or notice that
  finds it records the hold on the plan (`hold` on
  `GET /installment-plans/{id}`, `0613`) and raises `finance.installment_registration_canceled`
  once (finance operator); enrollment's own cancellation of the registration, with any accepted
  consequence other than `none`, also raises `enrollment.cancellation_consequence_pending` for the
  finance operator, plan or no plan. A held plan is never collected (the worker no longer selects it, a
  staff collection answers `INSTALLMENT_REGISTRATION_CANCELED`, and the database refuses an
  installment charge for it) and its payer is sent no installment notice. Resolving the exception
  neither lifts the hold nor raises it again; no command ends a hold yet: whether the remaining
  installments are owed follows the cancellation policy (DEC-009 **Pending decision**). Until that
  decision a held plan's open installment obligations still count as owed: once one falls due,
  financial standing (FIN-03) reports the participant `outstanding`. Collection and extension
  lock the obligation before its installment, the order the capture path uses (MONEY-07).
- **Cash (SPK-PAY-012):** permitted staff only, facility-scoped, with evidence; against an existing
  obligation or through the checkout (holds and capacity apply); reconciled per cash drawer.
- **Reconciliation (SPK-PAY-010/011):** balances are computed from journal entries; the report
  keeps orders, obligations, receipts, refunds, credits, processor fees, disputes, settlements and
  cash apart; revenue stays deferred (payment volume is not revenue). A processor settlement
  expects the provider's receipts and point-of-sale card captures (settled card tenders and late
  captures, which have no receipt) less their processor fees less settled refunds; the report's
  `processorFeesMinor` counts every processor fee and its `pointOfSale` section shows card,
  drawer (cash and external tenders), fees and returns beside receipts and cash tenders
  (MONEY-03).

## Policy defaults (proposed, pending operator decisions §6.6)

`finance.policy.ts` (`DEFAULT_FINANCE_POLICY`), overridable by approved catalog policy versions of
kind `installment` / `overpayment` / `refund` with key `finance` (the quote records which applied,
and for an installment version every term it leaves out as `installment.<term>: engineering
default <value>`, MONEY-08):
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
- SPK-AT-028, §5.8: money commands' HTTP routes are `@RefusedDuringRecovery()` (503
  `INTEGRATION_UNAVAILABLE` `recovery_mode` while the organization recovers from a restore), and
  `RefundsService.request`, `CreditsService.issue`, `ObligationsService.create` and
  `ObligationsService.pay` refuse in-process callers (support, automation, migration) the same way
  before recording anything (R3-OPERATIONS-02, `__tests__/recovery-in-process.spec.ts`); payment and refund reconcile and
  settlement reconciliation stay allowed; installment collection starts no new charge; the
  `finance.provider_facts` recovery check blocks resuming until no payment or refund outcome is
  unresolved and a processor settlement since the restore balances.
  `apps/api/src/__tests__/journeys/spk-at-028.spec.ts`. Every refused finance command, the
  point-of-sale and accounting ones included, publishes that 503 in its contract
  (`__tests__/recovery-contract.spec.ts`, R2-API-CONTRACT-03). A provider feed that recreates
  post-backup facts is **Pending decision** (DEC-019).

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
- SPK-IAM-007 (R2-LIFECYCLES-02): a merge rewrites no credit owner or obligation debtor; finance
  reads them through the survivor instead (`FinanceCustomerScope.idsOf` / `subjectOf`).
  `GET /credits?ownerPersonId=` and `GET /obligations?debtorPersonId=` with the survivor include
  the records merged into it; a merged owner's credit and a merged debtor's obligation are read,
  redeemed and paid under the survivor as the authorization subject (the merge moved the
  relationships and grants there; someone without authority over the survivor still gets
  `NOT_FOUND`); a quote and its checkout accept a credit owned by any record merged into the payer.
  The handler `finance.follow_person_merge` raises one `finance.merged_person_money` exception
  (finance operator) per merge that brings the survivor an active or pending credit with a
  balance or an open obligation owed or answered for, each row naming the record that holds it,
  so anything given or owed twice is reviewed; a merge that brings no money raises nothing, and a
  replay raises nothing new. Merges chain (A into B, later B into C): the B-into-C exception names
  A's money too, even when B holds none and A's own exception (raised for B) was resolved. The
  identity directory gives the survivor's whole merge tree, not the branch that just joined it, so
  the handler reads every record merged into the survivor and leaves out money an earlier
  exception of the same survivor already named (**limit:** money issued to a merged record after
  its own merge, which should not happen, would be named again at the survivor's next merge).
  A merged payer's payment, refund, checkout, order and installment plan are read under the
  survivor too, as the `/me` lists show them, and so are a contribution request asked of a merged
  record (read and paid) and a merged customer's point-of-sale receipt; the finance operator's
  `GET /orders?payerPersonId=` and `GET /payments?payerPersonId=` include the records merged into
  that payer, as `/credits` and `/obligations` do. Commands on a merged payer's checkout or
  payment (retry, abort, refund request) still name the stored payer and are done by staff.
  `__tests__/person-merge.spec.ts`.
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
  belong to an order registering them as participant; `outstanding` names the earliest-due one
  whose order has a line for the activity's offering (`related: true`) when there is one, otherwise
  the earliest-due one (`related: false`), so an older unrelated balance never hides a related one;
  a failed read is `unknown`, never a guess.
  Whether a balance blocks arrival is entry's decision (POL-017 / DEC-056 **Pending decision**:
  informational by default). `ParticipationStandingService` (competition's
  `FINANCIAL_CONDITIONS_IMPL`) reads through the same service.
- The checkout passes its operation id to enrollment's `BASKET_PORT.startCheckout`,
  `finishCheckout` and `failConfirmation` (IF-30), so an enrollment names the checkout operation
  (SPK-UX-001). Verified at the port boundary; the enrollment side (ENR-06) is merged separately.
- Finance notices through communications' `NotificationsService.composeAndQueueIn` in the
  handler's transaction: contribution requested (to the requested player), payment failed (to the
  payer; not for POS or installment attempts), installment failed and installment due, and (stage
  6, R2-JOURNEYS-04, SPK-AT-023) a checkout that could not finish after payment
  (`finance.notify_checkout_recovery` on `finance.checkout_recovery_required`: what happens to the
  money, a refund, a credit or staff contact) and its compensation
  (`finance.notify_checkout_compensated` on `finance.checkout_compensated`: the refund made or the
  credit added, with the amount; `__tests__/finalization.spec.ts` "§4.11 step 10: staff may
  compensate an unfulfillable checkout with a credit instead"). Each is keyed by its source event,
  so a replay queues nothing new. Kind `payment_attention`; the wording is not a policy value
  (communication policy DEC-012 **Pending decision**).

### Point of sale (FIN-06) — verified, behind capability `point_of_sale`

Enabled per organization by its capability switch (default off), naming its applicability
decision: DEC-079 "Point of sale" within DEC-016 "Conditional capability applicability", both
**Pending decision**. Disabled: creating or changing products, creating registers, opening a
session, starting a sale or adding a line are refused (`ACCESS_DENIED`,
`details.code: CAPABILITY_DISABLED`); a tender settling an existing open sale, retiring, closing a
session, voids, returns and reads are never gated (DEC-016), so a sale partly paid (a card tender
cannot be voided) when the switch is turned off is still completed, returned, and its session and
register closed through the API. The staff dashboard's sale page offers the tender form on an open
sale whatever the switch, and hides only adding a line while it is off (`SalePage.test.tsx`
"DEC-016 / CAPABILITIES-01: ...").

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
  `GET /pos-registers` and `GET /pos-products` without `facilityId` are narrowed to the
  facilities the caller's `read_pos` or `operate_register` roles cover (organization-wide
  products stay listed; §4.3, §4.14), as the per-record reads are.
- §4.9: lines, tenders, voids and returns compare the body's `expectedRevision` with the locked
  sale (`STALE_REVISION`), and recording a tender moves the sale's revision on, so a void or return
  decided on a view older than another operator's tender is refused instead of applied.
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
  concurrent returns cannot both pass, also under PostgreSQL; since `0610` the units one return
  names for the same line are summed first, MONEY-10; since `0615` every `saleLineId` is the
  canonical lower-case uuid text, refused otherwise with `pos_returns_line_id_canonical`, and lines
  are grouped and matched with earlier returns by uuid value, R2-SCHEMA-04; since `0616` every line
  is an object whose `quantity` is a whole JSON number from 1 and whose `amountMinor` is a whole
  JSON number from 0, refused otherwise with `pos_returns_line_shape`, so a missing or null value
  can no longer make the quantity and amount checks pass, R2-SCHEMA-04); a cash return names an open drawer
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
- A card capture the provider reports after its tender was recorded as failed is received money:
  besides its refundable funds and the critical exception `finance.pos_capture_after_failure`, it
  is booked once per attempt (`pos_capture_after_failure`: processor less fee against
  `overpayment_liability`, the fee kept on the attempt), and its refund settles that liability
  instead of booking a refund expense (MONEY-05).
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
  when their batch is rejected or canceled). Migration `0609_finance_export_line_guards.sql`
  (INTEGRITY-03): a line is added only to a `prepared` batch and within its line count, copies its
  journal entry's account, debit, credit and currency, and a batch commits holding exactly its
  `line_count` lines, so the database keeps an exported batch as it was sent. Migration
  `0614_finance_export_line_ledger_guards.sql` (R2-SCHEMA-02): a line is live when it is added
  (`accounting_export_lines_live_at_insert`, so no line escapes the at-most-once index while its
  batch can still be accepted), states its journal's `posted_at`
  (`accounting_export_lines_posted_as_booked`), and exports only an entry whose journal was posted
  inside the batch's `[periodStart, periodEnd)` (`accounting_export_lines_within_period`).
- No default mapping exists: a batch is prepared only when every account of its entries has an
  approved mapping, else `ACCOUNTING_MAPPING_REQUIRED` naming the accounts (SPK-PAY-011, DEC-022).
  Corrections are later journals exported in a later batch; an exported batch never changes
  (SPK-PAY-010).
- Submission follows §4.11 (unit of work 1 records `submitted`, the connection is called outside a
  transaction with the batch's idempotency key, unit of work 2 records accepted, rejected or
  unknown). The periodic job `finance.reconcile_accounting_exports` (every 60 s, failure owner
  finance operator) asks about `unknown` batches and `submitted` ones older than
  `FINANCE_ACCOUNTING_SUBMIT_STALE_SECONDS` (technical setting, default 300) and resubmits with
  the same key when the connection has no record; it renews its lease (`renewJobLease`, K-06)
  before each connection call and asks about nothing more once another runner holds the job
  (ASYNC-06). Exceptions:
  `finance.accounting_export_unknown` (resolved by the finance system actor when the answer
  arrives, R4-PROVIDER-OUTCOMES-04), `_rejected`, `_conflict`. Every batch transition is
  audited, the move to `unknown` included (`finance.accounting_batch_unknown` with the error).
- `ACCOUNTING_EXPORT_PORT` has only `FakeAccountingProvider` (success, rejection, timeout/unknown,
  duplicate submission), refused in production; registered as integration
  `finance.accounting_export` (gate `accounting`). Events `finance.accounting_mapping_changed`,
  `finance.accounting_batch_changed` (IF-37).

### Stage-3 gaps and dependencies

- The stage-3 port members finance depends on are merged and implemented: identity's
  `personIdsResolvingTo` (ID-01, `PeopleService`) and `subjectsWithPermission` (ID-09,
  `RelationshipAuthorityService`), and catalog's `tax_fee` policy kind (CAT-02). The doubles in
  `__tests__/stage3-doubles.ts` only stand in for module tests that do not load those modules;
  each answers only while the real member is declared but not implemented, so a test that loads
  the real module exercises it. `personIdsOf` (`services/customer-scope.ts`) keeps the same guard
  for a build without ID-01 and otherwise lets a survivor see the records of the people merged
  into it (**Verified**, prior DOCS-TRUTH-13).
- A POS card tender needs a sale customer (`CARD_TENDER_NEEDS_CUSTOMER`): a payment attempt always
  has a payer; anonymous card sales depend on the processor (DEC-019 **Pending decision**). A
  zero-total sale cannot be paid. Refunding a cash or external POS tender is a drawer payout or an
  external fact, not a provider refund.
- The accounting export sends journal entries as booked; revenue recognition, payroll and
  account-level summaries are not exported (DEC-022, DEC-052 **Pending decision**).

## Park UI redesign gaps — verified 2026-11-06

Verified by `__tests__/desk.spec.ts` and `__tests__/pos-line-quantity.spec.ts`:

- **Payment reminders** (`POST /v1/obligations/{id}/reminders`, `finance.send_payment_reminder`,
  finance roles): an open, past-due obligation with a balance; recorded in `payment_reminders`
  (migration 0685, append-only, past due and positive balance checked in the database), audited,
  announced as `finance.payment_reminder_requested`; handler `finance.notify_payment_reminder`
  composes an essential `payment_attention` notice to the debtor (or a team fee's responsible
  payer). One reminder per obligation per 24 hours: an engineering placeholder
  (`PAYMENT_REMINDER_MIN_INTERVAL_HOURS`), pending DEC-012/DEC-062. Staff obligation views carry
  `lastReminderAt`.
- **Person money summary** (`GET /v1/people/{id}/money-summary`, `finance.read_person_money`:
  desk, finance, general manager, system administration, support; the person and holders of `pay`
  over them): open balance, credits available and pending approval, receipts and succeeded refunds
  since 1 January (the facilities' zone when they share one, else UTC; said in the response), per
  currency, over merged records. Anyone else gets a protected NOT_FOUND.
- **Basket price** (`GET /v1/basket-prices/{id}`, `finance.read_quote`): the order's figures once
  checked out; else an estimate from the price rules and approved charges in effect, before
  discounts and credits; `unpriced` when a line has no rule. Never stored, never a quote.
- **POS line quantity** (`POST /v1/pos-sales/{id}/lines/{lineId}/quantity`, 0 removes): a new
  append-only line supersedes the old one (migration 0686: superseded once, same sale and product,
  quantity 0 only on a superseding line, never below the tenders taken; returns name live lines
  only). Totals, the paid journal, returns and receipts use the lines in effect.
  `PosSale.charges` lists the configured tax and fee lines. A household "account" tender (charging a
  sale to the customer's account) is **not** implemented: no specification rule or approved policy
  says how a POS sale becomes an obligation.

## Known gaps

- Disputes and chargebacks are not modelled: the fake provider reports none and the dispute flow
  depends on the processor (DEC-019); the report shows zero with that note.
- A refund released after the reconciliation threshold ("no provider record") that the provider
  later reports as succeeded is not re-reserved or re-booked: it stays visible as the critical
  exception `finance.refund_evidence_conflict` (a design decision against the refundable check is
  pending). The opposite contradiction, `failed` after `succeeded`, is booked as a reversal
  (R4-PROVIDER-OUTCOMES-02, above).
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
  DEC-056), so it is never a pass or a block until the policy is approved. **Verified:** the
  finding carries no count, amount or due date (deadline `null`) and no obligation id
  (R3-TRACE-B-01, `__tests__/fixture-conditions.spec.ts`). It names the team entry, and
  competition's `ReadinessService` scopes it by viewer (**Verified**, R3-TRACE-B-01b): for each
  competing entry it decides `finance.read_obligation` for the viewer; an admitted viewer (finance
  readers such as the league manager, the entry's captain or responsible payer) gets the
  entry-level finding with the formatted amount and the next due date, in the division facility's
  time zone, as its deadline (SPK-READY-003); every other viewer gets one fixture-level finding
  that names no entry and states no balance, the same whether or not any entry has one
  (`fixture-conditions.spec.ts`; competition `__tests__/readiness-finance-viewer.spec.ts`).
- Team entry financial status (R2-JOURNEYS-05, SPK-COMP-004, SPK-CAP-002) — **Verified**:
  `POST /v1/obligations` for a team entry records the obligation as the entry's
  `financialStatusRef` through competition's `TEAM_ENTRY_QUERY_PORT.recordFinancialStatusRef`, in
  the same transaction (competition audits it), and `ParticipationStandingService
.entryFinancialStatus` answers `none`, `clear` or `outstanding` (open count, remaining amount per
  currency in minor units, earliest open due date) from the entry's obligations that are not
  canceled. The captain workspace shows it (`__tests__/obligations.spec.ts` "R2-JOURNEYS-05").
- The money side of transfers and cancellations is answered (consequence) but not executed
  automatically (no automatic refund, credit or charge from enrollment's commands); a plan whose
  registrations were all canceled is held (no collection, no notice) and waits for the finance
  operator, with no command yet to end the hold, write off or cancel its installments (DEC-009).
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
  `BOOKING_DEPOSIT_POLICY_INCOMPLETE`) instead of assuming a default. The collection terms a
  deposit version may leave out (retry attempts and interval, notice lead time) take the
  engineering default, and the quote records each one taken in its `policies.defaults`
  (`installment.<term>: engineering default <value>`, MONEY-08). Whether such a booking may be
  paid in full instead is not answered by the terms (**Pending decision**, POL-040). Found and
  verified by `apps/api/src/__tests__/journeys/spk-cond-003-rentals.spec.ts`.
- `docs/api/openapi.json` and the API client are regenerated (the parity test passes); the
  `stage3-doubles.ts` test doubles remain for module tests, while the journeys run the real
  identity and catalog members (`pos-to-accounting-export.spec.ts` approves a real `tax_fee`).

## POS lists (FIN-08) — verified 2026-11-09

`GET /pos-registers/{id}/sessions` (most recently opened first, `status` filter) and
`GET /pos-register-sessions/{id}/sales` (newest first, `status` filter) list a register's sessions
and a session's sales in keyset pages for POS readers of the facility (`finance.read_pos`); a
customer or a role without it is refused, an unknown id is NOT_FOUND. The staff session page
(SCR-S-55) lists both. Test: `__tests__/pos-lists.spec.ts`.
