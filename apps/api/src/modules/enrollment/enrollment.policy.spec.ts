import type { PolicyVersion } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENROLLMENT_POLICY, requiresApproval } from './enrollment.policy';

const version = (kind: PolicyVersion['kind'], content: Record<string, unknown>): PolicyVersion => ({
  id: '01a16c09-0000-7000-8000-000000000003',
  kind,
  key: 'registration',
  version: 1,
  title: kind,
  content,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  approvalStatus: 'approved',
  approvedAt: null,
  retiredAt: null,
  retiredReason: null,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const offering = { id: '01a16c09-0000-7000-8000-0000000000aa', kind: 'term' as const };

describe('SPK-REG-007 approval mechanism (DEC-028 defaults)', () => {
  it('uses the configured default intents when no policy says otherwise', () => {
    expect(requiresApproval(DEFAULT_ENROLLMENT_POLICY, 'youth', offering, null, null)).toBe(false);
    expect(
      requiresApproval(
        DEFAULT_ENROLLMENT_POLICY,
        'join_team',
        { ...offering, kind: 'season' },
        null,
        null,
      ),
    ).toBe(true);
    expect(DEFAULT_ENROLLMENT_POLICY.holdMinutes).toBe(10);
    expect(DEFAULT_ENROLLMENT_POLICY.approvalReservesCapacity).toBe(false);
    expect(DEFAULT_ENROLLMENT_POLICY.defaultFulfillmentMode).toBe('all_or_nothing');
  });

  it('lets the eligibility policy decide first, then the organization approval policy', () => {
    expect(
      requiresApproval(
        DEFAULT_ENROLLMENT_POLICY,
        'youth',
        offering,
        version('eligibility', { requiresApproval: true }),
        null,
      ),
    ).toBe(true);
    expect(
      requiresApproval(
        DEFAULT_ENROLLMENT_POLICY,
        'join_team',
        offering,
        version('eligibility', { requiresApproval: false }),
        version('approval', { requiresApproval: true }),
      ),
    ).toBe(false);
    const approval = version('approval', { offeringKinds: ['camp'], intents: ['trial'] });
    expect(
      requiresApproval(
        DEFAULT_ENROLLMENT_POLICY,
        'youth',
        { ...offering, kind: 'camp' },
        null,
        approval,
      ),
    ).toBe(true);
    expect(requiresApproval(DEFAULT_ENROLLMENT_POLICY, 'trial', offering, null, approval)).toBe(
      true,
    );
    // An approval policy that names nothing applicable means no approval, not the defaults.
    expect(requiresApproval(DEFAULT_ENROLLMENT_POLICY, 'join_team', offering, null, approval)).toBe(
      false,
    );
  });
});
