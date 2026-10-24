/**
 * Customer-visible status vocabulary for SCR-C-32 to SCR-C-35, from docs/package-a/journeys.md
 * section 3 (SPK-UX-004, SPK-UX-010). Every status is a phrase plus a tone; StatusBadge adds a
 * distinct glyph, so no status is carried by colour alone (SPK-UX-009). "Payment processing",
 * "Awaiting placement" and "Confirmed" use different tones, glyphs and words.
 *
 * Nothing here decides a policy: amounts, expiries and limits are the API's values, formatted.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatDay, formatMoney, hasPassed } from './format';

/*
 * The OpenAPI document marks several shared components themselves as nullable (a `.nullable()`
 * where one schema references them leaks into the component: FinancialConsequence,
 * EligibilityResult, PaymentAttempt, Receipt, SessionBooking, PriceSnapshot; reported). The
 * non-null forms are named here once; fields that are nullable in the contract stay nullable.
 */
export type Enrollment = Schema<'Enrollment'>;
export type FinancialConsequence = NonNullable<Schema<'FinancialConsequence'>>;
export type EligibilityResult = NonNullable<Schema<'EligibilityResult'>>;
export type Obligation = Schema<'Obligation'>;
export type Installment = Schema<'Installment'>;
export type InstallmentPlan = Schema<'InstallmentPlan'>;
export type PaymentAttempt = NonNullable<Schema<'PaymentAttempt'>>;
export type Receipt = NonNullable<Schema<'Receipt'>>;
export type Credit = Schema<'Credit'>;
export type MakeupEntitlement = Schema<'MakeupEntitlement'>;
export type SessionBooking = NonNullable<Schema<'SessionBooking'>>;
export type PlacementRequest = Schema<'PlacementRequest'>;

/** `POST /enrollments/{id}/transfer`: the API always sends eligibility and the consequence. */
export type TransferPreview = Omit<
  Schema<'TransferPreview'>,
  'eligibility' | 'financialConsequence' | 'newEnrollment' | 'previousEnrollment'
> & {
  eligibility: EligibilityResult;
  financialConsequence: FinancialConsequence;
  newEnrollment: Enrollment | null;
  previousEnrollment: Enrollment | null;
};

/** `GET /enrollments/{id}/cancellation-preview`: the consequence is always present. */
export type CancellationPreview = Omit<Schema<'CancellationPreview'>, 'financialConsequence'> & {
  financialConsequence: FinancialConsequence;
};

/** `POST /obligations/{id}/payments`: the payment is always present; the receipt may be null. */
export type PaymentOutcome = Omit<Schema<'PaymentOutcome'>, 'payment' | 'receipt'> & {
  payment: PaymentAttempt;
  receipt: Receipt | null;
};

type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

export interface EnrollmentContext {
  /** The offering's name when the API lets this customer read it (published offerings only). */
  offeringName?: string | null;
  /** The name of the offering this enrollment was transferred to, when known. */
  transferTargetName?: string | null;
  /** The placement request of a confirmed enrollment, when it has one (SPK-PLACE-002). */
  placement?: PlacementRequest | null;
  /** Due date of the next scheduled installment of the enrollment's order (SPK-PAY-006). */
  nextInstallmentDueAt?: string | null;
  /** The checkout behind a pending enrollment is `recovery_required` (§4.11). */
  recoveryRequired?: boolean;
}

/**
 * SPK-REG-003: each record keeps its own state. A future installment never makes a confirmed
 * enrollment look unconfirmed ("Confirmed. Next payment due <date>.").
 */
