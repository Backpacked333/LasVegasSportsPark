/**
 * Fixtures for the operations screen tests: API payloads shaped like the OpenAPI schemas, with
 * fictional people only. Deterministic ids and times (the test clock is 2026-10-24T12:00Z).
 */
import { FACILITY_A, staffMe } from '../../testing/test-app';

export const ORG = '0192f1a0-0000-7000-8000-0000000000aa';
export const ME_PERSON = '0192f1a0-0000-7000-8000-0000000000dd';
export const ADULT = '0192f1a0-0000-7000-8000-00000000a001';
export const CHILD_1 = '0192f1a0-0000-7000-8000-00000000c001';
export const CHILD_2 = '0192f1a0-0000-7000-8000-00000000c002';
export const OFFERING = '0192f1a0-0000-7000-8000-0000000000f1';
export const SESSION_1 = '0192f1a0-0000-7000-8000-000000000051';
export const SESSION_2 = '0192f1a0-0000-7000-8000-000000000052';
export const PASS = '0192f1a0-0000-7000-8000-0000000000b1';
export const VISIT_1 = '0192f1a0-0000-7000-8000-0000000000e1';
export const CHECKIN_1 = '0192f1a0-0000-7000-8000-0000000000e2';

/** `GET /me` for a staff member scoped to one facility (so screens pick it without a choice). */
export const oneFacilityMe = () => staffMe([FACILITY_A]);

export function actor(label = 'Front desk (Dana)') {
  return { kind: 'staff', accountId: null, personId: ME_PERSON, staffRoles: [], actorLabel: label };
}

export function person(id: string, givenName: string, familyName: string, kind = 'child') {
  return {
    status: 200,
    body: {
      id,
      kind,
      givenName,
      familyName,
      dateOfBirth: null,
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      contactPoints: [],
    },
  };
}

export function sessionActivity(
  sessionId: string,
  title: string,
  start = '2026-10-24T16:00:00.000Z',
) {
  return {
    activity: {
      type: 'session',
      id: sessionId,
      offeringId: OFFERING,
      sessionId,
      eventId: null,
    },
    title,
    scheduledStart: start,
    scheduledEnd: start.replace('16:00', '17:00'),
    basis: { kind: 'enrollment', id: '0192f1a0-0000-7000-8000-0000000000aa', status: 'confirmed' },
    checkin: null,
  };
}

export function scanPerson(
  personId: string,
  givenName: string,
  kind: 'adult' | 'child',
  relation: 'holder' | 'household_member' | 'dependent',
  activities: unknown[] = [],
  onSite = false,
) {
  return {
    personId,
    givenName,
    familyName: 'Rivera',
    kind,
    relation,
    onSite,
    visitId: null,
    holderMayCollect: null,
    activities,
  };
}

/** A household pass with an adult and two children, each in a different session today. */
export function householdScan() {
  return {
    pass: { id: PASS, holderKind: 'household' },
    facilityId: FACILITY_A,
    scannedAt: '2026-10-24T12:00:00.000Z',
    window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
    people: [
      scanPerson(ADULT, 'Sam', 'adult', 'household_member'),
      scanPerson(CHILD_1, 'Alex', 'child', 'household_member', [
        sessionActivity(SESSION_1, 'Junior skills'),
      ]),
      scanPerson(CHILD_2, 'Blake', 'child', 'household_member', [
        sessionActivity(SESSION_2, 'Mini kickers'),
      ]),
    ],
    recorded: 'nothing',
    nextAction: 'select_people_and_sessions',
  };
}

export function visit(id: string, personId: string, category = 'participant') {
  return {
    id,
    facilityId: FACILITY_A,
    personId,
    visitorDescription: null,
    partySize: 1,
    visitorCategory: category,
    arrivedAt: '2026-10-24T12:00:00.000Z',
    passId: PASS,
    source: 'desk',
    status: 'on_site',
    departedAt: null,
    voidedAt: null,
    voidReason: null,
    recordedBy: actor(),
    revision: 1,
  };
}

export function checkin(
  id: string,
  personId: string,
  sessionId: string,
  status: 'held' | 'admitted',
  issues: unknown[] = [],
  revision = 1,
) {
  return {
    id,
    facilityId: FACILITY_A,
    visitId: VISIT_1,
    personId,
    activity: { type: 'session', id: sessionId, offeringId: OFFERING, sessionId, eventId: null },
    activityStart: '2026-10-24T16:00:00.000Z',
    activityEnd: '2026-10-24T17:00:00.000Z',
    basis: { kind: 'enrollment', id: '0192f1a0-0000-7000-8000-0000000000aa' },
    status,
    issues,
    checkedInAt: '2026-10-24T12:00:00.000Z',
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    admittedAt: status === 'admitted' ? '2026-10-24T12:00:00.000Z' : null,
    withdrawnAt: null,
    withdrawnReason: null,
    recordedBy: actor(),
    revision,
  };
}

