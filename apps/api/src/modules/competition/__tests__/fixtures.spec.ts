import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { EventsService, at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { FIXTURE_PORT, type FixturePort } from '../ports';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

interface Team {
  teamEntryId: string;
  teamId: string;
  captain: Actor;
  player: Actor;
}

describe('fixtures and availability (§4.4 Matches, SPK-FIX-005, SPK-CAP-003, §4.8)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let lions: Team;
  let tigers: Team;
  let bears: Team;

  async function teamOf(name: string): Promise<Team> {
    const captain = await adultCustomer(t);
    const player = await adultCustomer(t);
    const entry = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
    });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: captain.personId });
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    return { teamEntryId: entry.teamEntryId, teamId: entry.teamId, captain, player };
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
      endsOn: '2027-04-10',
    });
    lions = await teamOf('Lions');
    tigers = await teamOf('Tigers');
    bears = await teamOf('Bears');
  });
  afterAll(async () => {
    await t.close();
  });

  const post = (path: string, actor: Actor, body: object, k: string = key()) =>
    t.http.post(`/v1${path}`).set(actor.header).set('Idempotency-Key', k).send(body);
  const patch = (path: string, actor: Actor, body: object) =>
    t.http.patch(`/v1${path}`).set(actor.header).set('Idempotency-Key', key()).send(body);
  const slot = (date: string, from: string, to: string) => ({
    facilityId: t.facilityId,
    resourceIds: [pitch.pitchId],
    scheduledStart: at(date, from),
    scheduledEnd: at(date, to),
  });

  let fixtureId: string;
  let eventId: string;

  it('SPK-FIX-005 / §4.9: the league manager creates a fixture and schedules it through the scheduling port with team commitments and a durable operation', async () => {
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      awayEntryId: tigers.teamEntryId,
      round: 1,
      schedule: slot('2027-01-16', '18:00', '19:00'),
    });
    expect(res.status).toBe(201);
    expect(res.body.operationStatus).toBe('succeeded');
    expect(res.body.fixture).toMatchObject({
      seasonId: season.seasonId,
      round: 1,
      homeEntryId: lions.teamEntryId,
      awayEntryId: tigers.teamEntryId,
      status: 'scheduled',
      scheduledStart: at('2027-01-16', '18:00'),
      scheduledEnd: at('2027-01-16', '19:00'),
      revision: 2,
    });
    fixtureId = res.body.fixture.id;
    eventId = res.body.fixture.schedulingEventId;
    expect(eventId).toEqual(expect.any(String));
    // the scheduling module owns the event; the fixture is its owning record with both teams committed
    const event = await t.db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      kind: 'game',
      title: 'Lions v Tigers',
      status: 'published',
      source_type: 'fixture',
      source_id: fixtureId,
      facility_id: t.facilityId,
    });
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select(['party_type', 'party_id', 'role'])
      .where('event_id', '=', eventId)
      .orderBy('role')
      .execute();
    expect(commitments).toEqual([
      { party_type: 'team', party_id: tigers.teamEntryId, role: 'away_team' },
      { party_type: 'team', party_id: lions.teamEntryId, role: 'home_team' },
    ]);
    const operation = await t.db
      .selectFrom('operations')
      .selectAll()
      .where('id', '=', res.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ kind: 'competition.create_fixture', status: 'succeeded' });
    expect(operation.result).toMatchObject({
      fixtureId,
      schedulingEventId: eventId,
      status: 'scheduled',
    });
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', fixtureId)
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => e.event_type)).toEqual([
      'competition.fixture_created',
      'competition.fixture_changed',
    ]);
    expect(events[1]?.payload).toMatchObject({
      change: 'scheduled',
      status: 'scheduled',
      previousStatus: 'unscheduled',
      schedulingEventId: eventId,
    });
    // authority and input guards
    const byFrontDesk = await post('/fixtures', frontDesk, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      awayEntryId: bears.teamEntryId,
    });
    expect(byFrontDesk.status).toBe(403);
    const byCaptain = await post('/fixtures', lions.captain, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      awayEntryId: bears.teamEntryId,
    });
    expect(byCaptain.status).toBe(403);
    const self = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      awayEntryId: lions.teamEntryId,
    });
    expect(self.status).toBe(400);
    const otherSeason = await createSeasonFixture(t, { status: 'active' });
    const crossSeason = await post('/fixtures', leagueManager, {
      seasonId: otherSeason.seasonId,
      homeEntryId: lions.teamEntryId,
    });
    expect(crossSeason.status).toBe(404);
  });

  it('§4.9 / §4.12: a scheduling conflict leaves the fixture unscheduled with a failed operation naming the reason; it can be scheduled later', async () => {
    const res = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: bears.teamEntryId,
      awayEntryId: tigers.teamEntryId,
      schedule: slot('2027-01-16', '18:30', '19:30'),
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESOURCE_CONFLICT');
    const row = await t.db
      .selectFrom('fixtures')
      .select(['id', 'status', 'scheduling_event_id', 'revision'])
      .where('season_id', '=', season.seasonId)
      .where('home_entry_id', '=', bears.teamEntryId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'unscheduled', scheduling_event_id: null, revision: 1 });
    const operation = await t.db
      .selectFrom('operations')
      .selectAll()
      .where('kind', '=', 'competition.create_fixture')
      .where('status', '=', 'failed')
      .executeTakeFirstOrThrow();
    expect(operation.error).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const readable = await t.http.get(`/v1/operations/${operation.id}`).set(leagueManager.header);
    expect(readable.status).toBe(200);
    expect(readable.body.status).toBe('failed');
    // the other pitch half at the same time is free: schedule there
    const scheduled = await patch(`/fixtures/${row.id}`, leagueManager, {
      action: 'schedule',
      expectedRevision: 1,
      schedule: { ...slot('2027-01-16', '20:00', '21:00'), resourceIds: [pitch.northHalfId] },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.fixture).toMatchObject({
      status: 'scheduled',
      scheduledStart: at('2027-01-16', '20:00'),
    });
  });

  it('reschedule, postpone, schedule again and cancel follow the fixture machine with revision guards; scheduling moves or cancels the event', async () => {
    const stale = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'reschedule',
      expectedRevision: 1,
      schedule: slot('2027-01-17', '18:00', '19:00'),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const moved = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'reschedule',
      expectedRevision: 2,
      schedule: slot('2027-01-17', '18:00', '19:00'),
      reason: 'referee availability',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.fixture).toMatchObject({
      status: 'scheduled',
      schedulingEventId: eventId,
      scheduledStart: at('2027-01-17', '18:00'),
      revision: 3,
    });
    const event = await t.db
      .selectFrom('events')
      .select(['scheduled_start', 'status'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(new Date(event.scheduled_start).toISOString()).toBe(at('2027-01-17', '18:00'));

    const noReason = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'postpone',
      expectedRevision: 3,
    });
    expect(noReason.status).toBe(400);
    const postponed = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'postpone',
      expectedRevision: 3,
      reason: 'frozen pitch',
    });
    expect(postponed.status).toBe(200);
    expect(postponed.body.fixture).toMatchObject({
      status: 'postponed',
      schedulingEventId: null,
      scheduledStart: null,
      revision: 4,
    });
    expect(
      (
        await t.db
          .selectFrom('events')
          .select('status')
          .where('id', '=', eventId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('canceled');
    const again = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'reschedule',
      expectedRevision: 4,
      schedule: slot('2027-01-24', '18:00', '19:00'),
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const rescheduled = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'schedule',
      expectedRevision: 4,
      schedule: slot('2027-01-24', '18:00', '19:00'),
    });
    expect(rescheduled.status).toBe(200);
    expect(rescheduled.body.fixture.status).toBe('scheduled');
    expect(rescheduled.body.fixture.schedulingEventId).not.toBe(eventId);
    eventId = rescheduled.body.fixture.schedulingEventId;
    const edited = await patch(`/fixtures/${fixtureId}`, leagueManager, {
      action: 'edit',
      expectedRevision: 5,
      round: 2,
      notes: 'moved to week 3',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.fixture).toMatchObject({
      round: 2,
      notes: 'moved to week 3',
      status: 'scheduled',
      revision: 6,
    });
    const denied = await patch(`/fixtures/${fixtureId}`, frontDesk, {
      action: 'cancel',
      expectedRevision: 6,
      reason: 'nope',
    });
    expect(denied.status).toBe(403);
    const changes = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', fixtureId)
      .where('event_type', '=', 'competition.fixture_changed')
      .orderBy('occurred_at')
      .execute();
    expect(changes.map((c) => (c.payload as { change: string }).change)).toEqual([
      'scheduled',
      'rescheduled',
      'postponed',
      'scheduled',
      'edited',
    ]);
  });

  it('a bye is a fixture without an opponent; the season list is paginated and filterable', async () => {
    const bye = await post('/fixtures', leagueManager, {
      seasonId: season.seasonId,
      homeEntryId: lions.teamEntryId,
      round: 3,
    });
    expect(bye.status).toBe(201);
    expect(bye.body.fixture).toMatchObject({ awayEntryId: null, status: 'unscheduled' });
    expect(bye.body.operationStatus).toBe('succeeded');
    const first = await t.http
      .get(`/v1/seasons/${season.seasonId}/fixtures`)
      .set(lions.captain.header)
      .query({ limit: 1 });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const seen = [first.body.items[0].id as string];
    let cursor = first.body.nextCursor as string | null;
    while (cursor) {
      const page = await t.http
        .get(`/v1/seasons/${season.seasonId}/fixtures`)
        .set(lions.captain.header)
        .query({ limit: 1, cursor });
      expect(page.status).toBe(200);
      for (const item of page.body.items) seen.push(item.id);
      cursor = page.body.nextCursor;
    }
    expect(new Set(seen).size).toBe(3);
    expect(seen[seen.length - 1]).toBe(bye.body.fixture.id); // unscheduled last
    const ofTigers = await t.http
      .get(`/v1/seasons/${season.seasonId}/fixtures`)
      .set(frontDesk.header)
      .query({ teamEntryId: tigers.teamEntryId, status: 'scheduled' });
    expect(ofTigers.body.items.map((f: { id: string }) => f.id).sort()).toHaveLength(2);
    expect(ofTigers.body.items.map((f: { id: string }) => f.id)).toContain(fixtureId);
    const port = t.app.get<FixturePort>(FIXTURE_PORT);
    expect(
      (await port.fixturesOfEntry(t.organizationId, lions.teamEntryId)).map((f) => f.id),
    ).toEqual(expect.arrayContaining([fixtureId, bye.body.fixture.id]));
    expect(await port.findFixture(t.organizationId, bye.body.fixture.id)).toMatchObject({
      status: 'unscheduled',
      awayEntryId: null,
    });
  });

  it('§4.10: roster players and staff read a fixture with availability summaries; strangers are told not-found', async () => {
    const stranger = await adultCustomer(t);
    expect((await t.http.get(`/v1/fixtures/${fixtureId}`).set(stranger.header)).status).toBe(404);
    expect((await t.http.get(`/v1/fixtures/${fixtureId}`).set(bears.player.header)).status).toBe(
      404,
    );
    const asPlayer = await t.http.get(`/v1/fixtures/${fixtureId}`).set(tigers.player.header);
    expect(asPlayer.status).toBe(200);
    expect(asPlayer.body).toMatchObject({
      id: fixtureId,
      home: {
        entryId: lions.teamEntryId,
        teamId: lions.teamId,
        teamName: 'Lions',
        availability: { available: 0, unavailable: 0, tentative: 0, noResponse: 2 },
      },
      away: { entryId: tigers.teamEntryId, teamName: 'Tigers', availability: { noResponse: 2 } },
      myResponse: null,
    });
    expect((await t.http.get(`/v1/fixtures/${fixtureId}`).set(frontDesk.header)).status).toBe(200);
  });

  it('SPK-CAP-003: RSVP by the player, a guardian with register, or staff; it is neither attendance nor eligibility', async () => {
    const first = await post(`/fixtures/${fixtureId}/availability`, tigers.player, {
      state: 'available',
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      fixtureId,
      teamEntryId: tigers.teamEntryId,
      personId: tigers.player.personId,
      state: 'available',
      respondedAt: '2026-10-23T12:00:00.000Z',
      revision: 1,
    });
    const changed = await post(`/fixtures/${fixtureId}/availability`, tigers.player, {
      state: 'unavailable',
      note: 'travelling',
    });
    expect(changed.body).toMatchObject({ state: 'unavailable', note: 'travelling', revision: 2 });
    const tentative = await post(`/fixtures/${fixtureId}/availability`, lions.captain, {
      state: 'tentative',
    });
    expect(tentative.status).toBe(200);
    const detail = await t.http.get(`/v1/fixtures/${fixtureId}`).set(tigers.player.header);
    expect(detail.body.home.availability).toEqual({
      available: 0,
      unavailable: 0,
      tentative: 1,
      noResponse: 1,
    });
    expect(detail.body.away.availability).toEqual({
      available: 0,
      unavailable: 1,
      tentative: 0,
      noResponse: 1,
    });
    expect(detail.body.myResponse).toBe('unavailable');
    // not on either roster: nothing to respond for; staff may record for a player
    const stranger = await adultCustomer(t);
    expect(
      (await post(`/fixtures/${fixtureId}/availability`, stranger, { state: 'available' })).status,
    ).toBe(400);
    expect(
      (
        await post(`/fixtures/${fixtureId}/availability`, bears.player, {
          state: 'available',
          personId: tigers.player.personId,
        })
      ).status,
    ).toBe(404);
    const byStaff = await post(`/fixtures/${fixtureId}/availability`, frontDesk, {
      state: 'no_response',
      personId: tigers.player.personId,
    });
    expect(byStaff.body).toMatchObject({ state: 'no_response', respondedAt: null, revision: 3 });
    // a guardian answers for a child on the roster only with the register permission
    const child = await createPersonFixture(t, { kind: 'child' });
    await addRosterMemberFixture(t, { teamEntryId: lions.teamEntryId, personId: child });
    const guardian = await adultCustomer(t);
    const viewer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: guardian.personId,
      subjectPersonId: child,
      permissions: ['view', 'register'],
    });
    await createRelationshipFixture(t, {
      actorPersonId: viewer.personId,
      subjectPersonId: child,
      permissions: ['view'],
    });
    expect(
      (
        await post(`/fixtures/${fixtureId}/availability`, viewer, {
          state: 'available',
          personId: child,
        })
      ).status,
    ).toBe(404);
    const forChild = await post(`/fixtures/${fixtureId}/availability`, guardian, {
      state: 'available',
      personId: child,
    });
    expect(forChild.status).toBe(200);
    expect(forChild.body).toMatchObject({
      personId: child,
      teamEntryId: lions.teamEntryId,
      state: 'available',
    });
    // RSVP changed nothing about the roster or eligibility
    const roster = await t.http
      .get(`/v1/team-entries/${tigers.teamEntryId}/roster`)
      .set(tigers.captain.header);
    expect(
      roster.body.members.find((m: { personId: string }) => m.personId === tigers.player.personId),
    ).toMatchObject({ status: 'active', eligibility: { status: 'eligible' } });
    const rsvps = await t.db
      .selectFrom('availability_responses')
      .select(['person_id', 'state'])
      .where('fixture_id', '=', fixtureId)
      .execute();
    expect(rsvps).toHaveLength(3);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', fixtureId)
      .where('event_type', '=', 'competition.availability_responded')
      .execute();
    expect(events).toHaveLength(5);
  });

  it('SPK-CAP-001: the captain workspace lists upcoming fixtures with the opponent, availability and the captain’s own answer', async () => {
    const workspace = await t.http
      .get(`/v1/team-entries/${lions.teamEntryId}`)
      .set(lions.captain.header);
    expect(workspace.status).toBe(200);
    const upcoming = workspace.body.upcomingFixtures as Array<Record<string, unknown>>;
    expect(upcoming.map((u) => (u.fixture as { id: string }).id)).toContain(fixtureId);
    const match = upcoming.find((u) => (u.fixture as { id: string }).id === fixtureId);
    expect(match).toMatchObject({
      side: 'home',
      opponent: { entryId: tigers.teamEntryId, teamName: 'Tigers' },
      availability: { tentative: 1, available: 1, noResponse: 1 },
      myResponse: 'tentative',
    });
    const bye = upcoming.find(
      (u) => (u.fixture as { awayEntryId: string | null }).awayEntryId === null,
    );
    expect(bye).toMatchObject({ opponent: null, side: 'home' });
  });

  it('scheduling.event_changed keeps the fixture copy in sync when scheduling moves or cancels the event directly (idempotent under replay)', async () => {
    const events = t.app.get(EventsService);
    const dispatcher = t.app.get(OutboxDispatcher);
    const scheduler = staffPrincipal(t.organizationId, ['scheduler']);
    await dispatcher.runOnce(200); // settle everything so far
    const before = await t.db
      .selectFrom('fixtures')
      .select('revision')
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    await events.moveEvent(scheduler, eventId, {
      scheduledStart: at('2027-01-24', '19:00'),
      scheduledEnd: at('2027-01-24', '20:00'),
      reason: 'swap with youth game',
    });
    await dispatcher.runOnce(200);
    const synced = await t.db
      .selectFrom('fixtures')
      .select(['status', 'scheduling_event_id', 'scheduled_start', 'revision'])
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    expect(synced).toMatchObject({
      status: 'scheduled',
      scheduling_event_id: eventId,
      revision: before.revision + 1,
    });
    expect(new Date(synced.scheduled_start as Date).toISOString()).toBe(at('2027-01-24', '19:00'));
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'details'])
      .where('target_id', '=', fixtureId)
      .execute();
    const sync = audit.filter(
      (a) => (a.details as { change?: string }).change === 'synced_from_scheduling',
    );
    expect(sync).toHaveLength(1);
    expect(sync[0]?.actor).toMatchObject({
      kind: 'system',
      actorLabel: 'competition.sync_fixture_schedule',
    });
    await dispatcher.runOnce(200);
    expect(
      (
        await t.db
          .selectFrom('fixtures')
          .select('revision')
          .where('id', '=', fixtureId)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(before.revision + 1);

    await events.cancelEvent(scheduler, eventId, { reason: 'field closed' });
    await dispatcher.runOnce(200);
    const postponed = await t.db
      .selectFrom('fixtures')
      .select(['status', 'scheduling_event_id', 'scheduled_start'])
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    expect(postponed).toEqual({
      status: 'postponed',
      scheduling_event_id: null,
      scheduled_start: null,
    });
    const summary = await dispatcher.runOnce(200);
    expect(summary.dead).toBe(0);
  });
});
