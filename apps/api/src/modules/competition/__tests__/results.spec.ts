import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { seedOrganization } from '@sportspark/db';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { ASSIGNMENT_CHECK_IMPL, type AssignmentCheckPort } from '../competition-matches.ports';
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

describe('results, standings and brackets (SPK-RESULT-001..004, SPK-STAFF-005, §4.7 invariants 8 and 9, SPK-AT-014)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let generalManager: Actor;
  let official: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let a: Team;
  let b: Team;
  let c: Team;
  let d: Team;
  const accepted = new Set<string>();
  const assignments: AssignmentCheckPort = {
    isAcceptedOfficial: async (_organizationId, fixtureId, personId) =>
      accepted.has(`${fixtureId}:${personId}`),
  };

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
    t = await competitionTestApp({
      providers: [{ provide: ASSIGNMENT_CHECK_IMPL, useValue: assignments }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    generalManager = await staffMember(t, ['general_manager']);
    official = await staffMember(t, ['official']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, { status: 'active' });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Premier' });
    a = await teamOf('Aces');
    b = await teamOf('Bolts');
    c = await teamOf('Comets');
    d = await teamOf('Dynamos');
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  async function scheduleFixture(home: Team, away: Team, date: string, from: string, to: string) {
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(date, from),
        scheduledEnd: at(date, to),
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.fixture.status).toBe('scheduled');
    return res.body.fixture.id as string;
  }

  let f1: string;
  let f1Official: string;

  it('SPK-STAFF-005 / SPK-RESULT-001: an accepted official submits a result (draft → submitted); an unassigned official cannot; the command is idempotent and one revision is open at a time', async () => {
    f1 = await scheduleFixture(a, b, '2027-01-16', '18:00', '19:00');
    const body = {
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      cards: [
        { personId: b.player.personId, teamEntryId: b.teamEntryId, kind: 'yellow', minute: 40 },
      ],
      incidents: [
        {
          kind: 'misconduct',
          subjectPersonId: b.player.personId,
          teamEntryId: b.teamEntryId,
          severity: 'medium',
          summary: 'Dissent after the yellow card',
          narrative: 'Restricted narrative that must never reach team views.',
        },
      ],
    };
    await atKickoff(t, f1);
    const unassigned = await post(`/fixtures/${f1}/results`, official, body);
    expect(unassigned.status).toBe(403);
    const byCaptain = await post(`/fixtures/${f1}/results`, a.captain, body);
    expect(byCaptain.status).toBe(403);

    accepted.add(`${f1}:${official.personId}`);
    const k = key();
    const res = await post(`/fixtures/${f1}/results`, official, body, k);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fixtureId: f1,
      revisionNo: 1,
      status: 'submitted',
      classification: 'completed',
      homeScore: 2,
      awayScore: 1,
      publishedAt: null,
      supersedesRevisionId: null,
    });
    expect(res.body.details.cards).toHaveLength(1);
    expect(res.body.details.incidentIds).toHaveLength(1);
    expect(res.body.submittedBy.personId).toBe(official.personId);
    const incident = await t.db
      .selectFrom('incidents')
      .selectAll()
      .where('id', '=', res.body.details.incidentIds[0])
      .executeTakeFirstOrThrow();
    expect(incident).toMatchObject({
      kind: 'misconduct',
      fixture_id: f1,
      result_revision_id: res.body.id,
      status: 'open',
    });

    // §4.9 idempotency: same key and payload replays the stored response
    const replay = await post(`/fixtures/${f1}/results`, official, body, k);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(res.body.id);
    // the database allows one open revision per fixture
    const second = await post(`/fixtures/${f1}/results`, leagueManager, body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('RESOURCE_CONFLICT');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', res.body.id)
      .execute();
    expect(audit.map((r) => r.action)).toContain('competition.submit_result');
  });

  it('§4.7 invariant 8 / SPK-AT-014 authority: officials and managers outside the approval roles cannot publish; the league manager publishes, standings recompute and the fixture is played', async () => {
    const [revision] = (await get(`/fixtures/${f1}/results`, leagueManager)).body as Array<{
      id: string;
      revision: number;
    }>;
    expect(revision).toBeDefined();
    const byOfficial = await post(`/results/${revision?.id}/publish`, official, {
      expectedRevision: revision?.revision,
    });
    expect(byOfficial.status).toBe(403);
    // the proposed default approveRoles are ['league_manager'] (DEC-065)
    const byGeneralManager = await post(`/results/${revision?.id}/publish`, generalManager, {
      expectedRevision: revision?.revision,
    });
    expect(byGeneralManager.status).toBe(403);
    const stillSubmitted = await t.db
      .selectFrom('result_revisions')
      .select('status')
      .where('id', '=', revision?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(stillSubmitted.status).toBe('submitted');

    const published = await post(`/results/${revision?.id}/publish`, leagueManager, {
      expectedRevision: revision?.revision,
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      published: true,
      supersededRevisionId: null,
      reviewExceptionId: null,
      revision: { status: 'official', revision: 2 },
    });
    expect(published.body.revision.publishedAt).not.toBeNull();
    expect(published.body.revision.publishedBy.personId).toBe(leagueManager.personId);
    f1Official = published.body.revision.id;
    expect(published.body.standings.rows[0]).toMatchObject({
      position: 1,
      teamEntryId: a.teamEntryId,
      played: 1,
      won: 1,
      points: season.ruleSet.scoring.win,
      goalsFor: 2,
      goalsAgainst: 1,
    });
    expect(published.body.standings.sourceResultIds).toEqual([f1Official]);
    const fixture = await t.db
      .selectFrom('fixtures')
      .select('status')
      .where('id', '=', f1)
      .executeTakeFirstOrThrow();
    expect(fixture.status).toBe('played');
    const operation = await t.db
      .selectFrom('operations')
      .select(['kind', 'status'])
      .where('id', '=', published.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toEqual({ kind: 'competition.publish_result', status: 'succeeded' });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', f1Official)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['competition.result_submitted', 'competition.result_published']),
    );
    // §4.9 stale revision: the publish command with the loaded revision fails rather than overwriting
    const stale = await post(`/results/${f1Official}/publish`, leagueManager, {
      expectedRevision: revision?.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const again = await post(`/results/${f1Official}/publish`, leagueManager, {
      expectedRevision: 2,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
  });

  it('every Result transition: return for correction (submitted → draft), resubmit (draft → submitted), publish; SPK-RESULT-003 standings explain the tiebreak', async () => {
    const f2 = await scheduleFixture(a, c, '2027-01-23', '18:00', '19:00');
    await atKickoff(t, f2);
    const submitted = await post(`/fixtures/${f2}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 3,
      awayScore: 1,
    });
    expect(submitted.status).toBe(201);
    const returned = await post(`/results/${submitted.body.id}/return`, leagueManager, {
      expectedRevision: submitted.body.revision,
      reason: 'The away team reported a different score.',
    });
    expect(returned.status).toBe(200);
    expect(returned.body).toMatchObject({ status: 'draft', returnReason: expect.any(String) });
    expect(returned.body.returnedAt).not.toBeNull();
    const publishDraft = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: returned.body.revision,
    });
    expect(publishDraft.status).toBe(409);
    expect(publishDraft.body.code).toBe('INVALID_TRANSITION');
    const resubmitted = await post(`/results/${submitted.body.id}/submit`, leagueManager, {
      expectedRevision: returned.body.revision,
      classification: 'completed',
      homeScore: 1,
      awayScore: 1,
    });
    expect(resubmitted.status).toBe(200);
    expect(resubmitted.body).toMatchObject({ status: 'submitted', homeScore: 1, awayScore: 1 });
    const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: resubmitted.body.revision,
    });
    expect(published.status).toBe(200);
    expect(published.body.published).toBe(true);

    const standings = await get(
      `/seasons/${season.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(standings.status).toBe(200);
    expect(
      standings.body.rows.map((r: { teamEntryId: string; points: number }) => [
        r.teamEntryId,
        r.points,
      ]),
    ).toEqual([
      [a.teamEntryId, 4],
      [c.teamEntryId, 1],
      [d.teamEntryId, 0],
      [b.teamEntryId, 0],
    ]);
    expect(standings.body.ruleSetId).toBe(season.ruleSetId);
    expect(standings.body.sourceResultIds).toHaveLength(2);
    // Bolts and Dynamos are level on 0 points: no head-to-head game, goal difference separates them
    const tie = standings.body.tiebreakExplanations.find(
      (e: { points: number }) => e.points === 0,
    ) as { resolved: boolean; steps: Array<{ tiebreaker: string; outcome: string }> };
    expect(tie.resolved).toBe(true);
    expect(tie.steps.map((s) => [s.tiebreaker, s.outcome])).toEqual([
      ['points', 'not_separating'],
      ['head_to_head', 'not_separating'],
      ['goal_difference', 'resolved'],
    ]);
    // customers read the official table as well
    const asCaptain = await get(
      `/seasons/${season.seasonId}/standings?divisionId=${divisionId}`,
      a.captain,
    );
    expect(asCaptain.status).toBe(200);
  });

  it('SPK-RESULT-004: a correction is a new revision that supersedes the official one, keeping actor, reason and publication time; the database refuses any rewrite (invariant 9)', async () => {
    const withoutReason = await post(`/fixtures/${f1}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 2,
    });
    expect(withoutReason.status).toBe(400);
    const before = await t.db
      .selectFrom('result_revisions')
      .selectAll()
      .where('id', '=', f1Official)
      .executeTakeFirstOrThrow();
    const correction = await post(`/fixtures/${f1}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 2,
      awayScore: 2,
      reason: 'Late equaliser omitted from the match card.',
    });
    expect(correction.status).toBe(201);
    expect(correction.body).toMatchObject({
      revisionNo: 2,
      status: 'submitted',
      supersedesRevisionId: f1Official,
      reason: 'Late equaliser omitted from the match card.',
    });
    const published = await post(`/results/${correction.body.id}/publish`, leagueManager, {
      expectedRevision: correction.body.revision,
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      published: true,
      supersededRevisionId: f1Official,
      revision: { status: 'official', homeScore: 2, awayScore: 2 },
    });
    const superseded = await t.db
      .selectFrom('result_revisions')
      .selectAll()
      .where('id', '=', f1Official)
      .executeTakeFirstOrThrow();
    expect(superseded).toMatchObject({
      status: 'superseded',
      home_score: 2,
      away_score: 1,
      superseded_by_revision_id: correction.body.id,
      published_by: before.published_by,
      submitted_by: before.submitted_by,
    });
    expect(new Date(superseded.published_at ?? 0).toISOString()).toBe(
      new Date(before.published_at ?? 0).toISOString(),
    );
    expect(superseded.superseded_at).not.toBeNull();
    // standings now reflect the draw: Aces drew f1 (corrected) and f2 → 2 points
    expect(
      published.body.standings.rows.find(
        (r: { teamEntryId: string }) => r.teamEntryId === a.teamEntryId,
      ),
    ).toMatchObject({
      points: 2,
      drawn: 2,
    });
    // invariant 9 at the database: superseded and official rows cannot be rewritten
    await expect(
      t.db
        .updateTable('result_revisions')
        .set({ home_score: 7 })
        .where('id', '=', f1Official)
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .updateTable('result_revisions')
        .set({ home_score: 7 })
        .where('id', '=', correction.body.id)
        .execute(),
    ).rejects.toThrow();
    const history = await get(`/fixtures/${f1}/results`, leagueManager);
    expect(
      history.body.map((r: { revisionNo: number; status: string }) => [r.revisionNo, r.status]),
    ).toEqual([
      [1, 'superseded'],
      [2, 'official'],
    ]);
  });

  it('SPK-AT-014: a correction that feeds a published bracket node is not rewritten; a management review exception owned by the league manager is raised and history is retained', async () => {
    const f3 = await scheduleFixture(c, d, '2027-01-30', '18:00', '19:00');
    // the playoff game is linked to its node before it is played (a published league result
    // cannot be linked, SPK-RESULT-004)
    const node = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Semi-final 1',
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 4 },
      homeEntryId: c.teamEntryId,
      awayEntryId: d.teamEntryId,
      fixtureId: f3,
    });
    expect(node.status).toBe(201);
    await atKickoff(t, f3);
    const submitted = await post(`/fixtures/${f3}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 1,
      awayScore: 0,
    });
    const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: submitted.body.revision,
    });
    expect(published.status).toBe(200);
    // a playoff game never counts in the league table; its winner progresses the bracket
    expect(published.body.standings).toBeNull();
    expect(published.body.progressedBracketNodeIds).toEqual([node.body.id]);
    const final = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      name: 'Final',
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: node.body.id },
      away: { kind: 'seed', seed: 2 },
    });
    expect(final.status).toBe(201);
    const byCaptain = await post(`/bracket-nodes/${node.body.id}/publish`, c.captain, {
      expectedRevision: 1,
    });
    expect(byCaptain.status).toBe(403);
    const publishedNode = await post(`/bracket-nodes/${final.body.id}/publish`, leagueManager, {
      expectedRevision: 1,
    });
    expect(publishedNode.status).toBe(200);
    expect(publishedNode.body.published).toBe(true);

    const correction = await post(`/fixtures/${f3}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 0,
      awayScore: 1,
      reason: 'Scores were entered the wrong way round.',
    });
    expect(correction.status).toBe(201);
    const attempt = await post(`/results/${correction.body.id}/publish`, leagueManager, {
      expectedRevision: correction.body.revision,
    });
    expect(attempt.status).toBe(200);
    expect(attempt.body).toMatchObject({
      published: false,
      supersededRevisionId: null,
      standings: null,
      revision: { status: 'submitted' },
    });
    expect(attempt.body.reviewExceptionId).toEqual(expect.any(String));
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('id', '=', attempt.body.reviewExceptionId)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'competition.result_correction_review',
      owner_queue: 'league_manager',
      status: 'open',
      affected_type: 'result_revision',
      affected_id: correction.body.id,
    });
    expect(exception.details).toMatchObject({
      officialRevisionId: submitted.body.id,
      affectedBracketNodeIds: [final.body.id],
    });
    const official = await t.db
      .selectFrom('result_revisions')
      .select(['status', 'home_score', 'away_score'])
      .where('id', '=', submitted.body.id)
      .executeTakeFirstOrThrow();
    expect(official).toEqual({ status: 'official', home_score: 1, away_score: 0 });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', correction.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toContain(
      'competition.result_correction_review_required',
    );
    // a retry collapses into the same open exception (dedupe) and still does not publish
    const retry = await post(`/results/${correction.body.id}/publish`, leagueManager, {
      expectedRevision: correction.body.revision,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.reviewExceptionId).toBe(attempt.body.reviewExceptionId);
    // customers see published nodes only
    const nodes = await get(`/seasons/${season.seasonId}/bracket-nodes`, c.captain);
    expect(nodes.status).toBe(200);
    expect(nodes.body.map((n: { id: string }) => n.id)).toEqual([final.body.id]);
  });

  it('SPK-STAFF-005 / SPK-DISC-001: an official reports incidents only for a fixture they accepted; the restricted record is readable by league management only', async () => {
    const assigned = await post('/incidents', official, {
      kind: 'operational',
      fixtureId: f1,
      severity: 'low',
      summary: 'Goal net torn at the north end',
      narrative: 'Restricted: net replaced at half time.',
    });
    expect(assigned.status).toBe(201);
    expect(assigned.body).toMatchObject({ fixtureId: f1, seasonId: season.seasonId });
    const f4 = await scheduleFixture(b, d, '2027-02-06', '18:00', '19:00');
    const unassigned = await post('/incidents', official, {
      kind: 'operational',
      fixtureId: f4,
      severity: 'low',
      summary: 'Lights flickered',
    });
    expect(unassigned.status).toBe(403);
    const withoutFixture = await post('/incidents', official, {
      kind: 'complaint',
      severity: 'low',
      summary: 'Spectator complaint',
    });
    expect(withoutFixture.status).toBe(403);
    expect((await get(`/incidents/${assigned.body.id}`, official)).status).toBe(404);
    expect((await get(`/incidents/${assigned.body.id}`, leagueManager)).status).toBe(200);
  });

  it('§4.10: roster players read published results only; outsiders and other organizations get NOT_FOUND; incident narratives never appear in result views', async () => {
    const asPlayer = await get(`/fixtures/${f1}/results`, a.player);
    expect(asPlayer.status).toBe(200);
    expect(
      asPlayer.body.every(
        (r: { status: string }) => r.status === 'official' || r.status === 'superseded',
      ),
    ).toBe(true);
    expect(JSON.stringify(asPlayer.body)).not.toContain('Restricted narrative');
    const stranger = await adultCustomer(t);
    expect((await get(`/fixtures/${f1}/results`, stranger)).status).toBe(404);
    expect((await get(`/results/${f1Official}`, stranger)).status).toBe(404);
    const otherOrg = await seedOrganization(t.db);
    const foreign = await createStaffMemberFixture(t, {
      roles: ['league_manager'],
      organizationId: otherOrg.organizationId,
    });
    const header = await authHeaderForPerson(t, foreign.personId);
    const foreignRead = await t.http.get(`/v1/fixtures/${f1}/results`).set(header);
    expect(foreignRead.status).toBe(404);
    const foreignPublish = await t.http
      .post(`/v1/results/${f1Official}/publish`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1 });
    expect(foreignPublish.status).toBe(404);
  });
});
