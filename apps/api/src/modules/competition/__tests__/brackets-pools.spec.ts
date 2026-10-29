import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { proposedRuleSetContent } from '../competition.policy';
import {
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import {
  adultCustomer,
  atKickoff,
  competitionTestApp,
  key,
  staffMember,
  type Actor,
} from './support';

interface Team {
  teamEntryId: string;
  captain: Actor;
}

/**
 * Seeding brackets from standings and shootout winners (CMP-10, every competition, not gated) and
 * tournament pools with compressed play (CMP-15, capability `tournaments`: DEC-016, DEC-078).
 */
describe('bracket seeding, shootouts and tournament pools (CMP-10, CMP-15; SPK-COMP-001, SPK-RESULT-005, SPK-FIX-004)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let nextDay = 0;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    const base = proposedRuleSetContent('small_sided_other');
    // A drawn playoff game is decided by a shootout (rule-set configuration, DEC-002).
    season = await createSeasonFixture(t, {
      status: 'active',
      startsOn: '2027-01-10',
      endsOn: '2027-06-30',
      ruleSet: { shootout: { enabled: true, kicks: 5 }, tiebreak: { playoff: 'shootout' } },
    });
    expect(base.shootout.enabled).toBe(false);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  async function teamOf(name: string, divisionId: string, seasonId = season.seasonId) {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId,
    });
    return { teamEntryId: entry.teamEntryId, captain } satisfies Team;
  }

  async function fixture(home: Team, away: Team, divisionId: string): Promise<string> {
    nextDay += 1;
    const date = new Date(Date.UTC(2027, 0, 11 + nextDay)).toISOString().slice(0, 10);
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(date, '18:00'),
        scheduledEnd: at(date, '19:00'),
      },
    });
    expect(res.status).toBe(201);
    return res.body.fixture.id as string;
  }

  async function submit(fixtureId: string, body: object) {
    await atKickoff(t, fixtureId);
    return post(`/fixtures/${fixtureId}/results`, leagueManager, body);
  }

  async function played(fixtureId: string, homeScore: number, awayScore: number) {
    const submitted = await submit(fixtureId, {
      classification: 'completed',
      homeScore,
      awayScore,
    });
    expect(submitted.status).toBe(201);
    const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: submitted.body.revision,
    });
    expect(published.status).toBe(200);
    return published.body;
  }

  async function seededNode(divisionId: string, name: string) {
    const res = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name,
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 2 },
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; revision: number };
  }

  // CMP-10 ---------------------------------------------------------------------------------------
  it('SPK-COMP-001: a league playoff node is seeded from division standings only after every division result is official', async () => {
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'League',
    });
    const a = await teamOf('Aces', divisionId);
    const b = await teamOf('Bolts', divisionId);
    const c = await teamOf('Comets', divisionId);
    const ab = await fixture(a, b, divisionId);
    const bc = await fixture(b, c, divisionId);
    const ac = await fixture(a, c, divisionId);
    await played(ab, 2, 0);
    await played(bc, 1, 0);
    const node = await seededNode(divisionId, 'Final');
    const sources = [
      { divisionId, rank: 1, slot: 'home' },
      { divisionId, rank: 2, slot: 'away' },
    ];
    const early = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources,
      expectedRevision: node.revision,
    });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'STANDINGS_NOT_FINAL', pendingFixtureIds: [ac] },
    });
    await played(ac, 1, 0);
    const byCaptain = await post(`/bracket-nodes/${node.id}/seed-from-standings`, a.captain, {
      sources,
      expectedRevision: node.revision,
    });
    expect(byCaptain.status).toBe(403);
    const missingRank = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources: [{ divisionId, rank: 4, slot: 'home' }],
      expectedRevision: node.revision,
    });
    expect(missingRank.status).toBe(400);
    expect(missingRank.body.details).toMatchObject({ code: 'RANK_NOT_FOUND', rank: 4 });
    const stale = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources,
      expectedRevision: node.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const seeded = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources,
      expectedRevision: node.revision,
      reason: 'League phase complete',
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body).toMatchObject({
      id: node.id,
      homeEntryId: a.teamEntryId,
      awayEntryId: b.teamEntryId,
      homeTeamName: 'Aces',
      awayTeamName: 'Bolts',
      revision: node.revision + 1,
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.bracket_seeded')
      .where('aggregate_id', '=', node.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      bracketNodeId: node.id,
      seasonId: season.seasonId,
      seeds: [
        { slot: 'home', teamEntryId: a.teamEntryId, rank: 1, divisionId, poolId: null },
        { slot: 'away', teamEntryId: b.teamEntryId, rank: 2, divisionId, poolId: null },
      ],
    });
    // a published node is not reseeded; a slot fed by another node is never seeded
    const published = await post(`/bracket-nodes/${node.id}/publish`, leagueManager, {
      expectedRevision: seeded.body.revision,
    });
    expect(published.status).toBe(200);
    const afterPublish = await post(
      `/bracket-nodes/${node.id}/seed-from-standings`,
      leagueManager,
      {
        sources,
        expectedRevision: published.body.revision,
      },
    );
    expect(afterPublish.status).toBe(409);
    const fed = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Super final',
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: node.id },
      away: { kind: 'seed', seed: 3 },
    });
    const notSeeded = await post(
      `/bracket-nodes/${fed.body.id}/seed-from-standings`,
      leagueManager,
      {
        sources: [{ divisionId, rank: 3, slot: 'home' }],
        expectedRevision: fed.body.revision,
      },
    );
    expect(notSeeded.status).toBe(400);
    expect(notSeeded.body.details).toMatchObject({ code: 'SLOT_NOT_SEEDED', slot: 'home' });
  });

  it('CMP-10: an unresolved tie refuses seeding with the tied entries named', async () => {
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Tied' });
    const x = await teamOf('Xylos', divisionId);
    const y = await teamOf('Yetis', divisionId);
    await played(await fixture(x, y, divisionId), 1, 1);
    const node = await seededNode(divisionId, 'Tied final');
    const res = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources: [{ divisionId, rank: 1, slot: 'home' }],
      expectedRevision: node.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: {
        code: 'UNRESOLVED_TIE',
        rank: 1,
        tiedEntryIds: [x.teamEntryId, y.teamEntryId].sort(),
      },
    });
    // nothing was seeded
    const row = await t.db
      .selectFrom('bracket_nodes')
      .select(['home_entry_id', 'revision'])
      .where('id', '=', node.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ home_entry_id: null, revision: node.revision });
  });

  it('CMP-10: a drawn playoff game names a shootout winner only under the rule set shootout tiebreak; publication advances the winner', async () => {
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Cup',
    });
    const home = await teamOf('Hornets', divisionId);
    const away = await teamOf('Ibis', divisionId);
    const other = await teamOf('Jays', divisionId);
    // a league game never names a shootout winner
    const league = await fixture(home, other, divisionId);
    const leagueDraw = await submit(league, {
      classification: 'completed',
      homeScore: 0,
      awayScore: 0,
      shootoutWinnerEntryId: home.teamEntryId,
    });
    expect(leagueDraw.status).toBe(400);
    expect(leagueDraw.body.details).toMatchObject({ code: 'SHOOTOUT_NOT_ALLOWED' });

    const cupTie = await fixture(home, away, divisionId);
    const semi = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Cup semi-final',
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 2 },
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      fixtureId: cupTie,
    });
    expect(semi.status).toBe(201);
    const final = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Cup final',
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: semi.body.id },
      away: { kind: 'seed', seed: 3 },
    });
    expect(final.status).toBe(201);
    // the winner must be one of the sides, and only a draw names one
    const stranger = await submit(cupTie, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 2,
      shootoutWinnerEntryId: other.teamEntryId,
    });
    expect(stranger.status).toBe(400);
    const notDrawn = await submit(cupTie, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      shootoutWinnerEntryId: away.teamEntryId,
    });
    expect(notDrawn.status).toBe(400);
    const drawn = await submit(cupTie, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 2,
      shootoutWinnerEntryId: away.teamEntryId,
    });
    expect(drawn.status).toBe(201);
    expect(drawn.body.shootoutWinnerEntryId).toBe(away.teamEntryId);
    const published = await post(`/results/${drawn.body.id}/publish`, leagueManager, {
      expectedRevision: drawn.body.revision,
    });
    expect(published.status).toBe(200);
    expect(published.body.progressedBracketNodeIds).toEqual(expect.arrayContaining([semi.body.id]));
    const nodes = await t.db
      .selectFrom('bracket_nodes')
      .select(['id', 'winner_entry_id', 'home_entry_id'])
      .where('id', 'in', [semi.body.id, final.body.id])
      .execute();
    expect(nodes.find((n) => n.id === semi.body.id)?.winner_entry_id).toBe(away.teamEntryId);
    expect(nodes.find((n) => n.id === final.body.id)?.home_entry_id).toBe(away.teamEntryId);
  });

  it('CMP-10: without the shootout tiebreak a drawn playoff game names no winner and the bracket waits', async () => {
    const plain = await createSeasonFixture(t, {
      status: 'active',
      startsOn: '2027-01-10',
      endsOn: '2027-06-30',
    });
    const divisionId = await createDivisionFixture(t, { seasonId: plain.seasonId, name: 'Plain' });
    const home = await teamOf('Kestrels', divisionId, plain.seasonId);
    const away = await teamOf('Larks', divisionId, plain.seasonId);
    nextDay += 1;
    const date = new Date(Date.UTC(2027, 0, 11 + nextDay)).toISOString().slice(0, 10);
    const created = await post('/fixtures', leagueManager, {
      seasonId: plain.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(date, '18:00'),
        scheduledEnd: at(date, '19:00'),
      },
    });
    const fixtureId = created.body.fixture.id as string;
    const node = await post(`/seasons/${plain.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Plain final',
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 2 },
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      fixtureId,
    });
    expect(node.status).toBe(201);
    const refused = await submit(fixtureId, {
      classification: 'completed',
      homeScore: 1,
      awayScore: 1,
      shootoutWinnerEntryId: home.teamEntryId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toMatchObject({ code: 'SHOOTOUT_NOT_ALLOWED' });
    const draw = await submit(fixtureId, {
      classification: 'completed',
      homeScore: 1,
      awayScore: 1,
    });
    expect(draw.status).toBe(201);
    const published = await post(`/results/${draw.body.id}/publish`, leagueManager, {
      expectedRevision: draw.body.revision,
    });
    expect(published.status).toBe(200);
    expect(published.body.progressedBracketNodeIds).toEqual([]);
    const row = await t.db
      .selectFrom('bracket_nodes')
      .select('winner_entry_id')
      .where('id', '=', node.body.id)
      .executeTakeFirstOrThrow();
    expect(row.winner_entry_id).toBeNull();
  });

  // CMP-15 ---------------------------------------------------------------------------------------
  it('CMP-15: pool commands are refused while the tournaments capability is off (DEC-016, DEC-078); removing an entry and reads stay open', async () => {
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Tournament',
    });
    const other = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Other' });
    const p = await teamOf('Pumas', divisionId);
    const q = await teamOf('Quails', divisionId);
    const outsider = await teamOf('Rooks', other);
    await t.disableCapability('tournaments');
    const off = await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool A' });
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({
      code: 'ACCESS_DENIED',
      details: {
        code: 'CAPABILITY_DISABLED',
        capability: 'tournaments',
        applicabilityReferences: expect.arrayContaining(['DEC-016']),
      },
    });
    await t.enableCapability('tournaments');
    const byCaptain = await post(`/divisions/${divisionId}/pools`, p.captain, { name: 'Pool A' });
    expect(byCaptain.status).toBe(403);
    const pool = await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool A' });
    expect(pool.status).toBe(201);
    expect(pool.body).toMatchObject({
      seasonId: season.seasonId,
      divisionId,
      name: 'Pool A',
      entries: [],
      revision: 1,
    });
    expect(
      (await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool A' })).status,
    ).toBe(409);
    const poolB = await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool B' });
    const added = await post(`/pools/${pool.body.id}/entries`, leagueManager, {
      teamEntryId: q.teamEntryId,
      seed: 2,
      expectedRevision: 1,
    });
    expect(added.status).toBe(200);
    const both = await post(`/pools/${pool.body.id}/entries`, leagueManager, {
      teamEntryId: p.teamEntryId,
      seed: 1,
      expectedRevision: 2,
    });
    expect(both.body).toMatchObject({
      revision: 3,
      entries: [
        { teamEntryId: p.teamEntryId, teamName: 'Pumas', seed: 1 },
        { teamEntryId: q.teamEntryId, teamName: 'Quails', seed: 2 },
      ],
    });
    const stale = await post(`/pools/${pool.body.id}/entries`, leagueManager, {
      teamEntryId: p.teamEntryId,
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const twice = await post(`/pools/${poolB.body.id}/entries`, leagueManager, {
      teamEntryId: p.teamEntryId,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.details).toMatchObject({ code: 'ENTRY_ALREADY_POOLED' });
    const foreign = await post(`/pools/${poolB.body.id}/entries`, leagueManager, {
      teamEntryId: outsider.teamEntryId,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.details).toMatchObject({ code: 'ENTRY_OUTSIDE_POOL_DIVISION' });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.pool_changed')
      .where('aggregate_id', '=', pool.body.id)
      .execute();
    expect(event.map((e) => (e.payload as { change: string }).change)).toEqual([
      'created',
      'entry_added',
      'entry_added',
    ]);

    // switched off again: no new placement, but unwinding and reads go on
    await t.disableCapability('tournaments');
    const blocked = await post(`/pools/${poolB.body.id}/entries`, leagueManager, {
      teamEntryId: q.teamEntryId,
    });
    expect(blocked.status).toBe(403);
    const removed = await post(
      `/pools/${pool.body.id}/entries/${q.teamEntryId}/remove`,
      leagueManager,
      { reason: 'Withdrew from the tournament', expectedRevision: 3 },
    );
    expect(removed.status).toBe(200);
    expect(removed.body.entries.map((e: { teamEntryId: string }) => e.teamEntryId)).toEqual([
      p.teamEntryId,
    ]);
    const read = await get(`/pools/${pool.body.id}`, leagueManager);
    expect(read.status).toBe(200);
    expect(read.body.revision).toBe(4);
    expect((await get(`/pools/${pool.body.id}/standings`, leagueManager)).status).toBe(200);
    await t.enableCapability('tournaments');
  });

  it('SPK-COMP-001: pool standings seed a bracket only after every pool result is official', async () => {
    await t.enableCapability('tournaments');
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Pools',
    });
    const [s1, s2, t1, t2] = [
      await teamOf('Sparks', divisionId),
      await teamOf('Storms', divisionId),
      await teamOf('Tides', divisionId),
      await teamOf('Torrents', divisionId),
    ] as [Team, Team, Team, Team];
    const pool1 = (await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool 1' }))
      .body;
    const pool2 = (await post(`/divisions/${divisionId}/pools`, leagueManager, { name: 'Pool 2' }))
      .body;
    let r1 = pool1.revision as number;
    for (const team of [s1, s2]) {
      r1 = (
        await post(`/pools/${pool1.id}/entries`, leagueManager, {
          teamEntryId: team.teamEntryId,
          expectedRevision: r1,
        })
      ).body.revision;
    }
    let r2 = pool2.revision as number;
    for (const team of [t1, t2]) {
      r2 = (
        await post(`/pools/${pool2.id}/entries`, leagueManager, {
          teamEntryId: team.teamEntryId,
          expectedRevision: r2,
        })
      ).body.revision;
    }
    const inPool1 = await fixture(s1, s2, divisionId);
    const inPool2 = await fixture(t1, t2, divisionId);
    await played(inPool1, 2, 0);
    const standings1 = await get(`/pools/${pool1.id}/standings`, leagueManager);
    expect(standings1.status).toBe(200);
    expect(standings1.body).toMatchObject({ poolId: pool1.id, pendingFixtureIds: [] });
    expect(standings1.body.rows.map((r: { teamEntryId: string }) => r.teamEntryId)).toEqual([
      s1.teamEntryId,
      s2.teamEntryId,
    ]);
    const standings2 = await get(`/pools/${pool2.id}/standings`, leagueManager);
    expect(standings2.body.pendingFixtureIds).toEqual([inPool2]);

    const node = await seededNode(divisionId, 'Pool final');
    const sources = [
      { poolId: pool1.id, rank: 1, slot: 'home' },
      { poolId: pool2.id, rank: 1, slot: 'away' },
    ];
    const early = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources,
      expectedRevision: node.revision,
    });
    expect(early.status).toBe(409);
    expect(early.body.details).toMatchObject({
      code: 'STANDINGS_NOT_FINAL',
      pendingFixtureIds: [inPool2],
    });
    await played(inPool2, 1, 3);
    // seeding from existing pools is never gated by the capability
    await t.disableCapability('tournaments');
    const seeded = await post(`/bracket-nodes/${node.id}/seed-from-standings`, leagueManager, {
      sources,
      expectedRevision: node.revision,
    });
    expect(seeded.status).toBe(200);
    expect(seeded.body).toMatchObject({
      homeEntryId: s1.teamEntryId,
      awayEntryId: t2.teamEntryId,
      homeTeamName: 'Sparks',
      awayTeamName: 'Torrents',
    });
    await t.enableCapability('tournaments');
  });

  it('SPK-FIX-004: with max games per day set, generated games respect it and report official demand', async () => {
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Compressed',
    });
    const teams = [
      await teamOf('Umbra', divisionId),
      await teamOf('Vega', divisionId),
      await teamOf('Wren', divisionId),
      await teamOf('Yarrow', divisionId),
    ];
    const created = await post(`/divisions/${divisionId}/fixture-specifications`, leagueManager, {
      name: 'Compressed weekend',
      facilityId: t.facilityId,
      gamesPerTeam: 3,
      opponentFrequency: 1,
      startsOn: '2027-05-01',
      endsOn: '2027-05-09',
      minimumRestMinutes: 60,
      allowedStartTimes: [
        { weekday: 6, time: '09:00' },
        { weekday: 6, time: '10:00' },
        { weekday: 6, time: '11:00' },
        { weekday: 6, time: '12:00' },
        { weekday: 6, time: '13:00' },
        { weekday: 6, time: '14:00' },
      ],
      matchDurationMinutes: 50,
      requiredResourceIds: [pitch.pitchId],
      maxGamesPerTeamPerDay: 2,
      officialsPerGame: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ maxGamesPerTeamPerDay: 2, officialsPerGame: 2 });
    const run = await post(`/fixture-specifications/${created.body.id}/generate`, leagueManager, {
      searchSettings: { maxCandidates: 10, timeLimitMs: 5000, seed: 7 },
    });
    expect(run.status).toBe(201);
    expect(['feasible', 'proven_optimal']).toContain(run.body.outcome);
    const games = (
      run.body.proposal.games as Array<{
        homeEntryId: string;
        awayEntryId: string | null;
        scheduledStart: string | null;
      }>
    ).filter((g) => g.awayEntryId !== null && g.scheduledStart !== null);
    expect(games).toHaveLength(6);
    const localDay = (instant: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(instant));
    const perTeamDay = new Map<string, number>();
    const perDay = new Map<string, number>();
    for (const game of games) {
      const date = localDay(game.scheduledStart as string);
      perDay.set(date, (perDay.get(date) ?? 0) + 1);
      for (const entry of [game.homeEntryId, game.awayEntryId as string]) {
        const k = `${entry}:${date}`;
        perTeamDay.set(k, (perTeamDay.get(k) ?? 0) + 1);
      }
    }
    expect(Math.max(...perTeamDay.values())).toBeLessThanOrEqual(2);
    expect(
      teams.every((team) => [...perTeamDay.keys()].some((k) => k.startsWith(team.teamEntryId))),
    ).toBe(true);
    // the per-day report: games, the most running at once (one pitch) and the officials they need
    const demand = run.body.explanation.dailyDemand as Array<{
      date: string;
      games: number;
      peakConcurrentGames: number;
      officialAssignments: number | null;
      peakConcurrentOfficials: number | null;
    }>;
    expect(demand.map((d) => d.date).sort()).toEqual([...perDay.keys()].sort());
    for (const day of demand) {
      expect(day).toEqual({
        date: day.date,
        games: perDay.get(day.date),
        peakConcurrentGames: 1,
        officialAssignments: (perDay.get(day.date) ?? 0) * 2,
        peakConcurrentOfficials: 2,
      });
    }
  });
});
