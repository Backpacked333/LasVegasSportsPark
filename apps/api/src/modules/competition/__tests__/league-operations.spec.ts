import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import {
  addRosterMemberFixture,
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
  player: Actor;
}

/**
 * League operations of stage 3: the staff lists (CMP-05) and the results, discipline, standings
 * and specification follow-ups (CMP-12).
 */
describe('league operations (CMP-05, CMP-12; SPK-RESULT-001..005, SPK-DISC-001..005, SPK-FIX-001)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let a: Team;
  let b: Team;
  let c: Team;
  let day = 0;

  async function teamOf(name: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const player = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId,
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    return { teamEntryId: entry.teamEntryId, captain, player };
  }

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
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
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Premier' });
    a = await teamOf('Aces');
    b = await teamOf('Bolts');
    c = await teamOf('Comets');
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const patch = (path: string, actor: Actor, body: object) =>
    t.http.patch(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  async function fixture(home: Team, away: Team): Promise<string> {
    day += 1;
    const date = new Date(Date.UTC(2027, 0, 9 + day * 7)).toISOString().slice(0, 10);
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

  async function played(fixtureId: string, body: object) {
    await atKickoff(t, fixtureId);
    const submitted = await post(`/fixtures/${fixtureId}/results`, leagueManager, body);
    expect(submitted.status).toBe(201);
    const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: submitted.body.revision,
    });
    expect(published.status).toBe(200);
    return published.body as {
      revision: { id: string };
      proposedSuspensionIds: string[];
    };
  }

  // CMP-12 (1) ------------------------------------------------------------------------------------
  it('CMP-12: a result before kickoff is refused; a forfeit before kickoff is recorded', async () => {
    const early = await fixture(a, c);
    const played = await post(`/fixtures/${early}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 1,
      awayScore: 0,
    });
    expect(played.status).toBe(409);
    expect(played.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: {
        code: 'FIXTURE_NOT_STARTED',
        fixtureId: early,
        classification: 'completed',
      },
    });
    const forfeit = await post(`/fixtures/${early}/results`, leagueManager, {
      classification: 'forfeit',
      homeScore: 3,
      awayScore: 0,
      forfeitingEntryId: c.teamEntryId,
    });
    expect(forfeit.status).toBe(201);
    expect(forfeit.body).toMatchObject({ classification: 'forfeit', status: 'submitted' });
    const published = await post(`/results/${forfeit.body.id}/publish`, leagueManager, {
      expectedRevision: forfeit.body.revision,
    });
    expect(published.status).toBe(200);
  });

  // CMP-12 (2) ------------------------------------------------------------------------------------
  let carded: string;

  it('SPK-DISC-001: a correction that removes a card overturns its proposed suspension; an active one raises a league-manager exception', async () => {
    carded = await fixture(a, b);
    const cards = [
      { personId: a.player.personId, teamEntryId: a.teamEntryId, kind: 'red', minute: 20 },
      { personId: b.player.personId, teamEntryId: b.teamEntryId, kind: 'red', minute: 30 },
    ];
    const first = await played(carded, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      cards,
    });
    expect(first.proposedSuspensionIds).toHaveLength(2);
    const suspensions = await t.db
      .selectFrom('suspensions')
      .select(['id', 'subject_person_id', 'status', 'revision'])
      .where('source_fixture_id', '=', carded)
      .execute();
    const ofA = suspensions.find((s) => s.subject_person_id === a.player.personId);
    const ofB = suspensions.find((s) => s.subject_person_id === b.player.personId);
    expect(ofA?.status).toBe('proposed');
    // the league manager approves B's suspension: it is active from now on
    const approved = await patch(`/suspensions/${ofB?.id}`, leagueManager, {
      action: 'approve',
      expectedRevision: ofB?.revision,
    });
    expect(approved.body.status).toBe('active');

    // the correction removes both red cards
    const correction = await post(`/fixtures/${carded}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      reason: 'The referee report names no sending-off.',
    });
    expect(correction.status).toBe(201);
    const published = await post(`/results/${correction.body.id}/publish`, leagueManager, {
      expectedRevision: correction.body.revision,
    });
    expect(published.status).toBe(200);
    const after = await t.db
      .selectFrom('suspensions')
      .select(['id', 'status', 'overturn_reason'])
      .where('source_fixture_id', '=', carded)
      .execute();
    expect(after.find((s) => s.id === ofA?.id)).toMatchObject({
      status: 'overturned',
      overturn_reason: 'card removed by correction',
    });
    // an active suspension is never lifted silently
    expect(after.find((s) => s.id === ofB?.id)).toMatchObject({ status: 'active' });
    const raised = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'competition.suspension_card_removed')
      .execute();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      affected_id: ofB?.id,
      owner_queue: 'league_manager',
      status: 'open',
    });
    // a further correction keeps the one exception (raised once per suspension)
    const again = await post(`/fixtures/${carded}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 3,
      awayScore: 1,
      reason: 'A late goal was missed.',
    });
    await post(`/results/${again.body.id}/publish`, leagueManager, {
      expectedRevision: again.body.revision,
    });
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('category', '=', 'competition.suspension_card_removed')
        .execute(),
    ).toHaveLength(1);
  });

  // CMP-12 (3) and CMP-05 disputes -----------------------------------------------------------------
  let withdrawnId: string;
  let openDisputeId: string;

  it("CMP-12: a captain withdraws the entry's dispute; another captain gets NOT_FOUND", async () => {
    const dispute = await post(`/fixtures/${carded}/disputes`, b.captain, {
      teamEntryId: b.teamEntryId,
      reason: 'The winning goal was offside.',
    });
    expect(dispute.status).toBe(201);
    withdrawnId = dispute.body.id;
    const byOpponent = await post(`/disputes/${withdrawnId}/withdraw`, a.captain, {
      reason: 'not ours',
      expectedRevision: dispute.body.revision,
    });
    expect(byOpponent.status).toBe(404);
    const byOutsider = await post(`/disputes/${withdrawnId}/withdraw`, c.captain, {
      reason: 'not ours',
      expectedRevision: dispute.body.revision,
    });
    expect(byOutsider.status).toBe(404);
    const byPlayer = await post(`/disputes/${withdrawnId}/withdraw`, b.player, {
      reason: 'not mine',
      expectedRevision: dispute.body.revision,
    });
    expect(byPlayer.status).toBe(404);
    const stale = await post(`/disputes/${withdrawnId}/withdraw`, b.captain, {
      reason: 'We accept the result.',
      expectedRevision: dispute.body.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const withdrawn = await post(`/disputes/${withdrawnId}/withdraw`, b.captain, {
      reason: 'We accept the result.',
      expectedRevision: dispute.body.revision,
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn' });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', withdrawnId)
      .where('action', '=', 'competition.withdraw_dispute')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('We accept the result.');
    // a withdrawn dispute cannot be withdrawn again
    const twice = await post(`/disputes/${withdrawnId}/withdraw`, b.captain, {
      reason: 'again',
      expectedRevision: withdrawn.body.revision,
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_TRANSITION');
  });

  it('SPK-RESULT-004: disputes list by season and status (CMP-05, newest first, keyset cursor)', async () => {
    t.clock.advance(60_000);
    const open = await post(`/fixtures/${carded}/disputes`, a.captain, {
      teamEntryId: a.teamEntryId,
      reason: 'A goal of ours was not counted.',
    });
    expect(open.status).toBe(201);
    openDisputeId = open.body.id;
    const all = await get(`/disputes?seasonId=${season.seasonId}`, leagueManager);
    expect(all.status).toBe(200);
    expect(all.body.items.map((d: { id: string }) => d.id)).toEqual([openDisputeId, withdrawnId]);
    expect(all.body.nextCursor).toBeNull();
    const submitted = await get(
      `/disputes?seasonId=${season.seasonId}&status=submitted`,
      leagueManager,
    );
    expect(submitted.body.items.map((d: { id: string }) => d.id)).toEqual([openDisputeId]);
    const withdrawn = await get(`/disputes?status=withdrawn`, leagueManager);
    expect(withdrawn.body.items.map((d: { id: string }) => d.id)).toEqual([withdrawnId]);
    // rows carry the same view as the single read
    const single = await get(`/disputes/${openDisputeId}`, leagueManager);
    expect(submitted.body.items[0]).toEqual(single.body);
    // keyset paging
    const first = await get(`/disputes?seasonId=${season.seasonId}&limit=1`, leagueManager);
    expect(first.body.items.map((d: { id: string }) => d.id)).toEqual([openDisputeId]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(
      `/disputes?seasonId=${season.seasonId}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      leagueManager,
    );
    expect(second.body.items.map((d: { id: string }) => d.id)).toEqual([withdrawnId]);
    expect(second.body.nextCursor).toBeNull();
    // another season lists none; the list is staff-only
    const other = await createSeasonFixture(t, { status: 'active' });
    expect((await get(`/disputes?seasonId=${other.seasonId}`, leagueManager)).body.items).toEqual(
      [],
    );
    expect((await get('/disputes', a.captain)).status).toBe(403);
    expect((await get('/disputes', frontDesk)).status).toBe(403);
    expect((await get('/disputes?cursor=not-a-cursor', leagueManager)).status).toBe(400);
  });

  it('SPK-DISC-005: appeals list by status; decisions list by person, competition and status (CMP-05)', async () => {
    const decision = await post('/disciplinary-decisions', leagueManager, {
      subjectPersonId: c.player.personId,
      basis: 'violent conduct',
      decision: 'suspension',
      suspension: {
        scope: 'competitions',
        competitionIds: [season.competitionId],
        matchCount: 1,
        completionCriteria: 'one match served',
      },
    });
    expect(decision.status).toBe(201);
    const appeal = await post('/appeals', c.player, {
      decisionId: decision.body.id,
      grounds: 'Self-defence.',
    });
    expect(appeal.status).toBe(201);
    const pending = await get('/appeals?status=submitted', leagueManager);
    expect(pending.status).toBe(200);
    expect(pending.body.items.map((x: { id: string }) => x.id)).toEqual([appeal.body.id]);
    expect(pending.body.items[0]).toEqual(
      (await get(`/appeals/${appeal.body.id}`, leagueManager)).body,
    );
    expect(
      (await get(`/appeals?decisionId=${decision.body.id}`, leagueManager)).body.items,
    ).toHaveLength(1);
    expect((await get('/appeals?status=granted', leagueManager)).body.items).toEqual([]);
    expect((await get('/appeals', c.player)).status).toBe(403);

    const byPerson = await get(
      `/disciplinary-decisions?personId=${c.player.personId}`,
      leagueManager,
    );
    expect(byPerson.status).toBe(200);
    expect(byPerson.body.items.map((d: { id: string }) => d.id)).toEqual([decision.body.id]);
    expect(byPerson.body.items[0]).toEqual(
      (await get(`/disciplinary-decisions/${decision.body.id}`, leagueManager)).body,
    );
    const byCompetition = await get(
      `/disciplinary-decisions?competitionId=${season.competitionId}&status=${decision.body.status}`,
      leagueManager,
    );
    expect(byCompetition.body.items.map((d: { id: string }) => d.id)).toContain(decision.body.id);
    const elsewhere = await createSeasonFixture(t, { status: 'active' });
    expect(
      (await get(`/disciplinary-decisions?competitionId=${elsewhere.competitionId}`, leagueManager))
        .body.items,
    ).toEqual([]);
    expect((await get('/disciplinary-decisions', a.captain)).status).toBe(403);
  });

  it('CMP-05: result revisions of a season list newest first by status', async () => {
    const all = await get(`/seasons/${season.seasonId}/result-revisions`, leagueManager);
    expect(all.status).toBe(200);
    const statuses = (all.body.items as Array<{ status: string }>).map((r) => r.status);
    expect(statuses).toContain('official');
    expect(statuses).toContain('superseded');
    const official = await get(
      `/seasons/${season.seasonId}/result-revisions?status=official`,
      leagueManager,
    );
    expect(
      (official.body.items as Array<{ status: string }>).every((r) => r.status === 'official'),
    ).toBe(true);
    // one official revision per fixture (§4.7 invariant 8)
    const fixtures = (official.body.items as Array<{ fixtureId: string }>).map((r) => r.fixtureId);
    expect(new Set(fixtures).size).toBe(fixtures.length);
    const paged = await get(`/seasons/${season.seasonId}/result-revisions?limit=2`, leagueManager);
    expect(paged.body.items).toHaveLength(2);
    expect(paged.body.items).toEqual(all.body.items.slice(0, 2));
    expect((await get(`/seasons/${season.seasonId}/result-revisions`, a.captain)).status).toBe(403);
  });

  // CMP-12 (4) ------------------------------------------------------------------------------------
  it('CMP-12: standings without divisionId on a divided season name the divisions', async () => {
    const res = await get(`/seasons/${season.seasonId}/standings`, leagueManager);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'DIVISION_REQUIRED', divisionIds: [divisionId] },
    });
    const division = await get(
      `/seasons/${season.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(division.status).toBe(200);
    expect(division.body.divisionId).toBe(divisionId);
    // an undivided season keeps its single table
    const undivided = await createSeasonFixture(t, { status: 'active' });
    expect((await get(`/seasons/${undivided.seasonId}/standings`, leagueManager)).status).toBe(200);
  });

  // CMP-12 (5) and CMP-05 specification lists -----------------------------------------------------
  it('CMP-12 / CMP-05: a specification changes until a generation from it sits in an open schedule draft; specifications and solver runs list for staff', async () => {
    // a division without fixtures yet (generation never overwrites existing fixtures)
    const springDivision = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Spring',
    });
    for (const name of ['Darts', 'Embers', 'Flares']) {
      await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: (await adultCustomer(t)).personId,
        teamName: name,
        divisionId: springDivision,
      });
    }
    const created = await post(
      `/divisions/${springDivision}/fixture-specifications`,
      leagueManager,
      {
        name: 'Spring phase',
        facilityId: t.facilityId,
        gamesPerTeam: 2,
        opponentFrequency: 1,
        startsOn: '2027-03-06',
        endsOn: '2027-04-24',
        minimumRestMinutes: 60,
        allowedStartTimes: [
          { weekday: 6, time: '09:00' },
          { weekday: 6, time: '11:00' },
        ],
        matchDurationMinutes: 60,
        requiredResourceIds: [pitch.pitchId],
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const listed = await get(`/divisions/${springDivision}/fixture-specifications`, leagueManager);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((s: { id: string }) => s.id)).toEqual([id]);
    expect(
      (await get(`/divisions/${springDivision}/fixture-specifications`, a.captain)).status,
    ).toBe(403);

    const stale = await patch(`/fixture-specifications/${id}`, leagueManager, {
      name: 'Spring phase (renamed)',
      expectedRevision: created.body.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const byCaptain = await patch(`/fixture-specifications/${id}`, a.captain, {
      name: 'Mine now',
      expectedRevision: created.body.revision,
    });
    expect(byCaptain.status).toBe(403);
    const changed = await patch(`/fixture-specifications/${id}`, leagueManager, {
      name: 'Spring phase (renamed)',
      minimumRestMinutes: 90,
      maxGamesPerTeamPerDay: 1,
      expectedRevision: created.body.revision,
      reason: 'One game per Saturday',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      name: 'Spring phase (renamed)',
      minimumRestMinutes: 90,
      maxGamesPerTeamPerDay: 1,
      gamesPerTeam: 2,
      revision: created.body.revision + 1,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', id)
      .where('reason', '=', 'One game per Saturday')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      operation: 'update',
      changedFields: ['maxGamesPerTeamPerDay', 'minimumRestMinutes', 'name'],
    });

    const run = await post(`/fixture-specifications/${id}/generate`, leagueManager, {
      searchSettings: { maxCandidates: 5, timeLimitMs: 3000, seed: 1 },
    });
    expect(run.status).toBe(201);
    const runs = await get(`/fixture-specifications/${id}/solver-runs`, leagueManager);
    expect(runs.status).toBe(200);
    expect(runs.body.items.map((r: { id: string }) => r.id)).toEqual([run.body.id]);
    expect((await get(`/fixture-specifications/${id}/solver-runs`, a.captain)).status).toBe(403);
    expect(run.body.scheduleDraftId).toEqual(expect.any(String));
    const inUse = await patch(`/fixture-specifications/${id}`, leagueManager, {
      gamesPerTeam: 4,
      expectedRevision: changed.body.revision,
    });
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { code: 'SPECIFICATION_IN_USE', scheduleDraftId: run.body.scheduleDraftId },
    });
  });
});
