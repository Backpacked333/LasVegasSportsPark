/**
 * The explanation of a quote line's price as the quote stored it (SPK-PAY-013 per-session price,
 * SPK-PAY-015 member price; proposed amendments PA-02 and PA-04). Only what the API recorded is
 * said: the per-session price, the count and the product, and which price applied and why. A line
 * without a basis (a plain term price) has no explanation.
 */
import type { Schema } from '@sportspark/api-client';
import { formatMoney } from './format';

type PriceBasis = Schema<'QuoteLinePriceBasis'>;

function classes(count: number): string {
  return count === 1 ? '1 class' : `${count} classes`;
}

/** "$24.00 per class × 7 classes = $168.00"; null for a price that is not per session. */
export function perSessionLine(basis: PriceBasis, currency: string): string | null {
  if (basis.pricingBasis !== 'per_session' || !basis.sessions) return null;
  return `${formatMoney(basis.appliedPriceMinor, currency)} per class × ${classes(
    basis.sessions.count,
  )} = ${formatMoney(basis.unitPriceMinor, currency)}`;
}

/** "Member price applied: Annual membership", or why the standard price applied instead. */
export function memberLine(basis: PriceBasis): string | null {
  const member = basis.member;
  if (!member) return null;
  if (member.applied) return `Member price applied: ${member.entitlementName}`;
  return member.reason === 'membership_suspended'
    ? `Standard price applied: ${member.entitlementName} was suspended when the quote was made.`
    : `Standard price applied: ${member.entitlementName} was not held when the quote was made.`;
}

export function priceBasisLines(basis: PriceBasis | null, currency: string): string[] {
  if (!basis) return [];
  return [perSessionLine(basis, currency), memberLine(basis)].filter(
    (line): line is string => line !== null,
  );
}
