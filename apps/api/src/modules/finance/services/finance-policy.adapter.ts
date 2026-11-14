import { Inject, Injectable } from '@nestjs/common';
import { percentageBasisPoints, money, type FinancialConsequence } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { DATABASE, currentTransaction, type Trx } from '../../../kernel';
import { POLICY_PORT, PRICING_PORT, type PolicyPort, type PricingPort } from '../../catalog';
import type {
  CancellationConsequenceInput,
  FinancePolicyPort,
  TransferConsequenceInput,
} from '../../enrollment';
import { LinePricing } from '../pricing/line-pricing.service';

/**
 * Finance's answer to enrollment's FinancePolicyPort (registered as FINANCE_POLICY_IMPL): what a
 * transfer or cancellation means in money (DEC-009, POL-007/POL-008). Mechanism only — the
 * values come from the approved cancellation policy version the enrollment carries:
 *   - `refundBasisPoints` (integer) → a refund of that share of the price;
 *   - `creditBasisPoints` (integer) → a credit of that share;
 *   - neither → `review_required` (a person decides; never a silent "none" for a paid place).
 * Transfers: a price increase is a charge, a decrease a credit (engineering proposal, DEC-009).
 *
 * Proposed amendments PA-02 and PA-04 (SPK-PAY-013, SPK-PAY-015): the price enrollment passes is
 * the price rule's base price, which is not what a place priced per session or at a member price
 * cost. For a place whose purchase stored a price basis, "the price" of a cancellation is the
 * unit price that was quoted (the order line finance keeps); a transfer from such a place, or to
 * an offering priced that way, is never worked out from base prices: finance reviews it. A place
 * bought at a plain term price is handled exactly as before.
 *
 * Proposed amendments PA-03 and PA-07 (SPK-PAY-014, SPK-REG-012): the consequences follow the
 * lines actually bought. An add-on is refunded with the registration it belongs to: the share of
 * the cancellation policy applies to the place and its add-on lines together. A uniform line is
 * not part of that share (the amendment does not say a uniform is refunded, and it may have been
 * handed over): it is named in the explanation, and a cancellation where only the uniform was
 * charged is reviewed by finance. A transfer of a place bought with add-ons or a uniform is
 * reviewed by finance, like every place not bought at a plain term price.
 */
