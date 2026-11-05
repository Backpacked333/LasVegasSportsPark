import type { PartyType } from '@sportspark/contracts';

/**
 * Scheduling policy values (SPK-SCHED-004 "required rest", SPK-FIX-001 "minimum rest").
 *
 * Pending operator decision (§6.6 "Soccer formats and competition rules" — league manager, and
 * "Actual facilities, spaces, subdivisions, hours" — operations): the required rest between two
 * commitments of the same party is not fixed by the specification. The mechanism is implemented
 * here with proposed defaults; a facility may override any value through
 * `facilities.settings.scheduling.requiredRestMinutes.<partyType>`, and the whole policy can be
 * replaced by providing SCHEDULING_POLICY.
 */
export interface SchedulingPolicy {
  /** Minimum minutes between the end of one commitment and the start of the next, per party kind. */
  requiredRestMinutes: Record<PartyType, number>;
  /** Default step between candidate start times when searching availability. */
  availabilityStepMinutes: number;
  /** Upper bound on occurrences a single series may materialize. */
  maxSeriesOccurrences: number;
}

export const SCHEDULING_POLICY = Symbol('SCHEDULING_POLICY');

/** Proposed defaults (pending decision): teams and people rest 60 minutes, equipment needs no rest. */
export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  requiredRestMinutes: { team: 60, person: 60, equipment: 0 },
  availabilityStepMinutes: 15,
  maxSeriesOccurrences: 366,
};

/** Merges a facility's `settings.scheduling` overrides onto the policy. */
export function policyForFacility(
  base: SchedulingPolicy,
  facilitySettings: Record<string, unknown> | null | undefined,
): SchedulingPolicy {
  const scheduling = (facilitySettings?.['scheduling'] ?? {}) as Record<string, unknown>;
  const rest = (scheduling['requiredRestMinutes'] ?? {}) as Partial<Record<PartyType, unknown>>;
  const minutes = (key: PartyType): number => {
    const value = rest[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : base.requiredRestMinutes[key];
  };
  return {
    ...base,
    requiredRestMinutes: {
      team: minutes('team'),
      person: minutes('person'),
      equipment: minutes('equipment'),
    },
  };
}
