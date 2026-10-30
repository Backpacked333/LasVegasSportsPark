/**
 * API answers for the today screens' tests, shaped like docs/api/openapi.json. Deterministic: the
 * clock is TEST_NOW (2026-10-24T12:00Z, a Saturday; 5:00 AM in Los Angeles) and tests pin the
 * device zone to America/Los_Angeles.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';

export const ORG = '0192f1a0-0000-7000-8000-00000000f001';
export const SELF = '0192f1a0-0000-7000-8000-00000000a001';
export const CHILD = '0192f1a0-0000-7000-8000-00000000a002';
export const CHILD_TWO = '0192f1a0-0000-7000-8000-00000000a003';
export const OFFERING = '0192f1a0-0000-7000-8000-00000000b001';
export const OFFERING_TWO = '0192f1a0-0000-7000-8000-00000000b002';
export const SESSION = '0192f1a0-0000-7000-8000-00000000c001';
export const SESSION_TWO = '0192f1a0-0000-7000-8000-00000000c002';
export const ENROLLMENT = '0192f1a0-0000-7000-8000-00000000d001';
export const ENROLLMENT_PENDING = '0192f1a0-0000-7000-8000-00000000d002';
export const BOOKING = '0192f1a0-0000-7000-8000-00000000d101';
export const EVENT = '0192f1a0-0000-7000-8000-00000000e001';
export const OPERATION = '0192f1a0-0000-7000-8000-00000000e101';
export const BASKET = '0192f1a0-0000-7000-8000-00000000e301';
export const ORDER = '0192f1a0-0000-7000-8000-00000000e401';
export const PLACEMENT = '0192f1a0-0000-7000-8000-00000000e201';
export const FIXTURE = '0192f1a0-0000-7000-8000-00000000f101';
export const HOME_ENTRY = '0192f1a0-0000-7000-8000-00000000f201';
export const AWAY_ENTRY = '0192f1a0-0000-7000-8000-00000000f202';
export const FACILITY = '0192f1a0-0000-7000-8000-00000000b801';
export const PITCH_3 = '0192f1a0-0000-7000-8000-00000000b703';

export const LA = 'America/Los_Angeles';
/** A facility on another clock than the test device (America/Los_Angeles), to prove whose zone is used. */
export const DENVER = 'America/Denver';
const AT = '2026-10-20T12:00:00.000Z';

export const ok = (body: unknown): FakeHandler => ({ status: 200, body });

/** `nextAction` per code, as `ErrorCodes` in packages/contracts/src/errors.ts sends it. */
const NEXT_ACTIONS: Record<string, string> = {
  ACCESS_DENIED: 'contact_support_or_request_access',
  PARTICIPANT_AUTHORITY_REQUIRED: 'request_participant_authority',
  NOT_FOUND: 'verify_reference',
  VALIDATION_FAILED: 'correct_input',
  STALE_REVISION: 'reload_and_retry',
  INVALID_TRANSITION: 'reload_current_state',
  INTEGRATION_UNAVAILABLE: 'retry_later',
  RATE_LIMITED: 'retry_later',
  INTERNAL_ERROR: 'retry_or_contact_support',
};

export const fail =
  (status: number, code: string, message = `Fake ${code}`): FakeHandler =>
  () =>
    fakeResponse(
      status,
      apiErrorBody(code, {
        message,
        correlationId: 'corr-1',
        nextAction: NEXT_ACTIONS[code] ?? 'contact_support',
      }),
    );

export function me(authorities: { subjectPersonId: string; permissions: string[] }[] = []) {
  return {
    principal: {
      kind: 'customer',
      organizationId: ORG,
      accountId: '0192f1a0-0000-7000-8000-0000000000aa',
      personId: SELF,
      staffRoles: [],
      facilityIds: [],
    },
    person: {
      id: SELF,
      kind: 'adult',
      givenName: 'Alex',
      familyName: 'Morgan',
      dateOfBirth: null,
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: AT,
      updatedAt: AT,
    },
    staffMemberships: [],
    authorities,
  };
}

export const GUARDIAN_OF_CHILD = [{ subjectPersonId: CHILD, permissions: ['view', 'register'] }];

/** `GET /v1/person-names` (ID-02): names only, for the ids asked that the map knows. */
export function names(known: Record<string, string>): FakeHandler {
  return (req) => {
    const ids = (req.query.ids ?? '').split(',').filter(Boolean);
    return fakeResponse(200, {
      items: ids.flatMap((id) =>
        known[id]
          ? [
              {
                personId: id,
                canonicalPersonId: id,
                givenName: known[id],
                familyName: 'Morgan',
                displayName: `${known[id]} Morgan`,
                kind: id === SELF ? 'adult' : 'child',
              },
            ]
          : [],
      ),
    });
  };
}

