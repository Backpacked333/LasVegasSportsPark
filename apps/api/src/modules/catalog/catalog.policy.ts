import type {
  CapabilityId,
  CapacityUnit,
  EntitlementKind,
  OfferingKind,
  PolicyKind,
} from '@sportspark/contracts';
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
  // CAT-02: booking terms decide deposits and confirmation (POL-005, POL-040); taxes and fees are
  // approved charges (DEC-057). Both decide money, so the finance operator approves them.
  booking_terms: CatalogActions.approveFinancialPolicy,
  tax_fee: CatalogActions.approveFinancialPolicy,
};

/**
 * CAT-02, K-12 (§1.6, §6.5 Package G): the conditional capability an offering kind belongs to.
 * Creating, copying or publishing an offering of one of these kinds needs the organization's
 * switch (DEC-016 and the capability's own record: memberships DEC-072, session packages DEC-074,
 * rentals DEC-076, parties DEC-077, pickup sessions DEC-082). Archiving and closing never do.
 */
export const OFFERING_KIND_CAPABILITY: Partial<Record<OfferingKind, CapabilityId>> = {
  membership: 'memberships',
  package: 'session_packages',
  rental: 'rentals',
  party: 'parties',
  pickup: 'pickup_sessions',
};

/**
 * CAT-02 (SPK-COND-001 to SPK-COND-003): the entitlement definition kind an offering of these
 * kinds must grant before it can be published (ENTITLEMENT_DEFINITION_REQUIRED).
 */
export const REQUIRED_ENTITLEMENT_KIND: Partial<Record<OfferingKind, EntitlementKind>> = {
  membership: 'membership_benefit',
  package: 'package_credits',
  rental: 'rental_resource',
  party: 'party_package',
};

/** CAT-02: offering kinds that are booked under approved booking terms (§3.16 rentals, parties). */
export const BOOKING_OFFERING_KINDS: readonly OfferingKind[] = ['rental', 'party'];

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
