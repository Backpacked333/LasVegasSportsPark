import { Inject, Injectable } from '@nestjs/common';
import { errors, type PriceRule } from '@sportspark/contracts';
import { CapabilityService } from '../../../kernel';
import { PRICING_PORT, type PricingPort } from '../../catalog';
import { MEMBERSHIP_PRICING_PORT, type MembershipPricingPort } from '../../enrollment';
import type { LinePricingFacts } from './quote-calculator';

/** The two amendment switches of an organization, read once per quote (DEC-016). */
export interface PricingSwitches {
  perSessionPricing: boolean;
  memberPricing: boolean;
}

export interface PricedLine {
  offeringId: string;
  participantPersonId: string;
  /** A line that names one session buys that session only. */
  sessionId: string | null;
}

/**
 * Gathers the facts a line's unit price depends on beyond the price rule's base price
 * (SPK-PAY-013 per-session price, SPK-PAY-015 member price; proposed amendments PA-02 and PA-04,
 * open values pending DEC-096 and DEC-098). Every read goes through another module's port
 * (catalog's sessions, enrollment's membership ledger) and happens before the caller's unit of
 * work; nothing here is a price a client sent (SPK-PAY-001). The arithmetic itself is the pure
 * `priceBasisOf` of the quote calculator.
 *
 * With a capability off the behaviour is the one before its amendment: a member price on the rule
 * is not evaluated and the standard price applies; a rule priced per session cannot be quoted at
 * all (its base price is the price of one session, so charging it for the term would be wrong)
 * and the quote is refused with CAPABILITY_DISABLED.
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
    };
  }

  /**
   * The pricing facts of one line at `at`, or null when the line is a plain term price (the rule
   * is priced per term and no member price is evaluated), which is every line while both
   * capabilities are off.
   *
   * Throws ACCESS_DENIED (CAPABILITY_DISABLED) for a per-session rule while per-session pricing
   * is off, and RESOURCE_CONFLICT (details.code NO_SESSIONS_REMAINING) when no session of the
   * offering can still be attended.
   */
  async factsFor(
    organizationId: string,
    switches: PricingSwitches,
    line: PricedLine,
    rule: PriceRule,
    at: Date,
  ): Promise<LinePricingFacts | null> {
    let sessions: LinePricingFacts['sessions'] = null;
    if (rule.pricingBasis === 'per_session') {
      if (!switches.perSessionPricing) {
        // Reports the standard refusal (code, capability, decision references).
        await this.capabilities.require(organizationId, 'per_session_pricing');
      }
      // PA-02 proposed cut-off (DEC-096 pending): a session counts until it starts; no minimum
      // charge. Sessions are catalog's and are read outside the transaction.
      const remaining = await this.pricing.remainingSessions(organizationId, line.offeringId, at);
      const counted = line.sessionId
        ? remaining.filter((session) => session.id === line.sessionId)
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
    if (
      switches.memberPricing &&
      rule.memberPriceMinor !== null &&
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
        priceMinor: rule.memberPriceMinor,
        entitlementDefinitionId: rule.memberEntitlementDefinitionId,
        entitlementName: rule.memberEntitlementName ?? '',
        holds: standing.holds,
        reason: standing.reason,
        membershipEnrollmentId: standing.membershipEnrollmentId,
        checkedAt: at.toISOString(),
      };
    }

    if (rule.pricingBasis === 'term' && member === null) return null;
    return { pricingBasis: rule.pricingBasis, member, sessions };
  }
}
