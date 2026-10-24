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

/**
 * SPK-YOUTH-002: the capacity units whose staffing ratio a change removes or relaxes. A unit that
 * carried a ratio before is relaxed when the change drops the unit (for example by swapping it for
 * an unstaffed one), drops its ratio, or raises its participants per staff member. Removing a
 * ratio lowers the computed requirement, so the staff count alone would call it a decrease.
 */
export function relaxedStaffingRatios(
  before: readonly CapacityUnit[],
  after: readonly CapacityUnit[],
): CapacityUnit['unit'][] {
  const relaxed: CapacityUnit['unit'][] = [];
  for (const unit of before) {
    if (!unit.staffingRatio) continue;
    const next = after.find((u) => u.unit === unit.unit);
    if (
      !next?.staffingRatio ||
      next.staffingRatio.participantsPerStaff > unit.staffingRatio.participantsPerStaff
    ) {
      relaxed.push(unit.unit);
    }
  }
  return relaxed;
}

/**
 * Mechanism for SPK-YOUTH-002: does this capacity change need an explicit reason? It does when it
 * raises the staffing requirement or removes or relaxes a staffing ratio.
 */
export function staffingIncreaseNeedsReason(
  before: readonly CapacityUnit[],
  after: readonly CapacityUnit[],
): {
  requiredStaffBefore: number;
  requiredStaffAfter: number;
  ratiosRelaxed: CapacityUnit['unit'][];
  needsReason: boolean;
} {
  const requiredStaffBefore = requiredStaffFor(before);
  const requiredStaffAfter = requiredStaffFor(after);
  const ratiosRelaxed = relaxedStaffingRatios(before, after);
  return {
    requiredStaffBefore,
    requiredStaffAfter,
    ratiosRelaxed,
    needsReason: requiredStaffAfter > requiredStaffBefore || ratiosRelaxed.length > 0,
  };
}
