/**
 * Handoff M 4a / 4b: the payment history as a family reads it (SPK-PAY-005, SPK-PAY-007,
 * SPK-PAY-008). Pure: the screen reads, this decides the words.
 *
 * - A payment is named by what it paid for: a registration order's lines (`GET /v1/orders/{id}`:
 *   the first line's description, "+ 1 more" for the rest, and the participant), or a fee
 *   (`GET /v1/obligations/{id}`: its description and debtor).
 * - A refund is its own row, green with a "+" (`GET /v1/payments/{id}` `refunds`, succeeded only:
 *   one being processed is never shown as money back).
 * - Only payments that went through are history; one being processed or unknown is shown on the
 *   older Payments views with "Do not pay again" (SPK-PAY-007), never as paid here.
 */
import type { Schema } from '@sportspark/api-client';

type PaymentAttempt = Schema<'PaymentAttempt'>;
type PaymentDetail = Schema<'PaymentDetail'>;
type Order = Schema<'Order'>;
type Obligation = Schema<'Obligation'>;

export interface HistoryRow {
  key: string;
  kind: 'payment' | 'refund';
  paymentId: string;
  title: string;
  personId: string | null;
  at: string;
  amountMinor: number;
  currency: string;
}

/** What a payment paid for, and for whom. */
export function paidFor(
  payment: PaymentAttempt,
  order: Order | undefined,
  obligation: Obligation | undefined,
): { title: string; personId: string | null } {
  if (order && order.lines.length > 0) {
    const first = order.lines[0] as Order['lines'][number];
    const more = order.lines.length - 1;
    return {
      title: more > 0 ? `${first.description} + ${more} more` : first.description,
      personId: first.participantPersonId,
    };
  }
  if (obligation) {
    return { title: obligation.description, personId: obligation.debtor.personId ?? null };
  }
  return { title: 'Payment', personId: null };
}

export function historyRows(
  payments: readonly PaymentAttempt[],
  details: Readonly<Record<string, PaymentDetail | undefined>>,
  orders: Readonly<Record<string, Order | undefined>>,
  obligations: Readonly<Record<string, Obligation | undefined>>,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const payment of payments) {
    if (payment.status !== 'succeeded') continue;
    const what = paidFor(
      payment,
      payment.orderId ? orders[payment.orderId] : undefined,
      payment.obligationId ? obligations[payment.obligationId] : undefined,
    );
    rows.push({
      key: payment.id,
      kind: 'payment',
      paymentId: payment.id,
      title: what.title,
      personId: what.personId,
      at: payment.resolvedAt ?? payment.createdAt,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    });
    for (const refund of details[payment.id]?.refunds ?? []) {
      if (refund.status !== 'succeeded') continue;
      rows.push({
        key: refund.id,
        kind: 'refund',
        paymentId: payment.id,
        title: `Refund · ${what.title}`,
        personId: what.personId,
        at: refund.requestedAt,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
      });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** "$40.00", "+$12.00" for money back. */
export function rowAmount(row: Pick<HistoryRow, 'kind' | 'amountMinor' | 'currency'>): string {
  const text = new Intl.NumberFormat('en-US', { style: 'currency', currency: row.currency }).format(
    row.amountMinor / 100,
  );
  return row.kind === 'refund' ? `+${text}` : text;
}

/** The refund rule of a place in words, from its cancellation preview (SPK-REG-010). */
export function refundWords(
  consequence: Schema<'FinancialConsequence'> | undefined,
  money: (minor: number, currency: string) => string,
): string {
  if (!consequence) return 'Checking what you would get back…';
  const amount =
    consequence.amountMinor !== null && consequence.currency
      ? money(consequence.amountMinor, consequence.currency)
      : null;
  switch (consequence.kind) {
    case 'refund':
      return amount ? `${amount} back to your card` : 'A refund to your card';
    case 'credit':
      return amount ? `${amount} as camp credit` : 'Camp credit';
    case 'charge':
      return amount ? `A ${amount} cancellation charge` : 'A cancellation charge';
    case 'review_required':
      return 'The desk decides what comes back';
    default:
      return 'No money back';
  }
}
