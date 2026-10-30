/**
 * API payload builders for the competition, placement and youth screen tests (SCR-S-08 to
 * SCR-S-13, SCR-S-16 to SCR-S-19). Shapes follow packages/contracts/src/api/competition.ts,
 * competition-matches.ts, enrollment.ts and support.ts; ids are fixed UUIDs, times are fixed
 * instants around TEST_NOW (2026-10-24T12:00:00Z). No real person data.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';

export const ID = {
  competition: '0192f1a0-0000-7000-8000-00000000c001',
  season: '0192f1a0-0000-7000-8000-00000000c101',
  ruleSet: '0192f1a0-0000-7000-8000-00000000c201',
  division: '0192f1a0-0000-7000-8000-00000000c301',
  teamRed: '0192f1a0-0000-7000-8000-00000000c401',
  teamBlue: '0192f1a0-0000-7000-8000-00000000c402',
  entryRed: '0192f1a0-0000-7000-8000-00000000c501',
  entryBlue: '0192f1a0-0000-7000-8000-00000000c502',
  fixture: '0192f1a0-0000-7000-8000-00000000c601',
  fixture2: '0192f1a0-0000-7000-8000-00000000c602',
  result1: '0192f1a0-0000-7000-8000-00000000c701',
  result2: '0192f1a0-0000-7000-8000-00000000c702',
  spec: '0192f1a0-0000-7000-8000-00000000c801',
  run: '0192f1a0-0000-7000-8000-00000000c901',
  draft: '0192f1a0-0000-7000-8000-00000000ca01',
  operation: '0192f1a0-0000-7000-8000-00000000cb01',
  dispute: '0192f1a0-0000-7000-8000-00000000cc01',
  incident: '0192f1a0-0000-7000-8000-00000000cd01',
  suspension: '0192f1a0-0000-7000-8000-00000000ce01',
  person: '0192f1a0-0000-7000-8000-00000000cf01',
  child: '0192f1a0-0000-7000-8000-00000000cf02',
  placement: '0192f1a0-0000-7000-8000-00000000d001',
  exception: '0192f1a0-0000-7000-8000-00000000d101',
  node1: '0192f1a0-0000-7000-8000-00000000d201',
  node2: '0192f1a0-0000-7000-8000-00000000d202',
  offering: '0192f1a0-0000-7000-8000-00000000d301',
  group: '0192f1a0-0000-7000-8000-00000000d401',
  poolCommercial: '0192f1a0-0000-7000-8000-00000000d501',
  poolStaffing: '0192f1a0-0000-7000-8000-00000000d502',
  enrollment: '0192f1a0-0000-7000-8000-00000000d601',
  resource: '0192f1a0-0000-7000-8000-00000000d701',
  member: '0192f1a0-0000-7000-8000-00000000d801',
  pool: '0192f1a0-0000-7000-8000-00000000d901',
  decision: '0192f1a0-0000-7000-8000-00000000da01',
  appeal: '0192f1a0-0000-7000-8000-00000000db01',
  recommendation: '0192f1a0-0000-7000-8000-00000000dc01',
  offering2: '0192f1a0-0000-7000-8000-00000000d302',
  program: '0192f1a0-0000-7000-8000-00000000dd01',
  facility: '0192f1a0-0000-7000-8000-00000000fa01',
} as const;

const T = '2026-10-20T12:00:00.000Z';

export const ok = (body: unknown): FakeHandler => ({ status: 200, body });
export const created = (body: unknown): FakeHandler => ({ status: 201, body });
export function fail(
  status: number,
  code: string,
  nextAction: string,
  extra: { message?: string; details?: unknown } = {},
): FakeHandler {
  return () => fakeResponse(status, apiErrorBody(code, { nextAction, ...extra }));
}

const actor = (label: string) => ({
  kind: 'staff',
  accountId: null,
  personId: null,
  staffRoles: ['league_manager'],
  sessionId: null,
  actorLabel: label,
});

export function competition(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.competition,
    name: 'Autumn League',
    kind: 'league',
    sportFormat: 'indoor_boarded',
    description: null,
    status: 'draft',
    revision: 2,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function ruleSetContent(overrides: Record<string, unknown> = {}) {
  return {
    playersOnField: 6,
    rosterMin: 8,
    rosterMax: 14,
    matchLengthMinutes: 50,
    periods: 2,
    minimumPlayers: 4,
    substitutions: { unlimited: true, maxPerMatch: null, rolling: true, reEntryAllowed: true },
    eligibilityReferenceDate: { rule: 'season_start' },
    multiTeamRestrictions: {
      maxEntriesPerSeason: null,
      allowSameDivision: false,
      allowCrossDivision: true,
    },
    scoring: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
    drawsAllowed: true,
    overtime: { enabled: false, periods: null, periodLengthMinutes: null, goldenGoal: false },
    shootout: { enabled: false, kicks: null },
    cards: {
      yellowAccumulationThreshold: null,
      yellowAccumulationSuspensionMatches: 0,
      redCardSuspensionMatches: 1,
      secondYellowIsRed: true,
      sinBinMinutes: 2,
    },
    forfeit: { scoreFor: 3, scoreAgainst: 0, graceMinutes: 10, minimumPlayersToStart: 4 },
    abandonment: { minimumMinutesForResult: null, policy: 'league_decision' },
    tiebreakers: ['points', 'head_to_head', 'goal_difference'],
    protestDeadlineHours: 48,
    resultApproval: {
      submitRoles: ['official'],
      approveRoles: ['league_manager'],
      captainConfirmationRequired: false,
    },
    roster: {
      guestPlayersAllowed: true,
      guestMaxConcurrent: 2,
      substitutesAllowed: true,
      guestOrSubstituteRequiresApproval: false,
      coCaptainMayActAsCaptain: false,
    },
    outdoor: null,
    indoorBoarded: { wallPlayAllowed: true, ceilingOutOfPlay: true, flySubstitutions: true },
    futsal: null,
    smallSidedOther: null,
    ...overrides,
  };
}

export function ruleSet(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.ruleSet,
    name: 'Indoor 6v6',
    format: 'indoor_boarded',
    version: 1,
    content: ruleSetContent(),
    supersedesRuleSetId: null,
    createdAt: T,
    ...overrides,
  };
}

export function season(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.season,
    competitionId: ID.competition,
    name: 'Autumn 2026',
    ruleSetId: ID.ruleSet,
    startsOn: '2026-11-01',
    endsOn: '2026-12-20',
    registrationOfferingRef: null,
    registrationOpensAt: null,
    registrationClosesAt: null,
    status: 'draft',
    revision: 4,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function division(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.division,
    seasonId: ID.season,
    name: 'Division A',
    criteria: {
      ageBand: { minAge: 18, maxAge: null },
      level: 'Open',
      category: null,
      format: null,
    },
    facilityId: null,
    capacityTeamEntries: 8,
    entryCount: 2,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function team(id: string, name: string) {
  return {
    id,
    name,
    colors: {},
    createdByPersonId: null,
    status: 'active',
    revision: 1,
    createdAt: T,
    updatedAt: T,
  };
}

export const TEAM_ROUTES: Record<string, FakeHandler> = {
  'GET /teams/{id}': (req) =>
    fakeResponse(200, team(req.params.id ?? '', req.params.id === ID.teamRed ? 'Red' : 'Blue')),
};

export function eligibilityReason(overrides: Record<string, unknown> = {}) {
  return {
    code: 'roster.minimum',
    severity: 'blocking',
    message: 'The roster has fewer players than the rule set minimum.',
    source: { type: 'team_entry', id: ID.entryRed },
    responsibleRole: 'captain',
    requiredAction: 'Add players to the roster.',
    ...overrides,
  };
}

export function teamEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.entryRed,
    seasonId: ID.season,
    divisionId: null,
    teamId: ID.teamRed,
    // CMP-01: an entry carries its team's name.
    teamName: overrides.teamId === ID.teamBlue ? 'Blue' : 'Red',
    status: 'applied',
    appliedByPersonId: null,
    appliedAt: T,
    approvedAt: null,
    approvalNote: null,
    rejectedAt: null,
    rejectionReason: null,
    withdrawnAt: null,
    withdrawalReason: null,
    financialStatusRef: null,
    eligibilityStatus: 'review_required',
    eligibilityReasons: [eligibilityReason()],
    renewedFromEntryId: null,
    rosterComplete: false,
    rosterCount: 5,
    rosterMin: 8,
    rosterMax: 14,
    revision: 3,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function fixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.fixture,
    seasonId: ID.season,
    divisionId: ID.division,
    round: 1,
    homeEntryId: ID.entryRed,
    awayEntryId: ID.entryBlue,
    // CMP-01: a season fixture row carries both team names (null away for a bye).
    homeTeamName: 'Red',
    awayTeamName: overrides.awayEntryId === null ? null : 'Blue',
    schedulingEventId: null,
    scheduledStart: '2026-11-07T18:00:00.000Z',
    scheduledEnd: '2026-11-07T19:00:00.000Z',
    status: 'scheduled',
    notes: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

const availability = { available: 6, unavailable: 1, tentative: 2, noResponse: 3 };

export function venue(overrides: Record<string, unknown> = {}) {
  return {
    facilityId: ID.facility,
    facilityName: 'North Park',
    timezone: 'America/Los_Angeles',
    resources: [{ id: ID.resource, name: 'Pitch 1' }],
    ...overrides,
  };
}

export function fixtureDetail(overrides: Record<string, unknown> = {}) {
  const { homeTeamName: _home, awayTeamName: _away, ...base } = fixture();
  void _home;
  void _away;
  return {
    ...base,
    home: { entryId: ID.entryRed, teamId: ID.teamRed, teamName: 'Red', availability },
    away: { entryId: ID.entryBlue, teamId: ID.teamBlue, teamName: 'Blue', availability },
    myResponse: null,
    venue: null,
    rosterStatus: null,
    responses: [],
    ...overrides,
  };
}

/** `GET /v1/facilities` (K-04) with the facility used by the competition fixtures. */
export function facilities() {
  return {
    items: [
      {
        id: ID.facility,
        slug: 'north-park',
        name: 'North Park',
        timezone: 'America/Los_Angeles',
        status: 'active',
        address: null,
        inStaffScope: true,
      },
    ],
  };
}

