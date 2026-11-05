import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher, UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import {
  EventsService,
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
} from '../testing/competition-fixtures';
import { FixturesService } from '../services/fixtures.service';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

/**
 * R3-TRACE-A-04 (SPK-FIX-002 "partial publication must explicitly record remaining obligations,
 * owner and deadline"; SPK-SCHED-006 step 4; SPK-AT-010 step 5). A fixture whose published game is
 * canceled is unscheduled again: the publication that cancels it reports it as a remaining
 * obligation and never resolves the season's incomplete-season exception, and a cancellation made
 * outside a draft (directly, or by a closure) opens that exception with owner and deadline too.
 */
describe('R3-TRACE-A-04: a canceled fixture game is a remaining obligation', () => {
  let t: TestApp;
  let pitch: PitchFixture;
  let drafts: ScheduleDraftsService;
  let dispatcher: OutboxDispatcher;
  let leagueManager: Actor;
  const scheduler = () => staffPrincipal(t.organizationId, ['scheduler']);

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    drafts = t.app.get(ScheduleDraftsService);
    dispatcher = t.app.get(OutboxDispatcher);
  });
  afterAll(async () => {
    await t.close();
  });

  /** A season with three entries and the given number of unscheduled fixtures between them. */
  async function seasonWithFixtures(count: number) {
    const season = await createSeasonFixture(t, {
      status: 'active',
      startsOn: '2027-01-10',
      endsOn: '2027-04-30',
    });
    const divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    const entries: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const captain = await adultCustomer(t);
      entries.push(
        (
          await createTeamEntryFixture(t, {
            seasonId: season.seasonId,
            captainPersonId: captain.personId,
            divisionId,
          })
        ).teamEntryId,
      );
    }
    const fixtures: string[] = [];
    for (let i = 0; i < count; i += 1) {
      fixtures.push(
        await createFixtureFixture(t, {
          seasonId: season.seasonId,
          divisionId,
          homeEntryId: entries[i % 3] as string,
          awayEntryId: entries[(i + 1) % 3] as string,
          round: i + 1,
        }),
      );
    }
    return { seasonId: season.seasonId, fixtures };
  }

  const gameFor = (fixtureId: string, date: string, from: string, to: string) => ({
    kind: 'create' as const,
    proposed: {
      kind: 'game' as const,
      title: `Game ${fixtureId.slice(0, 8)}`,
      scheduledStart: at(date, from),
      scheduledEnd: at(date, to),
      sourceType: 'fixture',
      sourceId: fixtureId,
    },
    resourceIds: [pitch.pitchId],
  });

  async function publish(
    name: string,
    changes: Parameters<ScheduleDraftsService['create']>[1]['changes'],
  ) {
    const draft = await drafts.create(scheduler(), { facilityId: t.facilityId, name, changes });
    return drafts.publish(scheduler(), draft.id, { expectedRevision: draft.revision });
  }

  async function settle() {
    await dispatcher.runOnce(200);
    await dispatcher.runOnce(200);
  }

  const fixtureRow = (id: string) =>
    t.db
      .selectFrom('fixtures')
      .select(['status', 'scheduling_event_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const fixtureRevision = async (id: string) =>
    (
      await t.db
        .selectFrom('fixtures')
        .select('revision')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).revision;

  /** PATCH /v1/fixtures/{id} as the league manager (the competition command path). */
  async function fixtureCommand(id: string, body: Record<string, unknown>) {
    const res = await t.http
      .patch(`/v1/fixtures/${id}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: await fixtureRevision(id), ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { fixture: { status: string; schedulingEventId: string | null } };
  }

  const scheduleOn = (date: string) => ({
    facilityId: t.facilityId,
    resourceIds: [pitch.pitchId],
    scheduledStart: at(date, '15:00'),
    scheduledEnd: at(date, '16:00'),
  });

  /** A result recorded the outcome (the results module's port call, in its own transaction). */
  async function recordOutcome(fixtureId: string, outcome: 'played' | 'forfeit') {
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app
        .get(FixturesService)
        .recordOutcome(
          trx,
          staffPrincipal(t.organizationId, ['league_manager']),
          fixtureId,
          outcome,
          'Result published',
          null,
        );
    });
  }

  /** A worker claimed the event's pending delivery of `change` and died (its lease lapses later). */
  async function claimedByDeadWorker(eventId: string, change: string) {
    const until = new Date(t.clock.now().getTime() + 60_000);
    const claimed = await sql`
      update outbox_events set locked_by = 'worker-a:dead', locked_until = ${until}
      where event_type = 'scheduling.event_changed' and status = 'pending'
        and payload->>'eventId' = ${eventId} and payload->>'change' = ${change}
    `.execute(t.db);
    expect(Number(claimed.numAffectedRows)).toBe(1);
  }

  const incompleteSeason = (seasonId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status', 'owner_queue', 'deadline_at', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', 'competition.incomplete_season')
      .where('affected_id', '=', seasonId)
      .orderBy('opened_at')
      .execute();

  it('SPK-FIX-002: a draft that cancels one fixture game and schedules another reports the canceled fixture and keeps the incomplete-season exception open', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(4);
    const [f1, f2, f3, f4] = fixtures as [string, string, string, string];
    const first = await publish('Rounds 1-3', [
      gameFor(f1, '2027-01-16', '09:00', '10:00'),
      gameFor(f2, '2027-01-16', '11:00', '12:00'),
      gameFor(f3, '2027-01-16', '13:00', '14:00'),
    ]);
    expect(first.summary.remainingObligations).toEqual([
      expect.objectContaining({ code: 'unscheduled_fixtures', owner: 'league_manager' }),
    ]);
    await settle();
    const f1Event = (await fixtureRow(f1)).scheduling_event_id as string;
    expect((await fixtureRow(f1)).status).toBe('scheduled');
    expect(await incompleteSeason(seasonId)).toEqual([
      expect.objectContaining({ status: 'open', owner_queue: 'league_manager' }),
    ]);

    // cancel F1's game (no proposed fields at all) and place the last unscheduled fixture
    const second = await publish('Swap', [
      { kind: 'cancel', targetEventId: f1Event },
      gameFor(f4, '2027-01-23', '09:00', '10:00'),
    ]);
    expect(second.summary.remainingObligations).toEqual([
      {
        code: 'unscheduled_fixtures',
        message: expect.stringMatching(/^1 fixture\(s\) .*1 of them because it cancels their game/),
        owner: 'league_manager',
        deadline: expect.any(String),
      },
    ]);
    const stillOpen = await incompleteSeason(seasonId);
    expect(stillOpen).toEqual([expect.objectContaining({ status: 'open' })]);
    expect(stillOpen[0]?.details).toMatchObject({ unscheduledFixtures: 1 });
    await settle();
    expect(await fixtureRow(f1)).toEqual({ status: 'postponed', scheduling_event_id: null });
    expect((await fixtureRow(f4)).status).toBe('scheduled');
    // the sync's own reconciliation keeps the one open exception (deduplicated)
    expect(await incompleteSeason(seasonId)).toEqual([expect.objectContaining({ status: 'open' })]);

    // a cancel-only draft is checked too
    const f2Event = (await fixtureRow(f2)).scheduling_event_id as string;
    const third = await publish('Cancel only', [{ kind: 'cancel', targetEventId: f2Event }]);
    expect(third.summary.remainingObligations).toEqual([
      expect.objectContaining({
        code: 'unscheduled_fixtures',
        message: expect.stringMatching(/^2 fixture\(s\)/),
      }),
    ]);
  });

  it('SPK-FIX-002: a draft may not give a fixture’s published game another source', async () => {
    const { fixtures } = await seasonWithFixtures(1);
    const [f1] = fixtures as [string];
    await publish('One game', [gameFor(f1, '2027-01-30', '09:00', '10:00')]);
    await settle();
    const eventId = (await fixtureRow(f1)).scheduling_event_id as string;
    const draft = await drafts.create(scheduler(), {
      facilityId: t.facilityId,
      name: 'Repurpose',
      changes: [
        {
          kind: 'move',
          targetEventId: eventId,
          proposed: {
            scheduledStart: at('2027-01-30', '11:00'),
            scheduledEnd: at('2027-01-30', '12:00'),
            sourceType: 'rental',
          },
        },
      ],
    });
    await expect(
      drafts.publish(scheduler(), draft.id, { expectedRevision: draft.revision }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        obligations: [expect.objectContaining({ code: 'fixture_game_repurposed', blocking: true })],
      },
    });
    expect((await fixtureRow(f1)).status).toBe('scheduled');
  });

  it('SPK-AT-010 step 5: a fixture game canceled outside a draft opens the incomplete-season exception with owner and deadline; placing the game again resolves it', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(1);
    const [f1] = fixtures as [string];
    const published = await publish('Only game', [gameFor(f1, '2027-02-06', '09:00', '10:00')]);
    expect(published.summary.remainingObligations).toEqual([]);
    await settle();
    expect(await incompleteSeason(seasonId)).toEqual([]);
    const eventId = (await fixtureRow(f1)).scheduling_event_id as string;
    const events = t.app.get(EventsService);
    const event = await events.getEvent(scheduler(), eventId);
    await events.cancelEvent(scheduler(), eventId, {
      expectedRevision: event.revision,
      reason: 'Pitch resurfacing',
    });
    await settle();
    expect((await fixtureRow(f1)).status).toBe('postponed');
    const opened = await incompleteSeason(seasonId);
    expect(opened).toEqual([
      expect.objectContaining({ status: 'open', owner_queue: 'league_manager' }),
    ]);
    expect(opened[0]?.deadline_at).not.toBeNull();
    expect(opened[0]?.details).toMatchObject({
      fixtureId: f1,
      eventId,
      unscheduledFixtures: 1,
    });

    await publish('Replacement', [gameFor(f1, '2027-02-13', '09:00', '10:00')]);
    await settle();
    expect((await fixtureRow(f1)).status).toBe('scheduled');
    expect(await incompleteSeason(seasonId)).toEqual([
      expect.objectContaining({ id: opened[0]?.id, status: 'resolved' }),
    ]);
  });
  it('R3-TRACE-A-04 / SPK-AT-010 step 5: the league manager’s fixture commands keep the incomplete-season exception true (schedule resolves it, postpone and unschedule reopen it, cancel resolves it)', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(1);
    const [f1] = fixtures as [string];
    await publish('Only game', [gameFor(f1, '2027-02-20', '09:00', '10:00')]);
    await settle();
    const eventId = (await fixtureRow(f1)).scheduling_event_id as string;
    const events = t.app.get(EventsService);
    const event = await events.getEvent(scheduler(), eventId);
    await events.cancelEvent(scheduler(), eventId, {
      expectedRevision: event.revision,
      reason: 'Pitch resurfacing',
    });
    await settle();
    const opened = await incompleteSeason(seasonId);
    expect(opened).toEqual([expect.objectContaining({ status: 'open' })]);

    // placing the game through the competition command resolves it (the sync then finds the
    // fixture already scheduled and changes nothing)
    const scheduled = await fixtureCommand(f1, {
      action: 'schedule',
      schedule: scheduleOn('2027-02-27'),
    });
    expect(scheduled.fixture.status).toBe('scheduled');
    expect(await incompleteSeason(seasonId)).toEqual([
      expect.objectContaining({ id: opened[0]?.id, status: 'resolved' }),
    ]);
    await settle();
    expect(await incompleteSeason(seasonId)).toEqual([
      expect.objectContaining({ id: opened[0]?.id, status: 'resolved' }),
    ]);

    // a postponement leaves the fixture to be scheduled: owner and deadline, in the command's
    // transaction
    const postponed = await fixtureCommand(f1, { action: 'postpone', reason: 'Referee shortage' });
    expect(postponed.fixture).toMatchObject({ status: 'postponed', schedulingEventId: null });
    const reopened = (await incompleteSeason(seasonId)).filter((e) => e.status === 'open');
    expect(reopened).toEqual([
      expect.objectContaining({ owner_queue: 'league_manager', deadline_at: expect.any(Date) }),
    ]);
    expect(reopened[0]?.details).toMatchObject({ fixtureId: f1, unscheduledFixtures: 1 });
    await settle();
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toHaveLength(1);

    await fixtureCommand(f1, { action: 'schedule', schedule: scheduleOn('2027-03-06') });
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toEqual([]);
    await fixtureCommand(f1, { action: 'unschedule', reason: 'Venue change' });
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toHaveLength(1);

    // canceling the fixture leaves nothing to schedule: resolved
    const canceled = await fixtureCommand(f1, { action: 'cancel', reason: 'Team folded' });
    expect(canceled.fixture.status).toBe('canceled');
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toEqual([]);
    await settle();
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toEqual([]);
  });

  it('R3-TRACE-A-04: a forfeit recorded for the last unplaced fixture resolves the exception', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(1);
    const [f1] = fixtures as [string];
    await publish('Only game', [gameFor(f1, '2027-03-13', '09:00', '10:00')]);
    await settle();
    await fixtureCommand(f1, { action: 'postpone', reason: 'Storm' });
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toHaveLength(1);
    await recordOutcome(f1, 'forfeit');
    expect((await fixtureRow(f1)).status).toBe('forfeit');
    expect((await incompleteSeason(seasonId)).filter((e) => e.status === 'open')).toEqual([]);
  });

  it('SPK-FIX-002: canceling the game of a played or forfeit fixture creates no obligation', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(2);
    const [f1, f2] = fixtures as [string, string];
    await publish('Two games', [
      gameFor(f1, '2027-03-20', '09:00', '10:00'),
      gameFor(f2, '2027-03-20', '11:00', '12:00'),
    ]);
    await settle();
    expect(await incompleteSeason(seasonId)).toEqual([]);
    // the outcome keeps the published game linked (results change only the fixture's status)
    await recordOutcome(f1, 'played');
    await recordOutcome(f2, 'forfeit');
    const e1 = (await fixtureRow(f1)).scheduling_event_id as string;
    const e2 = (await fixtureRow(f2)).scheduling_event_id as string;
    expect(e1).not.toBeNull();

    const freed = await publish('Free the pitch', [
      { kind: 'cancel', targetEventId: e1 },
      { kind: 'cancel', targetEventId: e2 },
    ]);
    expect(freed.summary.remainingObligations).toEqual([]);
    expect(await incompleteSeason(seasonId)).toEqual([]);
    await settle();
    expect((await fixtureRow(f1)).status).toBe('played');
    expect((await fixtureRow(f2)).status).toBe('forfeit');
    expect(await incompleteSeason(seasonId)).toEqual([]);
  });

  it('SPK-FIX-002: a draft that cancels a fixture’s game and creates its replacement publishes, and the fixture follows the new game in either delivery order', async () => {
    const { seasonId, fixtures } = await seasonWithFixtures(2);
    const [f1, f2] = fixtures as [string, string];
    await publish('Two games', [
      gameFor(f1, '2027-04-03', '09:00', '10:00'),
      gameFor(f2, '2027-04-03', '11:00', '12:00'),
    ]);
    await settle();
    expect(await incompleteSeason(seasonId)).toEqual([]);

    // in order: the cancel is delivered first, then the replacement
    const old1 = (await fixtureRow(f1)).scheduling_event_id as string;
    const moved1 = await publish('Move F1', [
      { kind: 'cancel', targetEventId: old1 },
      gameFor(f1, '2027-04-10', '09:00', '10:00'),
    ]);
    expect(moved1.summary.remainingObligations).toEqual([]);
    const new1 = moved1.summary.changes.find((c) => c.kind === 'create')?.eventId as string;
    await settle();
    expect(await fixtureRow(f1)).toEqual({ status: 'scheduled', scheduling_event_id: new1 });
    // no exception was opened between the two deliveries
    expect(await incompleteSeason(seasonId)).toEqual([]);

    // out of order: the cancel's delivery is held by a dead worker and handled last
    const old2 = (await fixtureRow(f2)).scheduling_event_id as string;
    const moved2 = await publish('Move F2', [
      { kind: 'cancel', targetEventId: old2 },
      gameFor(f2, '2027-04-10', '11:00', '12:00'),
    ]);
    const new2 = moved2.summary.changes.find((c) => c.kind === 'create')?.eventId as string;
    await claimedByDeadWorker(old2, 'canceled');
    await dispatcher.runOnce(200);
    expect(await fixtureRow(f2)).toEqual({ status: 'scheduled', scheduling_event_id: new2 });
    t.clock.advance(61_000);
    await settle();
    expect(await fixtureRow(f2)).toEqual({ status: 'scheduled', scheduling_event_id: new2 });
    expect(await incompleteSeason(seasonId)).toEqual([]);
  });

  it('SPK-FIX-002: a draft may not give one fixture two games', async () => {
    const { fixtures } = await seasonWithFixtures(1);
    const [f1] = fixtures as [string];
    const draft = await drafts.create(scheduler(), {
      facilityId: t.facilityId,
      name: 'Twice',
      changes: [
        gameFor(f1, '2027-04-17', '09:00', '10:00'),
        gameFor(f1, '2027-04-17', '11:00', '12:00'),
      ],
    });
    await expect(
      drafts.publish(scheduler(), draft.id, { expectedRevision: draft.revision }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        obligations: [
          expect.objectContaining({ code: 'fixture_already_scheduled', blocking: true }),
        ],
      },
    });
    expect(await fixtureRow(f1)).toEqual({ status: 'unscheduled', scheduling_event_id: null });
  });
});
