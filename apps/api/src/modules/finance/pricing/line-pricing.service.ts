import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type BasketLineAddon,
  type BasketLineUniform,
  type PriceRule,
} from '@sportspark/contracts';
import { CapabilityService } from '../../../kernel';
import { PRICING_PORT, type PricingPort } from '../../catalog';
import { MEMBERSHIP_PRICING_PORT, type MembershipPricingPort } from '../../enrollment';
import {
  addonQuoteLine,
  uniformQuoteLine,
  type LinePricingFacts,
  type QuoteLineInput,
} from './quote-calculator';

/** The amendment switches of an organization, read once per quote (DEC-016). */
export interface PricingSwitches {
  perSessionPricing: boolean;
  memberPricing: boolean;
  /** `price_tiers_addons` (SPK-PAY-014, PA-03). */
  priceTiersAddons: boolean;
  /** `uniforms` (SPK-REG-012, PA-07). */
  uniforms: boolean;
}

export interface PricedLine {
  offeringId: string;
  participantPersonId: string;
  /** A line that names one session buys that session only. */
  sessionId: string | null;
  /** SPK-PAY-014: the tier named on the line and its day selection (null = every session). */
  priceTierId?: string | null;
  selectedSessionIds?: string[] | null;
}

/** What a basket line chose beyond its place, as enrollment's basket states it. */
export interface LineExtras {
  offeringId: string;
  addons: readonly BasketLineAddon[];
  uniform: BasketLineUniform | null;
}

/**
 * Gathers the facts a line's unit price depends on beyond the price rule's base price
 * (SPK-PAY-013 per-session price, SPK-PAY-015 member price; proposed amendments PA-02 and PA-04,
 * open values pending DEC-096 and DEC-098), and the price tier of a line and the lines of its
 * add-ons and uniform (SPK-PAY-014, SPK-REG-012; proposed amendments PA-03 and PA-07, pending
 * DEC-097 and DEC-101). Every read goes through another module's port (catalog's sessions, tiers,
 * add-ons and uniforms; enrollment's membership ledger and basket) and happens before the
 * caller's unit of work; nothing here is a price a client sent (SPK-PAY-001). The arithmetic
 * itself is the pure `priceBasisOf` of the quote calculator.
 *
 * With a capability off the behaviour is the one before its amendment: a member price on the rule
 * is not evaluated and the standard price applies; the tiers of a rule are not evaluated and a
 * line without a tier is priced at the rule's base price. A rule priced per session cannot be
 * quoted at all (its base price is the price of one session, so charging it for the term would be
 * wrong), and neither can a line that names a tier, an add-on or a uniform whose capability was
 * turned off after it was chosen: the quote is refused with CAPABILITY_DISABLED.
 */
@Injectable()
export class LinePricing {
  constructor(
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    @Inject(MEMBERSHIP_PRICING_PORT) private readonly memberships: MembershipPricingPort,
    private readonly capabilities: CapabilityService,
  ) {}

  async switches(organizationId: string): Promise<PricingSwitches> {
    return {
      perSessionPricing: await this.capabilities.isEnabled(organizationId, 'per_session_pricing'),
      memberPricing: await this.capabilities.isEnabled(organizationId, 'member_pricing'),
      priceTiersAddons: await this.capabilities.isEnabled(organizationId, 'price_tiers_addons'),
      uniforms: await this.capabilities.isEnabled(organizationId, 'uniforms'),
    };
  }