@Injectable()
export class FinancePolicyAdapter implements FinancePolicyPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    private readonly linePricing: LinePricing,
  ) {}

  /**
   * The unit price quoted for the enrollment's place when its purchase recorded a price basis
   * (per session, member price), read from finance's own order lines; null for a plain term price
   * and for a place never bought through a checkout.
   */
  private async quotedPrice(
    organizationId: string,
    enrollmentId: string,
    trx?: Trx,
  ): Promise<{ amountMinor: number; currency: string } | null> {
    const line = await (trx ?? currentTransaction() ?? this.db)
      .selectFrom('order_lines')
      .select(['unit_price_minor', 'currency', 'price_basis'])
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .where('line_kind', '=', 'registration')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const basis = line?.price_basis as { pricing?: unknown } | undefined;
    if (!line || !basis?.pricing) return null;
    return { amountMinor: line.unit_price_minor, currency: line.currency };
  }

  /**
   * SPK-PAY-014, SPK-REG-012: what the latest order of the enrollment charged for its add-ons and
   * its uniform (base amounts, as the place's price is a base amount), from finance's own order
   * lines. Zero for a place bought without extras and for one never bought through a checkout.
   */
  private async extrasBought(
    organizationId: string,
    enrollmentId: string,
    trx?: Trx,
  ): Promise<{ addonsMinor: number; uniformMinor: number; hasExtras: boolean }> {
    const db = trx ?? currentTransaction() ?? this.db;
    const place = await db
      .selectFrom('order_lines')
      .select('order_id')
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .where('line_kind', '=', 'registration')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!place) return { addonsMinor: 0, uniformMinor: 0, hasExtras: false };
    const extras = await db
      .selectFrom('order_lines')
      .select(['line_kind', 'base_amount_minor'])
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', place.order_id)
      .where('enrollment_id', '=', enrollmentId)
      .where('line_kind', '<>', 'registration')
      .execute();
    const sum = (kind: string) =>
      extras
        .filter((line) => line.line_kind === kind)
        .reduce((total, line) => total + Number(line.base_amount_minor), 0);
    return {
      addonsMinor: sum('addon'),
      uniformMinor: sum('uniform'),
      hasExtras: extras.length > 0,
    };
  }

  /** Whether a quote of the offering at `at` would use more than the rule's base price. */
  private async pricedByAmendment(
    organizationId: string,
    offeringId: string,
    at: Date,
    trx?: Trx,
  ): Promise<boolean> {
    const executor = trx ?? currentTransaction();
    const rule = await this.pricing.effectivePriceRule(organizationId, offeringId, at, executor);
    if (!rule) return false;
    if (rule.pricingBasis === 'per_session') return true;
    if (rule.memberPriceMinor === null && rule.tiers.length === 0) return false;
    const switches = await this.linePricing.switches(organizationId);
    // SPK-PAY-014: a place in an offering sold by tier costs its tier, not the base price.
    return (
      (rule.memberPriceMinor !== null && switches.memberPricing) ||
      (rule.tiers.length > 0 && switches.priceTiersAddons)
    );
  }

  async transferConsequence(
    organizationId: string,
    input: TransferConsequenceInput,
    trx?: Trx,
  ): Promise<FinancialConsequence> {
    const from = input.fromPrice?.amountMinor ?? 0;
    const to = input.toPrice?.amountMinor ?? 0;
    const currency = input.toPrice?.currency ?? input.fromPrice?.currency ?? null;
    if (input.fromPrice && input.toPrice && input.fromPrice.currency !== input.toPrice.currency) {
      return {
        kind: 'review_required',
        amountMinor: null,
        currency: null,
        explanation: 'The prices are in different currencies; finance reviews the transfer.',
        policyVersionId: null,
      };
    }
    // SPK-PAY-013, SPK-PAY-015: the base prices are not what these places cost, so a difference
    // of base prices would be a wrong charge or credit. A person decides (DEC-009 pending).
    if (
      (await this.quotedPrice(organizationId, input.enrollmentId, trx)) !== null ||
      (await this.pricedByAmendment(organizationId, input.toOfferingId, input.at, trx))
    ) {
      return {
        kind: 'review_required',
        amountMinor: null,
        currency,
        explanation:
          'One of the places is priced per session or at a member price; finance reviews the transfer.',
        policyVersionId: null,
      };
    }
    // SPK-PAY-014, SPK-REG-012: add-ons and a uniform belong to the place they were bought with
    // and to its offering; what moving the place means for them is for a person to decide.
    if ((await this.extrasBought(organizationId, input.enrollmentId, trx)).hasExtras) {
      return {
        kind: 'review_required',
        amountMinor: null,
        currency,
        explanation:
          'This place was bought with add-ons or a uniform; finance reviews the transfer.',
        policyVersionId: null,
      };
    }
    if (to === from) {
      return {
        kind: 'none',
        amountMinor: 0,
        currency,
        explanation: 'Same price: no refund, credit or charge.',
        policyVersionId: null,
      };
    }
    return to > from
      ? {
          kind: 'charge',
          amountMinor: to - from,
          currency,
          explanation: 'The new place costs more: the difference is charged (proposed, DEC-009).',
          policyVersionId: null,
        }
      : {
          kind: 'credit',
          amountMinor: from - to,
          currency,
          explanation:
            'The new place costs less: the difference becomes a credit (proposed, DEC-009).',
          policyVersionId: null,
        };
  }

  async cancellationConsequence(
    organizationId: string,
    input: CancellationConsequenceInput,
    trx?: Trx,
  ): Promise<FinancialConsequence> {
    // SPK-PAY-013, SPK-PAY-015: for a place bought per session or at a member price, the price is
    // the unit price the quote stored, not the rule's base price enrollment passes.
    const place = (await this.quotedPrice(organizationId, input.enrollmentId, trx)) ?? input.price;
    // SPK-PAY-014: an add-on is refunded with the registration it belongs to, so the policy's
    // share applies to the place and its add-on lines together. SPK-REG-012: a uniform is not
    // part of that share; it is named, and reviewed where it is all that was charged.
    const extras = await this.extrasBought(organizationId, input.enrollmentId, trx);
    const charged =
      place || extras.addonsMinor > 0
        ? {
            amountMinor: (place?.amountMinor ?? 0) + extras.addonsMinor,
            currency: place?.currency ?? input.price?.currency ?? null,
          }
        : null;
    const uniformNote =
      extras.uniformMinor > 0 ? ' The uniform is not part of this amount; finance reviews it.' : '';
    if (!charged || charged.amountMinor === 0 || charged.currency === null) {
      if (extras.uniformMinor > 0) {
        return {
          kind: 'review_required',
          amountMinor: null,
          currency: charged?.currency ?? null,
          explanation:
            'Nothing was charged for this place; its uniform was charged, and finance reviews it.',
          policyVersionId: input.cancellationPolicyVersionId,
        };
      }
      return {
        kind: 'none',
        amountMinor: 0,
        currency: charged?.currency ?? null,
        explanation: 'Nothing was charged for this place.',
        policyVersionId: input.cancellationPolicyVersionId,
      };
    }
    const policy = input.cancellationPolicyVersionId
      ? await this.policies.getPolicyVersion(
          organizationId,
          input.cancellationPolicyVersionId,
          trx ?? currentTransaction(),
        )
      : null;
    const content = policy?.approvalStatus === 'approved' ? policy.content : {};
    const price = money(charged.amountMinor, charged.currency);
    for (const [key, kind] of [
      ['refundBasisPoints', 'refund'],
      ['creditBasisPoints', 'credit'],
    ] as const) {
      const bp = content[key];
      if (typeof bp === 'number' && Number.isInteger(bp) && bp >= 0 && bp <= 10_000) {
        const amount = percentageBasisPoints(price, bp);
        return {
          kind,
          amountMinor: amount.amountMinor,
          currency: amount.currency,
          explanation:
            `The cancellation policy grants a ${kind} of ${bp / 100}% of the price${
              extras.addonsMinor > 0 ? ', the add-ons included' : ''
            }.` + uniformNote,
          policyVersionId: policy?.id ?? null,
        };
      }
    }
    return {
      kind: 'review_required',
      amountMinor: null,
      currency: charged.currency,
      explanation:
        'The cancellation policy states no refund or credit share; finance reviews it.' +
        uniformNote,
      policyVersionId: policy?.id ?? input.cancellationPolicyVersionId,
    };
  }
}
