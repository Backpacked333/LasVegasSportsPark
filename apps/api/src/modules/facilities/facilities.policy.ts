import type { MaintenanceSeverity } from '@sportspark/contracts';

/**
 * Facilities policy values (SPK-FAC-002 due dates, SPK-FAC-005 lead time, SPK-UX-006 escalation).
 *
 * Pending operator decision (§6.6 "Pickup and outage procedure" / "Actual facilities, spaces,
 * subdivisions, hours" — Operations): the specification fixes neither the default due lead time
 * per severity, nor how far ahead preventive maintenance is materialized, nor which severities
 * escalate to the Today workspace when overdue. The mechanism is implemented here with proposed
 * defaults; the whole policy can be replaced by providing FACILITIES_POLICY.
 */
export interface FacilitiesPolicy {
  /** Proposed default due lead time (hours after the report) when a report names no due instant. */
  defaultDueHoursBySeverity: Record<MaintenanceSeverity, number>;
  /** Severities whose overdue open tasks raise an operational exception (dedupe key per task). */
  overdueExceptionSeverities: readonly MaintenanceSeverity[];
  /** Default horizon (days ahead) for which preventive schedules materialize tasks and restrictions. */
  defaultPreventiveLeadTimeDays: number;
  /** Upper bound on occurrences one generation run materializes (each one creates a closure). */
  maxPreventiveOccurrencesPerRun: number;
  /** Upper bound on occurrences a preventive recurrence may describe. */
  maxScheduleOccurrences: number;
  /** How already-booked events are handled when a restriction's closure is applied, unless the command says otherwise. */
  defaultResolutionMode: 'cancel_affected' | 'leave_for_resolution';
}

export const FACILITIES_POLICY = Symbol('FACILITIES_POLICY');

/** Proposed defaults (pending decision). */
export const DEFAULT_FACILITIES_POLICY: FacilitiesPolicy = {
  defaultDueHoursBySeverity: { critical: 4, high: 24, medium: 72, low: 168 },
  overdueExceptionSeverities: ['critical'],
  defaultPreventiveLeadTimeDays: 14,
  maxPreventiveOccurrencesPerRun: 50,
  maxScheduleOccurrences: 366,
  defaultResolutionMode: 'leave_for_resolution',
};
