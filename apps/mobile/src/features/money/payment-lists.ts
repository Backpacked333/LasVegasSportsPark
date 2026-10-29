/**
 * Wording for the customer money lists of SCR-C-34 and SCR-C-35 that the stage-3 API added
 * (FIN-01, ENR-11): payment attempts, receipts, orders, checkouts in recovery, the payment still
 * on its way for a balance (`liveAttempt`), refunds of a payment and session packages
 * (SPK-PAY-002, SPK-PAY-005, SPK-PAY-007, SPK-PAY-008, SPK-UX-004, SPK-UX-010).
 *
 * Every status is a phrase and a tone; `StatusBadge` adds a glyph, so nothing is carried by colour
 * alone (SPK-UX-009). An unknown outcome is never success or failure: it reads "Payment outcome
 * being confirmed. Do not pay again." (SPK-PAY-007). Amounts are the API's minor units with their
 * currency, formatted for display only (SPK-PAY-001).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatInstant, formatMoney, hasPassed } from './format';
import type { Obligation, PaymentAttempt, Receipt } from './status';

export type Order = Schema<'Order'>;
export type Checkout = Schema<'Checkout'>;
export type LiveAttempt = Schema<'LiveAttempt'>;
export type PaymentDetail = Schema<'PaymentDetail'>;
export type PaymentRefundSummary = Schema<'PaymentRefundSummary'>;
export type PackageEntitlement = Schema<'PackageEntitlement'>;
export type PackageRedemption = Schema<'PackageRedemption'>;

type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

/** "Left to pay $40.00 of $120.00", with any overpayment named (SPK-PAY-005). */
export function obligationAmounts(obligation: Obligation): string {
  const t = obligation.totals;
  const parts =
    obligation.status === 'open'
      ? [
          `Left to pay ${formatMoney(t.remainingMinor, t.currency)} of ${formatMoney(t.amountMinor, t.currency)}`,
        ]
      : [`${formatMoney(t.amountMinor, t.currency)}`];
  if (t.excessMinor > 0)
    parts.push(`Paid beyond the balance: ${formatMoney(t.excessMinor, t.currency)}`);
  return parts.join('. ');
}

/** What a payment attempt paid for, in the customer's words. */
export const PAYMENT_PURPOSE_LABELS: Record<PaymentAttempt['purpose'], string> = {
  checkout: 'Registration payment',
  obligation: 'Balance payment',
  contribution: 'Team contribution',
  installment: 'Installment payment',
  pos_sale: 'Front desk purchase',
};

/** "Registration payment: $40.00". */
export function paymentTitle(
  attempt: Pick<PaymentAttempt, 'purpose' | 'amountMinor' | 'currency'>,
) {
  return `${PAYMENT_PURPOSE_LABELS[attempt.purpose]}: ${formatMoney(attempt.amountMinor, attempt.currency)}`;
}

/**
 * The payment still on its way for a balance (Obligation `liveAttempt`, FIN-01): the payer is told
 * to wait or not to pay again instead of finding out from a refused second payment (SPK-PAY-007).
 */
export function liveAttemptStatus(live: LiveAttempt): Status {
  switch (live.status) {
    case 'unknown':
      return { tone: 'warning', label: 'Payment outcome being confirmed. Do not pay again.' };
    case 'processing':
    case 'created':
      return { tone: 'pending', label: 'Payment processing' };
    case 'action_required':
      return { tone: 'warning', label: 'Payment needs your action' };
  }
}

/** The explanation under a live attempt, with the API's amount and times. */
export function liveAttemptText(live: LiveAttempt): string {
  const amount = formatMoney(live.amountMinor, live.currency);
  switch (live.status) {
    case 'unknown':
      return `A payment of ${amount} was started ${formatInstant(live.createdAt)} and its outcome is not known yet${
        live.unknownSince ? ` (since ${formatInstant(live.unknownSince)})` : ''
      }. Do not pay again: the facility confirms it.`;
    case 'processing':
    case 'created':
      return `A payment of ${amount} started ${formatInstant(live.createdAt)} is still being processed. Do not pay again.`;
    case 'action_required':
      return `A payment of ${amount} started ${formatInstant(live.createdAt)} is waiting for a step with the payment provider.`;
  }
}

/** Where a receipt's money came from. */
export const RECEIPT_SOURCE_LABELS: Record<Receipt['sourceKind'], string> = {
  payment_attempt: 'Paid through the app or online',
  cash_tender: 'Paid at the front desk',
};

/** "Applied $40.00. Paid beyond the balance: $5.00" (SPK-PAY-005: the excess stays visible). */
export function receiptAmounts(receipt: Receipt): string {
  const parts = [`Applied ${formatMoney(receipt.allocatedMinor, receipt.currency)}`];
  if (receipt.excessMinor > 0) {
    parts.push(`Paid beyond the balance: ${formatMoney(receipt.excessMinor, receipt.currency)}`);
  }
  return parts.join('. ');
}

