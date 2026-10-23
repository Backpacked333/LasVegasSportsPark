import type { CapacityUnit, PolicyKind } from '@sportspark/contracts';
import type { ActionDefinition } from '../../kernel';
import { CatalogActions } from './catalog.actions';

/**
 * Catalog policy defaults. These are engineering defaults that implement the mechanism the
 * specification requires; the values themselves await the operator decisions cited on each one
 * (docs/package-a/decision-register.md). None of them is law.
 */

/**
 * Which staff role approves which policy kind (brief: "approval by program_manager |
 * league_manager | finance_operator per kind"). Participation kinds are approved by program and
 * league managers (DEC-003 youth eligibility, DEC-006 waitlist/holds/approvals); financial kinds
 * by the finance operator (DEC-007 prices and discounts, DEC-008 installments and overpayments,
 * DEC-009 refunds and cancellation consequences).
 */
export const POLICY_APPROVAL_ACTION: Record<PolicyKind, ActionDefinition> = {
  eligibility: CatalogActions.approveParticipationPolicy,
  waitlist: CatalogActions.approveParticipationPolicy,
  hold: CatalogActions.approveParticipationPolicy,
  approval: CatalogActions.approveParticipationPolicy,
  form: CatalogActions.approveParticipationPolicy,
  cancellation: CatalogActions.approveFinancialPolicy,
  refund: CatalogActions.approveFinancialPolicy,
  discount: CatalogActions.approveFinancialPolicy,
  overpayment: CatalogActions.approveFinancialPolicy,
  installment: CatalogActions.approveFinancialPolicy,
};

/**
 * SPK-YOUTH-002 "capacity must respect configured group size, space and staffing requirements;
 * increasing commercial capacity must not silently bypass a staffing requirement". The staffing
 * requirement of a capacity configuration is the sum over units that carry a staffing ratio of
 * ceil(limit / participantsPerStaff). Raising it requires an explicit reason on the command and is
 * published on the update event so workforce can plan against it (DEC-003 for the ratios).
 */
export function requiredStaffFor(units: readonly CapacityUnit[]): number {
  let total = 0;
  for (const unit of units) {
    if (!unit.staffingRatio) continue;
    total += Math.ceil(unit.limit / unit.staffingRatio.participantsPerStaff);
  }
  return total;
}

/** Mechanism for SPK-YOUTH-002: is this capacity change a staffing increase that needs a reason? */
export function staffingIncreaseNeedsReason(
  before: readonly CapacityUnit[],
  after: readonly CapacityUnit[],
): { requiredStaffBefore: number; requiredStaffAfter: number; needsReason: boolean } {
  const requiredStaffBefore = requiredStaffFor(before);
  const requiredStaffAfter = requiredStaffFor(after);
  return {
    requiredStaffBefore,
    requiredStaffAfter,
    needsReason: requiredStaffAfter > requiredStaffBefore,
  };
}