  /**
   * The pricing facts of one line at `at`, or null when the line is a plain term price (the rule
   * is priced per term, the line names no tier and no member price is evaluated), which is every
   * line while the capabilities are off.
   *
   * Throws ACCESS_DENIED (CAPABILITY_DISABLED) for a per-session rule while per-session pricing
   * is off or a tier while tiers are off, and RESOURCE_CONFLICT with `details.code`
   * NO_SESSIONS_REMAINING (no session of the line can still be attended), TIER_REQUIRED (the rule
   * has tiers and the line names none) or TIER_NOT_AVAILABLE (the tier is not a tier of the rule
   * in effect, or its purchase deadline has passed).
   */
  async factsFor(
    organizationId: string,
    switches: PricingSwitches,
    line: PricedLine,
    rule: PriceRule,
    at: Date,
  ): Promise<LinePricingFacts | null> {
    // SPK-PAY-014 (PA-03): exactly one tier applies to a line; it comes first in the order.
    let tier: LinePricingFacts['tier'] = null;
    if (line.priceTierId) {
      if (!switches.priceTiersAddons) {
        await this.capabilities.require(organizationId, 'price_tiers_addons');
      }
      const found = rule.tiers.find((candidate) => candidate.id === line.priceTierId);
      if (!found) {
        throw errors.resourceConflict(
          'The price of this offering changed since the line was added; remove the line and add it again.',
          {
            code: 'TIER_NOT_AVAILABLE',
            offeringId: line.offeringId,
            priceTierId: line.priceTierId,
          },
        );
      }
      // The purchase instant is the quote instant (DEC-097 pending).
      if (found.availableUntil && new Date(found.availableUntil).getTime() <= at.getTime()) {
        throw errors.resourceConflict(
          `The tier "${found.name}" could be bought until ${found.availableUntil}.`,
          {
            code: 'TIER_NOT_AVAILABLE',
            offeringId: line.offeringId,
            priceTierId: found.id,
            availableUntil: found.availableUntil,
          },
        );
      }
      tier = {
        tierId: found.id,
        code: found.code,
        name: found.name,
        attendance: found.attendance,
        priceMinor: found.priceMinor,
        memberPriceMinor: found.memberPriceMinor,
        availableUntil: found.availableUntil,
        purchasedAt: at.toISOString(),
        selectedSessionIds: [...(line.selectedSessionIds ?? [])],
      };
    } else if (switches.priceTiersAddons && rule.tiers.length > 0) {
      throw errors.resourceConflict(
        'This offering is priced by tier and this line names none; remove the line and add it again with a tier.',
        {
          code: 'TIER_REQUIRED',
          offeringId: line.offeringId,
          participantPersonId: line.participantPersonId,
        },
      );
    }

    let sessions: LinePricingFacts['sessions'] = null;
    if (rule.pricingBasis === 'per_session') {
      if (!switches.perSessionPricing) {
        // Reports the standard refusal (code, capability, decision references).
        await this.capabilities.require(organizationId, 'per_session_pricing');
      }
      // PA-02 proposed cut-off (DEC-096 pending): a session counts until it starts; no minimum
      // charge. Sessions are catalog's and are read outside the transaction. A line with a day
      // selection counts the selected sessions only (SPK-PAY-014).
      const remaining = await this.pricing.remainingSessions(organizationId, line.offeringId, at);
      const selected = line.selectedSessionIds ? new Set(line.selectedSessionIds) : null;
      const counted = line.sessionId
        ? remaining.filter((session) => session.id === line.sessionId)
        : selected
          ? remaining.filter((session) => selected.has(session.id))
          : remaining;
      if (counted.length === 0) {
        throw errors.resourceConflict(
          line.sessionId
            ? 'This session has started or is no longer scheduled, so it cannot be priced.'
            : 'No session of this offering can still be attended, so there is nothing to price.',
          {
            code: 'NO_SESSIONS_REMAINING',
            offeringId: line.offeringId,
            participantPersonId: line.participantPersonId,
            countedAt: at.toISOString(),
          },
        );
      }
      sessions = { sessionIds: counted.map((session) => session.id), countedAt: at.toISOString() };
    }

    let member: LinePricingFacts['member'] = null;
    // With a tier, the member price is the tier's (SPK-PAY-014 then SPK-PAY-015).
    const memberPriceMinor = tier ? tier.memberPriceMinor : rule.memberPriceMinor;
    if (
      switches.memberPricing &&
      memberPriceMinor !== null &&
      rule.memberEntitlementDefinitionId !== null
    ) {
      // PA-04 proposed defaults (DEC-098 pending): the reference date is the quote instant and
      // the membership follows the participant (merged records resolved by enrollment's port).
      const standing = await this.memberships.memberStanding(
        organizationId,
        line.participantPersonId,
        rule.memberEntitlementDefinitionId,
        at,
      );
      member = {
        priceMinor: memberPriceMinor,
        entitlementDefinitionId: rule.memberEntitlementDefinitionId,
        entitlementName: rule.memberEntitlementName ?? '',
        holds: standing.holds,
        reason: standing.reason,
        membershipEnrollmentId: standing.membershipEnrollmentId,
        checkedAt: at.toISOString(),
      };
    }

    if (rule.pricingBasis === 'term' && member === null && tier === null) return null;
    return {
      pricingBasis: rule.pricingBasis,
      member,
      sessions,
      ...(tier ? { tier } : {}),
    };
  }

