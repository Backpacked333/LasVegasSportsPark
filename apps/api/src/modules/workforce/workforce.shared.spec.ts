import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFORCE_POLICY, workforcePolicyForFacility } from './workforce.policy';
import { computeFeeAmount, overlaps } from './workforce.shared';

describe('workforce pure rules', () => {
  it('SPK-STAFF-006: the rate basis yields a deterministic whole-minor-unit amount', () => {
    expect(computeFeeAmount({ kind: 'per_assignment', rateMinor: 4500 })).toBe(4500);
    expect(computeFeeAmount({ kind: 'flat', amountMinor: 1200 })).toBe(1200);
    expect(computeFeeAmount({ kind: 'hourly', rateMinor: 3000, minutes: 75 })).toBe(3750);
    // 1001 per hour for 30 minutes = 500.5 → rounds half up
    expect(computeFeeAmount({ kind: 'hourly', rateMinor: 1001, minutes: 30 })).toBe(501);
  });

  it('SPK-STAFF-003: facility settings override the proposed turnaround and escalation window; invalid values fall back', () => {
    const policy = workforcePolicyForFacility(DEFAULT_WORKFORCE_POLICY, {
      workforce: {
        turnaroundMinutes: { official: 45, coach: -1, supervisor: 'ten' },
        uncoveredEscalationHours: 72,
      },
    });
    expect(policy.turnaroundMinutes).toEqual({
      official: 45,
      coach: 15,
      supervisor: 0,
      organizer: 0,
    });
    expect(policy.uncoveredEscalationHours).toBe(72);
    expect(workforcePolicyForFacility(DEFAULT_WORKFORCE_POLICY, null)).toEqual(
      DEFAULT_WORKFORCE_POLICY,
    );
  });

  it('intervals are half-open: adjacent commitments do not overlap', () => {
    const t = (h: number) => new Date(Date.UTC(2027, 0, 1, h));
    expect(overlaps(t(10), t(11), t(11), t(12))).toBe(false);
    expect(overlaps(t(10), t(12), t(11), t(13))).toBe(true);
  });
});
