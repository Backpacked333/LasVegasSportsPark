import type { PolicyVersion } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  evaluateRegistrationEligibility,
  missingAcknowledgments,
  type EligibilityInput,
} from './registration-eligibility';

const policy = (
  content: Record<string, unknown> = {},
  approvalStatus: PolicyVersion['approvalStatus'] = 'approved',
): PolicyVersion => ({
  id: '01a16c09-0000-7000-8000-000000000001',
  kind: 'eligibility',
  key: 'youth',
  version: 1,
  title: 'Youth eligibility',
  content,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  approvalStatus,
  approvedAt: '2026-01-01T00:00:00.000Z',
  retiredAt: null,
  retiredReason: null,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const form = {
  ...policy(),
  id: '01a16c09-0000-7000-8000-000000000002',
  kind: 'form' as const,
  title: 'Medical consent',
};

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    intent: 'youth',
    at: new Date('2026-11-02T15:00:00Z'),
    offering: {
      id: '01a16c09-0000-7000-8000-0000000000aa',
      kind: 'term',
      publicationState: 'registration_open',
      ageBand: { minAgeYears: 6, maxAgeYears: 12 },
      startsOn: '2027-01-10',
      endsOn: '2027-03-20',
    },
    registrationOpen: true,
    eligibilityReferenceDate: '2027-01-10',
    eligibilityPolicy: policy(),
    requiredForms: [],
    acknowledgedFormIds: [],
    person: {
      id: '01a16c09-0000-7000-8000-0000000000bb',
      kind: 'child',
      status: 'active',
      dateOfBirth: '2016-09-03',
    },
    ...overrides,
  };
}

describe('SPK-REG-002 registration eligibility (pure evaluation)', () => {
  it('computes completed years on the reference date, never a stored age (§4.5)', () => {
    expect(ageOn('2016-09-03', '2027-01-10')).toBe(10);
    expect(ageOn('2016-01-10', '2027-01-10')).toBe(11);
    expect(ageOn('2016-01-11', '2027-01-10')).toBe(10);
  });

  it('passes an eligible child and reports the policy version and reference date', () => {
    const result = evaluateRegistrationEligibility(input());
    expect(result).toMatchObject({
      eligible: true,
      referenceDate: '2027-01-10',
      policyVersionId: policy().id,
      reasons: [],
    });
  });

  it('explains an age failure from the policy band before the offering band, with alternatives', () => {
    const result = evaluateRegistrationEligibility(
      input({ eligibilityPolicy: policy({ maxAgeYears: 9, ageRuleLabel: 'U10' }) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatchObject({
      code: 'above_maximum_age',
      severity: 'blocking',
      source: { type: 'policy_version' },
    });
    expect(result.reasons[0]?.message).toContain('(U10)');
    expect(result.alternatives.map((a) => a.kind)).toEqual(['other_offering', 'contact_staff']);
  });

  it('treats unknown evidence as never a pass', () => {
    const noDob = evaluateRegistrationEligibility(
      input({ person: { ...input().person, dateOfBirth: null } }),
    );
    expect(noDob.eligible).toBe(false);
    expect(noDob.reasons[0]).toMatchObject({ code: 'date_of_birth_unknown', severity: 'unknown' });
    const noPolicy = evaluateRegistrationEligibility(input({ eligibilityPolicy: null }));
    expect(noPolicy.eligible).toBe(false);
    expect(noPolicy.reasons[0]?.code).toBe('eligibility_policy_missing');
    const draft = evaluateRegistrationEligibility(
      input({ eligibilityPolicy: policy({}, 'draft') }),
    );
    expect(draft.reasons[0]?.code).toBe('eligibility_policy_not_approved');
  });

  it('blocks closed registration, mismatched intents, adults in youth enrollment and closed sessions', () => {
    expect(
      evaluateRegistrationEligibility(input({ registrationOpen: false })).reasons[0]?.code,
    ).toBe('registration_closed');
    expect(
      evaluateRegistrationEligibility(input({ intent: 'pickup' })).reasons.map((r) => r.code),
    ).toContain('intent_offering_mismatch');
    const grown = evaluateRegistrationEligibility(
      input({
        offering: { ...input().offering, ageBand: {} },
        person: { ...input().person, kind: 'adult', dateOfBirth: '1990-01-01' },
      }),
    );
    expect(grown.reasons.map((r) => r.code)).toEqual(['youth_requires_child']);
    const started = evaluateRegistrationEligibility(
      input({
        intent: 'trial',
        offering: { ...input().offering, kind: 'trial' },
        session: {
          id: 's1',
          status: 'scheduled',
          scheduledStart: new Date('2026-11-01T00:00:00Z'),
        },
      }),
    );
    expect(started.reasons.map((r) => r.code)).toEqual(['session_not_bookable']);
    const noEntry = evaluateRegistrationEligibility(
      input({
        intent: 'join_team',
        offering: { ...input().offering, kind: 'season' },
        teamEntry: null,
      }),
    );
    expect(noEntry.reasons.map((r) => r.code)).toEqual(['team_entry_missing']);
  });

  it('lists outstanding forms as warnings that do not fail the evaluation (SPK-REG-009)', () => {
    const result = evaluateRegistrationEligibility(input({ requiredForms: [form] }));
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: 'acknowledgment_missing', severity: 'warning' }),
    ]);
    expect(missingAcknowledgments(result)).toEqual([form.id]);
    expect(
      missingAcknowledgments(
        evaluateRegistrationEligibility(
          input({ requiredForms: [form], acknowledgedFormIds: [form.id] }),
        ),
      ),
    ).toEqual([]);
  });
});
