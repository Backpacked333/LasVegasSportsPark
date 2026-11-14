/**
 * How a price is explained to a customer (SPK-PAY-013 per-session price, SPK-PAY-015 member price;
 * proposed amendments PA-02 and PA-04). Only what the API states is said: the per-class price, the
 * count and the product, and which price applied and why. The app never works out a price: the
 * product shown for a listing is the API's own figure for the view instant, and the quote decides.
 */
import type { Schema } from '@sportspark/api-client';
import { formatMoney } from './format';

type PriceBasis = Schema<'QuoteLinePriceBasis'>;
type PublicPrice = Schema<'PublicPrice'>;

function classes(count: number): string {
  return count === 1 ? '1 class' : `${count} classes`;
}

/** "$24.00 per class × 7 classes = $168.00". */
function product(perClassMinor: number, count: number, totalMinor: number, currency: string) {
  return `${formatMoney(perClassMinor, currency)} per class × ${classes(count)} = ${formatMoney(
    totalMinor,
    currency,
  )}`;
}

/** The stored explanation of a quote line; empty for a plain term price. */
export function priceBasisLines(basis: PriceBasis | null, currency: string): string[] {
  if (!basis) return [];
  const lines: string[] = [];
  if (basis.pricingBasis === 'per_session' && basis.sessions) {
    lines.push(
      product(basis.appliedPriceMinor, basis.sessions.count, basis.unitPriceMinor, currency),
    );
  }
  const member = basis.member;
  if (member?.applied) {
    lines.push(`Member price applied: ${member.entitlementName}`);
  } else if (member) {
    lines.push(
      member.reason === 'membership_suspended'
        ? `Standard price applied: ${member.entitlementName} was suspended when this price was made.`
        : `Standard price applied: ${member.entitlementName} was not held when this price was made.`,
    );
  }
  return lines;
}

/**
 * A per-session listing: the classes still to come at the price per class, as the API counted
 * them when the listing was read. Null for a term price.
 */
export function listedPerSessionLine(price: PublicPrice): string | null {
  if (price.pricingBasis !== 'per_session') return null;
  const count = price.remainingSessionCount ?? 0;
  if (count === 0 || price.remainingSessionsPriceMinor === null) {
    return 'No class of this activity is still to come.';
  }
  return product(price.basePriceMinor, count, price.remainingSessionsPriceMinor, price.currency);
}
