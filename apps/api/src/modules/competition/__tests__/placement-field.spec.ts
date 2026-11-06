import { newId } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import type { TestApp } from '../../../testing';
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
  competitionTestApp,
  isRestrictViolation,
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
 * Placement and field-side work (migrations 0464 to 0466): staff player profiles and team balance
 * (SPK-PLACE-002, SPK-PLACE-005), the playoff line on standings (SPK-FIX-001, SPK-RESULT-003),
 * player check-in on the match sheet (SPK-UX-007, SPK-STAFF-005), results awaiting a decision
 * with a suggested forfeit (SPK-RESULT-001, SPK-RESULT-002) and reminders to captains.
 */
describe('placement and field-side work (SPK-PLACE-002/005, SPK-UX-007, SPK-STAFF-005, SPK-RESULT-001/002)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let official: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let lions: Team;
  let tigers: Team;
  let fixtureId: string;
  const accepted = new Set<string>();
  const assignments: AssignmentCheckPort = {
    isAcceptedOfficial: async (_organizationId, fixture, personId) =>
      accepted.has(`${fixture}:${personId}`),
  };

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);
  const settle = () => t.app.get(OutboxDispatcher).runOnce(500);

  async function teamOf(name: string, seasonId: string, divisionId?: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const player = await adultCustomer(t, { dateOfBirth: '1990-07-14' });
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId,
    });
    for (const [personId, jerseyNumber] of [
      [captain.personId, 1],
      [player.personId, 9],
    ] as const) {
      await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId, jerseyNumber });
    }
    return { teamEntryId: entry.teamEntryId, captain, player };
  }

  beforeAll(async () => {
    t = await competitionTestApp({
      providers: [{ provide: ASSIGNMENT_CHECK_IMPL, useValue: assignments }],
    });
    leagueManager = await staffMember(t, ['league_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
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
      ruleSet: {
        forfeit: { scoreFor: 3, scoreAgainst: 0, graceMinutes: 10, minimumPlayersToStart: 2 },
      },
    });
    lions = await teamOf('Lions', season.seasonId);
    tigers = await teamOf('Tigers', season.seasonId);
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      awayEntryId: tigers.teamEntryId,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at('2027-01-16', '18:00'),
        scheduledEnd: at('2027-01-16', '19:00'),
      },
    });
    expect(res.status).toBe(201);
    await settle();
    fixtureId = res.body.fixture.id as string;
  });
  afterAll(async () => {
    await t.close();
  });

  // -------------------------------------------------------------------------------------------
  // Player profiles
  // -------------------------------------------------------------------------------------------
  it('SPK-PLACE-002: staff record position and skill rating; the read balances each team (keepers, skill average)', async () => {
    const keeper = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: lions.player.personId,
      position: 'goalkeeper',
      skillRating: 4,
    });
    expect(keeper.status).toBe(201);
    expect(keeper.body).toMatchObject({
      seasonId: season.seasonId,
      personId: lions.player.personId,
      position: 'goalkeeper',
      skillRating: 4,
      revision: 1,
    });
    const rated = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: lions.captain.personId,
      position: null,
      skillRating: 3,
    });
    expect(rated.status).toBe(201);
    const res = await get(`/seasons/${season.seasonId}/player-profiles`, leagueManager);
    expect(res.status).toBe(200);
    expect(res.body.skillScale).toEqual({ min: 1, max: 5 });
    expect(res.body.profiles).toHaveLength(2);
    const byEntry = new Map(
      (res.body.teams as Array<{ teamEntryId: string }>).map((team) => [team.teamEntryId, team]),
    );
    expect(byEntry.get(lions.teamEntryId)).toEqual({
      teamEntryId: lions.teamEntryId,
      players: 2,
      goalkeepers: 1,
      rated: 2,
      averageSkill: 3.5,
    });
    expect(byEntry.get(tigers.teamEntryId)).toEqual({
      teamEntryId: tigers.teamEntryId,
      players: 2,
      goalkeepers: 0,
      rated: 0,
      averageSkill: null,
    });
    const narrowed = await get(
      `/seasons/${season.seasonId}/player-profiles?personIds=${lions.player.personId}`,
      leagueManager,
    );
    expect(narrowed.body.profiles.map((p: { personId: string }) => p.personId)).toEqual([
      lions.player.personId,
    ]);
    // The event carries no rating (SPK-PLACE-005, §4.14).
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.player_profile_recorded')
      .where('aggregate_id', '=', keeper.body.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(event.payload)).not.toContain('skill');
  });

  it('§4.9: a change names the profile revision; a stale or missing one is STALE_REVISION, and the change is audited', async () => {
    const missing = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: lions.player.personId,
      position: 'defender',
      skillRating: 4,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('STALE_REVISION');
    const stale = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: lions.player.personId,
      position: 'defender',
      skillRating: 4,
      expectedRevision: 7,
    });
    expect(stale.status).toBe(409);
    const changed = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: lions.player.personId,
      position: 'goalkeeper',
      skillRating: 5,
      expectedRevision: 1,
      reason: 'Assessed at training',
    });
    expect(changed.status).toBe(201);
    expect(changed.body).toMatchObject({ skillRating: 5, revision: 2 });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision'])
      .where('target_id', '=', changed.body.id)
      .orderBy('after_revision')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'competition.record_player_profile',
      'competition.record_player_profile',
    ]);
    const empty = await post(`/seasons/${season.seasonId}/player-profiles`, leagueManager, {
      personId: tigers.player.personId,
      position: null,
      skillRating: null,
    });
    expect(empty.status).toBe(400);
  });

  it('SPK-PLACE-005: profiles are staff-only: a captain, a player and the front desk are refused', async () => {
    for (const actor of [lions.captain, lions.player, frontDesk]) {
      const read = await get(`/seasons/${season.seasonId}/player-profiles`, actor);
      expect(read.status).toBe(403);
      const write = await post(`/seasons/${season.seasonId}/player-profiles`, actor, {
        personId: tigers.player.personId,
        position: 'forward',
        skillRating: 2,
      });
      expect(write.status).toBe(403);
    }
  });

  it('SPK-PLACE-002: the database refuses a rating off the scale, a second profile per season and person, and deletion', async () => {
    const base = {
      organization_id: t.organizationId,
      season_id: season.seasonId,
      recorded_by: JSON.stringify({ kind: 'system', actorLabel: 'test' }),
      recorded_at: t.clock.now(),
    };
    const offScale = t.db
      .insertInto('season_player_profiles')
      .values({ ...base, id: newId(), person_id: tigers.captain.personId, skill_rating: 6 })
      .execute();
    await expect(offScale).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    const twice = t.db
      .insertInto('season_player_profiles')
      .values({ ...base, id: newId(), person_id: lions.player.personId, skill_rating: 2 })
      .execute();
    await expect(twice).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
    const nothing = t.db
      .insertInto('season_player_profiles')
      .values({ ...base, id: newId(), person_id: tigers.captain.personId })
      .execute();
    await expect(nothing).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    const remove = t.db
      .deleteFrom('season_player_profiles')
      .where('person_id', '=', lions.player.personId)
      .execute();
    await expect(remove).rejects.toSatisfy(isRestrictViolation);
  });

  // -------------------------------------------------------------------------------------------
  // Playoff line
  // -------------------------------------------------------------------------------------------
  it('SPK-RESULT-003: standings carry the playoff line of the division’s fixture specification; none without one', async () => {
    const divided = await createSeasonFixture(t, { status: 'active', name: 'Divided league' });
    const divisionId = await createDivisionFixture(t, { seasonId: divided.seasonId, name: 'D1' });
    const plain = await createDivisionFixture(t, { seasonId: divided.seasonId, name: 'D2' });
    for (const name of ['Aces', 'Bolts', 'Comets']) {
      await teamOf(name, divided.seasonId, divisionId);
    }
    const before = await get(
      `/seasons/${divided.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(before.status).toBe(200);
    expect(before.body.playoffLine).toBeNull();
    const spec = await post(`/divisions/${divisionId}/fixture-specifications`, leagueManager, {
      name: 'D1 league phase',
      facilityId: t.facilityId,
      gamesPerTeam: 2,
      opponentFrequency: 1,
      startsOn: '2027-01-16',
      endsOn: '2027-04-10',
      allowedStartTimes: [{ weekday: 6, time: '09:00' }],
      matchDurationMinutes: 60,
      requiredResourceIds: [pitch.pitchId],
      playoffStructure: { kind: 'single_elimination', teams: 2 },
    });
    expect(spec.status).toBe(201);
    const res = await get(
      `/seasons/${divided.seasonId}/standings?divisionId=${divisionId}`,
      leagueManager,
    );
    expect(res.body.playoffLine).toEqual({
      specificationId: spec.body.id,
      kind: 'single_elimination',
      qualifyingTeams: 2,
      cutPosition: 2,
    });
    const other = await get(
      `/seasons/${divided.seasonId}/standings?divisionId=${plain}`,
      leagueManager,
    );
    expect(other.body.playoffLine).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // Fixture attendance
  // -------------------------------------------------------------------------------------------
  it('SPK-UX-007: league staff mark players present on the match sheet; the sheet shows each mark and the count', async () => {
    const res = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: lions.teamEntryId,
      personId: lions.player.personId,
      state: 'present',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fixtureId,
      teamEntryId: lions.teamEntryId,
      personId: lions.player.personId,
      state: 'present',
    });
    const sheet = await get(`/fixtures/${fixtureId}/match-sheet`, leagueManager);
    expect(sheet.status).toBe(200);
    expect(sheet.body.canRecordAttendance).toBe(true);
    const home = sheet.body.sides.find((s: { entryId: string }) => s.entryId === lions.teamEntryId);
    expect(home.presentCount).toBe(1);
    expect(
      home.players.find((p: { personId: string }) => p.personId === lions.player.personId)
        .attendance,
    ).toBe('present');
    expect(
      home.players.find((p: { personId: string }) => p.personId === lions.captain.personId)
        .attendance,
    ).toBeNull();
  });

  it('SPK-STAFF-002/005: an official marks only with an accepted assignment for the fixture', async () => {
    const body = {
      teamEntryId: tigers.teamEntryId,
      personId: tigers.player.personId,
      state: 'absent',
    };
    const refused = await post(`/fixtures/${fixtureId}/attendance`, official, body);
    expect(refused.status).toBe(404);
    accepted.add(`${fixtureId}:${official.personId}`);
    const ok = await post(`/fixtures/${fixtureId}/attendance`, official, body);
    expect(ok.status).toBe(201);
    const corrected = await post(`/fixtures/${fixtureId}/attendance`, official, {
      ...body,
      state: 'present',
    });
    expect(corrected.status).toBe(201);
    const read = await get(`/fixtures/${fixtureId}/attendance`, official);
    expect(read.status).toBe(200);
    const away = read.body.sides.find(
      (s: { teamEntryId: string }) => s.teamEntryId === tigers.teamEntryId,
    );
    expect(away).toMatchObject({ present: 1, absent: 0 });
    expect(away.marks).toHaveLength(1);
    // The superseded mark stays (append-only chain).
    const chain = await t.db
      .selectFrom('fixture_attendance_marks')
      .select(['id', 'supersedes_mark_id', 'state'])
      .where('fixture_id', '=', fixtureId)
      .where('person_id', '=', tigers.player.personId)
      .execute();
    expect(chain).toHaveLength(2);
    expect(chain.find((m) => m.state === 'present')?.supersedes_mark_id).toBe(
      chain.find((m) => m.state === 'absent')?.id,
    );
  });

  it('SPK-UX-007: a captain marks only their own side; a person off the roster and clearing an unmarked player are refused', async () => {
    const own = await post(`/fixtures/${fixtureId}/attendance`, lions.captain, {
      teamEntryId: lions.teamEntryId,
      personId: lions.captain.personId,
      state: 'present',
    });
    expect(own.status).toBe(201);
    const otherSide = await post(`/fixtures/${fixtureId}/attendance`, lions.captain, {
      teamEntryId: tigers.teamEntryId,
      personId: tigers.captain.personId,
      state: 'absent',
    });
    expect(otherSide.status).toBe(404);
    const stranger = await adultCustomer(t);
    const offRoster = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: tigers.teamEntryId,
      personId: stranger.personId,
      state: 'present',
    });
    expect(offRoster.status).toBe(400);
    expect(offRoster.body.details.code).toBe('NOT_ON_ROSTER');
    const clear = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: tigers.teamEntryId,
      personId: tigers.captain.personId,
      state: 'cleared',
    });
    expect(clear.status).toBe(409);
    const nobody = await get(`/fixtures/${fixtureId}/attendance`, stranger);
    expect(nobody.status).toBe(404);
    // A captain reads only their own side.
    const captainRead = await get(`/fixtures/${fixtureId}/attendance`, lions.captain);
    expect(captainRead.body.sides.map((s: { teamEntryId: string }) => s.teamEntryId)).toEqual([
      lions.teamEntryId,
    ]);
  });

  it('SPK-UX-007: the database keeps each player’s marks one chain on a fixture side, and never rewrites a mark', async () => {
    const actor = JSON.stringify({ kind: 'system', actorLabel: 'test' });
    const base = {
      organization_id: t.organizationId,
      fixture_id: fixtureId,
      team_entry_id: lions.teamEntryId,
      person_id: lions.player.personId,
      recorded_by: actor,
      recorded_at: t.clock.now(),
    };
    const secondFirst = t.db
      .insertInto('fixture_attendance_marks')
      .values({ ...base, id: newId(), state: 'absent', supersedes_mark_id: null })
      .execute();
    await expect(secondFirst).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
    const first = await t.db
      .selectFrom('fixture_attendance_marks')
      .select('id')
      .where('fixture_id', '=', fixtureId)
      .where('person_id', '=', lions.player.personId)
      .executeTakeFirstOrThrow();
    await t.db
      .insertInto('fixture_attendance_marks')
      .values({ ...base, id: newId(), state: 'absent', supersedes_mark_id: first.id })
      .execute();
    const fork = t.db
      .insertInto('fixture_attendance_marks')
      .values({ ...base, id: newId(), state: 'present', supersedes_mark_id: first.id })
      .execute();
    await expect(fork).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
    const crossChain = t.db
      .insertInto('fixture_attendance_marks')
      .values({
        ...base,
        id: newId(),
        person_id: lions.captain.personId,
        state: 'present',
        supersedes_mark_id: first.id,
      })
      .execute();
    await expect(crossChain).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    const wrongSide = t.db
      .insertInto('fixture_attendance_marks')
      .values({
        ...base,
        id: newId(),
        team_entry_id: (
          await createTeamEntryFixture(t, {
            seasonId: season.seasonId,
            captainPersonId: lions.player.personId,
          })
        ).teamEntryId,
        state: 'present',
        supersedes_mark_id: null,
      })
      .execute();
    await expect(wrongSide).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
    const rewrite = t.db
      .updateTable('fixture_attendance_marks')
      .set({ state: 'present' })
      .where('id', '=', first.id)
      .execute();
    await expect(rewrite).rejects.toSatisfy(isRestrictViolation);
    // Restore the player to present through the service for the forfeit test below.
    const restore = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: lions.teamEntryId,
      personId: lions.player.personId,
      state: 'present',
    });
    expect(restore.status).toBe(201);
  });

  // -------------------------------------------------------------------------------------------
  // Results awaiting, suggested forfeit, reminders
  // -------------------------------------------------------------------------------------------
  it('SPK-RESULT-002: after the game a fixture without a result waits, with the forfeit the rule set and the attendance suggest', async () => {
    const early = await get(`/seasons/${season.seasonId}/results-awaiting`, leagueManager);
    expect(early.status).toBe(200);
    expect(early.body.items).toEqual([]);
    // Tigers: one player present against a minimum of two; Lions: two present.
    const tigerCaptain = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: tigers.teamEntryId,
      personId: tigers.captain.personId,
      state: 'absent',
    });
    expect(tigerCaptain.status).toBe(201);
    t.clock.set(new Date(at('2027-01-16', '20:00')));
    const res = await get(`/seasons/${season.seasonId}/results-awaiting`, leagueManager);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      fixtureId,
      minimumPlayersToStart: 2,
      sides: [
        { teamEntryId: lions.teamEntryId, teamName: 'Lions', present: 2 },
        { teamEntryId: tigers.teamEntryId, teamName: 'Tigers', present: 1 },
      ],
      suggestedForfeit: {
        forfeitingEntryId: tigers.teamEntryId,
        homeScore: 3,
        awayScore: 0,
      },
      reminderCount: 0,
      lastReminderAt: null,
    });
    const refused = await get(`/seasons/${season.seasonId}/results-awaiting`, frontDesk);
    expect(refused.status).toBe(403);
  });

  it('SPK-RESULT-001: a reminder reaches both captains, is recorded append-only and raises the event for communications', async () => {
    const byCaptain = await post(`/fixtures/${fixtureId}/result-reminders`, lions.captain, {});
    expect(byCaptain.status).toBe(404);
    const res = await post(`/fixtures/${fixtureId}/result-reminders`, leagueManager, {
      message: 'Please send the score.',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fixtureId,
      recipientCount: 2,
      message: 'Please send the score.',
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.result_reminder_requested')
      .where('aggregate_id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    expect((event.payload as { recipientPersonIds: string[] }).recipientPersonIds.sort()).toEqual(
      [lions.captain.personId, tigers.captain.personId].sort(),
    );
    const listed = await get(`/seasons/${season.seasonId}/results-awaiting`, leagueManager);
    expect(listed.body.items[0]).toMatchObject({
      reminderCount: 1,
      lastReminderAt: res.body.requestedAt,
    });
    const rewrite = t.db
      .updateTable('result_reminders')
      .set({ recipient_count: 0 })
      .where('id', '=', res.body.id)
      .execute();
    await expect(rewrite).rejects.toSatisfy(isRestrictViolation);
  });

  it('SPK-RESULT-002: recording the suggested forfeit through the ordinary submission takes the fixture off the list; attendance closes', async () => {
    const submitted = await post(`/fixtures/${fixtureId}/results`, leagueManager, {
      classification: 'forfeit',
      homeScore: 3,
      awayScore: 0,
      forfeitingEntryId: tigers.teamEntryId,
    });
    expect(submitted.status).toBe(201);
    const listed = await get(`/seasons/${season.seasonId}/results-awaiting`, leagueManager);
    expect(listed.body.items).toEqual([]);
    const reminder = await post(`/fixtures/${fixtureId}/result-reminders`, leagueManager, {});
    expect(reminder.status).toBe(201);
    const published = await post(`/results/${submitted.body.id}/publish`, leagueManager, {
      expectedRevision: submitted.body.revision,
    });
    expect(published.status).toBe(200);
    const late = await post(`/fixtures/${fixtureId}/attendance`, leagueManager, {
      teamEntryId: lions.teamEntryId,
      personId: lions.captain.personId,
      state: 'absent',
    });
    expect(late.status).toBe(409);
    const afterward = await post(`/fixtures/${fixtureId}/result-reminders`, leagueManager, {});
    expect(afterward.status).toBe(409);
  });
});
