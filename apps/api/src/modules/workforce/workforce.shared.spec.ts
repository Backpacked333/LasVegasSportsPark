import { describe, expect, it } from 'vitest';
import {
  turnaroundFor,
  UNCONFIGURED_WORKFORCE_POLICY,
  workforcePolicyForFacility,
  workforcePolicyFromSettings,
} from './workforce.policy';
import { computeFeeAmount, overlaps } from './workforce.shared';

describe('workforce pure rules', () => {
  it('SPK-STAFF-006: the rate basis yields a deterministic whole-minor-unit amount', () => {
    expect(computeFeeAmount({ kind: 'per_assignment', rateMinor: 4500 })).toBe(4500);
    expect(computeFeeAmount({ kind: 'flat', amountMinor: 1200 })).toBe(1200);
    expect(computeFeeAmount({ kind: 'hourly', rateMinor: 3000, minutes: 75 })).toBe(3750);
    // 1001 per hour for 30 minutes = 500.5 → rounds half up
    expect(computeFeeAmount({ kind: 'hourly', rateMinor: 1001, minutes: 30 })).toBe(501);
  });

  it('DEC-011 / WRK-06: with no settings every policy value is unconfigured (null), never a default', () => {
    expect(UNCONFIGURED_WORKFORCE_POLICY).toMatchObject({
      turnaroundMinutes: { official: null, coach: null, supervisor: null, organizer: null },
      uncoveredEscalationHours: null,
      officialMaxAssignmentsPerDay: null,
      temporaryAccess: { trailHours: null },
    });
    expect(turnaroundFor(UNCONFIGURED_WORKFORCE_POLICY, 'official')).toBe(0);
    const configured = workforcePolicyFromSettings({
      OFFICIAL_TURNAROUND_MINUTES: 30,
      COACH_TURNAROUND_MINUTES: 15,
      UNCOVERED_ESCALATION_HOURS: 48,
      ACCESS_TRAILING_HOURS: 24,
      OFFICIAL_MAX_ASSIGNMENTS_PER_DAY: 3,
    });
    expect(configured).toMatchObject({
      turnaroundMinutes: { official: 30, coach: 15, supervisor: null, organizer: null },
      uncoveredEscalationHours: 48,
      officialMaxAssignmentsPerDay: 3,
      temporaryAccess: { trailHours: 24 },
    });
  });

  it('SPK-STAFF-003: facility settings override the configured turnaround and escalation window; invalid values fall back', () => {
    const base = workforcePolicyFromSettings({ COACH_TURNAROUND_MINUTES: 15 });
    const policy = workforcePolicyForFacility(base, {
      workforce: {
        turnaroundMinutes: { official: 45, coach: -1, supervisor: 'ten' },
        uncoveredEscalationHours: 72,
      },
    });
    expect(policy.turnaroundMinutes).toEqual({
      official: 45,
      coach: 15,
      supervisor: null,
      organizer: null,
    });
    expect(policy.uncoveredEscalationHours).toBe(72);
    expect(workforcePolicyForFacility(base, null)).toEqual(base);
  });

  it('intervals are half-open: adjacent commitments do not overlap', () => {
    const t = (h: number) => new Date(Date.UTC(2027, 0, 1, h));
    expect(overlaps(t(10), t(11), t(11), t(12))).toBe(false);
    expect(overlaps(t(10), t(12), t(11), t(13))).toBe(true);
  });
});