/**
 * `GET /v1/person-names` answering with the people it knows; anyone else is omitted, as the API
 * omits a person the viewer may not view (ID-02). The client repeats `ids` once per person and the
 * fake fetch keeps only one value, so every known person is answered; rows map names by id.
 */
export function personNames(known: Record<string, [string, string, ('adult' | 'child')?]>) {
  return () => {
    const items = Object.entries(known).map(([id, [givenName, familyName, kind]]) => ({
      personId: id,
      canonicalPersonId: id,
      givenName,
      familyName,
      displayName: `${givenName} ${familyName}`,
      kind: kind ?? 'child',
    }));
    return fakeResponse(200, { items });
  };
}

export function seasonReadiness(
  items: { fixtureId: string; status: string; blockingCount?: number; unknownCount?: number }[],
  evaluatedAt = '2026-10-24T11:58:00.000Z',
) {
  return {
    seasonId: ID.season,
    evaluatedAt,
    items: items.map((i) => ({ blockingCount: 0, unknownCount: 0, ...i })),
  };
}

export function matchSheet(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: ID.fixture,
    scheduledStart: '2026-11-07T18:00:00.000Z',
    status: 'scheduled',
    venue: venue(),
    view: 'full',
    sides: [
      {
        entryId: ID.entryRed,
        teamName: 'Red',
        players: [
          {
            personId: ID.person,
            displayName: 'Sam Player',
            jerseyNumber: 7,
            playingStatus: 'active',
            roles: ['captain'],
          },
        ],
      },
      {
        entryId: ID.entryBlue,
        teamName: 'Blue',
        players: [
          {
            personId: ID.child,
            displayName: 'Alex Keeper',
            jerseyNumber: 1,
            playingStatus: 'guest',
            roles: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

export function dispute(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.dispute,
    fixtureId: ID.fixture,
    resultRevisionId: ID.result1,
    submittingTeamEntryId: ID.entryBlue,
    submittingRole: 'captain',
    submittedBy: actor('Captain Blue'),
    submittedAt: '2026-11-07T20:00:00.000Z',
    submissionDeadlineAt: '2026-11-09T19:00:00.000Z',
    reason: 'The second goal was offside.',
    evidence: [{ kind: 'video', reference: 'clip-12', description: 'Minute 30' }],
    status: 'submitted',
    reviewer: null,
    decision: null,
    decidedAt: null,
    decisionReason: null,
    publicationConsequence: null,
    appealStatus: 'none',
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.decision,
    incidentId: ID.incident,
    subjectPersonId: ID.person,
    ruleSetId: ID.ruleSet,
    basis: 'Red card for serious foul play.',
    decision: 'suspension',
    details: {},
    decidedBy: actor('League Manager'),
    decidedAt: '2026-11-08T10:00:00.000Z',
    status: 'issued',
    overturnedAt: null,
    overturnReason: null,
    suspensionId: ID.suspension,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function appeal(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.appeal,
    subjectPersonId: ID.person,
    decisionId: ID.decision,
    suspensionId: null,
    disputeId: null,
    grounds: 'The foul was accidental.',
    evidence: [],
    submittedBy: actor('Guardian'),
    submittedAt: '2026-11-08T12:00:00.000Z',
    status: 'submitted',
    reviewer: null,
    decidedAt: null,
    decisionReason: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function pool(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.pool,
    seasonId: ID.season,
    divisionId: ID.division,
    name: 'Pool A',
    entries: [{ teamEntryId: ID.entryRed, teamName: 'Red', seed: 1 }],
    revision: 2,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function poolStandings(overrides: Record<string, unknown> = {}) {
  const table = standings();
  return {
    poolId: ID.pool,
    seasonId: ID.season,
    divisionId: ID.division,
    ruleSetId: table.ruleSetId,
    ruleSetVersion: table.ruleSetVersion,
    computedAt: table.computedAt,
    sourceResultIds: table.sourceResultIds,
    pendingFixtureIds: [],
    rows: table.rows,
    tiebreakExplanations: [],
    ...overrides,
  };
}

export function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.recommendation,
    participantPersonId: ID.child,
    fromOfferingId: ID.offering,
    recommendedOfferingId: ID.offering2,
    recommendedProgramId: null,
    eligibility: {
      eligible: true,
      policyVersionId: null,
      referenceDate: '2027-01-01',
      evaluatedAt: '2026-10-24T12:00:00.000Z',
      reasons: [],
      alternatives: [],
      overridden: false,
    },
    suitability: 'Ready for the next level.',
    status: 'draft',
    sharedAt: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function personSearchResult(id: string, givenName: string, familyName: string) {
  return { id, givenName, familyName, kind: 'adult', status: 'active', matchedOn: 'name' };
}

export function readiness(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: ID.fixture,
    fixtureStatus: 'scheduled',
    status: 'ready',
    evaluatedAt: '2026-10-24T11:58:00.000Z',
    scheduledStart: '2026-11-07T18:00:00.000Z',
    checks: [
      { name: 'schedule.published', status: 'ready', issueCount: 0 },
      { name: 'workforce.required_officials', status: 'ready', issueCount: 0 },
    ],
    issues: [],
    sides: [
      {
        teamEntryId: ID.entryRed,
        teamName: 'Red',
        entryStatus: 'approved',
        rosterSize: 10,
        eligiblePlayers: 9,
        unknownPlayers: 1,
        minimumPlayers: 4,
      },
    ],
    ...overrides,
  };
}

export function readinessIssue(overrides: Record<string, unknown> = {}) {
  return {
    code: 'officials.unassigned',
    severity: 'blocking',
    message: 'No referee has accepted this fixture.',
    source: { type: 'assignment', id: null },
    responsibleRole: 'scheduler',
    requiredAction: 'Assign and confirm a referee.',
    lastEvaluatedAt: '2026-10-24T11:58:00.000Z',
    deadline: '2026-11-06T18:00:00.000Z',
    ...overrides,
  };
}

export function resultRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.result1,
    fixtureId: ID.fixture,
    revisionNo: 1,
    status: 'submitted',
    classification: 'completed',
    homeScore: 3,
    awayScore: 1,
    forfeitingEntryId: null,
    details: { cards: [], abandonment: null, incidentIds: [], notes: null, disputeId: null },
    submittedBy: actor('Referee R. One'),
    submittedAt: '2026-11-07T19:10:00.000Z',
    returnedAt: null,
    returnReason: null,
    publishedBy: null,
    publishedAt: null,
    supersedesRevisionId: null,
    supersededAt: null,
    supersededByRevisionId: null,
    reason: null,
    revision: 2,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function standings(overrides: Record<string, unknown> = {}) {
  return {
    id: '0192f1a0-0000-7000-8000-00000000e001',
    seasonId: ID.season,
    divisionId: null,
    ruleSetId: ID.ruleSet,
    ruleSetVersion: 3,
    computedAt: '2026-11-08T09:00:00.000Z',
    sourceResultIds: [ID.result1, ID.result2],
    rows: [row(1, ID.entryRed, 'Red', 6), row(2, ID.entryBlue, 'Blue', 6)],
    tiebreakExplanations: [
      {
        teamEntryIds: [ID.entryRed, ID.entryBlue],
        points: 6,
        steps: [
          {
            tiebreaker: 'head_to_head',
            outcome: 'resolved',
            values: [
              { teamEntryId: ID.entryRed, value: '3' },
              { teamEntryId: ID.entryBlue, value: '0' },
            ],
            explanation: 'Red won the match between the two teams.',
          },
        ],
        resolved: true,
      },
    ],
    ...overrides,
  };
}

function row(position: number, entryId: string, name: string, points: number) {
  return {
    position,
    teamEntryId: entryId,
    teamName: name,
    played: 3,
    won: 2,
    drawn: 0,
    lost: 1,
    goalsFor: 7,
    goalsAgainst: 4,
    goalDifference: 3,
    points,
    fairPlayPoints: 1,
    forfeits: 0,
  };
}

export function bracketNode(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.node1,
    seasonId: ID.season,
    divisionId: null,
    name: 'Final',
    round: 1,
    slot: 1,
    sourceRule: { home: { kind: 'seed', seed: 1 }, away: { kind: 'seed', seed: 2 } },
    homeEntryId: ID.entryRed,
    awayEntryId: ID.entryBlue,
    // CMP-01: the slot holders' team names.
    homeTeamName: 'Red',
    awayTeamName: 'Blue',
    fixtureId: ID.fixture,
    winnerEntryId: null,
    published: true,
    publishedAt: T,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function reviewTask(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.exception,
    facilityId: null,
    category: 'competition.result_correction_review',
    severity: 'high',
    title: 'Result correction affects published history',
    affected: { type: 'result_revision', id: ID.result2 },
    ownerQueue: 'league_manager',
    status: 'open',
    openedAt: '2026-10-24T10:00:00.000Z',
    ageMinutes: 120,
    deadlineAt: null,
    acknowledgeBy: null,
    overdue: false,
    acknowledgedAt: null,
    resolvedAt: null,
    closedAt: null,
    resolution: null,
    details: {
      fixtureId: ID.fixture,
      officialRevisionId: ID.result1,
      affectedBracketNodeIds: [ID.node1],
      affectedFixtureIds: [ID.fixture2],
    },
    revision: 1,
    history: [],
    nextActions: [],
    underlyingRecordUnchanged: true,
    ...overrides,
  };
}

export const page = (items: unknown[], nextCursor: string | null = null) => ({ items, nextCursor });

export function solverRun(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.run,
    specificationId: ID.spec,
    ruleSetId: ID.ruleSet,
    searchSettings: { maxCandidates: 40, timeLimitMs: 2000, seed: 1 },
    outcome: 'feasible',
    proposal: {
      games: [
        {
          key: 'g1',
          round: 1,
          homeEntryId: ID.entryRed,
          awayEntryId: ID.entryBlue,
          fixtureId: null,
          scheduledStart: '2026-11-07T18:00:00.000Z',
          scheduledEnd: '2026-11-07T19:00:00.000Z',
          resourceId: ID.resource,
        },
      ],
    },
    completenessReport: {
      complete: true,
      expectedGames: 1,
      proposedGames: 1,
      scheduledGames: 1,
      byes: [],
      issues: [],
      remainingObligations: [],
    },
    explanation: {
      hardViolations: [],
      preferenceScores: [
        {
          kind: 'home_away_balance',
          hard: false,
          weight: 2,
          penalty: 0,
          explanation: 'Balanced.',
        },
      ],
      totalPenalty: 0,
      candidatesTried: 12,
      stoppedBy: 'candidate_limit',
      summary: 'A proposal meeting every hard constraint was found.',
    },
    dryRun: true,
    scheduleDraftId: null,
    fixtureIds: [],
    operationId: null,
    startedAt: '2026-10-24T11:59:00.000Z',
    finishedAt: '2026-10-24T11:59:02.000Z',
    createdAt: '2026-10-24T11:59:02.000Z',
    ...overrides,
  };
}

export function specification(overrides: Record<string, unknown> = {}) {
  return {
    id: ID.spec,
    seasonId: ID.season,
    divisionId: ID.division,
    facilityId: '0192f1a0-0000-7000-8000-00000000fa01',
    name: 'Division A round robin',
    teamEntryIds: [ID.entryRed, ID.entryBlue],
    gamesPerTeam: 1,
    opponentFrequency: 1,
    startsOn: '2026-11-01',
    endsOn: '2026-12-20',
    blackouts: [],
    byesAllowed: true,
    minimumRestMinutes: 1440,
    allowedStartTimes: [{ weekday: 6, time: '10:00' }],
    matchDurationMinutes: 60,
    requiredResourceIds: [ID.resource],
    playoffStructure: null,
    fairnessPreferences: [
      { kind: 'no_consecutive_games', hard: true, weight: 1 },
      { kind: 'home_away_balance', hard: false, weight: 2 },
    ],
    revision: 1,
    createdAt: T,
    updatedAt: T,
    ...overrides,
  };
}

export function person(id: string, givenName: string, familyName: string) {
  return {
    id,
    kind: 'child',
    givenName,
    familyName,
    dateOfBirth: '2016-05-04',
    // PersonDetail carries contact points; staff name reads keep only the name (§4.14).
    contactPoints: [{ id: `${id.slice(0, 30)}ff`, kind: 'email', value: 'guardian@example.test' }],
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
  };
}

export function operation(status: string) {
  return {
    id: ID.operation,
    kind: 'competition.publish_result',
    status,
    correlationId: null,
    result: null,
    error: null,
    createdAt: T,
    updatedAt: T,
    completedAt: status === 'running' ? null : T,
  };
}
