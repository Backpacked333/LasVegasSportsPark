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

function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`;
}

/** The stored explanation of a quote line; empty for a plain term price. */
export function priceBasisLines(basis: PriceBasis | null, currency: string): string[] {
  if (!basis) return [];
  const lines: string[] = [];
  // SPK-PAY-014 (PA-03): the one tier that applied, with the days chosen under it.
  if (basis.tier) {
    lines.push(
      basis.tier.attendance === 'chosen_sessions'
        ? `${basis.tier.name}: ${days(basis.tier.selectedSessionIds.length)} chosen`
        : basis.tier.name,
    );
  }
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

type QuoteLine = Schema<'QuoteLine'>;

/** What a quote line charges for, said before its description: an add-on or the uniform. */
export function lineKindLabel(line: Pick<QuoteLine, 'lineKind'>): string | null {
  if (line.lineKind === 'addon') return 'Add-on';
  if (line.lineKind === 'uniform') return 'Uniform';
  return null;
}

/**
 * The stored basis of any quote line (SPK-PAY-002; SPK-PAY-014 add-ons, SPK-REG-012 uniform):
 * the price explanation of a place, the days of an add-on, and the size of a uniform with the
 * reason it was not charged. Only what the quote recorded is said.
 */
export function quoteLineBasisLines(
  line: Pick<QuoteLine, 'lineKind' | 'priceBasis' | 'addon' | 'uniform' | 'currency'>,
): string[] {
  if (line.lineKind === 'addon' && line.addon) {
    return [
      line.addon.selection === 'per_session'
        ? `Chosen for ${days(line.addon.quantity)}`
        : 'Chosen once for this registration',
    ];
  }
  if (line.lineKind === 'uniform' && line.uniform) {
    return [
      `Size ${line.uniform.size}`,
      ...(line.uniform.charged
        ? []
        : [
            `Not charged: this uniform is already held (listed at ${formatMoney(
              line.uniform.priceMinor,
              line.currency,
            )}).`,
          ]),
    ];
  }
  return priceBasisLines(line.priceBasis, line.currency);
}

type PriceSnapshot = Schema<'PriceSnapshot'>;

/**
 * The price of a basket line before the quote (SPK-PAY-013, SPK-PAY-014, SPK-PAY-015). A plain
 * term price is the base price each, as before. Otherwise it is the estimate the API worked out
 * from the tier, the membership and the classes still to come, labelled as an estimate, with what
 * it was worked out from. The app never multiplies a price itself.
 */
export function basketLinePrice(price: PriceSnapshot): {
  label: string;
  value: string;
  notes: string[];
} {
  const estimate = price.estimate;
  if (!estimate) {
    return {
      label: 'Base price each',
      value: formatMoney(price.basePriceMinor, price.currency),
      notes: [],
    };
  }
  const notes: string[] = [];
  if (estimate.tier) notes.push(estimate.tier.name);
  if (estimate.sessionCount !== null) {
    notes.push(
      `${formatMoney(estimate.appliedPriceMinor, price.currency)} per class × ${classes(
        estimate.sessionCount,
      )}`,
    );
  }
  if (estimate.appliedPrice === 'member') notes.push('Member price');
  notes.push('The price is confirmed when you review it.');
  return {
    label: 'Estimated price each',
    value: formatMoney(estimate.unitPriceMinor, price.currency),
    notes,
  };
}
