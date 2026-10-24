/**
 * API fixtures for the team screen tests (SCR-C-21 to SCR-C-29), shaped like the OpenAPI schemas.
 * Deterministic: fixed ids and instants around TEST_NOW (2026-10-24T12:00:00Z).
 */
import type { Schema } from '@sportspark/api-client';
import type { FakeHandler } from '@sportspark/api-client/testing';

const id = (n: number) => `0192f1a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const IDS = {
  me: id(1),
  child: id(2),
  player2: id(3),
  player3: id(4),
  formerPlayer: id(5),
  entry: id(10),
  priorEntry: id(11),
  newEntry: id(12),
  opponentEntry: id(13),
  team: id(20),
  opponentTeam: id(21),
  season: id(30),
  priorSeason: id(31),
  competition: id(32),
  division: id(33),
  ruleSet: id(34),
  fixture: id(40),
  playedFixture: id(41),
  invitation: id(50),
  joinRequest: id(51),
  obligation: id(60),
  contribution: id(61),
  payment: id(62),
  officialResult: id(70),
  supersededResult: id(71),
  dispute: id(80),
  bracketNode: id(90),
  operation: id(99),
} as const;

const T0 = '2026-09-01T12:00:00.000Z';

function actor(kind: string, actorLabel: string): Schema<'ActorSnapshot'> {
  return { kind, accountId: null, personId: null, actorLabel };
}

/**
 * Some nullable references are generated as intersections (`X & (Record<string, never> | null)`)
 * that no value satisfies (reported as an OpenAPI generation issue); fixtures cast to the field type.
 */
function asField<T>(value: unknown): T {
  return value as T;
}

export function team(overrides: Partial<Schema<'Team'>> = {}): Schema<'Team'> {
  return {
    id: IDS.team,
    name: 'Desert Foxes',
    colors: {},
    createdByPersonId: IDS.me,
    status: 'active',
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function teamEntry(overrides: Partial<Schema<'TeamEntry'>> = {}): Schema<'TeamEntry'> {
  return {
    id: IDS.entry,
    seasonId: IDS.season,
    divisionId: IDS.division,
    teamId: IDS.team,
    status: 'approved',
    appliedByPersonId: IDS.me,
    appliedAt: T0,
    approvedAt: T0,
    approvalNote: null,
    rejectedAt: null,
    rejectionReason: null,
    withdrawnAt: null,
    withdrawalReason: null,
    financialStatusRef: null,
    eligibilityStatus: 'eligible',
    eligibilityReasons: [],
    renewedFromEntryId: null,
    rosterComplete: false,
    rosterCount: 3,
    rosterMin: 7,
    rosterMax: 15,
    revision: 4,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function member(
  overrides: Partial<Schema<'RosterMember'>> & { personId: string; displayName: string },
): Schema<'RosterMember'> {
  return {
    id: overrides.id ?? `${overrides.personId.slice(0, -4)}9${overrides.personId.slice(-3)}`,
    teamEntryId: IDS.entry,
    personKind: 'adult',
    status: 'active',
    statusBeforeRemoval: asField<Schema<'RosterMember'>['statusBeforeRemoval']>(null),
    effectiveFrom: '2026-09-02T12:00:00.000Z',
    effectiveTo: null,
    jerseyNumber: null,
    source: 'captain',
    removedAt: null,
    removalReason: null,
    eligibility: { status: 'eligible', blocking: 0, warnings: 0, codes: [] },
    ...overrides,
  };
}

export const ROSTER = [
  member({ personId: IDS.me, displayName: 'Casey Captain', jerseyNumber: 9 }),
  member({
    personId: IDS.player2,
    displayName: 'Pat Player',
    eligibility: { status: 'ineligible', blocking: 1, warnings: 0, codes: ['suspended'] },
  }),
  member({
    personId: IDS.child,
    displayName: 'Kim Junior',
    personKind: 'child',
    eligibility: { status: 'unknown', blocking: 0, warnings: 0, codes: ['date_of_birth_unknown'] },
  }),
  member({
    personId: IDS.player3,
    displayName: 'Riley Requester',
    status: 'requested',
    source: 'join_request',
    eligibility: null,
  }),
];

export function upcoming(
  overrides: Partial<Schema<'UpcomingFixture'>> = {},
): Schema<'UpcomingFixture'> {
  return {
    fixture: fixture(),
    side: 'home',
    opponent: { entryId: IDS.opponentEntry, teamName: 'Canyon Hawks' },
    availability: { available: 1, unavailable: 1, tentative: 0, noResponse: 1 },
    myResponse: null,
    ...overrides,
  };
}

export function fixture(overrides: Partial<Schema<'Fixture'>> = {}): Schema<'Fixture'> {
  return {
    id: IDS.fixture,
    seasonId: IDS.season,
    divisionId: IDS.division,
    round: 3,
    homeEntryId: IDS.entry,
    awayEntryId: IDS.opponentEntry,
    schedulingEventId: null,
    scheduledStart: '2026-10-31T17:00:00.000Z',
    scheduledEnd: '2026-10-31T18:00:00.000Z',
    status: 'scheduled',
    notes: null,
    revision: 2,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function invitation(
  overrides: Partial<Schema<'TeamInvitation'>> = {},
): Schema<'TeamInvitation'> {
  return {
    id: IDS.invitation,
    teamEntryId: IDS.entry,
    invitedByPersonId: IDS.me,
    recipientPersonId: null,
    recipientContact: { kind: 'email', value: 'sam@example.test' },
    message: null,
    status: 'pending',
    expiresAt: '2026-10-31T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    revokedAt: null,
    rosterMembershipId: null,
    revision: 1,
    createdAt: '2026-10-24T11:00:00.000Z',
    ...overrides,
  };
}

export function joinRequest(overrides: Partial<Schema<'JoinRequest'>> = {}): Schema<'JoinRequest'> {
  return {
    id: IDS.joinRequest,
    teamEntryId: IDS.entry,
    personId: IDS.player3,
    requestedByPersonId: IDS.player3,
    message: 'I played with you last season.',
    status: 'pending',
    decidedByPersonId: null,
    decidedAt: null,
    decisionNote: null,
    rosterMembershipId: null,
    revision: 1,
    createdAt: '2026-10-23T12:00:00.000Z',
    ...overrides,
  };
}

export function workspace(
  overrides: Partial<Schema<'TeamEntryWorkspace'>> = {},
): Schema<'TeamEntryWorkspace'> {
  return {
    entry: teamEntry(),
    team: team(),
    season: {
      id: IDS.season,
      name: 'Fall 2026',
      status: 'active',
      startsOn: '2026-09-07',
      endsOn: '2026-12-13',
    },
    division: { id: IDS.division, name: 'Coed Division 2' },
    ruleSet: { id: IDS.ruleSet, name: 'Adult outdoor 7v7', version: 3 },
    roles: [
      {
        id: id(100),
        teamEntryId: IDS.entry,
        personId: IDS.me,
        role: 'captain',
        effectiveFrom: T0,
        effectiveTo: null,
      },
    ],
    roster: ROSTER,
    readiness: {
      approval: 'approved',
      financialStatusRef: null,
      rosterCount: 3,
      rosterMin: 7,
      rosterMax: 15,
      rosterComplete: false,
      eligiblePlayers: 1,
      pendingInvitations: 1,
      pendingJoinRequests: 1,
      issues: [
        {
          code: 'roster_below_minimum',
          severity: 'blocking',
          message: '3 of the required 7 players are on the roster.',
          responsibleRole: 'captain',
          requiredAction: 'Add 4 more eligible player(s).',
        },
        {
          code: 'financial_status_unknown',
          severity: 'unknown',
          message: 'No financial obligation has been recorded for this entry yet.',
          responsibleRole: 'finance_operator',
          requiredAction: 'Finance records the entry obligation.',
        },
      ],
    },
    pendingInvitations: [invitation()],
    pendingJoinRequests: [joinRequest()],
    upcomingFixtures: [upcoming()],
    ...overrides,
  };
}

/** The same workspace as a roster player (not captain) sees it: no invitations or requests. */
export function playerWorkspace(): Schema<'TeamEntryWorkspace'> {
  return workspace({
    roles: [
      {
        id: id(100),
        teamEntryId: IDS.entry,
        personId: IDS.player2,
        role: 'captain',
        effectiveFrom: T0,
        effectiveTo: null,
      },
    ],
    pendingInvitations: [],
    pendingJoinRequests: [],
  });
}

export function me(overrides: Partial<Schema<'Me'>> = {}): Schema<'Me'> {
  return {
    principal: {
      kind: 'customer',
      organizationId: id(200),
      accountId: '0192f1a0-0000-7000-8000-0000000000aa',
      personId: IDS.me,
      staffRoles: [],
      facilityIds: [],
    },
    person: {
      id: IDS.me,
      kind: 'adult',
      givenName: 'Casey',
      familyName: 'Captain',
      dateOfBirth: null,
      status: 'active',
      mergedIntoPersonId: null,
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    staffMemberships: [],
    authorities: [],
    ...overrides,
  };
}

export function standings(
  overrides: Partial<NonNullable<Schema<'Standings'>>> = {},
): NonNullable<Schema<'Standings'>> {
  const row = (
    position: number,
    teamEntryId: string,
    teamName: string,
    points: number,
  ): Schema<'StandingsRow'> => ({
    position,
    teamEntryId,
    teamName,
    played: 4,
    won: Math.floor(points / 3),
    drawn: points % 3,
    lost: 4 - Math.floor(points / 3) - (points % 3),
    goalsFor: 8,
    goalsAgainst: 5,
    goalDifference: 3,
    points,
    fairPlayPoints: 2,
    forfeits: 0,
  });
  return {
    id: id(300),
    seasonId: IDS.season,
    divisionId: IDS.division,
    ruleSetId: IDS.ruleSet,
    ruleSetVersion: 3,
    computedAt: '2026-10-23T20:00:00.000Z',
    sourceResultIds: [IDS.officialResult],
    rows: [row(1, IDS.opponentEntry, 'Canyon Hawks', 9), row(2, IDS.entry, 'Desert Foxes', 9)],
    tiebreakExplanations: [
      {
        teamEntryIds: [IDS.opponentEntry, IDS.entry],
        points: 9,
        steps: [
          {
            tiebreaker: 'head_to_head',
            outcome: 'resolved',
            values: [
              { teamEntryId: IDS.opponentEntry, value: '3' },
              { teamEntryId: IDS.entry, value: '0' },
            ],
            explanation: 'Canyon Hawks won the head-to-head game 2-1.',
          },
        ],
        resolved: true,
      },
    ],
    ...overrides,
  };
}

export function result(
  overrides: Partial<Schema<'ResultRevision'>> = {},
): Schema<'ResultRevision'> {
  return {
    id: IDS.officialResult,
    fixtureId: IDS.playedFixture,
    revisionNo: 1,
    status: 'official',
    classification: 'completed',
    homeScore: 1,
    awayScore: 2,
    forfeitingEntryId: null,
    details: { cards: [], abandonment: null, incidentIds: [], notes: null, disputeId: null },
    submittedBy: actor('staff', 'Match official'),
    submittedAt: '2026-10-17T19:00:00.000Z',
    returnedAt: null,
    returnReason: null,
    publishedBy: asField<Schema<'ResultRevision'>['publishedBy']>(actor('staff', 'League manager')),
    publishedAt: '2026-10-23T10:00:00.000Z',
    supersedesRevisionId: null,
    supersededAt: null,
    supersededByRevisionId: null,
    reason: null,
    revision: 2,
    createdAt: '2026-10-17T19:00:00.000Z',
    updatedAt: '2026-10-23T10:00:00.000Z',
    ...overrides,
  };
}

export function fixtureDetail(
  overrides: Partial<Schema<'FixtureDetail'>> = {},
): Schema<'FixtureDetail'> {
  return {
    ...fixture({
      id: IDS.playedFixture,
      status: 'played',
      scheduledStart: '2026-10-17T17:00:00.000Z',
      scheduledEnd: '2026-10-17T18:00:00.000Z',
    }),
    home: {
      entryId: IDS.entry,
      teamId: IDS.team,
      teamName: 'Desert Foxes',
      availability: { available: 0, unavailable: 0, tentative: 0, noResponse: 3 },
    },
    away: asField<Schema<'FixtureDetail'>['away']>({
      entryId: IDS.opponentEntry,
      teamId: IDS.opponentTeam,
      teamName: 'Canyon Hawks',
      availability: { available: 0, unavailable: 0, tentative: 0, noResponse: 3 },
    }),
    myResponse: null,
    ...overrides,
  };
}

export function dispute(overrides: Partial<Schema<'Dispute'>> = {}): Schema<'Dispute'> {
  return {
    id: IDS.dispute,
    fixtureId: IDS.playedFixture,
    resultRevisionId: IDS.officialResult,
    submittingTeamEntryId: IDS.entry,
    submittingRole: 'captain',
    submittedBy: actor('customer', 'Casey Captain'),
    submittedAt: '2026-10-24T12:00:00.000Z',
    submissionDeadlineAt: '2026-10-25T10:00:00.000Z',
    reason: 'The second goal was scored after the final whistle.',
    evidence: [{ kind: 'video', reference: 'https://video.example.test/clip-7' }],
    status: 'submitted',
    reviewer: asField<Schema<'Dispute'>['reviewer']>(null),
    decision: null,
    decidedAt: null,
    decisionReason: null,
    publicationConsequence: null,
    appealStatus: 'none',
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

export function ruleSet(overrides: Partial<Schema<'RuleSet'>> = {}): Schema<'RuleSet'> {
  return {
    id: IDS.ruleSet,
    name: 'Adult outdoor 7v7',
    format: 'outdoor',
    version: 3,
    content: { protestDeadlineHours: 48 } as Schema<'RuleSet'>['content'],
    supersedesRuleSetId: null,
    createdAt: T0,
    ...overrides,
  };
}

export function obligation(overrides: Partial<Schema<'Obligation'>> = {}): Schema<'Obligation'> {
  return {
    id: IDS.obligation,
    debtor: { kind: 'team_entry', personId: null, teamEntryId: IDS.entry },
    mode: 'team_with_contributions',
    responsiblePayerPersonId: null,
    source: { kind: 'team_fee', id: null },
    orderId: null,
    description: 'Fall 2026 team fee',
    dueAt: '2026-11-15T12:00:00.000Z',
    status: 'open',
    totals: {
      amountMinor: 90000,
      receivedMinor: 30000,
      allocatedMinor: 30000,
      remainingMinor: 60000,
      excessMinor: 0,
      currency: 'USD',
    },
    contributions: [
      {
        id: IDS.contribution,
        requestedPersonId: IDS.player2,
        amountMinor: 10000,
        currency: 'USD',
        status: 'paid',
        paidAt: '2026-10-20T12:00:00.000Z',
      },
    ],
    revision: 2,
    createdAt: T0,
    ...overrides,
  };
}

export function contributionRequest(
  overrides: Partial<Schema<'ContributionRequest'>> = {},
): Schema<'ContributionRequest'> {
  return {
    id: IDS.contribution,
    obligationId: IDS.obligation,
    requestedPersonId: IDS.me,
    amountMinor: 7500,
    currency: 'USD',
    message: 'Your share of the Fall team fee.',
    status: 'requested',
    paidAt: null,
    obligation: {
      description: 'Fall 2026 team fee',
      totals: obligation().totals,
      status: 'open',
    },
    revision: 1,
    createdAt: '2026-10-22T12:00:00.000Z',
    ...overrides,
  };
}

export function paymentAttempt(
  overrides: Partial<NonNullable<Schema<'PaymentAttempt'>>> = {},
): NonNullable<Schema<'PaymentAttempt'>> {
  return {
    id: IDS.payment,
    purpose: 'contribution',
    status: 'succeeded',
    amountMinor: 7500,
    currency: 'USD',
    provider: 'fake',
    providerReference: 'fake_ref_1',
    actionRequired: null,
    failureReason: null,
    evidenceSource: 'sync_response',
    payerPersonId: IDS.me,
    checkoutId: null,
    orderId: null,
    obligationId: IDS.obligation,
    contributionRequestId: IDS.contribution,
    installmentId: null,
    unknownSince: null,
    resolvedAt: null,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    ...overrides,
  };
}

export function season(overrides: Partial<Schema<'Season'>> = {}): Schema<'Season'> {
  return {
    id: IDS.season,
    competitionId: IDS.competition,
    name: 'Winter 2027',
    ruleSetId: IDS.ruleSet,
    startsOn: '2027-01-10',
    endsOn: '2027-03-28',
    registrationOfferingRef: null,
    registrationOpensAt: '2026-10-01T12:00:00.000Z',
    registrationClosesAt: '2026-12-01T12:00:00.000Z',
    status: 'open',
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function competition(overrides: Partial<Schema<'Competition'>> = {}): Schema<'Competition'> {
  return {
    id: IDS.competition,
    name: 'Adult Coed League',
    kind: 'league',
    sportFormat: 'outdoor',
    description: null,
    status: 'active',
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function division(overrides: Partial<Schema<'Division'>> = {}): Schema<'Division'> {
  return {
    id: IDS.division,
    seasonId: IDS.season,
    name: 'Coed Division 2',
    criteria: {
      ageBand: { minAge: 18, maxAge: null },
      level: 'Recreational',
      category: 'Coed',
      format: '7v7',
    },
    facilityId: null,
    capacityTeamEntries: 8,
    entryCount: 5,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** Routes every team screen reads: the signed-in person and this team's workspace. */
export function baseRoutes(
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    'GET /me': { status: 200, body: me() },
    'GET /team-entries/{id}': { status: 200, body: workspace() },
    ...overrides,
  };
}
