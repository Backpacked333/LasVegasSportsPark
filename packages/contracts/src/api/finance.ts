import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { CurrencyCode } from '../money';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { PageRequestSchema, pageSchema } from '../pagination';
import { Instant } from '../time';

/**
 * Finance module API contract (specification §3.15 SPK-PAY-001..012, §4.4 Finance + Accounting
 * support, §4.6 PaymentAttempt / Refund / Checkout machines, §4.7 invariants 5, 6, 7, §4.8
 * `POST /v1/registration-quotes`, `POST /v1/registration-checkouts`, `POST /v1/payments/{id}/refunds`,
 * §4.11). Prices are never accepted from the client (SPK-PAY-001): quote and checkout bodies are
 * strict and carry no amounts. Card details never reach the API: only an opaque provider
 * payment-method token does. Organization scope always comes from the authenticated principal.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary (mirrored by the database check constraints in migration 0600 and the §4.6 machines)
// ---------------------------------------------------------------------------------------------

export const QuoteStatusSchema = z.enum(['active', 'expired', 'consumed']).openapi('QuoteStatus');
export const CheckoutStatusSchema = z
  .enum([
    'prepared',
    'awaiting_payment',
    'finalizing',
    'completed',
    'recovery_required',
    'compensated',
    'aborted',
  ])
  .openapi('CheckoutStatus');
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>;
/**
 * FIN-01 wording (the API is authoritative; docs/package-a/journeys.md section 3 follows it):
 * `created` and `processing` mean the payment is on its way and the payer waits
 * (`await_payment_confirmation`); only `action_required` asks the payer to act
 * (`complete_payment_action`); `unknown` means the outcome is not known yet and the payer must not
 * pay again until it is reconciled (`await_reconciliation`, SPK-PAY-007).
 */
export const PaymentAttemptStatusSchema = z
  .enum(['created', 'action_required', 'processing', 'succeeded', 'failed', 'canceled', 'unknown'])
  .openapi('PaymentAttemptStatus', {
    description:
      'created and processing: the payment is on its way, the payer waits (nextAction await_payment_confirmation). action_required: the provider asks the payer to act (complete_payment_action); no other status asks the payer anything. unknown: the outcome is not known yet; do not pay again until it is reconciled (await_reconciliation, SPK-PAY-007). succeeded, failed and canceled are final.',
  });
export type PaymentAttemptStatus = z.infer<typeof PaymentAttemptStatusSchema>;
export const RefundStatusSchema = z
  .enum(['requested', 'processing', 'succeeded', 'failed', 'canceled', 'unknown'])
  .openapi('RefundStatus');
export type RefundStatus = z.infer<typeof RefundStatusSchema>;
export const ObligationStatusSchema = z
  .enum(['open', 'settled', 'written_off', 'canceled'])
  .openapi('ObligationStatus');
export const ObligationModeSchema = z
  .enum(['individual', 'single_team_payer', 'team_with_contributions'])
  .openapi('ObligationMode');
export type ObligationMode = z.infer<typeof ObligationModeSchema>;
export const CreditStatusSchema = z
  .enum(['pending_approval', 'active', 'exhausted', 'expired', 'revoked'])
  .openapi('CreditStatus');
export const CreditUseSchema = z.enum(['registration', 'obligation']).openapi('CreditUse');
export type CreditUse = z.infer<typeof CreditUseSchema>;
export const LedgerAccountSchema = z
  .enum([
    'customer_receivable',
    'cash_processor',
    'deferred_revenue',
    'credits_payable',
    'processor_fees',
    'refunds',
    'cash_on_hand',
    'overpayment_liability',
    // FIN-06: point-of-sale revenue and the approved taxes and fees collected on sales (DEC-057).
    'pos_revenue',
    'taxes_payable',
    'fees_payable',
  ])
  .openapi('LedgerAccount');
export type LedgerAccount = z.infer<typeof LedgerAccountSchema>;
export const CashTenderKindSchema = z
  .enum(['cash', 'check', 'external_terminal'])
  .openapi('CashTenderKind');

const Reason = z.string().trim().min(1).max(2000);
const PositiveMinor = z.number().int().min(1).safe();
const DiscountCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,49}$/, 'letters, digits, "-" and "_" only');

/**
 * An opaque payment-method token issued by the provider's hosted fields. Card numbers never reach
 * this API (§4.14): anything resembling a primary account number is rejected outright.
 */
export const PaymentMethodToken = z
  .string()
  .trim()
  .regex(/^pm_[A-Za-z0-9_]{3,100}$/, 'must be a provider payment-method token (pm_…)')
  .refine((v) => !/\d{12,19}/.test(v), 'card details must never be sent to this API')
  .openapi('PaymentMethodToken');

// ---------------------------------------------------------------------------------------------
// Quotes (SPK-PAY-002/003)
// ---------------------------------------------------------------------------------------------

/** An approved tax or fee as applied to one line (amounts computed by the server). */
export const AppliedChargeSchema = z
  .object({
    code: z.string(),
    label: z.string(),
    kind: z.enum(['tax', 'fee']),
    inclusive: z.boolean(),
    basisPoints: z.number().int().nullable(),
    amountMinor: z.number().int(),
  })
  .openapi('AppliedCharge');
export type AppliedCharge = z.infer<typeof AppliedChargeSchema>;

export const QuoteDiscountLineSchema = z
  .object({
    discountDefinitionId: z.uuid(),
    code: z.string().nullable(),
    name: z.string(),
    amountMinor: z.number().int(),
    explanation: z.array(z.string()),
  })
  .openapi('QuoteDiscountLine');
export type QuoteDiscountLine = z.infer<typeof QuoteDiscountLineSchema>;

export const LinePolicyReferencesSchema = z
  .object({
    eligibilityPolicyVersionId: z.uuid().nullable(),
    cancellationPolicyVersionId: z.uuid().nullable(),
    requiredFormPolicyVersionIds: z.array(z.uuid()),
    approvalPolicyVersionId: z.uuid().nullable(),
  })
  .openapi('LinePolicyReferences');