export function syncBatch(
  items: { clientObservationId: string; kind: string; outcome: string; reason?: string | null }[],
) {
  const count = (o: string) => items.filter((i) => i.outcome === o).length;
  return {
    id: '0192f1a0-0000-7000-8000-0000000000d1',
    facilityId: FACILITY_A,
    deviceId: 'staff-web-x',
    clientBatchId: 'b',
    snapshot: { reference: 'r', takenAt: '2026-10-24T12:00:00.000Z' },
    receivedAt: '2026-10-24T12:00:00.000Z',
    snapshotAgeSeconds: 0,
    maxRosterAgeMinutes: 120,
    stale: false,
    counts: {
      items: items.length,
      accepted: count('accepted'),
      acceptedWithConflict: count('accepted_with_conflict'),
      duplicate: count('duplicate'),
      rejected: count('rejected'),
      stale: 0,
    },
    items: items.map((i) => ({
      clientObservationId: i.clientObservationId,
      kind: i.kind,
      outcome: i.outcome,
      reason: i.reason ?? null,
      recordId: null,
      flags: i.outcome === 'accepted_with_conflict' ? ['conflict'] : [],
    })),
    exceptionIds: [],
    operationId: null,
    replayed: false,
  };
}

export const ASSIGNMENT_1 = '0192f1a0-0000-7000-8000-0000000001a1';
export const OFFICIAL = '0192f1a0-0000-7000-8000-000000000001';
export const FIXTURE_1 = '0192f1a0-0000-7000-8000-0000000001f1';

export function assignmentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_1,
    facilityId: FACILITY_A,
    personId: OFFICIAL,
    kind: 'official',
    targetType: 'fixture',
    targetId: FIXTURE_1,
    offeringId: null,
    schedulingEventId: '0192f1a0-0000-7000-8000-0000000001e1',
    targetTitle: 'U12 Red v Blue',
    role: 'referee',
    slot: 1,
    engagement: 'regular',
    status: 'offered',
    scheduledStart: '2026-10-24T18:00:00.000Z',
    scheduledEnd: '2026-10-24T19:00:00.000Z',
    turnaroundMinutes: 30,
    committedUntil: '2026-10-24T19:30:00.000Z',
    replacesAssignmentId: null,
    offeredAt: '2026-10-20T10:00:00.000Z',
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
    revision: 4,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

export function feeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    id: '0192f1a0-0000-7000-8000-0000000001b1',
    assignmentId: ASSIGNMENT_1,
    personId: OFFICIAL,
    rateBasis: { kind: 'per_assignment', rateMinor: 2500, rateReference: 'Referee rate card' },
    computedAmountMinor: 2500,
    submittedAmountMinor: 3000,
    currency: 'USD',
    note: 'Extra time played',
    status: 'submitted',
    submittedAt: '2026-10-23T20:00:00.000Z',
    approvedAmountMinor: null,
    approver: null,
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    exportBatchId: null,
    exportedAt: null,
    adjustments: [],
    revision: 2,
    createdAt: '2026-10-23T20:00:00.000Z',
    ...overrides,
  };
}

/** A `GET /me/assignments` item for the viewer (workspace screens). */
export function workspaceItem(
  assignment: Record<string, unknown>,
  availableActions: string[],
  fee: unknown = null,
) {
  return {
    assignment,
    activity: {
      targetType: assignment.targetType,
      targetId: assignment.targetId,
      title: assignment.targetTitle,
      facilityId: FACILITY_A,
      scheduledStart: assignment.scheduledStart,
      scheduledEnd: assignment.scheduledEnd,
      participants:
        assignment.targetType === 'fixture'
          ? [
              { side: 'home', teamEntryId: '0192f1a0-0000-7000-8000-0000000004a1', name: 'Red' },
              { side: 'away', teamEntryId: '0192f1a0-0000-7000-8000-0000000004a2', name: 'Blue' },
            ]
          : [],
    },
    fee,
    availableActions,
  };
}

export function myAssignments(items: unknown[]) {
  return { status: 200, body: { evaluatedAt: '2026-10-24T12:00:00.000Z', items } };
}