export function enrollmentStatus(enrollment: Enrollment, context: EnrollmentContext = {}): Status {
  switch (enrollment.status) {
    case 'pending':
      return context.recoveryRequired
        ? { tone: 'warning', label: 'Payment received. We are completing your registration.' }
        : { tone: 'pending', label: 'Registration pending' };
    case 'confirmed': {
      const placement = context.placement?.status;
      if (placement === 'unassigned' || placement === 'proposed') {
        return {
          tone: 'info',
          label: context.offeringName
            ? `Confirmed in ${context.offeringName}. Awaiting placement.`
            : 'Confirmed. Awaiting placement.',
        };
      }
      if (placement === 'assigned') return { tone: 'success', label: 'Confirmed: team assigned' };
      if (context.nextInstallmentDueAt) {
        return {
          tone: 'success',
          label: `Confirmed. Next payment due ${formatDay(context.nextInstallmentDueAt)}.`,
        };
      }
      return { tone: 'success', label: 'Confirmed' };
    }
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'transferred':
      return {
        tone: 'neutral',
        label: context.transferTargetName
          ? `Transferred to ${context.transferTargetName}`
          : 'Transferred',
      };
    case 'completed':
      return { tone: 'neutral', label: 'Completed' };
  }
}

export interface ConsequenceSummary {
  /** "Refund of $40.00", "No money changes", ... */
  headline: string;
  /** The API's own explanation of the consequence (policy wording, never invented here). */
  explanation: string;
  tone: StatusBadgeProps['tone'];
}

/** SPK-REG-010, SPK-PAY-008, SPK-PAY-009: the money consequence, before and after commitment. */
export function consequenceSummary(consequence: FinancialConsequence): ConsequenceSummary {
  const amount =
    consequence.amountMinor !== null && consequence.currency !== null
      ? formatMoney(consequence.amountMinor, consequence.currency)
      : null;
  const explanation = consequence.explanation;
  switch (consequence.kind) {
    case 'none':
      return { headline: 'No money changes', explanation, tone: 'neutral' };
    case 'refund':
      return {
        headline: amount ? `Refund of ${amount}` : 'Refund, amount to be confirmed',
        explanation,
        tone: 'info',
      };
    case 'credit':
      return {
        headline: amount ? `Credit of ${amount} to your account` : 'Credit, amount to be confirmed',
        explanation,
        tone: 'info',
      };
    case 'charge':
      return {
        headline: amount
          ? `Additional charge of ${amount}`
          : 'Additional charge, amount to be confirmed',
        explanation,
        tone: 'warning',
      };
    case 'review_required':
      return {
        headline: 'Any refund or credit is decided by the facility after review',
        explanation,
        tone: 'pending',
      };
  }
}

/** Whether two previews state the same money consequence (kind, amount and currency). */
export function sameConsequence(a: FinancialConsequence, b: FinancialConsequence): boolean {
  return a.kind === b.kind && a.amountMinor === b.amountMinor && a.currency === b.currency;
}

