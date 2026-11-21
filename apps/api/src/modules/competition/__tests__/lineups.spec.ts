import { newId } from '@sportspark/contracts';
import { isCheckViolation, isUniqueViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { ASSIGNMENT_CHECK_IMPL, type AssignmentCheckPort } from '../competition-matches.ports';
import {
  addRosterMemberFixture,
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
  players: string[];
}

/**
 * The coach's team sheet (migration 0475; SPK-CAP-001 captain tools, SPK-CAP-003 availability,
 * SPK-UX-007 field-side work, SPK-RESULT-001; staff redesign Phase 8 "Coach · Lineup" and
 * "Coach · Live game day").
 */
describe('team sheet: lineups and game logs (SPK-CAP-001, SPK-CAP-003, SPK-UX-007, SPK-RESULT-001)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let official: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let hawks: Team;
  let comets: Team;
  let firstGame: string;
  let secondGame: string;
  const accepted = new Set<string>();
  const assignments: AssignmentCheckPort = {
    isAcceptedOfficial: async (_organizationId, fixture, personId) =>
      accepted.has(`${fixture}:${personId}`),
  };

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);
  const settle = () => t.app.get(OutboxDispatcher).runOnce(500);

  async function teamOf(name: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
    });
    const players: string[] = [];
    for (let i = 0; i < 4; i++) {
      const personId = await createPersonFixture(t, { kind: 'adult', dateOfBirth: '1992-03-01' });
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId,
        jerseyNumber: i + 2,
      });
      players.push(personId);
    }
    return { teamEntryId: entry.teamEntryId, captain, players };
  }

  async function game(day: string): Promise<string> {
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: hawks.teamEntryId,
      awayEntryId: comets.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at(day, '18:00'),
        scheduledEnd: at(day, '19:00'),
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await settle();
    return res.body.fixture.id as string;
  }

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: ASSIGNMENT_CHECK_IMPL, useValue: assignments }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    official = await staffMember(t, ['official']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, {
      status: 'active',
      name: 'Winter league',
      startsOn: '2027-01-10',
      endsOn: '2027-04-10',
    });
    hawks = await teamOf('Hawks');
    comets = await teamOf('Comets');
    firstGame = await game('2027-01-16');
    secondGame = await game('2027-01-23');
    // Answers for the second game: two Going, one Not going, one without an answer.
    const answers = ['available', 'available', 'unavailable'] as const;
    for (const [i, state] of answers.entries()) {
      const res = await post(`/fixtures/${secondGame}/availability`, leagueManager, {
        personId: hawks.players[i],
        state,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-UX-007 / SPK-RESULT-001: the captain records the game log with minutes; it is never the result', async () => {
    const early = await post(`/fixtures/${firstGame}/game-log`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      homeScore: 0,
      awayScore: 0,
      events: [],
      minutes: [],
    });
    expect(early.status).toBe(400);
    expect(early.body.details).toMatchObject({ code: 'GAME_NOT_STARTED' });

    await atKickoff(t, firstGame);
    const [a, b, c] = hawks.players as [string, string, string];
    const log = await post(`/fixtures/${firstGame}/game-log`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      homeScore: 3,
      awayScore: 1,
      events: [
        { kind: 'goal', minute: 12, personId: a, assistPersonId: b },
        { kind: 'opponent_goal', minute: 20 },
        { kind: 'half_time', minute: 25 },
        { kind: 'substitution', minute: 30, offPersonId: b, onPersonId: c },
      ],
      minutes: [
        { personId: a, minutes: 50 },
        { personId: b, minutes: 30 },
        { personId: c, minutes: 20 },
      ],
    });
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    expect(log.body).toMatchObject({ homeScore: 3, awayScore: 1, revision: 1 });
    expect(log.body.events).toHaveLength(4);
    // No result revision exists: the game log is the side's record only.
    const results = await t.db
      .selectFrom('result_revisions')
      .select('id')
      .where('fixture_id', '=', firstGame)
      .execute();
    expect(results).toHaveLength(0);

    // A second record without the revision is refused; a correction names it.
    const again = await post(`/fixtures/${firstGame}/game-log`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      homeScore: 3,
      awayScore: 2,
      events: [],
      minutes: [{ personId: a, minutes: 50 }],
    });
    expect(again.status).toBe(400);
    const corrected = await post(`/fixtures/${firstGame}/game-log`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      homeScore: 3,
      awayScore: 1,
      events: log.body.events,
      minutes: log.body.minutes,
      expectedRevision: 1,
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.revision).toBe(2);

    // A player of another side is refused.
    const stranger = await post(`/fixtures/${firstGame}/game-log`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      homeScore: 3,
      awayScore: 1,
      events: [],
      minutes: [{ personId: comets.players[0], minutes: 10 }],
      expectedRevision: 2,
    });
    expect(stranger.status).toBe(400);
    expect(stranger.body.details).toMatchObject({ code: 'NOT_ON_ROSTER' });
  });

  it('SPK-RESULT-001 / SPK-STAFF-005: an accepted official reads the game log scores for the match check; others see nothing', async () => {
    const before = await get(`/fixtures/${firstGame}/game-logs`, official);
    expect(before.status).toBe(404);
    accepted.add(`${firstGame}:${official.personId}`);
    const res = await get(`/fixtures/${firstGame}/game-logs`, official);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.logs).toEqual([
      expect.objectContaining({ teamEntryId: hawks.teamEntryId, homeScore: 3, awayScore: 1 }),
    ]);
    // The other captain sees only their own side's (none yet).
    const other = await get(`/fixtures/${firstGame}/game-logs`, comets.captain);
    expect(other.status).toBe(200);
    expect(other.body.logs).toEqual([]);
  });

  it('SPK-CAP-001 / SPK-CAP-003: the team sheet lists answers and season minutes; the captain saves and shares a lineup', async () => {
    const sheet = await get(`/fixtures/${secondGame}/lineup`, hawks.captain);
    expect(sheet.status, JSON.stringify(sheet.body)).toBe(200);
    const [a, b, c, d] = hawks.players as [string, string, string, string];
    const byId = new Map(
      (sheet.body.players as { personId: string }[]).map((p) => [p.personId, p]),
    );
    expect(byId.get(a)).toMatchObject({
      availability: 'available',
      minutesThisSeason: 50,
      gamesThisSeason: 1,
    });
    expect(byId.get(c)).toMatchObject({ availability: 'unavailable', minutesThisSeason: 20 });
    expect(byId.get(d)).toMatchObject({ availability: 'no_response', minutesThisSeason: 0 });
    expect(sheet.body).toMatchObject({
      side: 'home',
      teamName: 'Hawks',
      opponentName: 'Comets',
      lineup: null,
      gameLog: null,
      availableActions: ['save_lineup', 'record_game_log'],
    });
    // 100 minutes over the rostered players (the captain is rostered here too).
    expect(sheet.body.teamAverageMinutes).toBeGreaterThan(0);

    const tooMany = await post(`/fixtures/${secondGame}/lineup`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      formation: '1-1',
      slots: [
        { slot: 1, personId: a },
        { slot: 4, personId: b },
      ],
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.details).toMatchObject({ code: 'SLOT_OUTSIDE_FORMATION', places: 3 });

    const saved = await post(`/fixtures/${secondGame}/lineup`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      formation: '1-1',
      slots: [
        { slot: 1, personId: a },
        { slot: 2, personId: b },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ formation: '1-1', sharedAt: null, revision: 1 });

    const shared = await post(`/fixtures/${secondGame}/lineup/share`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      expectedRevision: 1,
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.sharedAt).not.toBeNull();
    expect(shared.body.changedSinceShared).toBe(false);
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', secondGame)
      .where('event_type', '=', 'competition.lineup_shared')
      .execute();
    expect(events).toHaveLength(1);

    // Swapping the two places after sharing marks the lineup as changed since it was shared.
    const swapped = await post(`/fixtures/${secondGame}/lineup`, hawks.captain, {
      teamEntryId: hawks.teamEntryId,
      formation: '1-1',
      slots: [
        { slot: 1, personId: b },
        { slot: 2, personId: a },
      ],
      expectedRevision: shared.body.revision,
    });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    expect(swapped.body.changedSinceShared).toBe(true);

    // The other side's captain cannot read or change this side's sheet (protected, §4.10).
    const peek = await get(
      `/fixtures/${secondGame}/lineup?teamEntryId=${hawks.teamEntryId}`,
      comets.captain,
    );
    expect(peek.status).toBe(404);
    const meddle = await post(`/fixtures/${secondGame}/lineup`, comets.captain, {
      teamEntryId: hawks.teamEntryId,
      formation: '1-1',
      slots: [],
    });
    expect(meddle.status).toBe(404);
  });

  it('SPK-CAP-001 (migration 0475): the database keeps one place per player, one lineup per side and sides of the fixture', async () => {
    const lineup = await t.db
      .selectFrom('fixture_lineups')
      .select(['id'])
      .where('fixture_id', '=', secondGame)
      .executeTakeFirstOrThrow();
    const [a] = hawks.players as [string];
    // The same player in a second place.
    await expect(
      t.db
        .insertInto('fixture_lineup_slots')
        .values({ organization_id: t.organizationId, lineup_id: lineup.id, slot: 3, person_id: a })
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    const base = {
      organization_id: t.organizationId,
      fixture_id: secondGame,
      formation: '2-3-1',
      updated_by: json({ kind: 'system', actorLabel: 'test' }),
    };
    // A second lineup for the same side.
    await expect(
      t.db
        .insertInto('fixture_lineups')
        .values({ ...base, id: newId(), team_entry_id: hawks.teamEntryId })
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    // A side that does not play the fixture.
    const outsider = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: (await adultCustomer(t)).personId,
      teamName: 'Outsiders',
    });
    await expect(
      t.db
        .insertInto('fixture_lineups')
        .values({ ...base, id: newId(), team_entry_id: outsider.teamEntryId })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // A shared lineup always records who shared it and which revision.
    await expect(
      t.db
        .insertInto('fixture_lineups')
        .values({ ...base, id: newId(), team_entry_id: comets.teamEntryId, shared_at: new Date() })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    // Minutes out of range, and minutes on another side than the game log's.
    const log = await t.db
      .selectFrom('fixture_game_logs')
      .select('id')
      .where('fixture_id', '=', firstGame)
      .executeTakeFirstOrThrow();
    await expect(
      t.db
        .insertInto('fixture_player_minutes')
        .values({
          organization_id: t.organizationId,
          game_log_id: log.id,
          team_entry_id: hawks.teamEntryId,
          person_id: hawks.players[3] as string,
          minutes: 400,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      t.db
        .insertInto('fixture_player_minutes')
        .values({
          organization_id: t.organizationId,
          game_log_id: log.id,
          team_entry_id: comets.teamEntryId,
          person_id: comets.players[0] as string,
          minutes: 10,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });
});
