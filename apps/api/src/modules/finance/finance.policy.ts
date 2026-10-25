/**
 * Finance policy values the specification leaves to operators (§6.6 "Prices, taxes, discounts,
 * rounding" DEC-007; "Team liability, installments, overpayments" DEC-008; "Refunds, credits,
 * transfers, cash" DEC-009). The mechanisms are implemented; the values below are engineering
 * proposals until the owners decide. An approved catalog policy version of kind `installment`,
 * `overpayment` or `refund` with key `finance` overrides them (FinancePolicyResolver), and the
 * version id is recorded on every quote that used it (SPK-PAY-002 "applicable policies").
 */
export const FINANCE_POLICY_CONFIG = Symbol('FINANCE_POLICY_CONFIG');

/** The catalog policy family key finance reads for its own policy kinds. */
export const FINANCE_POLICY_KEY = 'finance';

export type OverpaymentHandling = 'hold_as_credit_pending_approval';
export type CompensationMethod = 'refund' | 'credit' | 'manual';

export interface InstallmentPolicy {
  enabled: boolean;
  maxInstallments: number;
  intervalDays: number;
  retry: { maxAttempts: number; retryIntervalHours: number };
  noticeDaysBefore: number;
}

export interface FinancePolicyConfig {
  /** POL-013 (DEC-007/DEC-006): quote validity; never beyond the basket's hold expiry. */
  quoteValidityMinutes: number;
  /** An awaiting checkout with no live payment is aborted this long after its hold expiry. */
  checkoutAbandonGraceMinutes: number;
  /** POL-015 (DEC-008): excess received beyond the remaining balance. */
  overpayment: OverpaymentHandling;
  /**
   * DEC-009: compensation when a paid checkout cannot be fulfilled because the place is no longer
   * available (SPK-AT-006). `refund` returns the money through the provider automatically.
   */
  compensation: CompensationMethod;
  /** POL-016 (DEC-008). */
  installments: InstallmentPolicy;
  /** POL-010 (DEC-009): expiry of credits finance issues itself; null means no expiry. */
  creditExpiryDays: number | null;
  /** SPK-PAY-007: an attempt older than this without evidence is reconciled with the provider. */
  reconcileAfterMinutes: number;
  /**
   * SPK-PAY-007, §4.11 step 10: a payment challenge (`action_required`) still open this long after
   * submission is treated as abandoned and canceled at the provider, so the checkout can end. The
   * challenge validity window depends on the processor (DEC-019 pending); the value must stay above
   * the basket hold (DEC-027) plus `checkoutAbandonGraceMinutes`.
   */
  actionRequiredCancelAfterMinutes: number;
  /** SPK-PAY-001 rounding of percentage taxes and fees (DEC-007). */
  rounding: 'half_up';
}

export const DEFAULT_FINANCE_POLICY: FinancePolicyConfig = {
  quoteValidityMinutes: 15,
  checkoutAbandonGraceMinutes: 5,
  overpayment: 'hold_as_credit_pending_approval',
  compensation: 'refund',
  installments: {
    enabled: true,
    maxInstallments: 3,
    intervalDays: 30,
    retry: { maxAttempts: 3, retryIntervalHours: 72 },
    noticeDaysBefore: 3,
  },
  creditExpiryDays: null,
  reconcileAfterMinutes: 15,
  actionRequiredCancelAfterMinutes: 60,
  rounding: 'half_up',
};
