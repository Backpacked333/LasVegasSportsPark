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
        bySystem: false,
        occurredAt: NOW,
      },
    ],
    allowedDecisions: ['restrict', 'lift', 'escalate', 'decide', 'note', 'reassign'],
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

export const HOUSEHOLD_ID = '0192f1a0-0000-7000-8000-000000000701';
export const INVITATION_ID = '0192f1a0-0000-7000-8000-000000000801';
export const CLAIM_ID = '0192f1a0-0000-7000-8000-000000000901';

/** `GET /v1/people/{id}/authority` (ID-04). */
export function authority(overrides: Record<string, unknown> = {}) {
  return {
    personId: PERSON_ID,
    relationships: [relationshipCreated([]).relationship],
    grants: [
      grantView('view'),
      grantView('pay', `${GRANT_ID.slice(0, -1)}9`, { status: 'suspended', underReview: true }),
    ],
    households: [{ id: HOUSEHOLD_ID, name: 'Rivera household', memberCount: 3 }],
    pendingInvitations: [invitationView()],
    accountLinked: false,
    claims: [
      {
        id: CLAIM_ID,
        kind: 'self',
        status: 'pending',
        effectiveStatus: 'expired',
        expiresAt: '2026-10-20T12:00:00.000Z',
        createdAt: '2026-10-13T12:00:00.000Z',
        recipientHint: 'a***@example.test',
      },
    ],
    ...overrides,
  };
}

/** A grant as `GET /v1/people/{id}/authority` lists it (GrantView). */
export function grantView(
  permission: string,
  grantId = GRANT_ID,
  overrides: Record<string, unknown> = {},
) {
  return {
    grantId,
    relationshipId: RELATIONSHIP_ID,
    relationshipKind: 'guardian',
    actorPersonId: OTHER_ID,
    actorDisplayName: 'Sam Rivera',
    subjectPersonId: PERSON_ID,
    subjectDisplayName: 'Alex Rivera',
    permission,
    source: 'staff',
    effectiveFrom: NOW,
    effectiveTo: null,
    revokedAt: null,
    status: 'effective',
    underReview: false,
    revision: 1,
    ...overrides,
  };
}

/** `GET /v1/invitations` and the authority's pending invitations (InvitationView). */
export function invitationView(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION_ID,
    invitedByPersonId: OTHER_ID,
    recipientPersonId: null,
    recipientContact: { kind: 'email', value: 'grandma@example.test' },
    scope: { type: 'person', personId: PERSON_ID },
    relationshipKind: 'delegate',
    requestedPermissions: ['view', 'collect'],
    grantedPermissions: [],
    status: 'pending',
    expiresAt: '2026-10-27T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    revokedAt: null,
    declinedAt: null,
    revision: 1,
    createdAt: NOW,
    inviter: { personId: OTHER_ID, displayName: 'Sam Rivera' },
    subjects: [{ personId: PERSON_ID, displayName: 'Alex Rivera' }],
    effectiveStatus: 'pending',
    ...overrides,
  };
}

/** `GET /v1/person-names` answering every asked id it knows (others are omitted, ID-02). */
export const KNOWN_NAMES: Record<string, { givenName: string; familyName: string; kind: string }> =
  {
    [PERSON_ID]: { givenName: 'Alex', familyName: 'Rivera', kind: 'adult' },
    [OTHER_ID]: { givenName: 'Sam', familyName: 'Rivera', kind: 'adult' },
    [CHILD_ID]: { givenName: 'Mia', familyName: 'Rivera', kind: 'child' },
  };

export function personNames(ids: readonly string[] = Object.keys(KNOWN_NAMES)) {
  return {
    status: 200,
    body: {
      items: ids
        .filter((id) => KNOWN_NAMES[id])
        .map((id) => {
          const n = KNOWN_NAMES[id] as { givenName: string; familyName: string; kind: string };
          return {
            personId: id,
            canonicalPersonId: id,
            givenName: n.givenName,
            familyName: n.familyName,
            displayName: `${n.givenName} ${n.familyName}`,
            kind: n.kind,
          };
        }),
    },
  };
}

/** `GET /v1/people?query` results (names only). */
export function searchPage(nextCursor: string | null = null) {
  return {
    items: [
      {
        id: PERSON_ID,
        givenName: 'Alex',
        familyName: 'Rivera',
        kind: 'adult',
        status: 'active',
        matchedOn: 'name',
      },
      {
        id: CHILD_ID,
        givenName: 'Mia',
        familyName: 'Rivera',
        kind: 'child',
        status: 'active',
        matchedOn: 'name',
      },
    ],
    nextCursor,
  };
}

/** `GET /v1/access-reviews` row (AccessReviewSummary). */
export function reviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    subjectPersonId: PERSON_ID,
    subjectDisplayName: 'Alex Rivera',
    reason: 'Two guardians disagree about pickup',
    ownerRole: 'support_operator',
    ownerPersonId: null,
    status: 'open',
    effectiveFrom: NOW,
    effectiveTo: null,
    escalatedAt: null,
    decidedAt: null,
    closedAt: null,
    restrictedGrantCount: 2,
    allowedDecisions: ['restrict', 'lift', 'escalate', 'decide', 'note', 'reassign'],
    revision: 2,
    createdAt: NOW,
    ...overrides,
  };
}

/** One side of `GET /v1/duplicate-candidates/{id}` (DuplicatePersonDetail). */
export function duplicateSide(id: string, overrides: Record<string, unknown> = {}) {
  const n = KNOWN_NAMES[id] ?? { givenName: 'Sam', familyName: 'Rivera', kind: 'adult' };
  return {
    personId: id,
    givenName: n.givenName,
    familyName: n.familyName,
    displayName: `${n.givenName} ${n.familyName}`,
    kind: n.kind,
    status: 'active',
    dateOfBirth: n.kind === 'child' ? '2018-01-01' : '1990-04-02',
    accountLinked: id === PERSON_ID,
    contactPointKinds: ['email'],
    ...overrides,
  };
}

export function candidateDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...candidate(),
    personA: duplicateSide(PERSON_ID),
    personB: duplicateSide(OTHER_ID),
    ...overrides,
  };
}
