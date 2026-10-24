import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import {
  ScheduleDraftsService,
  at,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import {
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

describe('fixture generation (SPK-FIX-001..005, SPK-AT-010, SPK-AT-011)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let scheduler: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let entries: string[];

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    scheduler = await staffMember(t, ['scheduler']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, {
      status: 'active',
      startsOn: '2027-01-10',
      endsOn: '2027-04-30',
    });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Division 1' });
    entries = [];
    for (const name of ['Aces', 'Bolts', 'Comets', 'Dynamos', 'Eagles']) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        teamName: name,
        divisionId,
      });
      entries.push(entry.teamEntryId);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);

  const specification = (overrides: object = {}) => ({
    name: 'Division 1 league phase',
    facilityId: t.facilityId,
    gamesPerTeam: 8,
    opponentFrequency: 2,
    startsOn: '2027-01-16',
    endsOn: '2027-04-10',
    blackouts: [{ start: '2027-02-13', end: '2027-02-14' }],
    minimumRestMinutes: 120,
    allowedStartTimes: [
      { weekday: 6, time: '09:00' },
      { weekday: 6, time: '11:00' },
      { weekday: 6, time: '13:00' },
    ],
    matchDurationMinutes: 60,
    requiredResourceIds: [pitch.pitchId],
    fairnessPreferences: [{ kind: 'home_away_balance', hard: false, weight: 2 }],
    ...overrides,
  });

  let specificationId: string;
  let runId: string;
  let draftId: string;

  it('SPK-FIX-001: the league manager defines a specification; resources must belong to the facility; captains cannot', async () => {
    const byCaptain = await post(
      `/divisions/${divisionId}/fixture-specifications`,
      await adultCustomer(t),
      specification(),
    );
    expect(byCaptain.status).toBe(403);
    const unknownResource = await post(
      `/divisions/${divisionId}/fixture-specifications`,
      leagueManager,
      specification({ requiredResourceIds: [newId()] }),
    );
    expect(unknownResource.status).toBe(400);
    const res = await post(
      `/divisions/${divisionId}/fixture-specifications`,
      leagueManager,
      specification(),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      divisionId,
      seasonId: season.seasonId,
      gamesPerTeam: 8,
      opponentFrequency: 2,
      byesAllowed: true,
      minimumRestMinutes: 120,
      matchDurationMinutes: 60,
      requiredResourceIds: [pitch.pitchId],
      fairnessPreferences: [{ kind: 'home_away_balance', hard: false, weight: 2 }],
    });
    expect(res.body.teamEntryIds).toHaveLength(5);
    specificationId = res.body.id;
    const read = await t.http
      .get(`/v1/fixture-specifications/${specificationId}`)
      .set(leagueManager.header);
    expect(read.status).toBe(200);
  });

  it('SPK-AT-010: five teams in a double round robin → 20 games and 10 byes (two per team), every game placed, obligations complete; the proposal is a scheduling draft, not a publication (SPK-FIX-005)', async () => {
    const res = await post(`/fixture-specifications/${specificationId}/generate`, leagueManager, {
      searchSettings: { maxCandidates: 20, timeLimitMs: 5000, seed: 3 },
    });
    expect(res.status).toBe(201);
    expect(['feasible', 'proven_optimal']).toContain(res.body.outcome);
    expect(res.body.completenessReport).toMatchObject({
      complete: true,
      expectedGames: 20,
      proposedGames: 20,
      scheduledGames: 20,
      issues: [],
      remainingObligations: [],
    });
    expect(res.body.completenessReport.byes).toHaveLength(5);
    expect(res.body.completenessReport.byes.every((b: { count: number }) => b.count === 2)).toBe(
      true,
    );
    expect(res.body.fixtureIds).toHaveLength(30);
    expect(res.body.scheduleDraftId).toEqual(expect.any(String));
    expect(res.body.ruleSetId).toBe(season.ruleSetId);
    expect(res.body.searchSettings).toEqual({ maxCandidates: 20, timeLimitMs: 5000, seed: 3 });
    expect(res.body.explanation.candidatesTried).toBeGreaterThan(0);
    runId = res.body.id;
    draftId = res.body.scheduleDraftId;

    const fixtures = await t.db
      .selectFrom('fixtures')
      .select(['id', 'status', 'away_entry_id', 'round', 'scheduling_event_id'])
      .where('division_id', '=', divisionId)
      .execute();
    expect(fixtures).toHaveLength(30);
    expect(
      fixtures.every((f) => f.status === 'unscheduled' && f.scheduling_event_id === null),
    ).toBe(true);
    expect(fixtures.filter((f) => f.away_entry_id === null)).toHaveLength(10);
    expect(new Set(fixtures.map((f) => f.round)).size).toBe(10);
    for (const game of res.body.proposal.games as Array<{ fixtureId: string | null }>) {
      expect(game.fixtureId).toEqual(expect.any(String));
    }

    const drafts = t.app.get(ScheduleDraftsService);
    const draft = await drafts.get(staffPrincipal(t.organizationId, ['scheduler']), draftId);
    expect(draft.status).toBe('editing');
    expect(draft.changes).toHaveLength(20);
    expect(
      draft.changes.every((c) => c.kind === 'create' && c.proposed.sourceType === 'fixture'),
    ).toBe(true);
    // no event holds space yet: suggestions remain drafts (SPK-FIX-005)
    const reservations = await t.db
      .selectFrom('reservations')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .execute();
    expect(reservations).toHaveLength(0);
    const operation = await t.db
      .selectFrom('operations')
      .select(['kind', 'status'])
      .where('id', '=', res.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ kind: 'competition.generate_fixtures', status: 'succeeded' });
    const run = await t.http.get(`/v1/solver-runs/${runId}`).set(leagueManager.header);
    expect(run.status).toBe(200);
    expect(run.body.scheduleDraftId).toBe(draftId);
    // a second run would duplicate the obligations unless it is a dry run
    const again = await post(
      `/fixture-specifications/${specificationId}/generate`,
      leagueManager,
      {},
    );
    expect(again.status).toBe(409);
    const dry = await post(`/fixture-specifications/${specificationId}/generate`, leagueManager, {
      dryRun: true,
    });
    expect(dry.status).toBe(201);
    expect(dry.body.fixtureIds).toEqual([]);
    expect(dry.body.scheduleDraftId).toBeNull();
    expect(dry.body.dryRun).toBe(true);
  });

  it('SPK-FIX-005 / SPK-FIX-002: the scheduler publishes the draft with the normal command; the fixture obligation check reports the remaining unscheduled obligation with owner and deadline; fixtures sync to scheduled', async () => {
    // an extra obligation of the same season that the draft does not cover
    const extra = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: entries[0] as string,
      awayEntryId: entries[1] as string,
      round: 99,
    });
    const drafts = t.app.get(ScheduleDraftsService);
    const schedulerPrincipal = staffPrincipal(t.organizationId, ['scheduler'], {
      personId: scheduler.personId,
    });
    const draft = await drafts.get(schedulerPrincipal, draftId);
    const publication = await drafts.publish(schedulerPrincipal, draftId, {
      expectedRevision: draft.revision,
    });
    expect(publication.eventIds).toHaveLength(20);
    expect(publication.summary.remainingObligations).toEqual([
      {
        code: 'unscheduled_fixtures',
        message: expect.stringContaining('1 fixture(s)'),
        owner: 'league_manager',
        deadline: '2027-01-10T00:00:00.000Z',
      },
    ]);
    const dispatcher = t.app.get(OutboxDispatcher);
    await dispatcher.runOnce(200);
    await dispatcher.runOnce(200);
    const fixtures = await t.db
      .selectFrom('fixtures')
      .select(['id', 'status', 'away_entry_id', 'scheduling_event_id', 'scheduled_start'])
      .where('division_id', '=', divisionId)
      .execute();
    const real = fixtures.filter((f) => f.away_entry_id !== null && f.id !== extra);
    expect(real).toHaveLength(20);
    expect(real.every((f) => f.status === 'scheduled' && f.scheduling_event_id !== null)).toBe(
      true,
    );
    expect(
      fixtures.filter((f) => f.away_entry_id === null).every((f) => f.status === 'unscheduled'),
    ).toBe(true);
    const events = await t.db
      .selectFrom('events')
      .select(['id', 'kind', 'source_type', 'source_id', 'status'])
      .where('facility_id', '=', t.facilityId)
      .where('source_type', '=', 'fixture')
      .execute();
    expect(events).toHaveLength(20);
    expect(events.every((e) => e.kind === 'game' && e.status === 'published')).toBe(true);
    expect(new Set(events.map((e) => e.source_id)).size).toBe(20);
  });

  it('SPK-FIX-002: a published game that names no live fixture fails the publication as a blocking obligation', async () => {
    const drafts = t.app.get(ScheduleDraftsService);
    const schedulerPrincipal = staffPrincipal(t.organizationId, ['scheduler']);
    const ghost = await drafts.create(schedulerPrincipal, {
      facilityId: t.facilityId,
      name: 'Ghost game',
      changes: [
        {
          kind: 'create',
          proposed: {
            kind: 'game',
            title: 'Ghost v Nobody',
            scheduledStart: at('2027-04-24', '09:00'),
            scheduledEnd: at('2027-04-24', '10:00'),
            sourceType: 'fixture',
            sourceId: newId(),
          },
          resourceIds: [pitch.pitchId],
        },
      ],
    });
    await expect(
      drafts.publish(schedulerPrincipal, ghost.id, { expectedRevision: ghost.revision }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        obligations: [expect.objectContaining({ code: 'unknown_fixture', blocking: true })],
      },
    });
  });

  it('SPK-AT-011: conflicting hard fairness preferences give no_proposal_within_limit with the conflict explained; infeasibility and optimality are never claimed falsely; nothing is materialized', async () => {
    const division2 = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Division 2',
    });
    const teams: string[] = [];
    for (const name of ['Foxes', 'Giants', 'Hawks', 'Ibex']) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        teamName: name,
        divisionId: division2,
      });
      teams.push(entry.teamEntryId);
    }
    teams.sort();
    const spec = await post(
      `/divisions/${division2}/fixture-specifications`,
      leagueManager,
      specification({
        name: 'Division 2 with conflicting hard preferences',
        gamesPerTeam: 3,
        opponentFrequency: 1,
        startsOn: '2027-01-16',
        endsOn: '2027-02-13',
        blackouts: [],
        minimumRestMinutes: 0,
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '10:00' },
          { weekday: 6, time: '11:00' },
        ],
        fairnessPreferences: [
          { kind: 'no_consecutive_games', hard: true, weight: 1 },
          ...teams.slice(0, 3).map((teamEntryId) => ({
            kind: 'preferred_availability',
            hard: true,
            weight: 1,
            teamEntryId,
            startTimes: [{ weekday: 6, time: '09:00' }],
          })),
        ],
      }),
    );
    expect(spec.status).toBe(201);
    const run = await post(`/fixture-specifications/${spec.body.id}/generate`, leagueManager, {
      searchSettings: { maxCandidates: 8, timeLimitMs: 5000, seed: 1 },
      dryRun: true,
    });
    expect(run.status).toBe(201);
    expect(run.body.outcome).toBe('no_proposal_within_limit');
    expect(run.body.explanation.candidatesTried).toBe(8);
    expect(run.body.explanation.summary).toMatch(/Infeasibility is not proven/);
    expect(run.body.explanation.summary).toMatch(/preferred availability|could not be placed/);
    expect(run.body.completenessReport.complete).toBe(false);
    expect(run.body.completenessReport.remainingObligations[0]).toMatchObject({
      code: 'unscheduled_games',
      owner: 'league_manager',
      deadline: '2027-01-10T00:00:00.000Z',
    });
    expect(
      run.body.explanation.preferenceScores.map((s: { kind: string; hard: boolean }) => s.hard),
    ).toEqual([true, true, true, true]);
    const fixtures = await t.db
      .selectFrom('fixtures')
      .select('id')
      .where('division_id', '=', division2)
      .execute();
    expect(fixtures).toHaveLength(0);
    // a provable shortage is reported as such, with no proposal
    const short = await post(
      `/divisions/${division2}/fixture-specifications`,
      leagueManager,
      specification({
        name: 'No slots',
        gamesPerTeam: 3,
        opponentFrequency: 1,
        startsOn: '2027-01-18',
        endsOn: '2027-01-22',
        blackouts: [],
      }),
    );
    const infeasible = await post(
      `/fixture-specifications/${short.body.id}/generate`,
      leagueManager,
      {
        dryRun: true,
      },
    );
    expect(infeasible.status).toBe(201);
    expect(infeasible.body.outcome).toBe('proven_infeasible');
    expect(infeasible.body.proposal).toBeNull();
    expect(infeasible.body.explanation.stoppedBy).toBe('proof');
  });
});