export type LinePolicyReferences = z.infer<typeof LinePolicyReferencesSchema>;

export const QuotePolicyReferencesSchema = z
  .object({
    overpaymentPolicyVersionId: z.uuid().nullable(),
    installmentPolicyVersionId: z.uuid().nullable(),
    refundPolicyVersionId: z.uuid().nullable(),
    /** Engineering defaults applied where no approved policy version exists (DEC-007/008/009). */
    defaults: z.array(z.string()),
  })
  .openapi('QuotePolicyReferences');
export type QuotePolicyReferences = z.infer<typeof QuotePolicyReferencesSchema>;

export const QuoteLineSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    basketLineId: z.uuid(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    description: z.string(),
    quantity: z.number().int(),
    priceRuleId: z.uuid().nullable(),
    unitPriceMinor: z.number().int(),
    baseAmountMinor: z.number().int(),
    discountMinor: z.number().int(),
    taxMinor: z.number().int(),
    feeMinor: z.number().int(),
    includedTaxMinor: z.number().int(),
    totalMinor: z.number().int(),
    currency: CurrencyCode,
    discounts: z.array(QuoteDiscountLineSchema),
    charges: z.array(AppliedChargeSchema),
    policies: LinePolicyReferencesSchema,
    enrollmentId: z.uuid().nullable(),
  })
  .openapi('QuoteLine');
export type QuoteLine = z.infer<typeof QuoteLineSchema>;

export const FutureObligationSchema = z
  .object({
    sequence: z.number().int(),
    dueAt: Instant,
    amountMinor: z.number().int(),
  })
  .openapi('FutureObligation');
export type FutureObligation = z.infer<typeof FutureObligationSchema>;

export const AppliedCreditSchema = z
  .object({ creditId: z.uuid(), amountMinor: z.number().int() })
  .openapi('AppliedCredit');
export type AppliedCredit = z.infer<typeof AppliedCreditSchema>;

export const PaymentPlanRequestSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('full') }).strict(),
    z.object({ kind: z.literal('installments'), count: z.number().int().min(2).max(24) }).strict(),
  ])
  .openapi('PaymentPlanRequest');
export type PaymentPlanRequest = z.infer<typeof PaymentPlanRequestSchema>;

export const QuoteSchema = z
  .object({
    id: z.uuid(),
    basketId: z.uuid(),
    payerPersonId: z.uuid(),
    status: QuoteStatusSchema,
    currency: CurrencyCode,
    lines: z.array(QuoteLineSchema),
    subtotalMinor: z.number().int(),
    discountMinor: z.number().int(),
    taxMinor: z.number().int(),
    feeMinor: z.number().int(),
    includedTaxMinor: z.number().int(),
    totalMinor: z.number().int(),
    creditsAppliedMinor: z.number().int(),
    appliedCredits: z.array(AppliedCreditSchema),
    dueNowMinor: z.number().int(),
    paymentPlan: z.enum(['full', 'installments']),
    futureObligations: z.array(FutureObligationSchema),
    discounts: z.array(QuoteDiscountLineSchema),
    policies: QuotePolicyReferencesSchema,
    /** Server-owned validity (POL-013); a checkout after this instant needs a new quote. */
    expiresAt: Instant,
    consumedByCheckoutId: z.uuid().nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Quote');
export type Quote = z.infer<typeof QuoteSchema>;

/** SPK-PAY-001: no amounts; unknown properties (a client price) are rejected, never trusted. */
export const CreateQuoteBody = withCommandMeta({
  basketId: z.uuid(),
  discountCodes: z.array(DiscountCode).max(10).default([]),
  /** SPK-PAY-002/009: each credit is listed once (a repeated id would count its balance twice). */
  creditIds: z
    .array(z.uuid())
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'A credit may be listed only once.',
    })
    .openapi({ uniqueItems: true })
    .default([]),
  paymentPlan: PaymentPlanRequestSchema.default({ kind: 'full' }),
})
  .strict()
  .openapi('CreateQuoteRequest');
export type CreateQuoteInput = z.infer<typeof CreateQuoteBody>;

// ---------------------------------------------------------------------------------------------
// Payment attempts, receipts and checkouts (§4.11)
// ---------------------------------------------------------------------------------------------

export const PaymentAttemptPurposeSchema = z
  .enum(['checkout', 'obligation', 'contribution', 'installment', 'pos_sale'])
  .openapi('PaymentAttemptPurpose');
export type PaymentAttemptPurposeValue = z.infer<typeof PaymentAttemptPurposeSchema>;

export const PaymentAttemptSchema = z
  .object({
    id: z.uuid(),
    purpose: PaymentAttemptPurposeSchema,
    status: PaymentAttemptStatusSchema,
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    provider: z.string(),
    providerReference: z.string().nullable(),
    /** Customer action required by the provider (for example a challenge); never card data. */
    actionRequired: z.record(z.string(), z.unknown()).nullable(),
    failureReason: z.string().nullable(),
    evidenceSource: z.enum(['sync_response', 'webhook', 'reconciliation']).nullable(),
    payerPersonId: z.uuid(),
    checkoutId: z.uuid().nullable(),
    orderId: z.uuid().nullable(),
    obligationId: z.uuid().nullable(),
    contributionRequestId: z.uuid().nullable(),
    installmentId: z.uuid().nullable(),
    /** FIN-06: the point-of-sale sale a card tender pays. */
    posSaleId: z.uuid().nullable(),
    unknownSince: Instant.nullable(),
    resolvedAt: Instant.nullable(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .openapi('PaymentAttempt');
export type PaymentAttempt = z.infer<typeof PaymentAttemptSchema>;

/**
 * FIN-01 (SPK-PAY-007, §4.7 invariant 5): the payment still on its way for a record (an obligation
 * or a checkout), so the payer is told to wait or not to pay again instead of finding out from a
 * refused second payment.
 */
export const LiveAttemptSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['created', 'action_required', 'processing', 'unknown']),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    unknownSince: Instant.nullable(),
    createdAt: Instant,
  })
  .openapi('LiveAttempt');
export type LiveAttempt = z.infer<typeof LiveAttemptSchema>;

