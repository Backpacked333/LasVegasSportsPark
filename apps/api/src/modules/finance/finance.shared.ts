import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  systemPrincipal,
  z,
  type AppliedCharge,
  type AppliedCredit,
  type CashTender,
  type Credit,
  type CreditUse,
  type FutureObligation,
  type Installment,
  type InstallmentPlan,
  type LinePolicyReferences,
  type LiveAttempt,
  type Order,
  type PaymentAttempt,
  type Principal,
  type Quote,
  type QuoteDiscountLine,
  type QuoteLine,
  type QuotePolicyReferences,
  type Receipt,
  type Refund,
  type Refundable,
  type SettlementReconciliation,
} from '@sportspark/contracts';
import type {
  CashTendersTable,
  CreditRedemptionsTable,
  CreditsTable,
  Db,
  InstallmentPlansTable,
  InstallmentsTable,
  OrderLinesTable,
  OrdersTable,
  PaymentAttemptsTable,
  PaymentRefundablesTable,
  QuoteLinesTable,
  QuotesTable,
  ReceiptsTable,
  RefundAttemptsTable,
  SettlementReconciliationsTable,
} from '@sportspark/db';
import { sql, type RawBuilder, type Selectable, type SqlBool } from 'kysely';
import type { RequestWithContext, Trx } from '../../kernel';

export type Reader = Db | Trx;
export type QuoteRow = Selectable<QuotesTable>;
export type QuoteLineRow = Selectable<QuoteLinesTable>;
export type OrderRow = Selectable<OrdersTable>;
export type OrderLineRow = Selectable<OrderLinesTable>;
export type PaymentAttemptRow = Selectable<PaymentAttemptsTable>;
export type ReceiptRow = Selectable<ReceiptsTable>;
export type RefundRow = Selectable<RefundAttemptsTable>;
export type RefundableRow = Selectable<PaymentRefundablesTable>;
export type CreditRow = Selectable<CreditsTable>;
export type CreditRedemptionRow = Selectable<CreditRedemptionsTable>;
export type InstallmentPlanRow = Selectable<InstallmentPlansTable>;
export type InstallmentRow = Selectable<InstallmentsTable>;
export type CashTenderRow = Selectable<CashTendersTable>;
export type SettlementRow = Selectable<SettlementReconciliationsTable>;

