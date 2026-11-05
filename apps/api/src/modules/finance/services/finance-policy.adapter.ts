import { Inject, Injectable } from '@nestjs/common';
import { percentageBasisPoints, money, type FinancialConsequence } from '@sportspark/contracts';
import { currentTransaction, type Trx } from '../../../kernel';
import { POLICY_PORT, type PolicyPort } from '../../catalog';
import type {
  CancellationConsequenceInput,
  FinancePolicyPort,
  TransferConsequenceInput,
} from '../../enrollment';

/**
 * Finance's answer to enrollment's FinancePolicyPort (registered as FINANCE_POLICY_IMPL): what a
 * transfer or cancellation means in money (DEC-009, POL-007/POL-008). Mechanism only — the
 * values come from the approved cancellation policy version the enrollment carries:
 *   - `refundBasisPoints` (integer) → a refund of that share of the price;
 *   - `creditBasisPoints` (integer) → a credit of that share;
 *   - neither → `review_required` (a person decides; never a silent "none" for a paid place).
 * Transfers: a price increase is a charge, a decrease a credit (engineering proposal, DEC-009).
 */
@Injectable()
export class FinancePolicyAdapter implements FinancePolicyPort {
  constructor(@Inject(POLICY_PORT) private readonly policies: PolicyPort) {}

  async transferConsequence(
    _organizationId: string,
    input: TransferConsequenceInput,
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
    if (!input.price || input.price.amountMinor === 0) {
      return {
        kind: 'none',
        amountMinor: 0,
        currency: input.price?.currency ?? null,
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
    const price = money(input.price.amountMinor, input.price.currency);
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
          explanation: `The cancellation policy grants a ${kind} of ${bp / 100}% of the price.`,
          policyVersionId: policy?.id ?? null,
        };
      }
    }
    return {
      kind: 'review_required',
      amountMinor: null,
      currency: input.price.currency,
      explanation: 'The cancellation policy states no refund or credit share; finance reviews it.',
      policyVersionId: policy?.id ?? input.cancellationPolicyVersionId,
    };
  }
}
