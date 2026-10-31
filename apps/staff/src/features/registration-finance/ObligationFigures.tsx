/**
 * The four obligation figures shown the same way everywhere (SPK-PAY-004: total obligation,
 * received, allocated and remaining, consistently), plus any excess, which stays visible and
 * traceable instead of disappearing into a zero balance (SPK-PAY-005).
 */
import type { Schema } from '@sportspark/api-client';
import { Facts } from './fields';
import { formatMoney } from './format';

export function ObligationFigures({
  totals,
  label = 'Obligation figures',
}: {
  totals: Schema<'ObligationTotals'>;
  label?: string;
}) {
  const items: [string, string][] = [
    ['Total obligation', formatMoney(totals.amountMinor, totals.currency)],
    ['Received', formatMoney(totals.receivedMinor, totals.currency)],
    ['Allocated', formatMoney(totals.allocatedMinor, totals.currency)],
    ['Remaining', formatMoney(totals.remainingMinor, totals.currency)],
  ];
  if (totals.excessMinor > 0) {
    items.push([
      'Excess held per the overpayment policy',
      formatMoney(totals.excessMinor, totals.currency),
    ]);
  }
  return <Facts label={label} items={items} />;
}
