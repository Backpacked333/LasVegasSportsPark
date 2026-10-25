import { Inject, Injectable } from '@nestjs/common';
import type { PolicyVersion, QuotePolicyReferences } from '@sportspark/contracts';
import type { Trx } from '../../../kernel';
import { POLICY_PORT, type PolicyPort } from '../../catalog';
import {
  FINANCE_POLICY_CONFIG,
  FINANCE_POLICY_KEY,
  type CompensationMethod,
  type FinancePolicyConfig,
} from '../finance.policy';

export interface ResolvedFinancePolicy {
  config: FinancePolicyConfig;
  references: QuotePolicyReferences;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Applies approved catalog policy versions (kinds `installment`, `overpayment`, `refund`, key
 * `finance`) over the engineering defaults. Only recognised content keys are read; anything else
 * stays the default, and the quote records which versions and which defaults applied.
 */
@Injectable()
export class FinancePolicyResolver {
  constructor(
    @Inject(FINANCE_POLICY_CONFIG) private readonly defaults: FinancePolicyConfig,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
  ) {}

  get configuration(): FinancePolicyConfig {
    return this.defaults;
  }

  async resolve(organizationId: string, at: Date, trx?: Trx): Promise<ResolvedFinancePolicy> {
    // Sequential: one connection may carry the caller's transaction.
    const installment = await this.current(organizationId, 'installment', at, trx);
    const overpayment = await this.current(organizationId, 'overpayment', at, trx);
    const refund = await this.current(organizationId, 'refund', at, trx);
    return this.build(installment, overpayment, refund);
  }

  /**
   * SPK-PAY-002: the policy basis a quote recorded, for everything that happens to that purchase
   * later (checkout, recovery, compensation). The recorded versions apply even if a newer version
   * was approved since (or the recorded one was retired); where the quote recorded none, the
   * engineering default applies, as it did when the quote was made.
   */
  async resolveRecorded(
    organizationId: string,
    references: QuotePolicyReferences,
    trx?: Trx,
  ): Promise<ResolvedFinancePolicy> {
    const installment = await this.recorded(
      organizationId,
      references.installmentPolicyVersionId,
      trx,
    );
    const overpayment = await this.recorded(
      organizationId,
      references.overpaymentPolicyVersionId,
      trx,
    );
    const refund = await this.recorded(organizationId, references.refundPolicyVersionId, trx);
    return this.build(installment, overpayment, refund);
  }

  private build(
    installment: PolicyVersion | null,
    overpayment: PolicyVersion | null,
    refund: PolicyVersion | null,
  ): ResolvedFinancePolicy {
    const defaults: string[] = [];
    const config: FinancePolicyConfig = {
      ...this.defaults,
      installments: {
        ...this.defaults.installments,
        retry: { ...this.defaults.installments.retry },
      },
    };
    if (installment) {
      const c = installment.content;
      if (typeof c['enabled'] === 'boolean') config.installments.enabled = c['enabled'];
      config.installments.maxInstallments =
        positiveInt(c['maxInstallments']) ?? config.installments.maxInstallments;
      config.installments.intervalDays =
        positiveInt(c['intervalDays']) ?? config.installments.intervalDays;
      config.installments.retry.maxAttempts =
        positiveInt(c['retryMaxAttempts']) ?? config.installments.retry.maxAttempts;
      config.installments.retry.retryIntervalHours =
        positiveInt(c['retryIntervalHours']) ?? config.installments.retry.retryIntervalHours;
      config.installments.noticeDaysBefore =
        positiveInt(c['noticeDaysBefore']) ?? config.installments.noticeDaysBefore;
    } else {
      defaults.push('installment: engineering default (POL-016, DEC-008)');
    }
    if (!overpayment)
      defaults.push('overpayment: hold as credit pending approval (POL-015, DEC-008)');
    if (refund) {
      const compensation = refund.content['compensation'];
      if (compensation === 'refund' || compensation === 'credit' || compensation === 'manual') {
        config.compensation = compensation as CompensationMethod;
      }
    } else {
      defaults.push(`refund/compensation: ${config.compensation} (POL-009, DEC-009)`);
    }
    return {
      config,
      references: {
        installmentPolicyVersionId: installment?.id ?? null,
        overpaymentPolicyVersionId: overpayment?.id ?? null,
        refundPolicyVersionId: refund?.id ?? null,
        defaults,
      },
    };
  }

  private async recorded(
    organizationId: string,
    id: string | null | undefined,
    trx?: Trx,
  ): Promise<PolicyVersion | null> {
    if (!id) return null;
    return this.policies.getPolicyVersion(organizationId, id, trx);
  }

  private async current(
    organizationId: string,
    kind: 'installment' | 'overpayment' | 'refund',
    at: Date,
    trx?: Trx,
  ): Promise<PolicyVersion | null> {
    const version = await this.policies.currentPolicyVersion(
      organizationId,
      kind,
      FINANCE_POLICY_KEY,
      at,
      trx,
    );
    return version && version.approvalStatus === 'approved' ? version : null;
  }
}