/** FIN-02 (SPK-PAY-008): an earlier refund of a payment, as listed on the payment. */
export const PaymentRefundSummarySchema = z
  .object({
    id: z.uuid(),
    status: z.enum(['requested', 'processing', 'succeeded', 'failed', 'canceled', 'unknown']),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    requestedAt: Instant,
  })
  .openapi('PaymentRefundSummary');
export type PaymentRefundSummary = z.infer<typeof PaymentRefundSummarySchema>;

/**
 * GET /v1/payments/{id} (FIN-02, SPK-PAY-008, SCR-S-37): the attempt with what can still be
 * refunded (captured minus refunded minus reserved; 0 when nothing was captured) and its refunds.
 */
export const PaymentDetailSchema = PaymentAttemptSchema.extend({
  refundableMinor: z.number().int(),
  refunds: z.array(PaymentRefundSummarySchema),
}).openapi('PaymentDetail');
export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;

export const ReceiptSchema = z
  .object({
    id: z.uuid(),
    sourceKind: z.enum(['payment_attempt', 'cash_tender']),
    paymentAttemptId: z.uuid().nullable(),
    cashTenderId: z.uuid().nullable(),
    amountMinor: z.number().int(),
    allocatedMinor: z.number().int(),
    /** SPK-PAY-005: what exceeded the remaining balance stays visible, never a silent zero. */
    excessMinor: z.number().int(),
    currency: CurrencyCode,
    receivedAt: Instant,
  })
  .openapi('Receipt');
export type Receipt = z.infer<typeof ReceiptSchema>;

export const CheckoutPaymentSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('provider'), paymentMethodToken: PaymentMethodToken }).strict(),
    z
      .object({
        method: z.literal('cash'),
        tenderKind: CashTenderKindSchema,
        facilityId: z.uuid(),
        evidence: z
          .object({ reference: z.string().trim().min(1).max(200), notes: z.string().max(2000) })
          .partial({ notes: true })
          .strict(),
      })
      .strict(),
  ])
  .openapi('CheckoutPayment');
export type CheckoutPayment = z.infer<typeof CheckoutPaymentSchema>;

export const CreateCheckoutBody = withCommandMeta({
  quoteId: z.uuid(),
  payment: CheckoutPaymentSchema.optional(),
  /** SPK-PAY-006: an installment plan needs explicit authorization of the future charges. */
  authorizeFutureInstallments: z.boolean().default(false),
})
  .strict()
  .openapi('CreateCheckoutRequest');
export type CreateCheckoutInput = z.infer<typeof CreateCheckoutBody>;

export const RetryCheckoutPaymentBody = withCommandMeta({ paymentMethodToken: PaymentMethodToken })
  .strict()
  .openapi('RetryCheckoutPaymentRequest');
export type RetryCheckoutPaymentInput = z.infer<typeof RetryCheckoutPaymentBody>;

export const AbortCheckoutBody = withCommandMeta({})
  .extend({ reason: Reason })
  .strict()
  .openapi('AbortCheckoutRequest');
export type AbortCheckoutInput = z.infer<typeof AbortCheckoutBody>;

export const RecoverCheckoutBody = withCommandMeta({})
  .extend({ reason: Reason })
  .strict()
  .openapi('RecoverCheckoutRequest');
export type RecoverCheckoutInput = z.infer<typeof RecoverCheckoutBody>;

export const CompensateCheckoutBody = withCommandMeta({ method: z.enum(['refund', 'credit']) })
  .extend({ reason: Reason })
  .strict()
  .openapi('CompensateCheckoutRequest');
export type CompensateCheckoutInput = z.infer<typeof CompensateCheckoutBody>;

export const CheckoutRecoverySchema = z
  .object({
    reasonCode: z.string(),
    message: z.string(),
    plan: z.enum(['refund', 'credit', 'manual']),
    refundAttemptId: z.uuid().nullable(),
    creditId: z.uuid().nullable(),
    exceptionId: z.uuid().nullable(),
  })
  .openapi('CheckoutRecovery');
export type CheckoutRecovery = z.infer<typeof CheckoutRecoverySchema>;

export const CheckoutSchema = z
  .object({
    id: z.uuid(),
    quoteId: z.uuid(),
    orderId: z.uuid(),
    basketId: z.uuid(),
    payerPersonId: z.uuid(),
    status: CheckoutStatusSchema,
    paymentKind: z.enum(['provider', 'cash', 'none']),
    payment: PaymentAttemptSchema.nullable(),
    receipt: ReceiptSchema.nullable(),
    holdIds: z.array(z.uuid()),
    enrollmentIds: z.array(z.uuid()),
    operationId: z.uuid(),
    failure: z.object({ code: z.string(), details: z.unknown() }).nullable(),
    recovery: CheckoutRecoverySchema.nullable(),
    /** What the payer or staff may do next (for example `await_reconciliation`). */
    nextAction: z.string().nullable(),
    revision: Revision,
    createdAt: Instant,
    updatedAt: Instant,
    completedAt: Instant.nullable(),
  })
  .openapi('Checkout');
export type Checkout = z.infer<typeof CheckoutSchema>;

export const OrderLineSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    basketLineId: z.uuid(),
    enrollmentId: z.uuid().nullable(),
    participantPersonId: z.uuid(),
    offeringId: z.uuid(),
    description: z.string(),
    quantity: z.number().int(),
    priceRuleId: z.uuid().nullable(),
    unitPriceMinor: z.number().int(),
    baseAmountMinor: z.number().int(),
    discountMinor: z.number().int(),
    taxMinor: z.number().int(),
    feeMinor: z.number().int(),
    totalMinor: z.number().int(),
    currency: CurrencyCode,
    policies: LinePolicyReferencesSchema,
  })
  .openapi('OrderLine');

