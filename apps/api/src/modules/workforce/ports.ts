import type { AssignmentKind, AssignmentTargetType } from '@sportspark/contracts';
import type { Trx } from '../../kernel';

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
}
export const ASSIGNMENT_COVERAGE_PORT = Symbol('ASSIGNMENT_COVERAGE_PORT');
