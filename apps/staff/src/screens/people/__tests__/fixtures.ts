// Fixtures for the People and families tests (SCR-S-20 to SCR-S-23).
import { TEST_NOW } from '../../../testing/test-app';

export const PERSON_ID = '0192f1a0-0000-7000-8000-000000000101';
export const OTHER_ID = '0192f1a0-0000-7000-8000-000000000102';
export const CHILD_ID = '0192f1a0-0000-7000-8000-000000000103';
export const REVIEW_ID = '0192f1a0-0000-7000-8000-000000000201';
export const CANDIDATE_ID = '0192f1a0-0000-7000-8000-000000000301';
export const RELATIONSHIP_ID = '0192f1a0-0000-7000-8000-000000000401';
export const GRANT_ID = '0192f1a0-0000-7000-8000-000000000501';
export const OPERATION_ID = '0192f1a0-0000-7000-8000-000000000601';

const NOW = TEST_NOW.toISOString();

export function person(id = PERSON_ID, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'adult',
    givenName: id === PERSON_ID ? 'Alex' : 'Sam',
    familyName: 'Rivera',
    dateOfBirth: '1990-04-02',
    status: 'active',
    mergedIntoPersonId: null,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    contactPoints: [
      {
        id: `cp-${id}`,
        personId: id,
        kind: 'email',
        value: `${id.slice(-3)}@example.test`,
        isPrimary: true,
        verifiedAt: NOW,
        createdAt: NOW,
      },
    ],
    ...overrides,
  };
}

export function timeline(overrides: Record<string, unknown> = {}) {
  return {
    person: {
      id: PERSON_ID,
      kind: 'adult',
      displayName: 'Alex Rivera',
      status: 'active',
      minimized: false,
    },
    scope: {
      personIds: [PERSON_ID, CHILD_ID],
      dependents: [
        { id: CHILD_ID, kind: 'child', displayName: 'Mia', status: 'active', minimized: true },
      ],
    },
    entries: [
      {
        id: 'payment:1',
        occurredAt: '2026-10-23T18:00:00.000Z',
        category: 'payment',
        kind: 'payment_attempt.succeeded',
        title: 'Payment for U10 fall program',
        personId: PERSON_ID,
        record: { type: 'payment_attempt', id: 'pa-1' },
        status: 'succeeded',
        amount: { amountMinor: 2500, currency: 'USD' },
        facilityId: null,
        details: {},
      },
    ],
    sources: [
      { source: 'finance.payments', status: 'ok', count: 1 },
      { source: 'communications.messages', status: 'not_permitted', count: 0 },
    ],
    generatedAt: NOW,
    nextCursor: null,
    ...overrides,
  };
}

export function relationshipCreated(permissions: string[]) {
  return {
    relationship: {
      id: RELATIONSHIP_ID,
      actorPersonId: OTHER_ID,
      subjectPersonId: PERSON_ID,
      kind: 'guardian',
      status: 'active',
      source: 'staff',
      effectiveFrom: NOW,
      effectiveTo: null,
      revision: 1,
      createdAt: NOW,
    },
    grants: permissions.map((permission, i) => grant(permission, `${GRANT_ID.slice(0, -1)}${i}`)),
  };
}

export function grant(permission: string, id = GRANT_ID, overrides: Record<string, unknown> = {}) {
  return {
    id,
    relationshipId: RELATIONSHIP_ID,
    actorPersonId: OTHER_ID,
    subjectPersonId: PERSON_ID,
    permission,
    source: 'staff',
    effectiveFrom: NOW,
    effectiveTo: null,
    revokedAt: null,
    revocationReason: null,
    suspendedAt: null,
    suspendedByReviewId: null,
    effective: true,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}

export function accessReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    subjectPersonId: PERSON_ID,
    reason: 'Two guardians disagree about pickup',
    parties: [{ personId: OTHER_ID, description: 'Second guardian' }],
    evidence: [{ type: 'court_order', reference: 'CO-2026-17', note: 'Copy seen at desk' }],
    ownerRole: 'support_operator',
    ownerPersonId: null,
    status: 'open',
    effectiveFrom: NOW,
    effectiveTo: null,
    escalatedAt: null,
    decidedAt: null,
    closedAt: null,
    outcome: null,
    decisions: [
      {
        id: 'd-1',
        sequence: 1,
        kind: 'note',
        note: 'Opened at the front desk',
        affectedGrantIds: [],
        effectiveFrom: null,
        effectiveTo: null,
        occurredAt: NOW,
      },
    ],
    revision: 2,
    createdAt: NOW,
    ...overrides,
  };
}

export function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: CANDIDATE_ID,
    personAId: PERSON_ID,
    personBId: OTHER_ID,
    reasons: ['Same name and date of birth'],
    score: 50,
    status: 'open',
    decision: null,
    decidedAt: null,
    revision: 1,
    createdAt: NOW,
    ...overrides,
  };
}
