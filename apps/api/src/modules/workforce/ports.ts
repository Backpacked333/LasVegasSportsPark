import type {
  AssignmentKind,
  AssignmentTargetType,
  Principal,
  StaffRole,
} from '@sportspark/contracts';
import { declaredNotImplemented, type Trx } from '../../kernel';

/**
 * Ports other modules consume (README "Ports"). Reads take the organization explicitly and an
 * optional transaction; without one they read through the caller's active transaction when
 * inside a command, else the root database. They return identifiers and coverage facts only.
 *
 * The competition module's `ASSIGNMENT_CHECK_PORT` (results submission, incident reports) and its
 * readiness check registry are filled in by this module as well (see workforce.module.ts).
 */

export interface RoleCoverage {
  requirementId: string;
  role: string;
  kind: AssignmentKind;
  requiredCount: number;
  mustBeAccepted: boolean;
  /** Accepted or completed assignees (SPK-STAFF-002: proposed and offered never count). */
  acceptedPersonIds: string[];
  offered: number;
  proposed: number;
  uncoveredSlots: number[];
}

export interface AssignmentCoveragePort {
  /** Requirement-by-requirement coverage of a target (fixture, event or session). */
  coverage(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    trx?: Trx,
  ): Promise<RoleCoverage[]>;
  /** People holding an accepted (or completed) assignment of the kind for the target. */
  acceptedAssignees(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    kind?: AssignmentKind,
    trx?: Trx,
  ): Promise<string[]>;
  /**
   * WRK-03, IF-34: whether the person holds an accepted or completed assignment of the kind on
   * any session of the offering (proposed and offered never count; retired requirements skipped).
   */
  isAcceptedOnOffering(
    organizationId: string,
    offeringId: string,
    personId: string,
    kind: AssignmentKind,
    trx?: Trx,
  ): Promise<boolean>;
}
export const ASSIGNMENT_COVERAGE_PORT = Symbol('ASSIGNMENT_COVERAGE_PORT');

/** WRK-02, IF-32: one staffing requirement of a booking event. */
export interface EventStaffingRequirement {
  kind: 'supervisor' | 'organizer';
  role: StaffRole;
  requiredCount: number;
  requiredQualifications: string[];
}

/**
 * Staffing for booking events (WRK-02, IF-32; SPK-STAFF-002, SPK-COND-003): requirements are
 * must-be-accepted; a repeat for the same (target, role) is a no-op; withdrawing retires them and
 * withdraws their assignments, and retired requirements never count in coverage, exceptions,
 * Today or reporting. Callers: the system principal 'enrollment.booking' or staff with
 * workforce.manage_requirements. Both methods join the caller's unit of work.
 */
export interface WorkforceStaffingPort {
  declareRequirements(
    principal: Principal,
    input: {
      targetType: 'event';
      targetId: string;
      facilityId: string;
      targetTitle: string;
      requirements: EventStaffingRequirement[];
    },
  ): Promise<{ requirementIds: string[] }>;
  withdrawRequirements(
    principal: Principal,
    input: { targetType: 'event'; targetId: string; reason: string },
  ): Promise<{ withdrawnAssignmentIds: string[]; retiredRequirementIds: string[] }>;
}
export const WORKFORCE_STAFFING_PORT = Symbol('WORKFORCE_STAFFING_PORT');
/** Workforce registers its implementation here (WRK-02); resolved lazily through the port. */
export const WORKFORCE_STAFFING_IMPL = Symbol('WORKFORCE_STAFFING_IMPL');

/** Until WRK-02 registers an implementation, staffing cannot be declared (nothing is booked). */
export const unavailableWorkforceStaffing: WorkforceStaffingPort = {
  declareRequirements: async () =>
    declaredNotImplemented('WorkforceStaffingPort.declareRequirements', 'WRK-02'),
  withdrawRequirements: async () =>
    declaredNotImplemented('WorkforceStaffingPort.withdrawRequirements', 'WRK-02'),
};
