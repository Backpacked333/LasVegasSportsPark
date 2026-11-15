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

  it('SPK-COMP-006: a team on the waiting list tells a new player to wait for its place, not to choose another team', () => {
    const season = { ...input().offering, kind: 'season' as const };
    const entryId = '01a16c09-0000-7000-8000-0000000000cc';
    const waiting = evaluateRegistrationEligibility(
      input({
        intent: 'join_team',
        offering: season,
        teamEntry: { id: entryId, status: 'waiting' },
      }),
    );
    expect(waiting.eligible).toBe(false);
    expect(waiting.reasons).toEqual([
      {
        code: 'team_entry_waiting',
        severity: 'blocking',
        message:
          'The team is waiting for a place in the season. Registration opens when the team is placed.',
        source: { type: 'team_entry', id: entryId },
        requiredAction: 'wait_for_team_place',
      },
    ]);
    // nothing sends the player elsewhere
    expect(waiting.alternatives).toEqual([]);

    // a withdrawn or rejected team is still closed, with the earlier advice
    const closed = evaluateRegistrationEligibility(
      input({
        intent: 'join_team',
        offering: season,
        teamEntry: { id: entryId, status: 'withdrawn' },
      }),
    );
    expect(closed.reasons.map((r) => [r.code, r.requiredAction])).toEqual([
      ['team_entry_not_open', 'choose_another_team'],
    ]);
    expect(closed.alternatives.map((a) => a.kind)).toEqual(['request_placement']);
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

  it('SPK-REG-011: a missing or lapsed waiver is a reason whose severity is the approved rule; a block fails the evaluation, a warning or an overridden block does not', () => {
    const finding = {
      policyKey: 'liability',
      title: 'Liability waiver',
      policyVersionId: '01a16c09-0000-7000-8000-000000000003',
      overridden: false,
    };
    const warned = evaluateRegistrationEligibility(
      input({ waiverFindings: [{ ...finding, status: 'missing', severity: 'warning' }] }),
    );
    expect(warned.eligible).toBe(true);
    expect(warned.reasons).toEqual([
      {
        code: 'waiver_missing',
        severity: 'warning',
        message:
          '"Liability waiver" has not been accepted for the participant; the participant or a guardian should accept it.',
        source: { type: 'waiver', id: finding.policyVersionId },
        requiredAction: 'accept_waiver',
      },
    ]);
    expect(warned.alternatives.map((a) => a.kind)).toEqual(['complete_acknowledgment']);
    const blocked = evaluateRegistrationEligibility(
      input({ waiverFindings: [{ ...finding, status: 'lapsed', severity: 'blocking' }] }),
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.reasons).toEqual([
      expect.objectContaining({
        code: 'waiver_lapsed',
        severity: 'blocking',
        message:
          '"Liability waiver" has lapsed for the participant and must be accepted before registering.',
      }),
    ]);
    const overridden = evaluateRegistrationEligibility(
      input({
        waiverFindings: [{ ...finding, status: 'missing', severity: 'warning', overridden: true }],
      }),
    );
    expect(overridden.eligible).toBe(true);
    expect(overridden.reasons[0]?.message).toContain('staff recorded an override');
    // no finding (a current waiver, none required, or the capability off): nothing is added
    expect(evaluateRegistrationEligibility(input({ waiverFindings: [] })).reasons).toEqual([]);
    expect(evaluateRegistrationEligibility(input()).reasons).toEqual([]);
    // a waiver reason is not an unacknowledged form
    expect(missingAcknowledgments(warned)).toEqual([]);
  });
});