export const OrderSchema = z
  .object({
    id: z.uuid(),
    quoteId: z.uuid(),
    basketId: z.uuid(),
    payerPersonId: z.uuid(),
    currency: CurrencyCode,
    totalMinor: z.number().int(),
    creditsAppliedMinor: z.number().int(),
    dueNowMinor: z.number().int(),
    paymentStatus: z.enum(['awaiting_payment', 'paid', 'canceled']),
    fulfillmentStatus: z.enum([
      'pending',
      'fulfilled',
      'recovery_required',
      'compensated',
      'canceled',
    ]),
    lines: z.array(OrderLineSchema),
    obligationIds: z.array(z.uuid()),
    installmentPlanId: z.uuid().nullable(),
    paidAt: Instant.nullable(),
    fulfilledAt: Instant.nullable(),
    canceledAt: Instant.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Order');
export type Order = z.infer<typeof OrderSchema>;

// ---------------------------------------------------------------------------------------------
// Obligations and team contributions (SPK-PAY-004/005)
// ---------------------------------------------------------------------------------------------

export const ObligationTotalsSchema = z
  .object({
    amountMinor: z.number().int(),
    /** Money received toward this obligation (receipts and credits), including any excess. */
    receivedMinor: z.number().int(),
    allocatedMinor: z.number().int(),
    remainingMinor: z.number().int(),
    /** Received beyond the remaining balance: held per the overpayment policy, never hidden. */
    excessMinor: z.number().int(),
    currency: CurrencyCode,
  })
  .openapi('ObligationTotals');
export type ObligationTotals = z.infer<typeof ObligationTotalsSchema>;

/** What a captain sees of a requested contribution: amount and status, never the payer's account. */
export const ContributionSummarySchema = z
  .object({
    id: z.uuid(),
    requestedPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    status: z.enum(['requested', 'paid', 'canceled']),
    paidAt: Instant.nullable(),
  })
  .openapi('ContributionSummary');
export type ContributionSummary = z.infer<typeof ContributionSummarySchema>;

export const ObligationSchema = z
  .object({
    id: z.uuid(),
    debtor: z.object({
      kind: z.enum(['person', 'team_entry']),
      personId: z.uuid().nullable(),
      teamEntryId: z.uuid().nullable(),
    }),
    mode: ObligationModeSchema,
    responsiblePayerPersonId: z.uuid().nullable(),
    source: z.object({
      kind: z.enum(['order', 'installment', 'team_fee', 'manual']),
      id: z.uuid().nullable(),
    }),
    orderId: z.uuid().nullable(),
    description: z.string(),
    dueAt: Instant,
    status: ObligationStatusSchema,
    totals: ObligationTotalsSchema,
    /** Present for team obligations with contributions (captain and staff views). */
    contributions: z.array(ContributionSummarySchema).nullable(),
    /**
     * FIN-01 (SPK-PAY-007): a payment toward this obligation that is still on its way or whose
     * outcome is unknown, as far as the reader may see it (their own payment; any for staff and,
     * outside the contributions model, for the household that owes it). `unknown`: do not pay
     * again until it is reconciled.
     */
    liveAttempt: LiveAttemptSchema.nullable(),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Obligation');
export type Obligation = z.infer<typeof ObligationSchema>;

export const CreateObligationBody = withCommandMeta({
  debtor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('person'), personId: z.uuid() }).strict(),
    z.object({ kind: z.literal('team_entry'), teamEntryId: z.uuid() }).strict(),
  ]),
  mode: ObligationModeSchema,
  responsiblePayerPersonId: z.uuid().optional(),
  amountMinor: PositiveMinor,
  currency: CurrencyCode,
  dueAt: Instant,
  description: z.string().trim().min(1).max(500),
  source: z
    .object({ kind: z.enum(['team_fee', 'manual']), id: z.uuid().optional() })
    .strict()
    .default({ kind: 'manual' }),
})
  .strict()
  .refine((v) => (v.mode === 'individual') === (v.debtor.kind === 'person'), {
    message: 'individual billing has a person debtor; team modes have a team entry debtor',
    path: ['mode'],
  })
  .refine((v) => v.mode !== 'single_team_payer' || v.responsiblePayerPersonId !== undefined, {
    message: 'one responsible team payer must be named',
    path: ['responsiblePayerPersonId'],
  })
  .openapi('CreateObligationRequest');
export type CreateObligationInput = z.infer<typeof CreateObligationBody>;

export const ListObligationsQuery = PageRequestSchema.extend({
  debtorPersonId: z.uuid().optional(),
  teamEntryId: z.uuid().optional(),
  status: ObligationStatusSchema.optional(),
});
export type ListObligationsQuery = z.infer<typeof ListObligationsQuery>;