/** Correlation id assigned by the kernel middleware, for audit and outbox records (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export function isStaffLike(principal: Principal): boolean {
  return principal.kind === 'staff' || principal.kind === 'system';
}

/** The system actor finance uses for follow-up work (timers, webhooks, reconciliation). */
export function financeSystem(organizationId: string, label: string): Principal {
  return systemPrincipal(organizationId, label);
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function minutesFrom(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

export function daysFrom(at: Date, days: number): Date {
  return new Date(at.getTime() + days * 86_400_000);
}

export function hoursFrom(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

export async function withSavepoint<T>(trx: Trx, name: string, fn: () => Promise<T>): Promise<T> {
  await sql.raw(`savepoint "${name}"`).execute(trx);
  try {
    const result = await fn();
    await sql.raw(`release savepoint "${name}"`).execute(trx);
    return result;
  } catch (error) {
    await sql.raw(`rollback to savepoint "${name}"`).execute(trx);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Row → contract mappers
// ---------------------------------------------------------------------------------------------

export function toQuoteLine(row: QuoteLineRow): QuoteLine {
  return {
    id: row.id,
    sequence: row.sequence,
    basketLineId: row.basket_line_id,
    participantPersonId: row.participant_person_id,
    offeringId: row.offering_id,
    description: row.description,
    quantity: row.quantity,
    priceRuleId: row.price_rule_id,
    unitPriceMinor: row.unit_price_minor,
    baseAmountMinor: row.base_amount_minor,
    discountMinor: row.discount_minor,
    taxMinor: row.tax_minor,
    feeMinor: row.fee_minor,
    includedTaxMinor: row.included_tax_minor,
    totalMinor: row.total_minor,
    currency: row.currency,
    discounts: row.discount_lines as unknown as QuoteDiscountLine[],
    charges: row.charge_lines as unknown as AppliedCharge[],
    policies: row.policy_references as unknown as LinePolicyReferences,
    enrollmentId: row.enrollment_id,
  };
}

export function toQuote(row: QuoteRow, lines: QuoteLineRow[], now: Date): Quote {
  const expired =
    row.status === 'expired' ||
    (row.status === 'active' && new Date(row.expires_at).getTime() <= now.getTime());
  return {
    id: row.id,
    basketId: row.basket_id,
    payerPersonId: row.payer_person_id,
    status: expired ? 'expired' : row.status,
    currency: row.currency,
    lines: lines.map(toQuoteLine),
    subtotalMinor: row.subtotal_minor,
    discountMinor: row.discount_minor,
    taxMinor: row.tax_minor,
    feeMinor: row.fee_minor,
    includedTaxMinor: row.included_tax_minor,
    totalMinor: row.total_minor,
    creditsAppliedMinor: row.credits_applied_minor,
    appliedCredits: row.applied_credits as unknown as AppliedCredit[],
    dueNowMinor: row.due_now_minor,
    paymentPlan: row.payment_plan,
    futureObligations: row.future_obligations as unknown as FutureObligation[],
    discounts: row.discounts as unknown as QuoteDiscountLine[],
    policies: row.policy_references as unknown as QuotePolicyReferences,
    expiresAt: iso(row.expires_at),
    consumedByCheckoutId: row.consumed_by_checkout_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toPaymentAttempt(row: PaymentAttemptRow): PaymentAttempt {
  return {
    id: row.id,
    purpose: row.purpose,
    status: row.status,
    amountMinor: row.amount_minor,
    currency: row.currency,
    provider: row.provider,
    providerReference: row.provider_reference,
    actionRequired: row.action_required_payload ?? null,
    failureReason: row.failure_reason,
    evidenceSource: row.evidence_source,
    payerPersonId: row.payer_person_id,
    checkoutId: row.checkout_id,
    orderId: row.order_id,
    obligationId: row.obligation_id,
    contributionRequestId: row.contribution_request_id,
    installmentId: row.installment_id,
    posSaleId: row.pos_sale_id ?? null,
    unknownSince: isoOrNull(row.unknown_since),
    resolvedAt: isoOrNull(row.resolved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    paymentAttemptId: row.payment_attempt_id,
    cashTenderId: row.cash_tender_id,
    amountMinor: row.amount_minor,
    allocatedMinor: row.allocated_minor,
    excessMinor: row.excess_minor,
    currency: row.currency,
    receivedAt: iso(row.received_at),
  };
}

export function toOrder(
  row: OrderRow,
  lines: OrderLineRow[],
  obligationIds: string[],
  installmentPlanId: string | null,
): Order {
  return {
    id: row.id,
    quoteId: row.quote_id,
    basketId: row.basket_id,
    payerPersonId: row.payer_person_id,
    currency: row.currency,
    totalMinor: row.total_minor,
    creditsAppliedMinor: row.credits_applied_minor,
    dueNowMinor: row.due_now_minor,
    paymentStatus: row.payment_status,
    fulfillmentStatus: row.fulfillment_status,
    lines: lines.map((line) => ({
      id: line.id,
      sequence: line.sequence,
      basketLineId: line.basket_line_id,
      enrollmentId: line.enrollment_id,
      participantPersonId: line.participant_person_id,
      offeringId: line.offering_id,
      description: line.description,
      quantity: line.quantity,
      priceRuleId: line.price_rule_id,
      unitPriceMinor: line.unit_price_minor,
      baseAmountMinor: line.base_amount_minor,
      discountMinor: line.discount_minor,
      taxMinor: line.tax_minor,
      feeMinor: line.fee_minor,
      totalMinor: line.total_minor,
      currency: line.currency,
      policies: line.policy_references as unknown as LinePolicyReferences,
    })),
    obligationIds,
    installmentPlanId,
    paidAt: isoOrNull(row.paid_at),
    fulfilledAt: isoOrNull(row.fulfilled_at),
    canceledAt: isoOrNull(row.canceled_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toRefundable(row: RefundableRow): Refundable {
  return {
    capturedMinor: row.captured_minor,
    refundedMinor: row.refunded_minor,
    reservedMinor: row.reserved_minor,
    availableMinor: row.captured_minor - row.refunded_minor - row.reserved_minor,
    currency: row.currency,
  };
}

export function toRefund(row: RefundRow, refundable: RefundableRow): Refund {
  return {
    id: row.id,
    paymentAttemptId: row.payment_attempt_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    purpose: row.purpose,
    status: row.status,
    reservationStatus: row.reservation_status,
    reason: row.reason,
    providerReference: row.provider_reference,
    failureReason: row.failure_reason,
    checkoutId: row.checkout_id,
    operationId: row.operation_id,
    refundable: toRefundable(refundable),
    unknownSince: isoOrNull(row.unknown_since),
    resolvedAt: isoOrNull(row.resolved_at),
    createdAt: iso(row.created_at),
  };
}

export function toCredit(row: CreditRow, redemptions: CreditRedemptionRow[], now: Date): Credit {
  const lapsed =
    row.status === 'active' && row.expires_at !== null && new Date(row.expires_at) <= now;
  return {
    id: row.id,
    ownerPersonId: row.owner_person_id,
    currency: row.currency,
    originalMinor: row.original_minor,
    remainingMinor: row.remaining_minor,
    permittedUses: row.permitted_uses as CreditUse[],
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    status: lapsed ? 'expired' : row.status,
    expiresAt: isoOrNull(row.expires_at),
    reason: row.reason,
    approvedAt: isoOrNull(row.approved_at),
    redemptions: redemptions.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountMinor: r.amount_minor,
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      redeemedAt: iso(r.redeemed_at),
    })),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toInstallment(row: InstallmentRow): Installment {
  return {
    id: row.id,
    sequence: row.sequence,
    obligationId: row.obligation_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    dueAt: iso(row.due_at),
    originalDueAt: iso(row.original_due_at),
    status: row.status,
    attemptCount: row.attempt_count,
    lastFailureReason: row.last_failure_reason,
    nextRetryAt: isoOrNull(row.next_retry_at),
    paidAt: isoOrNull(row.paid_at),
    extensionCount: row.extension_count,
    noticeSentAt: isoOrNull(row.notice_sent_at),
    revision: row.revision,
  };
}

export function toInstallmentPlan(
  row: InstallmentPlanRow,
  installments: InstallmentRow[],
  outstandingMinor: number,
): InstallmentPlan {
  const authorization = row.payment_authorization as {
    authorizedAt: string;
    authorizedByPersonId: string | null;
  };
  const retry = row.retry_policy as { maxAttempts: number; retryIntervalHours: number };
  const notice = row.notice_policy as { daysBefore: number };
  return {
    id: row.id,
    orderId: row.order_id,
    payerPersonId: row.payer_person_id,
    currency: row.currency,
    totalMinor: row.total_minor,
    status: row.status,
    // The stored payment-method reference is never returned (§4.14).
    authorization: {
      authorizedAt: authorization.authorizedAt,
      authorizedByPersonId: authorization.authorizedByPersonId,
    },
    retryPolicy: { maxAttempts: retry.maxAttempts, retryIntervalHours: retry.retryIntervalHours },
    noticePolicy: { daysBefore: notice.daysBefore },
    outstandingMinor,
    installments: installments.map(toInstallment),
    revision: row.revision,
  };
}

export function toCashTender(
  row: CashTenderRow,
  receipt: ReceiptRow | null,
  overpaymentCreditId: string | null,
): CashTender {
  return {
    id: row.id,
    facilityId: row.facility_id,
    tenderKind: row.tender_kind,
    payerPersonId: row.payer_person_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    obligationId: row.obligation_id,
    checkoutId: row.checkout_id,
    evidence: row.evidence,
    recordedByPersonId: row.recorded_by_person_id,
    recordedAt: iso(row.recorded_at),
    status: row.status,
    reconciliationId: row.reconciliation_id,
    receipt: receipt ? toReceipt(receipt) : null,
    overpaymentCreditId,
  };
}

export function toSettlement(row: SettlementRow): SettlementReconciliation {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    facilityId: row.facility_id,
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    currency: row.currency,
    expectedMinor: row.expected_minor,
    reportedMinor: row.reported_minor,
    differenceMinor: row.difference_minor,
    status: row.status,
    breakdown: row.breakdown,
    externalReference: row.external_reference,
    performedAt: iso(row.performed_at),
  };
}

// ---------------------------------------------------------------------------------------------
// Live attempts and PAYMENT_OUTCOME_UNKNOWN (FIN-01, SPK-PAY-007)
// ---------------------------------------------------------------------------------------------

export const LIVE_ATTEMPT_STATES = ['created', 'action_required', 'processing', 'unknown'] as const;

export function toLiveAttempt(row: PaymentAttemptRow): LiveAttempt {
  return {
    id: row.id,
    status: row.status as LiveAttempt['status'],
    amountMinor: row.amount_minor,
    currency: row.currency,
    unknownSince: isoOrNull(row.unknown_since),
    createdAt: iso(row.created_at),
  };
}

/**
 * The details of a PAYMENT_OUTCOME_UNKNOWN refusal (FIN-01): the attempt's payer and staff learn
 * which attempt is in the way (`attemptId`, with the earlier `paymentAttemptId` kept for
 * existing clients) and its purpose; anyone else learns only that a payment is on its way, never
 * another payer's attempt (§4.10).
 */
export function outcomeUnknownDetails(
  principal: Principal,
  attempt: Pick<PaymentAttemptRow, 'id' | 'purpose' | 'status' | 'payer_person_id'>,
): Record<string, unknown> {
  const visible =
    isStaffLike(principal) ||
    (principal.personId !== null && principal.personId === attempt.payer_person_id);
  return visible
    ? {
        attemptId: attempt.id,
        paymentAttemptId: attempt.id,
        purpose: attempt.purpose,
        status: attempt.status,
      }
    : { purpose: attempt.purpose, status: attempt.status };
}

// ---------------------------------------------------------------------------------------------
// Keyset pages (§4.5, FIN-01/02). The cursor carries the ordering column as the database's own
// text so microseconds survive the round trip, and the id as the tie-breaker; a malformed cursor
// reads as the first page.
// ---------------------------------------------------------------------------------------------

const KeysetCursor = z.object({ at: z.string().min(1).max(64), id: z.uuid() });
export type Keyset = z.infer<typeof KeysetCursor>;

export function decodeKeyset(cursor: string | undefined): Keyset | null {
  return decodeCursor(cursor, KeysetCursor);
}

/** `<table>.<column>::text`, selected as `cursor_at` beside the row. */
export function keysetAt(table: string, column = 'created_at'): RawBuilder<string> {
  return sql<string>`${sql.ref(`${table}.${column}`)}::text`;
}

/** Rows strictly after the cursor in (`column` desc, id desc) order. */
export function afterKeysetDesc(
  table: string,
  cursor: Keyset,
  column = 'created_at',
): RawBuilder<SqlBool> {
  return sql<SqlBool>`(${sql.ref(`${table}.${column}`)}, ${sql.ref(`${table}.id`)}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** Rows strictly after the cursor in (`column` asc, id asc) order. */
export function afterKeysetAsc(
  table: string,
  cursor: Keyset,
  column = 'created_at',
): RawBuilder<SqlBool> {
  return sql<SqlBool>`(${sql.ref(`${table}.${column}`)}, ${sql.ref(`${table}.id`)}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** Splits a `limit + 1` read into the page and its next cursor. */
export function keysetPage<R extends { id: string; cursor_at: string }>(
  rows: readonly R[],
  limit: number,
): { rows: R[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  };
}
