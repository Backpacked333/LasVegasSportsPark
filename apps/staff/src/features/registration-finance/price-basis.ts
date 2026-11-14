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

/** "Tier: Three days (3 days chosen)" for a line priced by a tier (SPK-PAY-014, PA-03). */
export function tierLine(basis: PriceBasis): string | null {
  const tier = basis.tier;
  if (!tier) return null;
  const days = tier.selectedSessionIds.length;
  return tier.attendance === 'chosen_sessions'
    ? `Tier: ${tier.name} (${days === 1 ? '1 day' : `${days} days`} chosen)`
    : `Tier: ${tier.name}`;
}

export function priceBasisLines(basis: PriceBasis | null, currency: string): string[] {
  if (!basis) return [];
  return [tierLine(basis), perSessionLine(basis, currency), memberLine(basis)].filter(
    (line): line is string => line !== null,
  );
}

type QuoteLine = Schema<'QuoteLine'>;

/** What a quote line charges for, said before its description: an add-on or the uniform. */
export function lineKindLabel(line: Pick<QuoteLine, 'lineKind'>): string | null {
  if (line.lineKind === 'addon') return 'Add-on';
  if (line.lineKind === 'uniform') return 'Uniform';
  return null;
}

/**
 * The stored basis of any quote line (SPK-PAY-002): the pricing basis of a place, "$9.00 each ×
 * 2 days = $18.00" for an add-on, and the size and the reason of a uniform that was not charged.
 */
export function quoteLineBasisLines(
  line: Pick<QuoteLine, 'lineKind' | 'priceBasis' | 'addon' | 'uniform' | 'currency'>,
): string[] {
  if (line.lineKind === 'addon' && line.addon) {
    const { addon } = line;
    const each = formatMoney(addon.unitPriceMinor, line.currency);
    return [
      addon.selection === 'per_session'
        ? `${each} each × ${addon.quantity === 1 ? '1 day' : `${addon.quantity} days`} = ${formatMoney(
            addon.unitPriceMinor * addon.quantity,
            line.currency,
          )}`
        : `${each}, once for the registration`,
    ];
  }
  if (line.lineKind === 'uniform' && line.uniform) {
    const { uniform } = line;
    return [
      `Size ${uniform.size}`,
      ...(uniform.charged
        ? []
        : [
            `Not charged: the participant already holds this uniform (listed at ${formatMoney(
              uniform.priceMinor,
              line.currency,
            )}).`,
          ]),
    ];
  }
  return priceBasisLines(line.priceBasis, line.currency);
}

type PriceSnapshot = Schema<'PriceSnapshot'>;

/**
 * The price of a basket line before the quote (SPK-PAY-013, SPK-PAY-014, SPK-PAY-015): the
 * estimate the API worked out from the tier, the membership and the sessions still to attend
 * when the line has one, else the base price. Never a figure computed here.
 */
export function basketLinePrice(price: PriceSnapshot | null): { amount: string; notes: string[] } {
  if (!price) return { amount: 'not priced', notes: [] };
  const estimate = price.estimate;
  if (!estimate) return { amount: formatMoney(price.basePriceMinor, price.currency), notes: [] };
  const notes: string[] = [];
  if (estimate.tier) notes.push(`Tier: ${estimate.tier.name}`);
  if (estimate.sessionCount !== null) {
    notes.push(
      `${formatMoney(estimate.appliedPriceMinor, price.currency)} per class × ${classes(
        estimate.sessionCount,
      )}`,
    );
  }
  if (estimate.appliedPrice === 'member') notes.push('Member price');
  notes.push('Estimate: the quote decides the price');
  return { amount: formatMoney(estimate.unitPriceMinor, price.currency), notes };
}
