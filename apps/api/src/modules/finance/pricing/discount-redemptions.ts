import { errors, type QuoteDiscountLine } from '@sportspark/contracts';

/**
 * R3-TIME-MONEY-01 (SPK-PAY-003 redemption limits, SPK-PAY-002, §4.7): the discount redemptions a
 * checkout records. Catalog evaluates a per-person limit per participant (the lines' participants,
 * explained as "per-participant limit") and its database guard (migrations 0207/0208) counts the
 * person a redemption names, so finance redeems against the same person: one redemption per
 * applied discount and per participant whose lines that discount reduced, never one per order in
 * the payer's name. A guardian paying for two children therefore uses each child's allowance
 * once, and two guardians paying for the same child use that child's one allowance.
 *
 * The redemption's reference is the participant's first discounted order line (by sequence), so
 * a replay of the same checkout redeems nothing twice and the release on compensation names
 * exactly what was redeemed. Its amount is the part of the discount allocated to that
 * participant's lines, so the redemptions of one discount add up to the quoted discount.
 *
 * Pure and deterministic: the same quote and lines always give the same redemptions in the same
 * order (quote discount order, then line sequence).
 */

/** The reference type of a checkout's discount redemption (catalog's ledger is free text). */
export const DISCOUNT_REDEMPTION_REFERENCE = 'order_line';

export interface DiscountRedemptionLine {
  orderLineId: string;
  sequence: number;
  participantPersonId: string;
  /** The discounts allocated to this line, as the quote recorded them. */
  discounts: readonly QuoteDiscountLine[];
}

export interface ParticipantRedemption {
  discountDefinitionId: string;
  personId: string;
  /** The participant's first order line the discount applies to: the redemption's reference. */
  orderLineId: string;
  amountMinor: number;
}

export function participantRedemptions(
  discounts: readonly Pick<QuoteDiscountLine, 'discountDefinitionId'>[],
  lines: readonly DiscountRedemptionLine[],
): ParticipantRedemption[] {
  const ordered = [...lines].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<string>();
  const redemptions: ParticipantRedemption[] = [];
  for (const { discountDefinitionId } of discounts) {
    if (seen.has(discountDefinitionId)) continue;
    seen.add(discountDefinitionId);
    const byParticipant = new Map<string, ParticipantRedemption>();
    for (const line of ordered) {
      const amount = line.discounts
        .filter((d) => d.discountDefinitionId === discountDefinitionId)
        .reduce((sum, d) => sum + d.amountMinor, 0);
      if (amount <= 0) continue;
      const existing = byParticipant.get(line.participantPersonId);
      if (existing) existing.amountMinor += amount;
      else {
        byParticipant.set(line.participantPersonId, {
          discountDefinitionId,
          personId: line.participantPersonId,
          orderLineId: line.orderLineId,
          amountMinor: amount,
        });
      }
    }
    if (byParticipant.size === 0) {
      // An applied discount always reduces at least one line (catalog allocates only positive
      // amounts); a discount without a line could be redeemed for no one, so it is refused.
      throw errors.internal('A quoted discount is allocated to no line.');
    }
    redemptions.push(...byParticipant.values());
  }
  return redemptions;
}