export const ContributionRequestSchema = z
  .object({
    id: z.uuid(),
    obligationId: z.uuid(),
    requestedPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    message: z.string().nullable(),
    status: z.enum(['requested', 'paid', 'canceled']),
    paidAt: Instant.nullable(),
    /** The team obligation's totals; never other players' payments. */
    obligation: z.object({
      description: z.string(),
      totals: ObligationTotalsSchema,
      status: ObligationStatusSchema,
    }),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('ContributionRequest');
export type ContributionRequest = z.infer<typeof ContributionRequestSchema>;

export const CreateContributionRequestBody = withCommandMeta({
  requestedPersonId: z.uuid(),
  amountMinor: PositiveMinor,
  message: z.string().trim().max(1000).optional(),
})
  .strict()
  .openapi('CreateContributionRequestRequest');
export type CreateContributionRequestInput = z.infer<typeof CreateContributionRequestBody>;

export const PayContributionBody = withCommandMeta({ paymentMethodToken: PaymentMethodToken })
  .strict()
  .openapi('PayContributionRequest');
export type PayContributionInput = z.infer<typeof PayContributionBody>;

export const PayObligationBody = withCommandMeta({
  paymentMethodToken: PaymentMethodToken,
  /** Defaults to the remaining balance; the server bounds and records any excess (SPK-PAY-005). */
  amountMinor: PositiveMinor.optional(),
})
  .strict()
  .openapi('PayObligationRequest');
export type PayObligationInput = z.infer<typeof PayObligationBody>;

export const PaymentOutcomeSchema = z
  .object({
    payment: PaymentAttemptSchema,
    receipt: ReceiptSchema.nullable(),
    obligation: ObligationSchema,
    /** Present when an excess became a credit pending approval (SPK-PAY-005, POL-015). */
    overpaymentCreditId: z.uuid().nullable(),
  })
  .openapi('PaymentOutcome');
export type PaymentOutcome = z.infer<typeof PaymentOutcomeSchema>;

// ---------------------------------------------------------------------------------------------
// Refunds (SPK-PAY-008)
// ---------------------------------------------------------------------------------------------

export const RefundableSchema = z
  .object({
    capturedMinor: z.number().int(),
    refundedMinor: z.number().int(),
    reservedMinor: z.number().int(),
    availableMinor: z.number().int(),
    currency: CurrencyCode,
  })
  .openapi('Refundable');
export type Refundable = z.infer<typeof RefundableSchema>;

export const RefundSchema = z
  .object({
    id: z.uuid(),
    paymentAttemptId: z.uuid(),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    purpose: z.enum(['customer_refund', 'compensation']),
    status: RefundStatusSchema,
    reservationStatus: z.enum(['reserved', 'settled', 'released']),
    reason: z.string(),
    providerReference: z.string().nullable(),
    failureReason: z.string().nullable(),
    checkoutId: z.uuid().nullable(),
    operationId: z.uuid().nullable(),
    refundable: RefundableSchema,
    unknownSince: Instant.nullable(),
    resolvedAt: Instant.nullable(),
    createdAt: Instant,
  })
  .openapi('Refund');
export type Refund = z.infer<typeof RefundSchema>;

export const CreateRefundBody = withCommandMeta({ amountMinor: PositiveMinor })
  .extend({ reason: Reason })
  .strict()
  .openapi('CreateRefundRequest');
export type CreateRefundInput = z.infer<typeof CreateRefundBody>;

// ---------------------------------------------------------------------------------------------
// Credits (SPK-PAY-009)
// ---------------------------------------------------------------------------------------------

export const CreditRedemptionSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['redeem', 'reversal']),
    amountMinor: z.number().int(),
    referenceType: z.string(),
    referenceId: z.uuid(),
    redeemedAt: Instant,
  })
  .openapi('CreditRedemption');

export const CreditSchema = z
  .object({
    id: z.uuid(),
    ownerPersonId: z.uuid(),
    currency: CurrencyCode,
    originalMinor: z.number().int(),
    remainingMinor: z.number().int(),
    permittedUses: z.array(CreditUseSchema),
    sourceKind: z.enum(['overpayment', 'compensation', 'goodwill', 'adjustment']),
    sourceId: z.uuid().nullable(),
    status: CreditStatusSchema,
    expiresAt: Instant.nullable(),
    reason: z.string(),
    approvedAt: Instant.nullable(),
    redemptions: z.array(CreditRedemptionSchema),
    revision: Revision,
    createdAt: Instant,
  })
  .openapi('Credit');
export type Credit = z.infer<typeof CreditSchema>;

export const IssueCreditBody = withCommandMeta({
  ownerPersonId: z.uuid(),
  amountMinor: PositiveMinor,
  currency: CurrencyCode,
  permittedUses: z.array(CreditUseSchema).min(1).max(2),
  /** "Expiry when approved" (SPK-PAY-009): omitted means no expiry. */
  expiresAt: Instant.optional(),
  sourceKind: z.enum(['goodwill', 'adjustment']),
})
  .extend({ reason: Reason })
  .strict()
  .openapi('IssueCreditRequest');
export type IssueCreditInput = z.infer<typeof IssueCreditBody>;

export const RedeemCreditBody = withCommandMeta({
  obligationId: z.uuid(),
  amountMinor: PositiveMinor,
})
  .strict()
  .openapi('RedeemCreditRequest');
export type RedeemCreditInput = z.infer<typeof RedeemCreditBody>;

export const ApproveCreditBody = withCommandMeta({}).strict().openapi('ApproveCreditRequest');
export type ApproveCreditInput = z.infer<typeof ApproveCreditBody>;

export const ListCreditsQuery = PageRequestSchema.extend({ ownerPersonId: z.uuid() });
export type ListCreditsQuery = z.infer<typeof ListCreditsQuery>;

// ---------------------------------------------------------------------------------------------
// Customer and staff money lists (FIN-01, FIN-02; §4.5 scoped, paginated keyset queries, newest
// first). Customer lists cover the people the caller pays for (K-05 customerSubjects) and every
// person merged into them (ID-01 personIdsResolvingTo); staff lists are finance readers only.
// ---------------------------------------------------------------------------------------------

const OrderPaymentStatusSchema = z.enum(['awaiting_payment', 'paid', 'canceled']);
const OrderFulfillmentStatusSchema = z.enum([
  'pending',
  'fulfilled',
  'recovery_required',
  'compensated',
  'canceled',
]);

export const ListMyOrdersQuery = PageRequestSchema.extend({
  paymentStatus: OrderPaymentStatusSchema.optional(),
  fulfillmentStatus: OrderFulfillmentStatusSchema.optional(),
});
export type ListMyOrdersQuery = z.infer<typeof ListMyOrdersQuery>;

export const ListMyCheckoutsQuery = PageRequestSchema.extend({
  status: CheckoutStatusSchema.optional(),
});
export type ListMyCheckoutsQuery = z.infer<typeof ListMyCheckoutsQuery>;

export const ListMyPaymentsQuery = PageRequestSchema.extend({
  status: PaymentAttemptStatusSchema.optional(),
  purpose: PaymentAttemptPurposeSchema.optional(),
});
export type ListMyPaymentsQuery = z.infer<typeof ListMyPaymentsQuery>;

export const ListMyReceiptsQuery = PageRequestSchema;
export type ListMyReceiptsQuery = z.infer<typeof ListMyReceiptsQuery>;

export const ListMyContributionRequestsQuery = PageRequestSchema.extend({
  status: z.enum(['requested', 'paid', 'canceled']).optional(),
});
export type ListMyContributionRequestsQuery = z.infer<typeof ListMyContributionRequestsQuery>;

