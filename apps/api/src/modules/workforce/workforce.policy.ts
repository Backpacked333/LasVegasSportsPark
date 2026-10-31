import type { AssignmentKind, StaffRole } from '@sportspark/contracts';
import type { WorkforceSettingsValue } from './workforce.settings';

/**
 * Workforce policy values (SPK-STAFF-001..004).
 *
 * Pending operator decision DEC-011 / POL-033 (Operations/finance: "official qualifications and
 * fees: required qualification evidence, permitted assignments, turnaround, rate basis, approver
 * and export"). The specification fixes the mechanisms, not the values, so every value is
 * configuration with no default (WRK-06, rule K-00 (i)): the module settings in
 * `workforce.settings.ts` (`WORKFORCE_<KEY>`), optionally overridden per facility through
 * `facilities.settings.workforce` (`turnaroundMinutes.<kind>`, `uncoveredEscalationHours`). A value
 * that is not configured is `null` and the module applies the conservative behaviour documented on
 * the field. The whole policy can be replaced by providing WORKFORCE_POLICY.
 */
export interface WorkforcePolicy {
  /**
   * Minutes a person is still held after an assignment ends before the next may start
   * (SPK-STAFF-003). `null`: no turnaround is required; only overlapping assignments are refused.
   */
  turnaroundMinutes: Record<AssignmentKind, number | null>;
  /**
   * A required slot left uncovered by a decline or withdrawal less than this many hours before
   * the start raises `workforce.uncovered_assignment` (SPK-STAFF-003, SPK-AT-012). `null`: the
   * exception is raised at once, however far away the start is.
   */
  uncoveredEscalationHours: number | null;
  /**
   * Accepted (or completed) official assignments one person may hold per facility-local day.
   * `null`: unchecked.
   */
  officialMaxAssignmentsPerDay: number | null;
  /** Time-bounded access granted for temporary and substitute work (SPK-STAFF-004). */
  temporaryAccess: {
    /**
     * Access begins when the assignment is accepted and ends this many hours after the activity
     * (match report, attendance corrections). `null`: access ends with the activity. It does not
     * start later than acceptance (see README "Remaining").
     */
    trailHours: number | null;
    /** Staff roles granted per assignment kind; an empty list grants nothing (proposed mapping). */
    roles: Record<AssignmentKind, StaffRole[]>;
  };
}

export const WORKFORCE_POLICY = Symbol('WORKFORCE_POLICY');

/**
 * The roles time-bounded access grants per kind (proposed, pending DEC-011): officials act as
 * `official`, coaches as `coach`; supervisors and organizers act through ordinary staff
 * memberships, so the platform hands out no desk or league administration automatically.
 */
export const TEMPORARY_ACCESS_ROLES: Record<AssignmentKind, StaffRole[]> = {
  official: ['official'],
  coach: ['coach'],
  supervisor: [],
  organizer: [],
};

/** The policy the module settings describe (WRK-06): an absent setting stays `null`. */
export function workforcePolicyFromSettings(
  settings: Partial<WorkforceSettingsValue> = {},
): WorkforcePolicy {
  return {
    turnaroundMinutes: {
      official: settings.OFFICIAL_TURNAROUND_MINUTES ?? null,
      coach: settings.COACH_TURNAROUND_MINUTES ?? null,
      // DEC-011 names no turnaround for supervisors and organizers: none is required.
      supervisor: null,
      organizer: null,
    },
    uncoveredEscalationHours: settings.UNCOVERED_ESCALATION_HOURS ?? null,
    officialMaxAssignmentsPerDay: settings.OFFICIAL_MAX_ASSIGNMENTS_PER_DAY ?? null,
    temporaryAccess: {
      trailHours: settings.ACCESS_TRAILING_HOURS ?? null,
      roles: TEMPORARY_ACCESS_ROLES,
    },
  };
}

/** The policy with nothing configured (every value `null`: the conservative behaviours). */
export const UNCONFIGURED_WORKFORCE_POLICY: WorkforcePolicy = workforcePolicyFromSettings();

/** The turnaround an assignment of the kind needs (0 when none is configured). */
export function turnaroundFor(policy: WorkforcePolicy, kind: AssignmentKind): number {
  return policy.turnaroundMinutes[kind] ?? 0;
}

/** Staff roles whose holders form the replacement candidate pool per assignment kind. */
export const CANDIDATE_ROLES: Record<AssignmentKind, StaffRole[]> = {
  official: ['official'],
  coach: ['coach'],
  supervisor: ['front_desk', 'program_manager', 'general_manager'],
  organizer: ['league_manager', 'program_manager', 'general_manager'],
};

/** Merges a facility's `settings.workforce` overrides onto the policy (absent keys keep it). */
export function workforcePolicyForFacility(
  base: WorkforcePolicy,
  facilitySettings: Record<string, unknown> | null | undefined,
): WorkforcePolicy {
  const workforce = (facilitySettings?.['workforce'] ?? {}) as Record<string, unknown>;
  const turnaround = (workforce['turnaroundMinutes'] ?? {}) as Partial<
    Record<AssignmentKind, unknown>
  >;
  const minutes = (kind: AssignmentKind): number | null => {
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
/**
 * Exception category raised once per person merge when the survivor and the merged person hold
 * accepted assignments whose held intervals overlap (WRK-05, SPK-IAM-007): nothing is rewritten,
 * a scheduler decides which to withdraw.
 */
export const MERGED_PERSON_OVERLAP = 'workforce.merged_person_overlap';
/** Name of the readiness check registered with competition (SPK-STAFF-002, SPK-READY-001). */
export const REQUIRED_OFFICIALS_CHECK = 'workforce.required_officials';
