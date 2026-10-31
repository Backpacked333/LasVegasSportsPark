import { defineEvent, z } from '@sportspark/contracts';

/**
 * Finance domain events (§4.12). Payloads carry identifiers and amounts only — never card data,
 * names or child information (§4.14). Timer events (`*_due`) are enqueued with `availableAt` and
 * handled idempotently by this module; the others are facts for other modules (communications,
 * reporting, participation consequences of balances).
 */
const Org = { organizationId: z.uuid() };

export const QuoteCreated = defineEvent(
  'finance.quote_created',
  z.object({
    ...Org,
    quoteId: z.uuid(),
    basketId: z.uuid(),
    totalMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const CheckoutStarted = defineEvent(
  'finance.checkout_started',
  z.object({ ...Org, checkoutId: z.uuid(), orderId: z.uuid(), basketId: z.uuid() }),
);

/** Timer: an awaiting checkout with no live payment is aborted after its hold expiry. */
export const CheckoutExpiryDue = defineEvent(
  'finance.checkout_expiry_due',
  z.object({ ...Org, checkoutId: z.uuid() }),
);

/** Authoritative payment evidence for a checkout was recorded: finalize it (§4.11 step 8). */
export const CheckoutPaymentReceived = defineEvent(
  'finance.checkout_payment_received',
  z.object({ ...Org, checkoutId: z.uuid(), orderId: z.uuid(), receiptId: z.uuid().nullable() }),
);

export const PaymentReceived = defineEvent(
  'finance.payment_received',
  z.object({
    ...Org,
    receiptId: z.uuid(),
    paymentAttemptId: z.uuid().nullable(),
    cashTenderId: z.uuid().nullable(),
    obligationId: z.uuid().nullable(),
    amountMinor: z.number().int(),
    allocatedMinor: z.number().int(),
    excessMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const PaymentFailed = defineEvent(
  'finance.payment_failed',
  z.object({
    ...Org,
    paymentAttemptId: z.uuid(),
    purpose: z.string(),
    status: z.enum(['failed', 'canceled']),
    failureReason: z.string().nullable(),
  }),
);

export const PaymentOutcomeUnknown = defineEvent(
  'finance.payment_outcome_unknown',
  z.object({ ...Org, paymentAttemptId: z.uuid(), purpose: z.string() }),
);

export const OrderPaid = defineEvent(
  'finance.order_paid',
  z.object({
    ...Org,
    orderId: z.uuid(),
    checkoutId: z.uuid(),
    payerPersonId: z.uuid(),
    totalMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const EnrollmentFulfilled = defineEvent(
  'finance.enrollment_fulfilled',
  z.object({
    ...Org,
    checkoutId: z.uuid(),
    orderId: z.uuid(),
    enrollmentIds: z.array(z.uuid()),
    recovered: z.boolean(),
  }),
);

export const CheckoutRecoveryRequired = defineEvent(
  'finance.checkout_recovery_required',
  z.object({
    ...Org,
    checkoutId: z.uuid(),
    orderId: z.uuid(),
    reasonCode: z.string(),
    plan: z.enum(['refund', 'credit', 'manual']),
  }),
);

export const CheckoutCompensated = defineEvent(
  'finance.checkout_compensated',
  z.object({
    ...Org,
    checkoutId: z.uuid(),
    orderId: z.uuid(),
    method: z.enum(['refund', 'credit']),
    refundAttemptId: z.uuid().nullable(),
    creditId: z.uuid().nullable(),
  }),
);

export const CheckoutAborted = defineEvent(
  'finance.checkout_aborted',
  z.object({ ...Org, checkoutId: z.uuid(), orderId: z.uuid(), reason: z.string() }),
);

export const RefundRequested = defineEvent(
  'finance.refund_requested',
  z.object({
    ...Org,
    refundAttemptId: z.uuid(),
    paymentAttemptId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
    purpose: z.enum(['customer_refund', 'compensation']),
  }),
);

/** A refund reached a terminal outcome; compensation refunds complete their checkout from this. */
export const RefundSettled = defineEvent(
  'finance.refund_settled',
  z.object({
    ...Org,
    refundAttemptId: z.uuid(),
    paymentAttemptId: z.uuid(),
    status: z.enum(['succeeded', 'failed']),
    purpose: z.enum(['customer_refund', 'compensation']),
    checkoutId: z.uuid().nullable(),
  }),
);

export const CreditIssued = defineEvent(
  'finance.credit_issued',
  z.object({
    ...Org,
    creditId: z.uuid(),
    ownerPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
    sourceKind: z.string(),
    status: z.string(),
  }),
);

export const CreditRedeemed = defineEvent(
  'finance.credit_redeemed',
  z.object({
    ...Org,
    creditId: z.uuid(),
    redemptionId: z.uuid(),
    amountMinor: z.number().int(),
    referenceType: z.string(),
    referenceId: z.uuid(),
  }),
);

export const OverpaymentRecorded = defineEvent(
  'finance.overpayment_recorded',
  z.object({
    ...Org,
    receiptId: z.uuid(),
    obligationId: z.uuid().nullable(),
    excessMinor: z.number().int(),
    currency: z.string(),
    creditId: z.uuid(),
  }),
);

export const ObligationCreated = defineEvent(
  'finance.obligation_created',
  z.object({
    ...Org,
    obligationId: z.uuid(),
    debtorKind: z.enum(['person', 'team_entry']),
    debtorId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
    dueAt: z.string(),
  }),
);

export const ObligationSettled = defineEvent(
  'finance.obligation_settled',
  z.object({ ...Org, obligationId: z.uuid() }),
);

export const ContributionRequested = defineEvent(
  'finance.contribution_requested',
  z.object({
    ...Org,
    contributionRequestId: z.uuid(),
    obligationId: z.uuid(),
    requestedPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const InstallmentPaid = defineEvent(
  'finance.installment_paid',
  z.object({ ...Org, installmentId: z.uuid(), planId: z.uuid(), obligationId: z.uuid() }),
);

/**
 * SPK-PAY-006: a failed installment is a financial state plus an action queue; participation
 * consequences are evaluated separately by whoever subscribes to this event (POL-017).
 */
export const InstallmentFailed = defineEvent(
  'finance.installment_failed',
  z.object({
    ...Org,
    installmentId: z.uuid(),
    planId: z.uuid(),
    obligationId: z.uuid(),
    orderId: z.uuid(),
    payerPersonId: z.uuid(),
    attemptCount: z.number().int(),
    finalAttempt: z.boolean(),
  }),
);

/** Timer: the notice before an installment falls due. */
export const InstallmentNoticeDue = defineEvent(
  'finance.installment_notice_due',
  z.object({ ...Org, installmentId: z.uuid() }),
);

export const InstallmentNotice = defineEvent(
  'finance.installment_notice',
  z.object({
    ...Org,
    installmentId: z.uuid(),
    payerPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
    dueAt: z.string(),
  }),
);

export const CashTenderRecorded = defineEvent(
  'finance.cash_tender_recorded',
  z.object({
    ...Org,
    cashTenderId: z.uuid(),
    facilityId: z.uuid(),
    amountMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const SettlementReconciled = defineEvent(
  'finance.settlement_reconciled',
  z.object({
    ...Org,
    reconciliationId: z.uuid(),
    kind: z.string(),
    status: z.enum(['balanced', 'discrepancy']),
    differenceMinor: z.number().int(),
  }),
);

// Package G finance facts (declared by stage 3; emitted by FIN-06 and FIN-07). Dispatched with no
// handler yet; payloads carry identifiers, states and amounts only (§4.14).

/** FIN-07, IF-37: an accounting mapping was proposed, approved or retired. */
export const AccountingMappingChanged = defineEvent(
  'finance.accounting_mapping_changed',
  z.object({
    mappingId: z.uuid(),
    ledgerAccount: z.string(),
    status: z.enum(['proposed', 'approved', 'retired']),
  }),
);

/** FIN-07, IF-37: an accounting export batch changed state. */
export const AccountingBatchChanged = defineEvent(
  'finance.accounting_batch_changed',
  z.object({
    batchId: z.uuid(),
    status: z.enum(['prepared', 'submitted', 'accepted', 'rejected', 'unknown', 'canceled']),
    lineCount: z.number().int().min(0),
  }),
);

/** FIN-06, IF-49: a point-of-sale sale changed state. */
export const PosSaleChanged = defineEvent(
  'finance.pos_sale_changed',
  z.object({
    saleId: z.uuid(),
    registerSessionId: z.uuid(),
    status: z.enum(['open', 'paid', 'voided', 'partially_returned', 'returned']),
    totalMinor: z.number().int(),
    currency: z.string(),
  }),
);

/** FIN-06, IF-49: a register session closed with its counted cash and variance. */
export const PosRegisterSessionClosed = defineEvent(
  'finance.pos_register_session_closed',
  z.object({
    sessionId: z.uuid(),
    registerId: z.uuid(),
    expectedCashMinor: z.number().int(),
    countedCashMinor: z.number().int(),
    varianceMinor: z.number().int(),
    currency: z.string(),
  }),
);

export const FinanceEvents = {
  quoteCreated: QuoteCreated,
  checkoutStarted: CheckoutStarted,
  checkoutExpiryDue: CheckoutExpiryDue,
  checkoutPaymentReceived: CheckoutPaymentReceived,
  paymentReceived: PaymentReceived,
  paymentFailed: PaymentFailed,
  paymentOutcomeUnknown: PaymentOutcomeUnknown,
  orderPaid: OrderPaid,
  enrollmentFulfilled: EnrollmentFulfilled,
  checkoutRecoveryRequired: CheckoutRecoveryRequired,
  checkoutCompensated: CheckoutCompensated,
  checkoutAborted: CheckoutAborted,
  refundRequested: RefundRequested,
  refundSettled: RefundSettled,
  creditIssued: CreditIssued,
  creditRedeemed: CreditRedeemed,
  overpaymentRecorded: OverpaymentRecorded,
  obligationCreated: ObligationCreated,
  obligationSettled: ObligationSettled,
  contributionRequested: ContributionRequested,
  installmentPaid: InstallmentPaid,
  installmentFailed: InstallmentFailed,
  installmentNoticeDue: InstallmentNoticeDue,
  installmentNotice: InstallmentNotice,
  cashTenderRecorded: CashTenderRecorded,
  settlementReconciled: SettlementReconciled,
  accountingMappingChanged: AccountingMappingChanged,
  accountingBatchChanged: AccountingBatchChanged,
  posSaleChanged: PosSaleChanged,
  posRegisterSessionClosed: PosRegisterSessionClosed,
} as const;
