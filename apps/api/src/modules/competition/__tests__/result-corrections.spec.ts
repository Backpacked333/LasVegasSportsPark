import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { proposedRuleSetContent } from '../competition.policy';
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
 * SPK-RESULT-004 / SPK-AT-014 beyond the first correction: league-phase corrections against a
 * published, standings-seeded bracket, the management review decision, bracket progression, and
 * SPK-DISC-003 suspensions proposed by the approved rule set from a result's cards.
 */
describe('result corrections, brackets and rule-set discipline (SPK-RESULT-004, SPK-AT-014, SPK-DISC-003)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let generalManager: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let otherDivisionId: string;
  let a: Team;
  let b: Team;
  let c: Team;
  let d: Team;
  let e: Team;
  let f: Team;
  let day = 0;

  async function teamOf(name: string, division: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const player = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId: division,
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    return { teamEntryId: entry.teamEntryId, captain, player };
  }

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    generalManager = await staffMember(t, ['general_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    const base = proposedRuleSetContent('small_sided_other');
    // A low accumulation threshold keeps the SPK-DISC-003 scenario short (rule-set configuration).
    season = await createSeasonFixture(t, {
      status: 'active',
      ruleSet: { cards: { ...base.cards, yellowAccumulationThreshold: 2 } },
    });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Premier' });
    otherDivisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Championship',
    });
    a = await teamOf('Aces', divisionId);
    b = await teamOf('Bolts', divisionId);
    c = await teamOf('Comets', divisionId);
    d = await teamOf('Dynamos', divisionId);
    e = await teamOf('Eagles', otherDivisionId);
    f = await teamOf('Foxes', otherDivisionId);
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);

  async function fixture(home: Team, away: Team, division = divisionId): Promise<string> {
    day += 1;
    const date = new Date(Date.UTC(2027, 0, 2 + day * 7)).toISOString().slice(0, 10);
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      divisionId: division,
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
    const res = await post(`/fixtures/${fixtureId}/results`, leagueManager, body);
    expect(res.status).toBe(201);
    return res.body as { id: string; revision: number };
  }

  async function publish(revision: { id: string; revision: number }, extra: object = {}) {
    return post(`/results/${revision.id}/publish`, leagueManager, {
      expectedRevision: revision.revision,
      ...extra,
    });
  }

  async function played(fixtureId: string, homeScore: number, awayScore: number, extra = {}) {
    const res = await publish(
      await submit(fixtureId, { classification: 'completed', homeScore, awayScore, ...extra }),
    );
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
    return res.body;
  }

  async function node(body: object) {
    const res = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId,
      ...body,
    });
    expect(res.status).toBe(201);
    const published = await post(`/bracket-nodes/${res.body.id}/publish`, leagueManager, {
      expectedRevision: res.body.revision,
    });
    expect(published.status).toBe(200);
    return published.body as { id: string };
  }

  let f1: string;
  let f1Official: string;
  let sf2: string;
  let semi1: { id: string };
  let semi2: { id: string };
  let final: { id: string };

  it('SPK-AT-014: a league correction that changes a seed of the published playoff bracket waits for management review; one that changes no seed is published at once; playoff games progress the bracket and never count in the league table', async () => {
    f1 = await fixture(a, b);
    const f2 = await fixture(c, d);
    f1Official = (await played(f1, 3, 0)).revision.id;
    const f2Result = await played(f2, 1, 0);
    // table A (+3), C (+1), D (−1), B (−3): seeds 1..4
    expect(f2Result.standings.rows.map((r: { teamEntryId: string }) => r.teamEntryId)).toEqual([
      a.teamEntryId,
      c.teamEntryId,
      d.teamEntryId,
      b.teamEntryId,
    ]);
    const sf1 = await fixture(a, b);
    sf2 = await fixture(c, d);
    semi1 = await node({
      name: 'Semi-final 1',
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 4 },
      homeEntryId: a.teamEntryId,
      awayEntryId: b.teamEntryId,
      fixtureId: sf1,
    });
    semi2 = await node({
      name: 'Semi-final 2',
      round: 1,
      slot: 2,
      home: { kind: 'seed', seed: 2 },
      away: { kind: 'seed', seed: 3 },
      homeEntryId: c.teamEntryId,
      awayEntryId: d.teamEntryId,
      fixtureId: sf2,
    });
    final = await node({
      name: 'Final',
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: semi1.id },
      away: { kind: 'winner_of', nodeId: semi2.id },
    });

    // C 2–0 D keeps the seeds: published immediately (no review)
    const keeps = await publish(
      await submit(f2, {
        classification: 'completed',
        homeScore: 2,
        awayScore: 0,
        reason: 'Second goal confirmed by the match card.',
      }),
    );
    expect(keeps.status).toBe(200);
    expect(keeps.body).toMatchObject({ published: true, reviewExceptionId: null });

    // bracket progression: the semi-finals record winners and fill the final
    const semiOne = await played(sf1, 2, 1);
    expect(semiOne.standings).toBeNull();
    expect(semiOne.progressedBracketNodeIds.sort()).toEqual([semi1.id, final.id].sort());
    const semiTwo = await played(sf2, 2, 1);
    expect(semiTwo.progressedBracketNodeIds.sort()).toEqual([semi2.id, final.id].sort());
    const nodes = await get(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager);
    const byId = new Map(
      (
        nodes.body as Array<{
          id: string;
          winnerEntryId: string | null;
          homeEntryId: string | null;
          awayEntryId: string | null;
        }>
      ).map((n) => [n.id, n]),
    );
    expect(byId.get(semi1.id)?.winnerEntryId).toBe(a.teamEntryId);
    expect(byId.get(semi2.id)?.winnerEntryId).toBe(c.teamEntryId);
    expect(byId.get(final.id)).toMatchObject({
      homeEntryId: a.teamEntryId,
      awayEntryId: c.teamEntryId,
      winnerEntryId: null,
    });
    // playoff games never count in the league table (SPK-RESULT-001)
    const table = await get(
      `/seasons/${season.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(table.body.sourceResultIds).toHaveLength(2);
    expect(
      table.body.rows.find((r: { teamEntryId: string }) => r.teamEntryId === a.teamEntryId),
    ).toMatchObject({ played: 1, won: 1 });

    // B 3–0 A moves seeds 1 and 4: semi-final 1 and the final it feeds are published history,
    // and semi-final 1 has been played
    const swap = await submit(f1, {
      classification: 'completed',
      homeScore: 0,
      awayScore: 3,
      reason: 'Home and away scores were swapped on the card.',
    });
    const attempt = await publish(swap);
    expect(attempt.status).toBe(200);
    expect(attempt.body).toMatchObject({
      published: false,
      supersededRevisionId: null,
      standings: null,
      revision: { id: swap.id, status: 'submitted' },
    });
    const task = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('id', '=', attempt.body.reviewExceptionId)
      .executeTakeFirstOrThrow();
    expect(task).toMatchObject({
      category: 'competition.result_correction_review',
      owner_queue: 'league_manager',
      status: 'open',
      affected_id: swap.id,
    });
    expect(task.details).toMatchObject({
      officialRevisionId: f1Official,
      affectedBracketNodeIds: [semi1.id, final.id].sort(),
      affectedFixtureIds: [sf1],
    });
    const unchanged = await t.db
      .selectFrom('result_revisions')
      .select(['status', 'home_score'])
      .where('id', '=', f1Official)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual({ status: 'official', home_score: 3 });
  });

  it('SPK-RESULT-004: the review is decided by league management naming the open task; the correction then supersedes the official result, the task is resolved, and the published bracket is not rewritten', async () => {
    const [swap] = (await get(`/fixtures/${f1}/results`, leagueManager)).body.filter(
      (r: { status: string }) => r.status === 'submitted',
    ) as Array<{ id: string; revision: number }>;
    expect(swap).toBeDefined();
    const revision = swap as { id: string; revision: number };
    const open = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('affected_id', '=', revision.id)
      .executeTakeFirstOrThrow();
    // a task of another record is refused; staff outside the publication roles are refused
    const wrongTask = await publish(revision, { reviewExceptionId: newId() });
    expect(wrongTask.status).toBe(400);
    const byGeneralManager = await post(`/results/${revision.id}/publish`, generalManager, {
      expectedRevision: revision.revision,
      reviewExceptionId: open.id,
    });
    expect(byGeneralManager.status).toBe(403);

    const k = key();
    const decided = await post(
      `/results/${revision.id}/publish`,
      leagueManager,
      { expectedRevision: revision.revision, reviewExceptionId: open.id },
      k,
    );
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({
      published: true,
      supersededRevisionId: f1Official,
      reviewExceptionId: open.id,
      revision: { status: 'official', homeScore: 0, awayScore: 3 },
    });
    // §4.9: the same key and payload replays the stored outcome
    const replay = await post(
      `/results/${revision.id}/publish`,
      leagueManager,
      { expectedRevision: revision.revision, reviewExceptionId: open.id },
      k,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.revision.id).toBe(revision.id);

    const task = await t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'resolution'])
      .where('id', '=', open.id)
      .executeTakeFirstOrThrow();
    expect(task.status).toBe('resolved');
    expect(task.resolution).toMatchObject({
      outcome: 'correction_published',
      resultRevisionId: revision.id,
      supersededRevisionId: f1Official,
    });
    // history retained: the superseded row keeps its facts; the bracket stays as published
    const superseded = await t.db
      .selectFrom('result_revisions')
      .select(['status', 'home_score', 'away_score'])
      .where('id', '=', f1Official)
      .executeTakeFirstOrThrow();
    expect(superseded).toEqual({ status: 'superseded', home_score: 3, away_score: 0 });
    const semi = await t.db
      .selectFrom('bracket_nodes')
      .select(['home_entry_id', 'away_entry_id', 'winner_entry_id'])
      .where('id', '=', semi1.id)
      .executeTakeFirstOrThrow();
    expect(semi).toEqual({
      home_entry_id: a.teamEntryId,
      away_entry_id: b.teamEntryId,
      winner_entry_id: a.teamEntryId,
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.result_published')
      .where('aggregate_id', '=', revision.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      reviewExceptionId: open.id,
      affectedBracketNodeIds: [semi1.id, final.id].sort(),
    });
    // a closed task cannot be used again
    const reuse = await post(`/fixtures/${f1}/results`, leagueManager, {
      classification: 'completed',
      homeScore: 0,
      awayScore: 4,
      reason: 'Another goal found on video.',
    });
    expect(reuse.status).toBe(201);
    const stale = await publish(reuse.body, { reviewExceptionId: open.id });
    expect(stale.status).toBe(400);
  });

  it('CMP-11: a league manager resolves a result review task as the audited actor', async () => {
    const resolved = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'competition.result_correction_review')
      .where('status', '=', 'resolved')
      .execute();
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    for (const task of resolved) {
      const audit = await t.db
        .selectFrom('audit_records')
        .select(['action', 'actor'])
        .where('target_id', '=', task.id)
        .where('action', '=', 'exceptions.resolved')
        .executeTakeFirstOrThrow();
      // the reviewer, not a system principal, is recorded (exceptions.manage_own_queue)
      expect(audit.actor).toMatchObject({ kind: 'staff', personId: leagueManager.personId });
    }
  });

  it('SPK-RESULT-004: returning a correction that waits for review closes its review task; the official playoff result stands', async () => {
    const correction = await submit(sf2, {
      classification: 'completed',
      homeScore: 1,
      awayScore: 2,
      reason: 'Disputed winner of semi-final 2.',
    });
    const attempt = await publish(correction);
    expect(attempt.body.published).toBe(false);
    expect(attempt.body.reviewExceptionId).toEqual(expect.any(String));
    const returned = await post(`/results/${correction.id}/return`, leagueManager, {
      expectedRevision: correction.revision,
      reason: 'Video confirms the original score; the correction is rejected.',
    });
    expect(returned.status).toBe(200);
    expect(returned.body.status).toBe('draft');
    const task = await t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'resolution'])
      .where('id', '=', attempt.body.reviewExceptionId)
      .executeTakeFirstOrThrow();
    expect(task.status).toBe('resolved');
    expect(task.resolution).toMatchObject({ outcome: 'correction_returned' });
    const official = await t.db
      .selectFrom('result_revisions')
      .select(['home_score', 'away_score'])
      .where('fixture_id', '=', sf2)
      .where('status', '=', 'official')
      .executeTakeFirstOrThrow();
    expect(official).toEqual({ home_score: 2, away_score: 1 });
  });

  it('SPK-DISC-003: cards propose the suspensions the approved rule set prescribes (red card, yellow accumulation), once per fixture and rule; they restrict nothing until approved, and only matches that took place serve them', async () => {
    const g1 = await fixture(e, f, otherDivisionId);
    const first = await played(g1, 1, 1, {
      cards: [
        { personId: e.player.personId, teamEntryId: e.teamEntryId, kind: 'red', minute: 30 },
        { personId: f.player.personId, teamEntryId: f.teamEntryId, kind: 'yellow', minute: 10 },
      ],
    });
    expect(first.proposedSuspensionIds).toHaveLength(1);
    const red = await get(`/suspensions/${first.proposedSuspensionIds[0]}`, leagueManager);
    expect(red.body).toMatchObject({
      subjectPersonId: e.player.personId,
      status: 'proposed',
      sourceKind: 'red_card',
      sourceFixtureId: g1,
      sourceResultRevisionId: first.revision.id,
      scope: 'competitions',
      competitionIds: [season.competitionId],
      matchCount: season.ruleSet.cards.redCardSuspensionMatches,
    });
    // proposed: no restriction yet (approval is the authorized review)
    const eligibility = await get(
      `/team-entries/${e.teamEntryId}/eligibility?personId=${e.player.personId}`,
      e.captain,
    );
    expect(eligibility.body.reasons.map((r: { code: string }) => r.code)).not.toContain(
      'suspended',
    );
    // a correction that keeps the red card does not propose it twice
    const corrected = await publish(
      await submit(g1, {
        classification: 'completed',
        homeScore: 1,
        awayScore: 2,
        reason: 'Late goal omitted.',
        cards: [
          { personId: e.player.personId, teamEntryId: e.teamEntryId, kind: 'red', minute: 30 },
          { personId: f.player.personId, teamEntryId: f.teamEntryId, kind: 'yellow', minute: 10 },
        ],
      }),
    );
    expect(corrected.status).toBe(200);
    expect(corrected.body.proposedSuspensionIds).toEqual([]);
    const forPlayer = await t.db
      .selectFrom('suspensions')
      .select('id')
      .where('subject_person_id', '=', e.player.personId)
      .execute();
    expect(forPlayer).toHaveLength(1);

    // the second yellow of the season reaches the threshold of 2
    const g2 = await fixture(f, e, otherDivisionId);
    const second = await played(g2, 0, 0, {
      cards: [
        { personId: f.player.personId, teamEntryId: f.teamEntryId, kind: 'yellow', minute: 55 },
      ],
    });
    expect(second.proposedSuspensionIds).toHaveLength(1);
    const yellow = await get(`/suspensions/${second.proposedSuspensionIds[0]}`, leagueManager);
    expect(yellow.body).toMatchObject({
      subjectPersonId: f.player.personId,
      sourceKind: 'yellow_accumulation',
      sourceFixtureId: g2,
      status: 'proposed',
    });

    // approval activates the red-card suspension; a canceled match does not serve it
    const approved = await t.http
      .patch(`/v1/suspensions/${red.body.id}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ action: 'approve', expectedRevision: red.body.revision });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('active');
    const g3 = await fixture(e, f, otherDivisionId);
    const canceled = await publish(await submit(g3, { classification: 'canceled' }));
    expect(canceled.status).toBe(200);
    expect((await get(`/suspensions/${red.body.id}`, leagueManager)).body.matchesServed).toBe(0);
    const g4 = await fixture(f, e, otherDivisionId);
    await played(g4, 2, 0);
    expect((await get(`/suspensions/${red.body.id}`, leagueManager)).body).toMatchObject({
      matchesServed: 1,
      status: 'served',
      servedFixtureIds: [g4],
    });
  });
  async function draftNode(division: string, body: object) {
    const res = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId: division,
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; revision: number };
  }

  async function bracketRow(id: string) {
    return t.db
      .selectFrom('bracket_nodes')
      .select(['home_entry_id', 'away_entry_id', 'winner_entry_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  it('SPK-RESULT-004 / SPK-COMP-001: a correction that changes the winner of a playoff game nobody downstream acts on yet revises the bracket (audited); a score-only correction leaves it; a first result without a winner progresses once it is corrected to a decided one', async () => {
    const division = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Cup A' });
    const [p, q, r, s2] = [
      await teamOf('Pumas', division),
      await teamOf('Quails', division),
      await teamOf('Ravens', division),
      await teamOf('Sharks', division),
    ] as [Team, Team, Team, Team];
    const sf1 = await fixture(p, q, division);
    const sf2 = await fixture(r, s2, division);
    const semi1 = await draftNode(division, {
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 4 },
      homeEntryId: p.teamEntryId,
      awayEntryId: q.teamEntryId,
      fixtureId: sf1,
    });
    const semi2 = await draftNode(division, {
      round: 1,
      slot: 2,
      home: { kind: 'seed', seed: 2 },
      away: { kind: 'seed', seed: 3 },
      homeEntryId: r.teamEntryId,
      awayEntryId: s2.teamEntryId,
      fixtureId: sf2,
    });
    const final = await draftNode(division, {
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: semi1.id },
      away: { kind: 'winner_of', nodeId: semi2.id },
    });

    // P 1–0 Q progresses P; the correction 0–1 makes Q the winner and revises both nodes
    const first = await played(sf1, 1, 0);
    expect(first.progressedBracketNodeIds.sort()).toEqual([semi1.id, final.id].sort());
    const flipped = await publish(
      await submit(sf1, {
        classification: 'completed',
        homeScore: 0,
        awayScore: 1,
        reason: 'Scores were entered the wrong way round.',
      }),
    );
    expect(flipped.status).toBe(200);
    expect(flipped.body).toMatchObject({ published: true, reviewExceptionId: null });
    expect(flipped.body.progressedBracketNodeIds.sort()).toEqual([semi1.id, final.id].sort());
    expect((await bracketRow(semi1.id)).winner_entry_id).toBe(q.teamEntryId);
    expect((await bracketRow(final.id)).home_entry_id).toBe(q.teamEntryId);
    const revisedAudit = (
      await t.db
        .selectFrom('audit_records')
        .select(['target_id', 'details'])
        .where('target_id', 'in', [semi1.id, final.id])
        .execute()
    ).filter((a) => (a.details as { operation?: string }).operation === 'progress_revised');
    expect(revisedAudit.map((a) => a.target_id).sort()).toEqual([semi1.id, final.id].sort());
    expect(revisedAudit[0]?.details).toMatchObject({
      previousOutcome: { winnerEntryId: p.teamEntryId, loserEntryId: q.teamEntryId },
      nextOutcome: { winnerEntryId: q.teamEntryId, loserEntryId: p.teamEntryId },
    });
    // a score-only correction keeps the winner and the bracket
    const scoreOnly = await publish(
      await submit(sf1, {
        classification: 'completed',
        homeScore: 0,
        awayScore: 2,
        reason: 'A second goal was confirmed.',
      }),
    );
    expect(scoreOnly.body).toMatchObject({ published: true, progressedBracketNodeIds: [] });
    expect(await bracketRow(final.id)).toMatchObject({ home_entry_id: q.teamEntryId });

    // a disputed first result has no winner; the decided correction then progresses the bracket
    const disputed = await publish(await submit(sf2, { classification: 'disputed' }));
    expect(disputed.status).toBe(200);
    expect(disputed.body.progressedBracketNodeIds).toEqual([]);
    const decided = await publish(
      await submit(sf2, {
        classification: 'completed',
        homeScore: 2,
        awayScore: 0,
        reason: 'The dispute was resolved for the home side.',
      }),
    );
    expect(decided.body).toMatchObject({ published: true, reviewExceptionId: null });
    expect(decided.body.progressedBracketNodeIds.sort()).toEqual([semi2.id, final.id].sort());
    expect((await bracketRow(semi2.id)).winner_entry_id).toBe(r.teamEntryId);
    expect(await bracketRow(final.id)).toMatchObject({
      home_entry_id: q.teamEntryId,
      away_entry_id: r.teamEntryId,
    });
  });

  it('SPK-RESULT-004 / SPK-COMP-001: a winner change that a later node already acts on (it has its fixture) waits for management review and rewrites nothing; on a published node a disputed first result progresses once the reviewed correction decides it', async () => {
    const division = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Cup B' });
    const [p, q, r] = [
      await teamOf('Panthers', division),
      await teamOf('Quokkas', division),
      await teamOf('Rhinos', division),
    ] as [Team, Team, Team];
    const sf = await fixture(p, q, division);
    const semi = await draftNode(division, {
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 4 },
      homeEntryId: p.teamEntryId,
      awayEntryId: q.teamEntryId,
      fixtureId: sf,
    });
    expect((await played(sf, 1, 0)).progressedBracketNodeIds).toEqual([semi.id]);
    // the final is scheduled with the semi-final winner: its sides follow the old outcome
    const finalFixture = await fixture(p, r, division);
    const final = await draftNode(division, {
      round: 2,
      slot: 1,
      home: { kind: 'winner_of', nodeId: semi.id },
      away: { kind: 'seed', seed: 2 },
      homeEntryId: p.teamEntryId,
      awayEntryId: r.teamEntryId,
      fixtureId: finalFixture,
    });
    const flip = await publish(
      await submit(sf, {
        classification: 'completed',
        homeScore: 0,
        awayScore: 1,
        reason: 'Scores were entered the wrong way round.',
      }),
    );
    expect(flip.status).toBe(200);
    expect(flip.body).toMatchObject({ published: false, progressedBracketNodeIds: [] });
    const task = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'details'])
      .where('id', '=', flip.body.reviewExceptionId)
      .executeTakeFirstOrThrow();
    expect(task.category).toBe('competition.result_correction_review');
    expect(task.details).toMatchObject({
      affectedBracketNodeIds: [final.id],
      affectedFixtureIds: [finalFixture],
    });
    expect((await bracketRow(semi.id)).winner_entry_id).toBe(p.teamEntryId);
    expect((await bracketRow(final.id)).home_entry_id).toBe(p.teamEntryId);

    // published semi-final whose first result was disputed: the reviewed decision fills the bracket
    const sf3 = await fixture(q, r, division);
    const semi3 = await node({
      divisionId: division,
      round: 1,
      slot: 2,
      home: { kind: 'seed', seed: 2 },
      away: { kind: 'seed', seed: 3 },
      homeEntryId: q.teamEntryId,
      awayEntryId: r.teamEntryId,
      fixtureId: sf3,
    });
    const final3 = await draftNode(division, {
      round: 3,
      slot: 1,
      home: { kind: 'winner_of', nodeId: semi3.id },
      away: { kind: 'seed', seed: 1 },
    });
    expect((await publish(await submit(sf3, { classification: 'disputed' }))).status).toBe(200);
    const correction = await submit(sf3, {
      classification: 'completed',
      homeScore: 3,
      awayScore: 1,
      reason: 'The dispute was resolved for the home side.',
    });
    const waiting = await publish(correction);
    expect(waiting.body.published).toBe(false);
    const approved = await publish(correction, {
      reviewExceptionId: waiting.body.reviewExceptionId,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.published).toBe(true);
    expect(approved.body.progressedBracketNodeIds.sort()).toEqual([semi3.id, final3.id].sort());
    expect((await bracketRow(semi3.id)).winner_entry_id).toBe(q.teamEntryId);
    expect((await bracketRow(final3.id)).home_entry_id).toBe(q.teamEntryId);
  });

  it('SPK-RESULT-004 / §4.7 invariant 9: a fixture whose result is published counts in the league table and cannot be linked to a bracket node', async () => {
    const division = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'League C',
    });
    const [w, x, y, z] = [
      await teamOf('Wolves', division),
      await teamOf('Xenops', division),
      await teamOf('Yaks', division),
      await teamOf('Zebras', division),
    ] as [Team, Team, Team, Team];
    const league = await fixture(w, z, division);
    const official = (await played(league, 5, 0)).revision.id as string;
    const linked = await post(`/seasons/${season.seasonId}/bracket-nodes`, leagueManager, {
      divisionId: division,
      round: 1,
      slot: 1,
      home: { kind: 'seed', seed: 1 },
      away: { kind: 'seed', seed: 4 },
      homeEntryId: w.teamEntryId,
      awayEntryId: z.teamEntryId,
      fixtureId: league,
    });
    expect(linked.status).toBe(400);
    expect(linked.body.details).toMatchObject({ code: 'fixture_result_published' });
    const next = await played(await fixture(x, y, division), 1, 0);
    expect(next.standings.sourceResultIds).toHaveLength(2);
    expect(next.standings.sourceResultIds).toContain(official);
    const nodes = await t.db
      .selectFrom('bracket_nodes')
      .select('id')
      .where('fixture_id', '=', league)
      .execute();
    expect(nodes).toEqual([]);
  });
  it('SPK-DISC-003 / SPK-RESULT-004: yellow accumulation is proposed once per threshold crossing in the season; correcting an earlier cautioned fixture (score only, or adding a yellow below the next multiple) proposes nothing again, and the next multiple still does', async () => {
    const division = await createDivisionFixture(t, { seasonId: season.seasonId, name: 'Cards' });
    const g = await teamOf('Gulls', division);
    const h = await teamOf('Herons', division);
    const yellow = (minute: number) => ({
      personId: g.player.personId,
      teamEntryId: g.teamEntryId,
      kind: 'yellow',
      minute,
    });
    const accumulation = async () =>
      t.db
        .selectFrom('suspensions')
        .select(['id', 'source_fixture_id'])
        .where('subject_person_id', '=', g.player.personId)
        .where('source_kind', '=', 'yellow_accumulation')
        .execute();
    const correct = async (fixtureId: string, body: object) => {
      const res = await publish(
        await submit(fixtureId, { classification: 'completed', reason: 'Card review.', ...body }),
      );
      expect(res.status).toBe(200);
      expect(res.body.published).toBe(true);
      return res.body as { proposedSuspensionIds: string[] };
    };
    // threshold 2 (this season's rule set): the second yellow of the season is the first crossing
    const f1 = await fixture(g, h, division);
    expect((await played(f1, 1, 0, { cards: [yellow(10)] })).proposedSuspensionIds).toEqual([]);
    const f2 = await fixture(h, g, division);
    expect((await played(f2, 0, 0, { cards: [yellow(20)] })).proposedSuspensionIds).toHaveLength(1);
    expect(await accumulation()).toEqual([expect.objectContaining({ source_fixture_id: f2 })]);
    // corrections of the earlier fixture: the score only, then a second yellow (3 < 4)
    expect(
      (await correct(f1, { homeScore: 2, awayScore: 0, cards: [yellow(10)] }))
        .proposedSuspensionIds,
    ).toEqual([]);
    expect(
      (await correct(f1, { homeScore: 2, awayScore: 0, cards: [yellow(10), yellow(70)] }))
        .proposedSuspensionIds,
    ).toEqual([]);
    expect(await accumulation()).toHaveLength(1);
    // the fourth yellow reaches the next multiple: a second crossing, proposed once
    const f3 = await fixture(g, h, division);
    expect((await played(f3, 1, 1, { cards: [yellow(5)] })).proposedSuspensionIds).toHaveLength(1);
    expect(
      (await correct(f3, { homeScore: 2, awayScore: 1, cards: [yellow(5)] })).proposedSuspensionIds,
    ).toEqual([]);
    expect((await accumulation()).map((r) => r.source_fixture_id).sort()).toEqual([f2, f3].sort());
  });
});