export const ListOrdersQuery = PageRequestSchema.extend({
  payerPersonId: z.uuid().optional(),
  paymentStatus: OrderPaymentStatusSchema.optional(),
  fulfillmentStatus: OrderFulfillmentStatusSchema.optional(),
  /** Orders created at or after this instant. */
  from: Instant.optional(),
  /** Orders created before this instant. */
  to: Instant.optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuery>;

export const ListPaymentsQuery = PageRequestSchema.extend({
  status: PaymentAttemptStatusSchema.optional(),
  purpose: PaymentAttemptPurposeSchema.optional(),
  payerPersonId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  obligationId: z.uuid().optional(),
});
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuery>;

export const ListRefundsQuery = PageRequestSchema.extend({
  paymentAttemptId: z.uuid().optional(),
  status: RefundStatusSchema.optional(),
});
export type ListRefundsQuery = z.infer<typeof ListRefundsQuery>;

// ---------------------------------------------------------------------------------------------
// Installments (SPK-PAY-006)
// ---------------------------------------------------------------------------------------------

export const InstallmentSchema = z
  .object({
    id: z.uuid(),
    sequence: z.number().int(),
    obligationId: z.uuid(),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    dueAt: Instant,
    originalDueAt: Instant,
    status: z.enum(['scheduled', 'paid', 'failed', 'canceled']),
    attemptCount: z.number().int(),
    lastFailureReason: z.string().nullable(),
    nextRetryAt: Instant.nullable(),
    paidAt: Instant.nullable(),
    extensionCount: z.number().int(),
    noticeSentAt: Instant.nullable(),
    revision: Revision,
  })
  .openapi('Installment');
export type Installment = z.infer<typeof InstallmentSchema>;

export const InstallmentPlanSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    payerPersonId: z.uuid(),
    currency: CurrencyCode,
    totalMinor: z.number().int(),
    status: z.enum(['active', 'completed', 'defaulted', 'canceled']),
    authorization: z.object({ authorizedAt: Instant, authorizedByPersonId: z.uuid().nullable() }),
    retryPolicy: z.object({ maxAttempts: z.number().int(), retryIntervalHours: z.number().int() }),
    noticePolicy: z.object({ daysBefore: z.number().int() }),
    outstandingMinor: z.number().int(),
    installments: z.array(InstallmentSchema),
    revision: Revision,
  })
  .openapi('InstallmentPlan');
export type InstallmentPlan = z.infer<typeof InstallmentPlanSchema>;

export const CollectInstallmentBody = withCommandMeta({})
  .strict()
  .openapi('CollectInstallmentRequest');
export type CollectInstallmentInput = z.infer<typeof CollectInstallmentBody>;

// §4.9: an extension moves the date the customer's stored method is charged, so a stale edit must
// fail rather than overwrite newer work; the current revision is required.
export const ExtendInstallmentBody = withCommandMeta({ dueAt: Instant })
  .extend({ reason: Reason, expectedRevision: Revision })
  .strict()
  .openapi('ExtendInstallmentRequest');
export type ExtendInstallmentInput = z.infer<typeof ExtendInstallmentBody>;

// ---------------------------------------------------------------------------------------------
// Cash and external tenders (SPK-PAY-012), reconciliation (SPK-PAY-011)
// ---------------------------------------------------------------------------------------------

export const CashTenderSchema = z
  .object({
    id: z.uuid(),
    facilityId: z.uuid(),
    tenderKind: CashTenderKindSchema,
    payerPersonId: z.uuid(),
    amountMinor: z.number().int(),
    currency: CurrencyCode,
    obligationId: z.uuid().nullable(),
    checkoutId: z.uuid().nullable(),
    evidence: z.record(z.string(), z.unknown()),
    recordedByPersonId: z.uuid(),
    recordedAt: Instant,
    status: z.enum(['recorded', 'reconciled']),
    reconciliationId: z.uuid().nullable(),
    receipt: ReceiptSchema.nullable(),
    overpaymentCreditId: z.uuid().nullable(),
  })
  .openapi('CashTender');
export type CashTender = z.infer<typeof CashTenderSchema>;

export const RecordCashTenderBody = withCommandMeta({
  obligationId: z.uuid(),
  facilityId: z.uuid(),
  tenderKind: CashTenderKindSchema,
  amountMinor: PositiveMinor,
  currency: CurrencyCode,
  payerPersonId: z.uuid().optional(),
  evidence: z
    .object({ reference: z.string().trim().min(1).max(200), notes: z.string().max(2000) })
    .partial({ notes: true })
    .strict(),
})
  .strict()
  .openapi('RecordCashTenderRequest');
export type RecordCashTenderInput = z.infer<typeof RecordCashTenderBody>;

export const SettlementReconciliationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['processor_settlement', 'cash_drawer']),
    provider: z.string().nullable(),
    facilityId: z.uuid().nullable(),
    periodStart: Instant,
    periodEnd: Instant,
    currency: CurrencyCode,
    expectedMinor: z.number().int(),
    reportedMinor: z.number().int(),
    differenceMinor: z.number().int(),
    status: z.enum(['balanced', 'discrepancy']),
    breakdown: z.record(z.string(), z.unknown()),
    externalReference: z.string().nullable(),
    performedAt: Instant,
  })
  .openapi('SettlementReconciliation');
export type SettlementReconciliation = z.infer<typeof SettlementReconciliationSchema>;

export const CreateSettlementReconciliationBody = withCommandMeta({
  kind: z.enum(['processor_settlement', 'cash_drawer']),
  provider: z.string().trim().min(1).max(100).optional(),
  facilityId: z.uuid().optional(),
  periodStart: Instant,
  periodEnd: Instant,
  currency: CurrencyCode,
  reportedMinor: z.number().int().safe(),
  externalReference: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
})
  .strict()
  .refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), {
    message: 'periodEnd must be after periodStart',
    path: ['periodEnd'],
  })
  .refine((v) => (v.kind === 'processor_settlement' ? !!v.provider : !!v.facilityId), {
    message: 'a processor settlement names its provider; a cash drawer names its facility',
    path: ['kind'],
  })
  .openapi('CreateSettlementReconciliationRequest');
export type CreateSettlementReconciliationInput = z.infer<
  typeof CreateSettlementReconciliationBody
