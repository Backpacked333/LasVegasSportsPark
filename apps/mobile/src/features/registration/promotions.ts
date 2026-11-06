/**
 * Promotion badges in Discover and on camp weeks (SPK-PAY-003, park UI "promotions"):
 * `PublicOffering.promotions` lists the active automatic discounts that apply to an offering now.
 * Promo codes are never listed by the API. A badge is informational: the evaluated basket
 * (`POST /v1/discounts/evaluate`) and the quote decide what is applied after stacking, caps and
 * per-person limits, so the wording never promises an amount off a total.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatMoney } from './format';

export type PublicPromotion = Schema<'PublicPromotion'>;

/** "10% off", "$20.00 off". */
export function promotionAmount(promotion: PublicPromotion): string {
  if (promotion.amountKind === 'percentage') {
    const percent = promotion.amountValue / 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}% off`;
  }
  return promotion.currency
    ? `${formatMoney(promotion.amountValue, promotion.currency)} off`
    : 'Discount';
}

/** A date in the facility's zone, "Nov 15". */
function untilDate(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(
    date,
  );
}

/**
 * The badge's words: "Early bird: 10% off until Nov 15", "Siblings: 15% off with 2 or more
 * registrations". The discount's own name leads, so the badge says which discount it is.
 */
export function promotionText(promotion: PublicPromotion, timeZone: string): string {
  const parts = [`${promotion.name}: ${promotionAmount(promotion)}`];
  if (promotion.basis === 'multi_line' && promotion.minLines !== null) {
    parts.push(`with ${promotion.minLines} or more registrations`);
  }
  if (promotion.availableUntil) parts.push(`until ${untilDate(promotion.availableUntil, timeZone)}`);
  return parts.join(' ');
}

export function promotionBadges(
  offering: { promotions: readonly PublicPromotion[]; facility: { timezone: string } },
): StatusBadgeProps[] {
  return offering.promotions.map((promotion) => ({
    tone: 'info',
    label: promotionText(promotion, offering.facility.timezone),
  }));
}