/** The order's payment state (journeys.md); `awaiting_payment` is never "paid". */
export const ORDER_PAYMENT_STATUS: Record<Order['paymentStatus'], Status> = {
  awaiting_payment: { tone: 'warning', label: 'Payment needs your action' },
  paid: { tone: 'success', label: 'Paid' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

/** journeys.md: checkout `recovery_required` and `compensated` wording on the order (§4.11). */
export const ORDER_FULFILLMENT_STATUS: Record<Order['fulfillmentStatus'], Status> = {
  pending: { tone: 'pending', label: 'Registration being completed' },
  fulfilled: { tone: 'success', label: 'Registration complete' },
  recovery_required: {
    tone: 'warning',
    label: 'Payment received. We are completing your registration.',
  },
  compensated: { tone: 'neutral', label: 'Payment returned. Registration was not completed.' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

/**
 * One status for an order row: what the customer most needs to know. A fulfillment problem or
 * an unpaid order comes before "Registration complete".
 */
export function orderStatus(order: Order): Status {
  if (order.fulfillmentStatus === 'recovery_required' || order.fulfillmentStatus === 'compensated')
    return ORDER_FULFILLMENT_STATUS[order.fulfillmentStatus];
  if (order.paymentStatus !== 'paid') return ORDER_PAYMENT_STATUS[order.paymentStatus];
  return ORDER_FULFILLMENT_STATUS[order.fulfillmentStatus];
}

/** "Autumn U10 League", or "Autumn U10 League and 2 more". */
export function orderTitle(order: Order): string {
  const [first, ...rest] = [...order.lines].sort((a, b) => a.sequence - b.sequence);
  if (!first) return 'Order';
  return rest.length === 0 ? first.description : `${first.description} and ${rest.length} more`;
}

/** "Total $120.00. Credits applied $10.00. Due at checkout $40.00". */
export function orderAmounts(order: Order): string {
  const parts = [`Total ${formatMoney(order.totalMinor, order.currency)}`];
  if (order.creditsAppliedMinor > 0) {
    parts.push(`Credits applied ${formatMoney(order.creditsAppliedMinor, order.currency)}`);
  }
  parts.push(`Due at checkout ${formatMoney(order.dueNowMinor, order.currency)}`);
  return parts.join('. ');
}

/** journeys.md: a checkout that needs the facility to finish it (§4.11). */
export function checkoutRecoveryStatus(checkout: Checkout): Status {
  if (checkout.status === 'recovery_required') {
    return { tone: 'warning', label: 'Payment received. We are completing your registration.' };
  }
  if (checkout.status === 'compensated') {
    return { tone: 'neutral', label: 'Payment returned. Registration was not completed.' };
  }
  return { tone: 'pending', label: 'Registration being completed' };
}

/** A refund of a payment (SPK-PAY-008): an unknown refund outcome is never "refunded". */
export function refundStatus(status: PaymentRefundSummary['status']): Status {
  switch (status) {
    case 'requested':
    case 'processing':
      return { tone: 'pending', label: 'Refund processing' };
    case 'succeeded':
      return { tone: 'success', label: 'Refunded' };
    case 'failed':
      return { tone: 'danger', label: 'Refund failed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Refund canceled' };
    case 'unknown':
      return { tone: 'warning', label: 'Refund outcome being confirmed' };
  }
}

/**
 * journeys.md: "Session package: <count> left" (ENR-11, SPK-COND-002). The count, the expiry and
 * the state are the API's; a package with no expiry says so without claiming a rule (POL-039).
 */
export function packageStatus(pkg: PackageEntitlement, now: Date): Status {
  switch (pkg.status) {
    case 'active':
      if (pkg.expiresAt && hasPassed(pkg.expiresAt, now))
        return { tone: 'neutral', label: 'Expired' };
      if (pkg.remainingCredits <= 0) return { tone: 'neutral', label: 'All sessions used' };
      return {
        tone: 'success',
        label: `${pkg.remainingCredits} ${pkg.remainingCredits === 1 ? 'session' : 'sessions'} left`,
      };
    case 'exhausted':
      return { tone: 'neutral', label: 'All sessions used' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'revoked':
      return { tone: 'neutral', label: 'Revoked' };
  }
}

/** Redemptions, newest first: a reversal returns the session credit and names its reason. */
export function packageHistory(pkg: PackageEntitlement): PackageRedemption[] {
  return [...pkg.redemptions].sort(
    (a, b) => new Date(b.redeemedAt).getTime() - new Date(a.redeemedAt).getTime(),
  );
}