>;

export const LedgerBalanceSchema = z
  .object({
    accountCode: LedgerAccountSchema,
    debitMinor: z.number().int(),
    creditMinor: z.number().int(),
    /** Debit-positive balance: debits minus credits. */
    balanceMinor: z.number().int(),
  })
  .openapi('LedgerBalance');
export type LedgerBalance = z.infer<typeof LedgerBalanceSchema>;

export const ReconciliationReportQuery = z.object({
  from: Instant,
  to: Instant,
  currency: CurrencyCode.default('USD'),
});
export type ReconciliationReportQuery = z.infer<typeof ReconciliationReportQuery>;

/** SPK-PAY-011: each category reported separately; payment volume is not revenue. */
export const ReconciliationReportSchema = z
  .object({
    from: Instant,
    to: Instant,
    currency: CurrencyCode,
    orders: z.object({
      count: z.number().int(),
      totalMinor: z.number().int(),
      paidCount: z.number().int(),
    }),
    obligations: z.object({
      openCount: z.number().int(),
      openRemainingMinor: z.number().int(),
      settledCount: z.number().int(),
    }),
    receipts: z.object({
      processorMinor: z.number().int(),
      cashMinor: z.number().int(),
      count: z.number().int(),
      excessMinor: z.number().int(),
    }),
    refunds: z.object({
      succeededMinor: z.number().int(),
      reservedMinor: z.number().int(),
      unknownCount: z.number().int(),
    }),
    credits: z.object({
      issuedMinor: z.number().int(),
      redeemedMinor: z.number().int(),
      pendingApprovalMinor: z.number().int(),
    }),
    /** Every processor fee of the period: receipts' and point-of-sale card tenders'. */
    processorFeesMinor: z.number().int(),
    disputes: z.object({ count: z.number().int(), note: z.string() }),
    settlements: z.array(SettlementReconciliationSchema),
    cash: z.object({ recordedMinor: z.number().int(), unreconciledMinor: z.number().int() }),
    /**
     * Point-of-sale money of the period (FIN-06, SPK-PAY-011), kept apart from receipts and cash
     * tenders: card tenders the processor captured (a capture reported after its tender failed
     * included), cash and external tenders taken into drawers, the processor fees of those card
     * tenders (also within `processorFeesMinor`) and what returns gave back.
     */
    pointOfSale: z
      .object({
        cardMinor: z.number().int(),
        drawerMinor: z.number().int(),
        processorFeesMinor: z.number().int(),
        returnedMinor: z.number().int(),
      })
      .optional(),
    exceptions: z.object({
      unknownPayments: z.number().int(),
      recoveryRequiredCheckouts: z.number().int(),
    }),
    /** Revenue is not inferred from payment volume: deferred revenue and refunds are shown as posted. */
    ledger: z.array(LedgerBalanceSchema),
  })
  .openapi('ReconciliationReport');
export type ReconciliationReport = z.infer<typeof ReconciliationReportSchema>;

// ---------------------------------------------------------------------------------------------
// Provider webhooks (§4.11): authenticated, durably recorded, duplicate- and order-tolerant
// ---------------------------------------------------------------------------------------------

export const PaymentWebhookBody = z
  .object({
    id: z.string().min(1).max(200),
    type: z.enum([
      'payment.succeeded',
      'payment.failed',
      'payment.canceled',
      'payment.processing',
      'payment.requires_action',
      'refund.succeeded',
      'refund.failed',
    ]),
    /** Provider-side ordering of events for one object; older events never override newer facts. */
    sequence: z.number().int().min(0),
    data: z.object({
      organizationId: z.uuid(),
      providerReference: z.string().min(1).max(200),
      paymentAttemptId: z.uuid().optional(),
      refundAttemptId: z.uuid().optional(),
      amountMinor: z.number().int().optional(),
      currency: CurrencyCode.optional(),
      feeMinor: z.number().int().min(0).optional(),
      failureReason: z.string().max(500).optional(),
    }),
  })
  .openapi('PaymentWebhook');