/** `GET /v1/facilities/{id}` (K-04): the facility with its IANA zone. */
export function facility(overrides: Record<string, unknown> = {}) {
  return {
    id: FACILITY,
    slug: 'main-park',
    name: 'Main Park',
    timezone: LA,
    status: 'active',
    address: null,
    inStaffScope: null,
    ...overrides,
  };
}

export function person(id: string, givenName: string, kind: 'adult' | 'child' = 'child') {
  return {
    id,
    kind,
    givenName,
    familyName: 'Morgan',
    dateOfBirth: kind === 'child' ? '2016-05-01' : null,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    contactPoints: [],
  };
}

export function calendarItem(overrides: Record<string, unknown> = {}) {
  return {
    id: `enrollment:${ENROLLMENT}:${SESSION}`,
    personId: CHILD,
    kind: 'enrollment_session',
    enrollmentId: ENROLLMENT,
    sessionBookingId: null,
    offeringId: OFFERING,
    sessionId: SESSION,
    title: 'Junior Skills',
    // 10:00 to 11:00 AM in Los Angeles.
    start: '2026-10-24T17:00:00.000Z',
    end: '2026-10-24T18:00:00.000Z',
    status: 'confirmed',
    // ENR-02: where it happens and the zone its local times are shown in.
    facilityId: FACILITY,
    timezone: LA,
    ...overrides,
  };
}

export const BOOKING_ITEM = calendarItem({
  id: `booking:${BOOKING}`,
  personId: SELF,
  kind: 'session_booking',
  enrollmentId: null,
  sessionBookingId: BOOKING,
  offeringId: OFFERING_TWO,
  sessionId: SESSION_TWO,
  title: 'Adult Pickup Night',
  // Saturday 6:00 to 7:30 PM in Los Angeles.
  start: '2026-10-25T01:00:00.000Z',
  end: '2026-10-25T02:30:00.000Z',
  status: 'pending',
});

export function calendar(
  items: unknown[],
  options: { participants?: string[]; overlaps?: unknown[] } = {},
) {
  return {
    from: '2026-10-24T07:00:00.000Z',
    to: '2026-11-21T08:00:00.000Z',
    participantPersonIds: options.participants ?? [SELF, CHILD],
    items,
    overlaps: options.overlaps ?? [],
  };
}

export function offering(
  id = OFFERING,
  name = 'Junior Skills',
  locationLabel: string | null = 'North field',
) {
  return {
    id,
    programId: '0192f1a0-0000-7000-8000-00000000b901',
    facilityId: FACILITY,
    facility: { id: FACILITY, name: 'Main Park', timezone: LA },
    name,
    description: 'Ball skills for younger players.',
    kind: 'term',
    activityType: 'soccer',
    format: null,
    locationLabel,
    startsOn: '2026-09-01',
    endsOn: '2026-12-15',
    registrationOpensAt: null,
    registrationClosesAt: null,
    publicationState: 'published',
    ageBand: { minAge: 6, maxAge: 9 },
    capacity: [],
    price: null,
    eligibilityPolicyVersionId: null,
    cancellationPolicyVersionId: null,
    requiredFormPolicyVersionIds: [],
    entitlementDefinitionId: null,
    staff: null,
  };
}

export function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    offeringId: OFFERING,
    sequence: 3,
    title: null,
    scheduledStart: '2026-10-24T17:00:00.000Z',
    scheduledEnd: '2026-10-24T18:00:00.000Z',
    schedulingEventId: EVENT,
    capacityOverride: null,
    status: 'scheduled',
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    createdAt: AT,
    ...overrides,
  };
}

