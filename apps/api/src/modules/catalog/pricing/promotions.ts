import type {
  DiscountEligibilityRules,
  OfferingKind,
  PriceRule,
  PublicPromotion,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';

/** An active automatic discount as discovery reads it (promo codes are never loaded). */
export interface PromotionCandidate {
  id: string;
  name: string;
  description: string | null;
  amountKind: 'percentage' | 'fixed';
  amountValue: number;
  currency: string | null;
  rules: DiscountEligibilityRules;
  effectiveTo: Date | null;
  /** True when the redemption limit is used up: such a discount is no longer offered. */
  exhausted: boolean;
}

/**
 * The automatic discounts of the organization in force at `at` (SPK-PAY-003): `active`, inside
 * their effective window, not a promo code, and not exhausted. One read for a page of offerings.
 */
export async function loadPromotionCandidates(
  db: Db | Trx,
  organizationId: string,
  at: Date,
): Promise<PromotionCandidate[]> {
  const rows = await db
    .selectFrom('discount_definitions as d')
    .leftJoin('discount_redemptions as r', (join) =>
      join
        .onRef('r.organization_id', '=', 'd.organization_id')
        .onRef('r.discount_definition_id', '=', 'd.id'),
    )
    .select([
      'd.id',
      'd.name',
      'd.description',
      'd.amount_kind',
      'd.amount_value',
      'd.currency',
      'd.eligibility_rules',
      'd.effective_to',
      'd.redemption_limit',
      'r.redeemed_count',
    ])
    .where('d.organization_id', '=', organizationId)
    .where('d.kind', '=', 'automatic')
    .where('d.status', '=', 'active')
    .where('d.effective_from', '<=', at)
    .where((eb) => eb.or([eb('d.effective_to', 'is', null), eb('d.effective_to', '>', at)]))
    .orderBy('d.stacking_priority')
    .orderBy('d.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    amountKind: r.amount_kind,
    amountValue: Number(r.amount_value),
    currency: r.currency,
    rules: r.eligibility_rules as DiscountEligibilityRules,
    effectiveTo: r.effective_to === null ? null : new Date(r.effective_to),
    exhausted: r.redemption_limit !== null && (r.redeemed_count ?? 0) >= r.redemption_limit,
  }));
}

/**
 * The promotions shown on one offering (park UI discover badges): the candidates whose
 * eligibility rules the offering itself meets at `at` — kind, offering and program lists, the
 * early-registration deadline, the minimum line amount against the effective price, and a fixed
 * amount only in the price's currency. Basket-level rules (`minLines`) are stated, not decided:
 * the badge says how many lines the basket needs. Pure and deterministic.
 */
export function promotionsFor(
  offering: { id: string; kind: OfferingKind; programId: string },
  price: PriceRule | null,
  candidates: readonly PromotionCandidate[],
  at: Date,
): PublicPromotion[] {
  const out: PublicPromotion[] = [];
  for (const c of candidates) {
    if (c.exhausted) continue;
    const rules = c.rules;
    if (rules.offeringKinds && !rules.offeringKinds.includes(offering.kind)) continue;
    if (rules.offeringIds && !rules.offeringIds.includes(offering.id)) continue;
    if (rules.programIds && !rules.programIds.includes(offering.programId)) continue;
    const before = rules.registrationBefore ? new Date(rules.registrationBefore) : null;
    if (before && before.getTime() <= at.getTime()) continue;
    if (rules.minLineAmountMinor !== undefined) {
      if (!price || price.basePriceMinor < rules.minLineAmountMinor) continue;
    }
    if (c.amountKind === 'fixed' && (!price || price.currency !== c.currency)) continue;
    const until = [before, c.effectiveTo]
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    out.push({
      discountDefinitionId: c.id,
      name: c.name,
      description: c.description,
      basis: before ? 'early_registration' : rules.minLines ? 'multi_line' : 'automatic',
      amountKind: c.amountKind,
      amountValue: c.amountValue,
      currency: c.currency,
      minLines: rules.minLines ?? null,
      availableUntil: until ? until.toISOString() : null,
    });
  }
  return out;
}