  /**
   * The quote lines of what a basket line chose beyond its place (SPK-PAY-014 add-ons,
   * SPK-REG-012 uniform), priced from catalog's own records now, never from the basket: one line
   * per add-on (its price each, times the sessions selected) and one for a priced uniform. A line
   * that chose nothing returns [] and reads nothing.
   *
   * Throws ACCESS_DENIED (CAPABILITY_DISABLED) when the capability of a choice was turned off,
   * RESOURCE_CONFLICT (`details.code` ADDON_NOT_OFFERED, UNIFORM_NOT_OFFERED) when an add-on or
   * the uniform was retired since it was chosen, and VALIDATION_FAILED for a second currency.
   */
  async extraLines(
    organizationId: string,
    switches: PricingSwitches,
    line: LineExtras,
    place: QuoteLineInput,
    currency: string | null,
  ): Promise<QuoteLineInput[]> {
    if (line.addons.length === 0 && !line.uniform) return [];
    if (line.addons.length > 0 && !switches.priceTiersAddons) {
      await this.capabilities.require(organizationId, 'price_tiers_addons');
    }
    if (line.uniform && !switches.uniforms) {
      await this.capabilities.require(organizationId, 'uniforms');
    }
    const extras = await this.pricing.offeringExtras(organizationId, line.offeringId);
    const out: QuoteLineInput[] = [];
    for (const chosen of line.addons) {
      const addon = extras.addons.find((candidate) => candidate.id === chosen.addonId);
      if (!addon || addon.status !== 'active') {
        throw errors.resourceConflict(
          'An add-on of this line is no longer offered; remove the line and add it again.',
          { code: 'ADDON_NOT_OFFERED', basketLineId: place.basketLineId, addonId: chosen.addonId },
        );
      }
      if (currency && addon.currency !== currency) {
        throw errors.validation('Every line of a quote must be priced in the same currency.', {
          basketLineId: place.basketLineId,
          addonId: addon.id,
        });
      }
      out.push(addonQuoteLine(place, addon, chosen.sessionIds));
    }
    if (line.uniform) {
      const chosen = line.uniform;
      const uniform = extras.uniforms.find(
        (candidate) => candidate.id === chosen.offeringUniformId,
      );
      if (!uniform || uniform.status !== 'active') {
        throw errors.resourceConflict(
          'The uniform of this line is no longer offered; remove the line and add it again.',
          { code: 'UNIFORM_NOT_OFFERED', basketLineId: place.basketLineId },
        );
      }
      if (currency && uniform.currency && uniform.currency !== currency) {
        throw errors.validation('Every line of a quote must be priced in the same currency.', {
          basketLineId: place.basketLineId,
          offeringUniformId: uniform.id,
        });
      }
      // SPK-REG-012: whether the participant already holds the current uniform is enrollment's
      // fact (the handed-over order it names); the offering's rule decides what it means.
      const uniformLine = uniformQuoteLine(place, uniform, chosen.size, chosen.heldUniformOrderId);
      if (uniformLine) out.push(uniformLine);
    }
    return out;
  }
}