export function enrollment(overrides: Record<string, unknown> = {}) {
  return {
    id: ENROLLMENT,
    offeringId: OFFERING,
    participantPersonId: CHILD,
    intent: 'individual_league',
    entitlementDefinitionId: null,
    equivalenceKey: null,
    status: 'confirmed',
    payerPersonId: SELF,
    registeredBy: {
      kind: 'customer',
      accountId: null,
      personId: SELF,
      staffRoles: [],
      actorLabel: 'Alex',
    },
    assistedByPersonId: null,
    sourceApplicationId: null,
    basketId: null,
    basketLineId: null,
    placementRequestId: null,
    trialParticipationId: null,
    orderRef: null,
    lastOperationId: null,
    price: null,
    policies: {},
    confirmedAt: AT,
    canceledAt: null,
    cancellationReason: null,
    cancellationPolicyVersionId: null,
    cancellationConsequence: null,
    transferredAt: null,
    transferredToEnrollmentId: null,
    transferredFromEnrollmentId: null,
    completedAt: null,
    offering: {
      id: OFFERING,
      name: 'Junior Skills',
      kind: 'term',
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
      facilityId: FACILITY,
      timezone: LA,
    },
    pendingReason: null,
    revision: 2,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function operation(status: string, kind = 'finance.registration_checkout') {
  return {
    id: OPERATION,
    kind,
    status,
    correlationId: null,
    result: null,
    error: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
  };
}

export function eventDetails(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Junior Skills',
    kind: 'session',
    scheduledStart: '2026-10-24T17:00:00.000Z',
    scheduledEnd: '2026-10-24T18:00:00.000Z',
    timezone: LA,
    facilityId: '0192f1a0-0000-7000-8000-00000000b801',
    resources: [{ id: '0192f1a0-0000-7000-8000-00000000b701', name: 'Pitch 2' }],
    status: 'published',
    ...overrides,
  };
}

let attempt = 0;
export function notice(overrides: Record<string, unknown> = {}) {
  attempt += 1;
  const n = String(attempt).padStart(3, '0');
  return {
    attemptId: `0192f1a0-0000-7000-8000-000000001${n}`,
    notificationId: `0192f1a0-0000-7000-8000-000000002${n}`,
    kind: 'staff_broadcast',
    category: 'operational',
    title: 'A notice',
    body: 'Something from the facility.',
    facilityId: null,
    subject: null,
    detailsBefore: null,
    detailsAfter: null,
    status: 'delivered',
    deliveredAt: '2026-10-24T11:00:00.000Z',
    readAt: null,
    acknowledgedAt: null,
    supersededByNotificationId: null,
    subjectPersonIds: [],
    revision: 1,
    createdAt: '2026-10-24T11:00:00.000Z',
    ...overrides,
  };
}

/** A schedule change moving the session from 10:00 on Pitch 1 to 11:00 on Pitch 2. */
export function scheduleChange(overrides: Record<string, unknown> = {}) {
  return notice({
    kind: 'schedule_changed',
    title: 'Schedule changed: Junior Skills',
    body: 'Was: Sat 10:00 at Pitch 1. Now: Sat 11:00 at Pitch 2.',
    subject: { type: 'event', id: EVENT },
    detailsBefore: eventDetails({
      resources: [{ id: '0192f1a0-0000-7000-8000-00000000b702', name: 'Pitch 1' }],
    }),
    detailsAfter: eventDetails({
      scheduledStart: '2026-10-24T18:00:00.000Z',
      scheduledEnd: '2026-10-24T19:00:00.000Z',
    }),
    ...overrides,
  });
}

export const inboxPage = (items: unknown[], nextCursor: string | null = null) =>
  ok({ items, nextCursor });

export const enrollmentsPage = (items: unknown[]) => ok({ items, nextCursor: null });

export function fixtureDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: FIXTURE,
    seasonId: '0192f1a0-0000-7000-8000-00000000f301',
    divisionId: null,
    round: 3,
    homeEntryId: HOME_ENTRY,
    awayEntryId: AWAY_ENTRY,
    schedulingEventId: EVENT,
    scheduledStart: '2026-10-25T17:00:00.000Z',
    scheduledEnd: '2026-10-25T18:30:00.000Z',
    status: 'scheduled',
    notes: null,
    revision: 4,
    createdAt: AT,
    updatedAt: AT,
    home: {
      entryId: HOME_ENTRY,
      teamId: '0192f1a0-0000-7000-8000-00000000f401',
      teamName: 'Lions',
      availability: { available: 5, unavailable: 1, tentative: 0, noResponse: 4 },
    },
    away: {
      entryId: AWAY_ENTRY,
      teamId: '0192f1a0-0000-7000-8000-00000000f402',
      teamName: 'Tigers',
      availability: { available: 3, unavailable: 0, tentative: 1, noResponse: 6 },
    },
    myResponse: null,
    // CMP-04: the venue from the scheduling event, the viewer's roster status and the answers
    // they may see.
    venue: {
      facilityId: FACILITY,
      facilityName: 'Main Park',
      timezone: LA,
      resources: [{ id: PITCH_3, name: 'Pitch 3' }],
    },
    rosterStatus: 'active',
    responses: [],
    ...overrides,
  };
}