export type PaymentWebhookInput = z.infer<typeof PaymentWebhookBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Finance';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(path: string, summary: string, body: z.ZodType | null, response: z.ZodType) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      headers: idempotencyHeader,
      body: body ? { content: { 'application/json': { schema: body } } } : undefined,
    },
    responses: {
      201: ok('Command outcome', response),
      400: err('Validation failed (client-submitted prices and card data are rejected)'),
      403: err('Access denied or participant authority required'),
      404: err('Not found or not visible (protected records never reveal existence)'),
      409: err(
        'Conflict (QUOTE_EXPIRED, PAYMENT_OUTCOME_UNKNOWN, REFUND_PENDING, CAPACITY_UNAVAILABLE, DUPLICATE_ENTITLEMENT, RESOURCE_CONFLICT, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)',
      ),
      503: err('Integration unavailable'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: {
      params: path.includes('{id}') ? IdParams : undefined,
      query: request ?? undefined,
    },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

command(
  '/registration-quotes',
  'Evaluate an authorized basket and price it from server-side price rules (SPK-PAY-001/002/003)',
  CreateQuoteBody,
  QuoteSchema,
);
query('/registration-quotes/{id}', 'Read a quote', null, QuoteSchema);
command(
  '/registration-checkouts',
  'Acquire capacity and initiate checkout for a stored quote (§4.11)',
  CreateCheckoutBody,
  CheckoutSchema,
);
query(
  '/registration-checkouts/{id}',
  'Read a checkout and its payment state',
  null,
  CheckoutSchema,
);
command(
  '/registration-checkouts/{id}/payments',
  'Retry payment of an awaiting checkout (never while an outcome is unknown, SPK-PAY-007)',
  RetryCheckoutPaymentBody,
  CheckoutSchema,
);
command(
  '/registration-checkouts/{id}/abort',
  'Abort a checkout that holds no live payment',
  AbortCheckoutBody,
  CheckoutSchema,
);
command(
  '/registration-checkouts/{id}/recover',
  'Retry finalization of a checkout whose money was received but fulfillment is incomplete',
  RecoverCheckoutBody,
  CheckoutSchema,
);
command(
  '/registration-checkouts/{id}/compensate',
  'Compensate a checkout that cannot be fulfilled (refund or credit)',
  CompensateCheckoutBody,
  CheckoutSchema,
);
query('/orders/{id}', 'Read an order with its price and policy basis', null, OrderSchema);
query(
  '/payments/{id}',
  'Read a payment attempt with its refundable amount and earlier refunds (SPK-PAY-008)',
  null,
  PaymentDetailSchema,
);
query(
  '/orders',
  'List orders (finance readers; SPK-PAY-011)',
  ListOrdersQuery,
  pageSchema(OrderSchema),
);
query(
  '/payments',
  'List payment attempts by state, purpose, payer, order or obligation (finance readers; SPK-PAY-007)',
  ListPaymentsQuery,
  pageSchema(PaymentAttemptSchema),
);
query(
  '/refunds',
  'List refunds by payment or state (finance readers; SPK-PAY-008)',
  ListRefundsQuery,
  pageSchema(RefundSchema),
);
query(
  '/me/orders',
  'My orders: the orders of the people I pay for (SPK-PAY-002)',
  ListMyOrdersQuery,
  pageSchema(OrderSchema),
);
query(
  '/me/registration-checkouts',
  'My registration checkouts, including one that needs recovery (SPK-PAY-007, §4.11)',
  ListMyCheckoutsQuery,
  pageSchema(CheckoutSchema),
);
query(
  '/me/payments',
  'My payment attempts and their states (SPK-PAY-007)',
  ListMyPaymentsQuery,
  pageSchema(PaymentAttemptSchema),
);
query(
  '/me/receipts',
  'My receipts: money received from the people I pay for (SPK-PAY-005)',
  ListMyReceiptsQuery,
  pageSchema(ReceiptSchema),
);
query(
  '/me/contribution-requests',
  'Contribution requests addressed to me or to the people I pay for (SPK-PAY-004)',
  ListMyContributionRequestsQuery,
  pageSchema(ContributionRequestSchema),
);
command(
  '/payments/{id}/refunds',
  'Reserve and request a refund (SPK-PAY-008)',
  CreateRefundBody,
  RefundSchema,
);
command(
  '/payments/{id}/reconcile',
  'Resolve an unknown payment outcome from authoritative provider evidence (SPK-PAY-007)',
  null,
  PaymentAttemptSchema,
);
query('/refunds/{id}', 'Read a refund', null, RefundSchema);
command(
  '/refunds/{id}/reconcile',
  'Resolve an unknown refund outcome from authoritative provider evidence',
  null,
  RefundSchema,
);
command(
  '/obligations',
  'Create an obligation (individual or team)',
  CreateObligationBody,
  ObligationSchema,
);
query('/obligations', 'List obligations', ListObligationsQuery, pageSchema(ObligationSchema));
query('/obligations/{id}', 'Read an obligation with consistent totals', null, ObligationSchema);
command(
  '/obligations/{id}/payments',
  'Pay toward an obligation (excess follows the overpayment policy, SPK-PAY-005)',
  PayObligationBody,
  PaymentOutcomeSchema,
);
command(
  '/obligations/{id}/contribution-requests',
  'Request a player contribution toward one team obligation (SPK-PAY-004)',
  CreateContributionRequestBody,
  ContributionRequestSchema,
);
query(
  '/contribution-requests/{id}',
  'Read a contribution request',
  null,
  ContributionRequestSchema,
);
command(
  '/contribution-requests/{id}/pay',
  'Pay a requested contribution',
  PayContributionBody,
  PaymentOutcomeSchema,
);
command('/credits', 'Issue a credit (SPK-PAY-009)', IssueCreditBody, CreditSchema);
query('/credits', "List a person's credits", ListCreditsQuery, pageSchema(CreditSchema));
query('/credits/{id}', 'Read a credit and its redemption history', null, CreditSchema);
command(
  '/credits/{id}/redeem',
  'Redeem a credit against an obligation',
  RedeemCreditBody,
  CreditSchema,
);
command(
  '/credits/{id}/approve',
  'Approve a credit held pending approval (overpayment, POL-015)',
  ApproveCreditBody,
  CreditSchema,
);
query('/installment-plans/{id}', 'Read an installment plan', null, InstallmentPlanSchema);
command(
  '/installments/{id}/collect',
  'Collect a due installment with the authorized payment method',
  CollectInstallmentBody,
  InstallmentPlanSchema,
);
command(
  '/installments/{id}/extend',
  'Extend an installment due date',
  ExtendInstallmentBody,
  InstallmentPlanSchema,
);
command(
  '/cash-tenders',
  'Record a cash or external tender with evidence (SPK-PAY-012)',
  RecordCashTenderBody,
  CashTenderSchema,
);
command(
  '/settlement-reconciliations',
  'Reconcile a processor settlement or cash drawer (SPK-PAY-011)',
  CreateSettlementReconciliationBody,
  SettlementReconciliationSchema,
);
query(
  '/finance/reconciliation-report',
  'Reconciliation report distinguishing orders, obligations, receipts, refunds, credits, fees, disputes, settlements and cash',
  ReconciliationReportQuery,
  ReconciliationReportSchema,
);
query(
  '/finance/ledger-balances',
  'Computed subledger balances (SPK-PAY-010)',
  z.object({ currency: CurrencyCode.default('USD') }),
  z.array(LedgerBalanceSchema),
);

openApiRegistry.registerPath({
  method: 'post',
  path: '/webhooks/payments/{provider}',
  summary: 'Authenticated payment provider event, recorded durably in the inbox (§4.11)',
  tags: [TAG],
  security: [],
  request: {
    params: z.object({ provider: z.string() }),
    headers: z.object({ 'x-payments-signature': z.string() }),
    body: { content: { 'application/json': { schema: PaymentWebhookBody } } },
  },
  responses: {
    202: ok(
      'Recorded (duplicates are acknowledged without a second effect)',
      z.object({ inboxEventId: z.uuid(), duplicate: z.boolean() }),
    ),
    401: err('Signature invalid'),
  },
});
