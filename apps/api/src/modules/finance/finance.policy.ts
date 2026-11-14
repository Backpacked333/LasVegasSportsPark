/**
 * Finance policy values the specification leaves to operators (§6.6 "Prices, taxes, discounts,
 * rounding" DEC-007; "Team liability, installments, overpayments" DEC-008; "Refunds, credits,
 * transfers, cash" DEC-009). The mechanisms are implemented; the values below are engineering
 * proposals until the owners decide. An approved catalog policy version of kind `installment`,
 * `overpayment` or `refund` with key `finance` overrides them (FinancePolicyResolver), and the
 * version id is recorded on every quote that used it (SPK-PAY-002 "applicable policies").
 */
import { CurrencyCode, StaffRole, z, type PolicyKind } from '@sportspark/contracts';

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

/**
 * SPK-PAY-016 (proposed amendment PA-08; open values **Pending decision**, DEC-102): the catalog
 * policy family finance reads for open-amount register lines. Its content is
 * `OpenAmountPolicyContent`; the finance operator approves it, like every policy that decides
 * money. Catalog's policy kinds are a closed list that has no kind for register rules yet, so the
 * family lives under the finance-approved kind `overpayment` with its own key (the finance family
 * of that kind keeps the key `finance` and is not read here). A kind of its own is a follow-up for
 * catalog; only this constant changes then.
 */
export const OPEN_AMOUNT_POLICY: { readonly kind: PolicyKind; readonly key: string } = {
  kind: 'overpayment',
  key: 'register-open-amount',
};

const CategoryCode = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const ChargePolicyKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const CeilingMinor = z.number().int().min(0).safe();

/** One reason category of the approved list: what it books to and which approved charges apply. */
const OpenAmountCategorySchema = z.strictObject({
  code: CategoryCode,
  label: z.string().trim().min(1).max(100),
  /** The accounting mapping: revenue is journaled under this category. */
  revenueCategory: CategoryCode,
  /** The tax treatment: keys of approved `tax_fee` policies applied to a line (DEC-057). */
  chargePolicyKeys: z.array(ChargePolicyKey).max(10).default([]),
});
export type OpenAmountCategory = z.infer<typeof OpenAmountCategorySchema>;

/**
 * The content of an approved open-amount policy version. A ceiling is the highest amount a person
 * of that staff role enters without a second approval; `defaultMinor` applies to a role the
 * version does not name. With `currency` stated the ceilings are amounts of that currency and a
 * sale in another currency takes no open-amount line; without it they are read in the minor units
 * of each sale's currency.
 */
export const OpenAmountPolicyContent = z.strictObject({
  currency: CurrencyCode.optional(),
  categories: z
    .array(OpenAmountCategorySchema)
    .min(1)
    .max(50)
    .refine((list) => new Set(list.map((c) => c.code)).size === list.length, {
      message: 'list each category code once',
    }),
  ceilings: z.strictObject({
    defaultMinor: CeilingMinor,
    byRole: z.partialRecord(StaffRole, CeilingMinor).default({}),
  }),
});

export interface OpenAmountLinePolicy {
  currency: string | null;
  categories: OpenAmountCategory[];
  ceilings: { defaultMinor: number; byRole: Partial<Record<StaffRole, number>> };
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
  /**
   * SPK-PAY-016 (proposed amendment PA-08): the open-amount rules that apply while no approved
   * policy version of `OPEN_AMOUNT_POLICY` is in effect. **Proposed**; the categories, the
   * ceilings and who may enter and approve are **Pending decision** (DEC-102).
   */
  openAmountLines: OpenAmountLinePolicy;
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
  // Proposed (DEC-102 pending): the examples the amendment names, none taxed, and one ceiling of
  // 50.00 in the sale's currency for desk staff with a higher one for finance. Tips and deposits
  // (questionnaire H9, G12) are not revenue and are left to the decision.
  openAmountLines: {
    currency: null,
    categories: [
      {
        code: 'field_damage_fee',
        label: 'Field damage fee',
        revenueCategory: 'facility_fees',
        chargePolicyKeys: [],
      },
      {
        code: 'lost_key',
        label: 'Lost key',
        revenueCategory: 'facility_fees',
        chargePolicyKeys: [],
      },
      {
        code: 'one_off_service',
        label: 'One-off service',
        revenueCategory: 'services',
        chargePolicyKeys: [],
      },
    ],
    ceilings: { defaultMinor: 5_000, byRole: { front_desk: 5_000, finance_operator: 25_000 } },
  },
};

/**
 * Payment reminders (SPK-COMMS-002 payment attention; park UI redesign): the shortest time between
 * two reminders for the same obligation, so a "remind all" pressed twice does not message a family
 * twice. An engineering placeholder: reminder frequency is part of the communication policy, which
 * is pending (DEC-012, DEC-062).
 */
export const PAYMENT_REMINDER_MIN_INTERVAL_HOURS = 24;
