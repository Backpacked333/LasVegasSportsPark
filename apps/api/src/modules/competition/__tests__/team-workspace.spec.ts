import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { ASSIGNMENT_CHECK_IMPL, type AssignmentCheckPort } from '../competition-matches.ports';
import {
  addRosterMemberFixture,
  assignTeamRoleFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import {
  adultCustomer,
  CLOCK_START,
  competitionTestApp,
  key,
  staffMember,
  type Actor,
} from './support';

const NOW = new Date(CLOCK_START).toISOString();

interface Team {
  teamEntryId: string;
  teamId: string;
  captain: Actor;
  player: Actor;
}

/**
 * Stage-3 team workspace reads (CMP-01, CMP-02, CMP-04, CMP-06, CMP-14): team names on lists,
 * season readiness in one read, my teams and fixtures, the fixture venue and availability rules,
 * the field-limited match sheet and captain availability requests.
 */
describe('team workspace (CMP-01, CMP-02, CMP-04, CMP-06, CMP-14; SPK-CAP-001/003, SPK-READY-001, SPK-SCHED-008, SPK-UX-007)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let official: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let lions: Team;
  let tigers: Team;
  let coCaptain: Actor;
  let guardian: Actor;
  let distantRelative: Actor;
  let child: string;
  let fixtureId: string;
  let byeFixtureId: string;
  const accepted = new Set<string>();
  const assignments: AssignmentCheckPort = {
    isAcceptedOfficial: async (_organizationId, fixture, personId) =>
      accepted.has(`${fixture}:${personId}`),
  };

  async function teamOf(name: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const player = await adultCustomer(t, { dateOfBirth: '1990-07-14' });
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: captain.personId,
      jerseyNumber: 1,
    });
    await addRosterMemberFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: player.personId,
      jerseyNumber: 9,
    });
    return { teamEntryId: entry.teamEntryId, teamId: entry.teamId, captain, player };
  }

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const get = (path: string, actor: Actor) => t.http.get(`/v1${path}`).set(actor.header);
  const settle = () => t.app.get(OutboxDispatcher).runOnce(500);

  async function scheduleFixture(date: string, home: Team, away: Team): Promise<string> {
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
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
    await settle();
    return res.body.fixture.id as string;
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
    });
    lions = await teamOf('Lions');
    tigers = await teamOf('Tigers');
    coCaptain = await adultCustomer(t);
    await addRosterMemberFixture(t, {
      teamEntryId: lions.teamEntryId,
      personId: coCaptain.personId,
    });
    await assignTeamRoleFixture(t, {
      teamEntryId: lions.teamEntryId,
      personId: coCaptain.personId,
      role: 'co_captain',
    });
    child = await createPersonFixture(t, { kind: 'child', dateOfBirth: '2013-03-21' });
    await addRosterMemberFixture(t, {
      teamEntryId: lions.teamEntryId,
      personId: child,
      jerseyNumber: 7,
    });
    guardian = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions: ['view', 'register'],
    });
    // a relative who may pay for the child but holds no view over them
    distantRelative = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: distantRelative.personId,
      subjectPersonId: child,
      permissions: ['pay'],
    });
    fixtureId = await scheduleFixture('2027-01-16', lions, tigers);
    byeFixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      homeEntryId: tigers.teamEntryId,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  // CMP-01 ---------------------------------------------------------------------------------------
  it('CMP-01: fixture lists and team entries carry team names', async () => {
    const list = await get(`/seasons/${season.seasonId}/fixtures`, leagueManager);
    expect(list.status).toBe(200);
    const scheduled = list.body.items.find((f: { id: string }) => f.id === fixtureId);
    expect(scheduled).toMatchObject({ homeTeamName: 'Lions', awayTeamName: 'Tigers' });
    const bye = list.body.items.find((f: { id: string }) => f.id === byeFixtureId);
    expect(bye).toMatchObject({ homeTeamName: 'Tigers', awayTeamName: null });

    const entries = await get(`/team-entries?seasonId=${season.seasonId}`, leagueManager);
    expect(entries.status).toBe(200);
    expect(
      (entries.body as Array<{ id: string; teamName: string }>)
        .map((e) => [e.id, e.teamName])
        .sort((a, b) => (a[1] as string).localeCompare(b[1] as string)),
    ).toEqual([
      [lions.teamEntryId, 'Lions'],
      [tigers.teamEntryId, 'Tigers'],
    ]);
    const workspace = await get(`/team-entries/${lions.teamEntryId}`, lions.captain);
    expect(workspace.body.entry.teamName).toBe('Lions');
  });

  it('SPK-READY-001: season readiness summarizes each fixture in one request (counts only; unknown stays unknown)', async () => {
    const res = await get(`/seasons/${season.seasonId}/readiness`, leagueManager);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ seasonId: season.seasonId, evaluatedAt: NOW });
    expect(res.body.items.map((i: { fixtureId: string }) => i.fixtureId).sort()).toEqual(
      [fixtureId, byeFixtureId].sort(),
    );
    for (const item of res.body.items as Array<{
      fixtureId: string;
      status: string;
      blockingCount: number;
      unknownCount: number;
    }>) {
      const single = await get(`/fixtures/${item.fixtureId}/readiness`, leagueManager);
      expect(single.status).toBe(200);
      const issues = single.body.issues as Array<{ severity: string }>;
      expect(item).toEqual({
        fixtureId: item.fixtureId,
        status: single.body.status,
        blockingCount: issues.filter((i) => i.severity === 'blocking').length,
        unknownCount: issues.filter((i) => i.severity === 'unknown').length,
      });
    }
    // the unscheduled bye is not ready: its readiness is never reported as ready
    const bye = res.body.items.find((i: { fixtureId: string }) => i.fixtureId === byeFixtureId);
    expect(bye.status).not.toBe('ready');
    // the window narrows the read to fixtures scheduled in it
    const windowed = await get(
      `/seasons/${season.seasonId}/readiness?from=${encodeURIComponent(at('2027-01-16', '00:00'))}&to=${encodeURIComponent(at('2027-01-17', '00:00'))}`,
      leagueManager,
    );
    expect(windowed.body.items.map((i: { fixtureId: string }) => i.fixtureId)).toEqual([fixtureId]);
    // a captain is not league staff
    expect((await get(`/seasons/${season.seasonId}/readiness`, lions.captain)).status).toBe(403);
    // more than 100 fixtures must be narrowed with from and to
    const crowded = await createSeasonFixture(t, { status: 'active' });
    const home = await createTeamEntryFixture(t, {
      seasonId: crowded.seasonId,
      captainPersonId: lions.captain.personId,
    });
    for (let i = 0; i < 101; i += 1) {
      await createFixtureFixture(t, { seasonId: crowded.seasonId, homeEntryId: home.teamEntryId });
    }
    const tooMany = await get(`/seasons/${crowded.seasonId}/readiness`, leagueManager);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'TOO_MANY_FIXTURES', limit: 100 },
    });
  });

  // CMP-02 ---------------------------------------------------------------------------------------
  it('SPK-CAP-001: a player and their guardian list the teams they are on with the next fixture', async () => {
    const mine = await get('/me/team-entries', lions.player);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({
      teamEntry: { id: lions.teamEntryId, teamName: 'Lions' },
      teamName: 'Lions',
      seasonId: season.seasonId,
      seasonName: 'Winter league',
      divisionName: null,
      members: [{ personId: lions.player.personId, roles: [], rosterStatus: 'active' }],
      nextFixture: {
        fixtureId,
        scheduledStart: at('2027-01-16', '18:00'),
        opponentTeamName: 'Tigers',
        venue: { facilityId: t.facilityId, resources: [{ id: pitch.pitchId, name: 'Pitch 1' }] },
        readiness: {
          status: expect.any(String),
          blockingCount: expect.any(Number),
          unknownCount: expect.any(Number),
        },
      },
    });
    // the captain's membership carries the role
    const captains = await get('/me/team-entries', lions.captain);
    expect(captains.body[0].members).toEqual([
      { personId: lions.captain.personId, roles: ['captain'], rosterStatus: 'active' },
    ]);
    // the guardian lists the child's team, naming the child as the member
    const family = await get('/me/team-entries', guardian);
    expect(family.status).toBe(200);
    expect(family.body).toHaveLength(1);
    expect(family.body[0]).toMatchObject({
      teamName: 'Lions',
      members: [{ personId: child, roles: [], rosterStatus: 'active' }],
      nextFixture: { fixtureId, opponentTeamName: 'Tigers' },
    });
    // the fixtures of those teams in a window, with the child's answer the guardian may change
    const fixtures = await get('/me/fixtures', guardian);
    expect(fixtures.status).toBe(200);
    expect(fixtures.body.map((f: { id: string }) => f.id)).toEqual([fixtureId]);
    expect(fixtures.body[0].responses).toEqual([
      { personId: child, state: 'no_response', revision: null, respondedAt: null },
    ]);
    // a status filter: no withdrawn entries
    expect((await get('/me/team-entries?status=withdrawn', lions.player)).body).toEqual([]);
    // the window spans at most 120 days
    const tooLong = await get(
      `/me/fixtures?from=${encodeURIComponent('2027-01-01T00:00:00Z')}&to=${encodeURIComponent('2027-06-01T00:00:00Z')}`,
      guardian,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.details).toMatchObject({ code: 'WINDOW_TOO_LONG', maxDays: 120 });
  });

  it("CMP-02: a guardian without view over a child never lists that child's team; staff and strangers list nothing", async () => {
    expect((await get('/me/team-entries', distantRelative)).body).toEqual([]);
    expect((await get('/me/fixtures', distantRelative)).body).toEqual([]);
    expect((await get('/me/team-entries', await adultCustomer(t))).body).toEqual([]);
    expect((await get('/me/team-entries', leagueManager)).body).toEqual([]);
  });

  it('CMP-02: the workspace viewer block names the viewer roles and distinguishes hidden (null) from empty pending lists', async () => {
    const asCaptain = await get(`/team-entries/${lions.teamEntryId}`, lions.captain);
    expect(asCaptain.status).toBe(200);
    expect(asCaptain.body.viewer).toMatchObject({ roles: ['captain'], actingAsCaptain: true });
    expect(asCaptain.body.viewer.availableActions).toEqual(
      expect.arrayContaining(['competition.request_availability']),
    );
    expect(asCaptain.body.pendingInvitations).toEqual([]);
    expect(asCaptain.body.pendingJoinRequests).toEqual([]);
    // a co-captain does not act as captain unless the rule set says so (DEC-002 proposed default)
    const asCoCaptain = await get(`/team-entries/${lions.teamEntryId}`, coCaptain);
    expect(asCoCaptain.body.viewer).toMatchObject({
      roles: ['co_captain'],
      actingAsCaptain: false,
    });
    expect(asCoCaptain.body.viewer.availableActions).not.toContain(
      'competition.request_availability',
    );
    const asPlayer = await get(`/team-entries/${lions.teamEntryId}`, lions.player);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body.viewer).toMatchObject({ roles: [], actingAsCaptain: false });
    expect(asPlayer.body.pendingInvitations).toBeNull();
    expect(asPlayer.body.pendingJoinRequests).toBeNull();
  });

  // CMP-04 ---------------------------------------------------------------------------------------
  it('SPK-SCHED-008: a fixture carries its facility time zone and pitch names, copied without bumping the fixture revision', async () => {
    const facility = await t.db
      .selectFrom('facilities')
      .select(['name', 'timezone'])
      .where('id', '=', t.facilityId)
      .executeTakeFirstOrThrow();
    const detail = await get(`/fixtures/${fixtureId}`, lions.player);
    expect(detail.status).toBe(200);
    expect(detail.body.venue).toEqual({
      facilityId: t.facilityId,
      facilityName: facility.name,
      timezone: facility.timezone,
      resources: [{ id: pitch.pitchId, name: 'Pitch 1' }],
    });
    expect(detail.body.rosterStatus).toBe('active');
    // the projection is a read model: replaying deliveries changes nothing
    const before = await t.db
      .selectFrom('fixtures')
      .select(['revision', 'venue_event_revision'])
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    expect(before.venue_event_revision).toBeGreaterThanOrEqual(1);
    await settle();
    expect(
      await t.db
        .selectFrom('fixtures')
        .select(['revision', 'venue_event_revision'])
        .where('id', '=', fixtureId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    // an unscheduled fixture has no venue yet
    expect((await get(`/fixtures/${byeFixtureId}`, tigers.captain)).body.venue).toBeNull();
  });

  it('SPK-CAP-003: a stale availability answer fails with STALE_REVISION; answers close at kickoff', async () => {
    const first = await post(`/fixtures/${fixtureId}/availability`, lions.player, {
      state: 'available',
    });
    expect(first.status).toBe(200);
    expect(first.body.revision).toBe(1);
    const changed = await post(`/fixtures/${fixtureId}/availability`, lions.player, {
      state: 'tentative',
      expectedRevision: 1,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.revision).toBe(2);
    const stale = await post(`/fixtures/${fixtureId}/availability`, lions.player, {
      state: 'unavailable',
      expectedRevision: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    // the guardian answers for the child and sees the child's answer with its revision
    expect(
      (
        await post(`/fixtures/${fixtureId}/availability`, guardian, {
          state: 'available',
          personId: child,
        })
      ).status,
    ).toBe(200);
    const asGuardian = await get(`/fixtures/${fixtureId}`, guardian);
    expect(asGuardian.body.responses).toEqual([
      { personId: child, state: 'available', revision: 1, respondedAt: NOW },
    ]);
    const asPlayer = await get(`/fixtures/${fixtureId}`, lions.player);
    expect(asPlayer.body.responses).toEqual([
      { personId: lions.player.personId, state: 'tentative', revision: 2, respondedAt: NOW },
    ]);
    // at kickoff the answers close (no rule set defines a cutoff yet, DEC-002)
    t.clock.set(at('2027-01-16', '18:00'));
    try {
      const late = await post(`/fixtures/${fixtureId}/availability`, lions.player, {
        state: 'available',
        expectedRevision: 2,
      });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { code: 'AVAILABILITY_CLOSED' },
      });
    } finally {
      t.clock.set(CLOCK_START);
    }
  });

  // CMP-06 ---------------------------------------------------------------------------------------
  it('SPK-STAFF-005 / SPK-UX-007: an accepted official reads the match sheet; a proposed one gets NOT_FOUND', async () => {
    const proposed = await get(`/fixtures/${fixtureId}/match-sheet`, official);
    expect(proposed.status).toBe(404);
    accepted.add(`${fixtureId}:${official.personId}`);
    const sheet = await get(`/fixtures/${fixtureId}/match-sheet`, official);
    expect(sheet.status).toBe(200);
    expect(sheet.body).toMatchObject({
      fixtureId,
      scheduledStart: at('2027-01-16', '18:00'),
      status: 'scheduled',
      view: 'full',
      venue: { facilityId: t.facilityId },
    });
    const [home, away] = sheet.body.sides;
    expect(home.entryId).toBe(lions.teamEntryId);
    expect(home.teamName).toBe('Lions');
    expect(away.teamName).toBe('Tigers');
    expect(home.players.map((p: { jerseyNumber: number | null }) => p.jerseyNumber)).toEqual([
      1,
      7,
      9,
      null,
    ]);
    expect(home.players[0]).toMatchObject({
      personId: lions.captain.personId,
      jerseyNumber: 1,
      playingStatus: 'active',
      roles: ['captain'],
    });
    // league staff read it by role; a captain sees names and numbers only
    expect((await get(`/fixtures/${fixtureId}/match-sheet`, leagueManager)).body.view).toBe('full');
    const asCaptain = await get(`/fixtures/${fixtureId}/match-sheet`, tigers.captain);
    expect(asCaptain.status).toBe(200);
    expect(asCaptain.body.view).toBe('captain');
    for (const side of asCaptain.body.sides) {
      for (const player of side.players) {
        expect(player).toMatchObject({ personId: null, playingStatus: null, roles: [] });
        expect(player.displayName).toEqual(expect.any(String));
      }
    }
    // no basis: protected NOT_FOUND
    expect((await get(`/fixtures/${fixtureId}/match-sheet`, lions.player)).status).toBe(404);
    expect((await get(`/fixtures/${fixtureId}/match-sheet`, frontDesk)).status).toBe(404);
    expect((await get(`/fixtures/${fixtureId}/match-sheet`, guardian)).status).toBe(404);
  });

  it('§4.14: the match sheet never carries dates of birth, contacts, eligibility or guardian data', async () => {
    const sheet = await get(`/fixtures/${fixtureId}/match-sheet`, leagueManager);
    expect(sheet.status).toBe(200);
    const text = JSON.stringify(sheet.body);
    expect(text).not.toContain('2013-03-21');
    expect(text).not.toContain('1990-07-14');
    expect(text).not.toContain(guardian.personId);
    for (const forbidden of [
      'dateOfBirth',
      'email',
      'phone',
      'contact',
      'guardian',
      'eligib',
      'suspension',
      'reasons',
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    for (const side of sheet.body.sides) {
      for (const player of side.players) {
        expect(Object.keys(player).sort()).toEqual(
          ['displayName', 'jerseyNumber', 'personId', 'playingStatus', 'roles'].sort(),
        );
      }
    }
  });

  // CMP-14 ---------------------------------------------------------------------------------------
  it('SPK-CAP-001: a captain requests availability and only players without an answer are recipients', async () => {
    const second = await scheduleFixture('2027-01-23', lions, tigers);
    expect(
      (await post(`/fixtures/${second}/availability`, lions.player, { state: 'available' })).status,
    ).toBe(200);
    const res = await post(`/fixtures/${second}/availability-requests`, lions.captain, {
      teamEntryId: lions.teamEntryId,
      message: 'Who can make Saturday?',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fixtureId: second,
      teamEntryId: lions.teamEntryId,
      requestedByPersonId: lions.captain.personId,
      message: 'Who can make Saturday?',
      requestedAt: NOW,
      recipientCount: 3,
    });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.availability_requested')
      .where('aggregate_id', '=', second)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      requestId: res.body.id,
      fixtureId: second,
      teamEntryId: lions.teamEntryId,
      recipientPersonIds: [lions.captain.personId, coCaptain.personId, child].sort(),
      scheduledStart: at('2027-01-23', '18:00'),
      facilityId: t.facilityId,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', res.body.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: 'competition.request_availability',
      details: { reminder: false },
    });

    // CMP-14: a repeated request reaches only those still without an answer
    await post(`/fixtures/${second}/availability`, guardian, {
      state: 'tentative',
      personId: child,
    });
    await post(`/fixtures/${second}/availability`, coCaptain, { state: 'unavailable' });
    t.clock.advance(3_600_000);
    const reminder = await post(`/fixtures/${second}/availability-requests`, lions.captain, {
      teamEntryId: lions.teamEntryId,
    });
    expect(reminder.status).toBe(201);
    expect(reminder.body.recipientCount).toBe(1);
    const reminderEvent = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'competition.availability_requested')
      .where('aggregate_id', '=', second)
      .execute();
    expect(
      reminderEvent.map((e) => (e.payload as { recipientPersonIds: string[] }).recipientPersonIds),
    ).toContainEqual([lions.captain.personId]);
    const reminderAudit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', reminder.body.id)
      .executeTakeFirstOrThrow();
    expect(reminderAudit.details).toMatchObject({ reminder: true });
    // league staff ask too
    const byStaff = await post(`/fixtures/${second}/availability-requests`, leagueManager, {
      teamEntryId: tigers.teamEntryId,
    });
    expect(byStaff.status).toBe(201);
    expect(byStaff.body.recipientCount).toBe(2);
    // earlier requests, newest first, for the captain's side only
    const list = await get(`/fixtures/${second}/availability-requests`, lions.captain);
    expect(list.status).toBe(200);
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([reminder.body.id, res.body.id]);
    const staffList = await get(
      `/fixtures/${second}/availability-requests?teamEntryId=${tigers.teamEntryId}`,
      leagueManager,
    );
    expect(staffList.body.map((r: { id: string }) => r.id)).toEqual([byStaff.body.id]);
    t.clock.set(CLOCK_START);
  });

  it('CMP-14: a player cannot request; a request after kickoff is refused', async () => {
    const third = await scheduleFixture('2027-01-30', lions, tigers);
    const byPlayer = await post(`/fixtures/${third}/availability-requests`, lions.player, {
      teamEntryId: lions.teamEntryId,
    });
    expect(byPlayer.status).toBe(404);
    // a co-captain acts as captain only when the rule set says so
    const byCoCaptain = await post(`/fixtures/${third}/availability-requests`, coCaptain, {
      teamEntryId: lions.teamEntryId,
    });
    expect(byCoCaptain.status).toBe(404);
    // the other side's captain cannot ask this side
    const byOpponent = await post(`/fixtures/${third}/availability-requests`, tigers.captain, {
      teamEntryId: lions.teamEntryId,
    });
    expect(byOpponent.status).toBe(404);
    // an entry that is not a side of the fixture
    const stranger = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: lions.captain.personId,
    });
    expect(
      (
        await post(`/fixtures/${third}/availability-requests`, lions.captain, {
          teamEntryId: stranger.teamEntryId,
        })
      ).status,
    ).toBe(404);
    expect((await get(`/fixtures/${third}/availability-requests`, lions.player)).status).toBe(404);
    expect((await get(`/fixtures/${third}/availability-requests`, lions.captain)).body).toEqual([]);
    t.clock.set(at('2027-01-30', '18:00'));
    try {
      const late = await post(`/fixtures/${third}/availability-requests`, lions.captain, {
        teamEntryId: lions.teamEntryId,
      });
      expect(late.status).toBe(409);
      expect(late.body).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { code: 'AVAILABILITY_CLOSED' },
      });
    } finally {
      t.clock.set(CLOCK_START);
    }
    // nothing was recorded for the refused requests
    expect(
      await t.db
        .selectFrom('availability_requests')
        .select('id')
        .where('fixture_id', '=', third)
        .execute(),
    ).toEqual([]);
  });
});
