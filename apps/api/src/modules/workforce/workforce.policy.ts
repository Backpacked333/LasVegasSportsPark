import type { AssignmentKind, StaffRole } from '@sportspark/contracts';

/**
 * Workforce policy values (SPK-STAFF-001..004).
 *
 * Pending operator decision DEC-011 / POL-033 (Operations/finance: "official qualifications and
 * fees: required qualification evidence, permitted assignments, turnaround, rate basis, approver
 * and export"). The specification fixes the mechanisms, not the values, so this module implements
 * the mechanisms with the proposed defaults below. A facility overrides any value through
 * `facilities.settings.workforce` (`turnaroundMinutes.<kind>`, `uncoveredEscalationHours`), and the
 * whole policy can be replaced by providing WORKFORCE_POLICY.
 */
export interface WorkforcePolicy {
  /** Minutes a person is still held after an assignment ends before the next may start (SPK-STAFF-003). */
  turnaroundMinutes: Record<AssignmentKind, number>;
  /**
   * A required slot left uncovered by a decline or withdrawal less than this many hours before
   * the start raises `workforce.uncovered_assignment` (SPK-STAFF-003, SPK-AT-012).
   */
  uncoveredEscalationHours: number;
  /** Time-bounded access granted for temporary and substitute work (SPK-STAFF-004). */
  temporaryAccess: {
    /**
     * Access begins when the assignment is accepted and ends this many hours after the activity
     * (match report, attendance corrections). It does not start later than acceptance because a
     * staff membership that has not started yet cannot be ended early (see README "Known gaps").
     */
    trailHours: number;
    /** Staff roles granted per assignment kind; an empty list grants nothing. */
    roles: Record<AssignmentKind, StaffRole[]>;
  };
}

export const WORKFORCE_POLICY = Symbol('WORKFORCE_POLICY');

/** Proposed defaults (pending DEC-011). */
export const DEFAULT_WORKFORCE_POLICY: WorkforcePolicy = {
  turnaroundMinutes: { official: 30, coach: 15, supervisor: 0, organizer: 0 },
  uncoveredEscalationHours: 48,
  temporaryAccess: {
    trailHours: 24,
    // Supervisors and organizers act through ordinary staff memberships; the platform does not
    // hand out desk or league administration automatically.
    roles: { official: ['official'], coach: ['coach'], supervisor: [], organizer: [] },
  },
};

/** Staff roles whose holders form the replacement candidate pool per assignment kind. */
export const CANDIDATE_ROLES: Record<AssignmentKind, StaffRole[]> = {
  official: ['official'],
  coach: ['coach'],
  supervisor: ['front_desk', 'program_manager', 'general_manager'],
  organizer: ['league_manager', 'program_manager', 'general_manager'],
};

/** Merges a facility's `settings.workforce` overrides onto the policy. */
export function workforcePolicyForFacility(
  base: WorkforcePolicy,
  facilitySettings: Record<string, unknown> | null | undefined,
): WorkforcePolicy {
  const workforce = (facilitySettings?.['workforce'] ?? {}) as Record<string, unknown>;
  const turnaround = (workforce['turnaroundMinutes'] ?? {}) as Partial<
    Record<AssignmentKind, unknown>
  >;
  const minutes = (kind: AssignmentKind): number => {
    const value = turnaround[kind];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 720
      ? value
      : base.turnaroundMinutes[kind];
  };
  const hours = workforce['uncoveredEscalationHours'];
  return {
    ...base,
    turnaroundMinutes: {
      official: minutes('official'),
      coach: minutes('coach'),
      supervisor: minutes('supervisor'),
      organizer: minutes('organizer'),
    },
    uncoveredEscalationHours:
      typeof hours === 'number' && Number.isFinite(hours) && hours >= 0
        ? hours
        : base.uncoveredEscalationHours,
  };
}

/** Exception category raised for an uncovered required slot (Today workspace, SPK-UX-006). */
export const UNCOVERED_ASSIGNMENT = 'workforce.uncovered_assignment';
/**
 * Exception category raised when an accepted assignee stops holding a required qualification
 * (revocation, or a requirement edited to add one): an operator decides, nothing is withdrawn
 * automatically (SPK-STAFF-001, SPK-READY-004; the policy on revocation timing is POL-033).
 */
export const UNQUALIFIED_ASSIGNMENT = 'workforce.unqualified_assignment';
/** Exception category raised when time-bounded access could not be granted or ended. */
export const TEMPORARY_ACCESS_FAILED = 'workforce.temporary_access_failed';
/** Name of the readiness check registered with competition (SPK-STAFF-002, SPK-READY-001). */
export const REQUIRED_OFFICIALS_CHECK = 'workforce.required_officials';