/** A row of `GET /v1/me/team-entries` (CMP-02): the entry, its team and the viewer's members. */
export function myTeamEntry(
  overrides: { entryId?: string; teamName?: string; members?: string[] } = {},
) {
  const entryId = overrides.entryId ?? HOME_ENTRY;
  return {
    teamEntry: { id: entryId, status: 'approved' },
    teamName: overrides.teamName ?? 'Lions',
    seasonId: '0192f1a0-0000-7000-8000-00000000f301',
    seasonName: 'Fall 2026',
    divisionName: 'Division 2',
    members: (overrides.members ?? [SELF]).map((personId) => ({
      personId,
      roles: ['member'],
      rosterStatus: 'active',
    })),
    nextFixture: null,
  };
}

/** The viewer (SELF) as captain of the entry, as `GET /v1/team-entries/{id}` lists team roles. */
export const SELF_CAPTAIN = [
  {
    id: '0192f1a0-0000-7000-8000-00000000f901',
    teamEntryId: HOME_ENTRY,
    personId: SELF,
    role: 'captain',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
  },
];

export function teamWorkspace(name = 'Lions', roles: unknown[] = []) {
  return {
    entry: { id: HOME_ENTRY },
    team: { id: '0192f1a0-0000-7000-8000-00000000f401', name },
    season: {
      id: '0192f1a0-0000-7000-8000-00000000f301',
      name: 'Fall 2026',
      status: 'active',
      startsOn: '2026-09-01',
      endsOn: '2026-12-15',
    },
    division: { id: '0192f1a0-0000-7000-8000-00000000f501', name: 'Division 2' },
    ruleSet: { id: '0192f1a0-0000-7000-8000-00000000f601', name: 'Adult 7v7', version: 2 },
    roles,
    roster: [],
    readiness: {},
    pendingInvitations: [],
    pendingJoinRequests: [],
    upcomingFixtures: [],
    viewer: {
      roles: (roles as { personId?: string; role?: string }[])
        .filter((r) => r.personId === SELF)
        .map((r) => r.role),
      actingAsCaptain: (roles as { personId?: string; role?: string }[]).some(
        (r) => r.personId === SELF && r.role === 'captain',
      ),
      availableActions: [],
    },
  };
}

export function readiness(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: FIXTURE,
    fixtureStatus: 'scheduled',
    status: 'warning',
    evaluatedAt: '2026-10-24T11:30:00.000Z',
    scheduledStart: '2026-10-25T17:00:00.000Z',
    checks: [{ name: 'roster', status: 'warning', issueCount: 1 }],
    issues: [
      {
        code: 'ROSTER_BELOW_MINIMUM',
        severity: 'warning',
        message: 'Lions have 6 eligible players; the rule set needs 7.',
        source: { type: 'team_entry', id: HOME_ENTRY },
        responsibleRole: 'captain',
        requiredAction: 'Invite or confirm another eligible player.',
        lastEvaluatedAt: '2026-10-24T11:30:00.000Z',
        deadline: '2026-10-25T17:00:00.000Z',
      },
    ],
    sides: [
      {
        teamEntryId: HOME_ENTRY,
        teamName: 'Lions',
        entryStatus: 'approved',
        rosterSize: 10,
        eligiblePlayers: 6,
        unknownPlayers: 1,
        minimumPlayers: 7,
      },
    ],
    ...overrides,
  };
}

export function result(overrides: Record<string, unknown> = {}) {
  return {
    id: '0192f1a0-0000-7000-8000-00000000f701',
    fixtureId: FIXTURE,
    revisionNo: 1,
    status: 'official',
    classification: 'completed',
    homeScore: 2,
    awayScore: 1,
    forfeitingEntryId: null,
    details: { cards: [], abandonment: null, incidentIds: [], notes: null, disputeId: null },
    submittedBy: { kind: 'staff' },
    submittedAt: AT,
    returnedAt: null,
    returnReason: null,
    publishedBy: null,
    publishedAt: '2026-10-21T12:00:00.000Z',
    supersedesRevisionId: null,
    supersededAt: null,
    supersededByRevisionId: null,
    reason: null,
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

/** The fields of a basket and its order that tell a pending registration's checkout state. */
export function checkoutBasket(status: string, orderRef: string | null = ORDER) {
  return { id: BASKET, status, orderRef, lines: [], revision: 3 };
}

export function checkoutOrder(fulfillmentStatus: string) {
  return { id: ORDER, basketId: BASKET, paymentStatus: 'paid', fulfillmentStatus };
}
