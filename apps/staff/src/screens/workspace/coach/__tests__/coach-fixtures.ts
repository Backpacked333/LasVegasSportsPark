/** Shared fixtures of the coach workspace tests (S 2d, S 3g, S 4d, S 5c). Not a spec file. */
import { fakeResponse, type FakeHandler, type FakeRequest } from '@sportspark/api-client/testing';
import { FACILITY_A } from '../../../../testing/test-app';

export const OFFERING = '0192f1a0-0000-7000-8000-00000000of01';
export const SESSION = '0192f1a0-0000-7000-8000-00000000se01';
export const ASSIGNMENT = '0192f1a0-0000-7000-8000-00000000as01';
export const AVA = '0192f1a0-0000-7000-8000-0000000c0001';
export const BEN = '0192f1a0-0000-7000-8000-0000000c0002';
export const LEO = '0192f1a0-0000-7000-8000-0000000c0003';
export const NOAH = '0192f1a0-0000-7000-8000-0000000c0004';
export const DANA = '0192f1a0-0000-7000-8000-0000000a0001';
export const ROSA = '0192f1a0-0000-7000-8000-0000000a0002';

/** TEST_NOW is 2026-10-24T12:00Z; the session started 12 minutes earlier (04:48 local). */
export const START = '2026-10-24T11:48:00.000Z';
export const END = '2026-10-24T12:33:00.000Z';

export function coachAssignment(overrides: Record<string, unknown> = {}) {
  return {
    assignment: {
      id: ASSIGNMENT,
      facilityId: FACILITY_A,
      personId: 'p-coach',
      kind: 'coach',
      targetType: 'session',
      targetId: SESSION,
      offeringId: OFFERING,
      schedulingEventId: null,
      targetTitle: 'Little Kickers (session 1)',
      role: 'coach',
      slot: 1,
      engagement: 'regular',
      status: 'accepted',
      scheduledStart: START,
      scheduledEnd: END,
      turnaroundMinutes: 0,
      committedUntil: END,
      replacesAssignmentId: null,
      offeredAt: null,
      respondedAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      withdrawnAt: null,
      withdrawnReason: null,
      completedAt: null,
      access: {
        status: 'not_applicable',
        staffMembershipId: null,
        from: null,
        until: null,
        active: false,
      },
      revision: 2,
      createdAt: START,
      updatedAt: START,
      ...overrides,
    },
    activity: {
      targetType: 'session',
      targetId: SESSION,
      title: 'Little Kickers (session 1)',
      facilityId: FACILITY_A,
      facility: { id: FACILITY_A, name: 'North Complex', timezone: 'America/Los_Angeles' },
      scheduledStart: START,
      scheduledEnd: END,
      participants: [],
    },
    fee: null,
    availableActions: [],
  };
}

export const ASSIGNMENTS = {
  status: 200,
  body: { evaluatedAt: '2026-10-24T12:00:00.000Z', items: [coachAssignment()] },
};

interface Person {
  personId: string;
  given: string;
  family: string;
  state?: 'present' | 'late' | 'absent' | null;
  observationId?: string;
  at?: string;
}

export function person({ personId, given, family, state = null, observationId, at }: Person) {
  const id = observationId ?? `obs-${personId.slice(-4)}`;
  return {
    personId,
    givenName: given,
    familyName: family,
    displayName: `${given} ${family}`,
    effectiveState: state,
    status: 'recorded',
    currentObservationIds: state ? [id] : [],
    history: state
      ? [
          {
            id,
            facilityId: FACILITY_A,
            personId,
            activity: {
              type: 'session',
              id: SESSION,
              offeringId: OFFERING,
              sessionId: SESSION,
              eventId: null,
            },
            observedState: state,
            observedAt: at ?? START,
            receivedAt: at ?? START,
            source: 'online',
            deviceId: null,
            clientObservationId: null,
            syncBatchId: null,
            snapshotReference: null,
            snapshotTakenAt: null,
            flags: [],
            correctsObservationId: null,
            correctionReason: null,
            recordedBy: { actorType: 'staff', actorLabel: 'Coach' },
            correctedByObservationId: null,
          },
        ]
      : [],
  };
}

export function attendance(people: ReturnType<typeof person>[]) {
  return {
    status: 200,
    body: {
      activity: {
        type: 'session',
        id: SESSION,
        offeringId: OFFERING,
        sessionId: SESSION,
        eventId: null,
      },
      people,
      expected: null,
    },
  };
}

export const DEFAULT_PEOPLE = () => [
  person({ personId: AVA, given: 'Ava', family: 'Kim', state: 'present' }),
  person({ personId: BEN, given: 'Ben', family: 'Tran' }),
  person({ personId: LEO, given: 'Leo', family: 'Ortiz' }),
  person({
    personId: NOAH,
    given: 'Noah',
    family: 'Brooks',
    state: 'late',
    at: '2026-10-24T11:53:00.000Z',
  }),
];

/** The reads every coach screen makes, answered as the API would for the session. */
export function coachRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me/assignments': ASSIGNMENTS,
    'GET /attendance': attendance(DEFAULT_PEOPLE()),
    'GET /enrollments': { status: 200, body: { items: [], nextCursor: null } },
    'GET /session-bookings': { status: 200, body: [] },
    'GET /offerings/{id}': {
      status: 200,
      body: { id: OFFERING, programId: 'prog-1', name: 'Little Kickers' },
    },
    'GET /offerings/{id}/sessions': {
      status: 200,
      body: [
        { id: SESSION, location: { label: 'Court 1' }, scheduledStart: START, scheduledEnd: END },
      ],
    },
    'GET /attendance/care-flags': {
      status: 200,
      body: { items: [{ personId: NOAH, kinds: ['allergy'] }] },
    },
    'GET /offerings/{id}/required-waivers': {
      status: 200,
      body: {
        offeringId: OFFERING,
        waivers: [{ policyKey: 'waiver', currentVersion: null, enforcement: null }],
      },
    },
    'GET /people/{id}/waivers': (request: FakeRequest) =>
      fakeResponse(200, {
        personId: request.params['id'],
        evaluated: true,
        waivers: [
          {
            policyKey: 'waiver',
            title: 'Liability waiver',
            status: request.params['id'] === LEO ? 'missing' : 'current',
            history: [],
            overrides: [],
          },
        ],
      }),
    ...extra,
  };
}
