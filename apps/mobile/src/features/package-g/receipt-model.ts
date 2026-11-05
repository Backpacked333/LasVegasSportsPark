/**
 * What a point-of-sale receipt shows (Package G, §3.16 POS row "receipts, returns"; SPK-PAY-001,
 * SPK-PAY-002, SPK-PAY-008, SPK-UX-010; capability `point_of_sale`, DEC-016, DEC-079). Amounts are
 * the API's integer minor units with the receipt's currency, formatted for display only: the app
 * never adds lines, taxes or tenders up. Taxes and fees are the approved charges the sale applied
 * (DEC-057 decides which may appear; the API refuses a charge policy that is not approved).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

export type PosReceipt = Schema<'PosReceipt'>;
type TenderKind = PosReceipt['tenders'][number]['kind'];

type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

export function receiptStatus(status: PosReceipt['status']): Status {
  switch (status) {
    case 'paid':
      return { tone: 'success', label: 'Paid' };
    case 'partially_returned':
      return { tone: 'info', label: 'Paid, partly returned' };
    case 'returned':
      return { tone: 'neutral', label: 'Returned' };
    case 'voided':
      return { tone: 'neutral', label: 'Voided' };
    case 'open':
      // The API lists paid sales only; an open sale is never shown as paid.
      return { tone: 'pending', label: 'Not paid yet' };
  }
}

export const TENDER_LABELS: Record<TenderKind, string> = {
  cash: 'Cash',
  card: 'Card',
  external: 'Other payment recorded at the desk',
};

/**
 * A return in words. The receipt does not say whether a card refund has reached the card yet
 * (no refund status on `PosReceipt`, reported), so a card return never reads as refunded.
 */
export function returnText(kind: TenderKind): string {
  switch (kind) {
    case 'cash':
      return 'Refunded in cash at the desk';
    case 'card':
      return 'Refund to your card requested. This receipt does not show whether it has arrived; ask the front desk if it has not.';
    case 'external':
      return 'Refunded by the payment method recorded at the desk';
  }
}