export function obligationStatus(obligation: Obligation, now: Date): Status {
  switch (obligation.status) {
    case 'open':
      return hasPassed(obligation.dueAt, now)
        ? { tone: 'warning', label: `Payment due since ${formatDay(obligation.dueAt)}` }
        : { tone: 'pending', label: `Due ${formatDay(obligation.dueAt)}` };
    case 'settled':
      return { tone: 'success', label: 'Paid' };
    case 'written_off':
      return { tone: 'neutral', label: 'Written off' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
  }
}

/** journeys.md: PaymentAttempt states. `unknown` is never shown as failure (SPK-PAY-007). */
export function paymentStatus(status: PaymentAttempt['status']): Status {
  switch (status) {
    case 'created':
    case 'action_required':
      return { tone: 'warning', label: 'Payment needs your action' };
    case 'processing':
      return { tone: 'pending', label: 'Payment processing' };
    case 'succeeded':
      return { tone: 'success', label: 'Payment received' };
    case 'failed':
      return { tone: 'danger', label: 'Payment failed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Payment canceled' };
    case 'unknown':
      return { tone: 'warning', label: 'Payment outcome being confirmed. Do not pay again.' };
  }
}

/** A payment that may still take effect: another payment must not be started (SPK-PAY-007). */
export function paymentIsUnresolved(status: PaymentAttempt['status']): boolean {
  return (
    status === 'created' ||
    status === 'action_required' ||
    status === 'processing' ||
    status === 'unknown'
  );
}

/** SPK-PAY-006: a failed installment reads "Payment attention needed", never "Canceled". */
export function installmentStatus(installment: Installment): Status {
  switch (installment.status) {
    case 'scheduled':
      return { tone: 'pending', label: `Scheduled for ${formatDay(installment.dueAt)}` };
    case 'paid':
      return { tone: 'success', label: 'Paid' };
    case 'failed':
      return { tone: 'warning', label: 'Payment attention needed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
  }
}

export function installmentPlanStatus(plan: InstallmentPlan): Status {
  switch (plan.status) {
    case 'active':
      return { tone: 'info', label: 'Installment plan active' };
    case 'completed':
      return { tone: 'success', label: 'Installment plan paid in full' };
    case 'defaulted':
      return { tone: 'warning', label: 'Payment attention needed' };
    case 'canceled':
      return { tone: 'neutral', label: 'Installment plan canceled' };
  }
}

/** The next installment still to be paid, if any (for "Next payment due <date>"). */
export function nextScheduledInstallment(plan: InstallmentPlan): Installment | null {
  const scheduled = plan.installments
    .filter((i) => i.status === 'scheduled')
    .sort((a, b) => a.sequence - b.sequence);
  return scheduled[0] ?? null;
}

/** journeys.md: "Credit: <amount>" (SPK-PAY-009), never mixed with makeup entitlements. */
export function creditStatus(credit: Credit): Status {
  switch (credit.status) {
    case 'pending_approval':
      return { tone: 'pending', label: 'Awaiting approval' };
    case 'active':
      return {
        tone: 'success',
        label: `Credit: ${formatMoney(credit.remainingMinor, credit.currency)}`,
      };
    case 'exhausted':
      return { tone: 'neutral', label: 'Used' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'revoked':
      return { tone: 'neutral', label: 'Revoked' };
  }
}

export function makeupRemaining(makeup: MakeupEntitlement): number {
  return Math.max(0, makeup.redemptionLimit - makeup.redeemedCount);
}

/** Whether the API's record still allows a redemption attempt (the API decides on submit). */
export function makeupRedeemable(makeup: MakeupEntitlement, now: Date): boolean {
  return (
    makeup.status === 'active' && !hasPassed(makeup.expiresAt, now) && makeupRemaining(makeup) > 0
  );
}

/** journeys.md: "Makeup sessions available: <count>, expires <date>" (SPK-YOUTH-004). */
export function makeupStatus(makeup: MakeupEntitlement, now: Date): Status {
  switch (makeup.status) {
    case 'active':
      if (hasPassed(makeup.expiresAt, now)) return { tone: 'neutral', label: 'Expired' };
      if (makeupRemaining(makeup) === 0)
        return { tone: 'neutral', label: 'All makeup sessions used' };
      return {
        tone: 'success',
        label: `Makeup sessions available: ${makeupRemaining(makeup)}, expires ${formatDay(makeup.expiresAt)}`,
      };
    case 'exhausted':
      return { tone: 'neutral', label: 'All makeup sessions used' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'revoked':
      return { tone: 'neutral', label: 'Revoked' };
  }
}

export function bookingStatus(status: SessionBooking['status']): Status {
  switch (status) {
    case 'pending':
      return { tone: 'pending', label: 'Booking pending' };
    case 'confirmed':
      return { tone: 'success', label: 'Booked' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
  }
}

export const CREDIT_SOURCE_LABELS: Record<Credit['sourceKind'], string> = {
  overpayment: 'From an overpayment',
  compensation: 'From a registration that could not be completed',
  goodwill: 'Goodwill credit from the facility',
  adjustment: 'Account adjustment',
};

export const CREDIT_USE_LABELS: Record<Credit['permittedUses'][number], string> = {
  registration: 'registrations',
  obligation: 'balances due',
};

export const MAKEUP_ORIGIN_LABELS: Record<MakeupEntitlement['originKind'], string> = {
  session_canceled: 'A session was canceled',
  absence: 'A missed session',
  policy_event: 'Under the program’s makeup policy',
  manual: 'Issued by the facility',
};
