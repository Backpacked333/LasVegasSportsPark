import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationsService, OutboxDispatcher } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { EventsService, at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import {
  addRosterMemberFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

/**
 * §4.12 (workers tolerate interruption and replay), §4.6 (independent facts never overwrite one
 * another), SPK-AT-009: `scheduling.event_changed` deliveries can arrive late and out of order (a
 * worker that claimed one dies, its lease lapses and the event is handled after later ones). The
 * fixture follows the event's current state, so a late delivery never resurrects a canceled game,
 * undoes a staff decision, or leaves an older time.
 */
describe('fixture sync tolerates out-of-order scheduling deliveries (§4.12, §4.6, SPK-AT-009)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let dispatcher: OutboxDispatcher;
  let events: EventsService;
  const scheduler = () => staffPrincipal(t.organizationId, ['scheduler']);

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
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
    dispatcher = t.app.get(OutboxDispatcher);
    events = t.app.get(EventsService);
  });
  afterAll(async () => {
    await t.close();
  });

  let teams = 0;
  async function scheduledFixture(day: string) {
    const entries: string[] = [];
    for (const name of ['Lions', 'Tigers']) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        teamName: `${name} ${(teams += 1)}`,
      });
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: captain.personId,
      });
      entries.push(entry.teamEntryId);
    }
    const res = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        homeEntryId: entries[0],
        awayEntryId: entries[1],
        round: 1,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at(day, '18:00'),
          scheduledEnd: at(day, '19:00'),
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await dispatcher.runOnce(500);
    return {
      fixtureId: res.body.fixture.id as string,
      eventId: res.body.fixture.schedulingEventId as string,
    };
  }

  /** Worker A claims the pending delivery (as the claim query does) and dies before handling it. */
  async function claimedByDeadWorker(eventId: string, change: string) {
    const until = new Date(t.clock.now().getTime() + 60_000);
    const claimed = await sql`
      update outbox_events set locked_by = 'worker-a:dead', locked_until = ${until}
      where event_type = 'scheduling.event_changed' and status = 'pending'
        and payload->>'eventId' = ${eventId} and payload->>'change' = ${change}
    `.execute(t.db);
    expect(Number(claimed.numAffectedRows)).toBe(1);
  }
  /** Worker B handles everything else; then the dead worker's lease lapses and B handles the rest. */
  async function deliverLateAfterOthers() {
    await dispatcher.runOnce(500);
    t.clock.advance(61_000);
    await dispatcher.runOnce(500);
  }
  const fixtureRow = (id: string) =>
    t.db
      .selectFrom('fixtures')
      .select(['status', 'scheduling_event_id', 'scheduled_start'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const eventRow = (id: string) =>
    t.db
      .selectFrom('events')
      .select(['status', 'scheduled_start'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('§4.12: a late `moved` after the scheduler canceled the event leaves the fixture postponed and unlinked', async () => {
    const { fixtureId, eventId } = await scheduledFixture('2027-01-16');
    await events.moveEvent(scheduler(), eventId, {
      scheduledStart: at('2027-01-24', '19:00'),
      scheduledEnd: at('2027-01-24', '20:00'),
      reason: 'Swap',
    });
    await claimedByDeadWorker(eventId, 'moved');
    await events.cancelEvent(scheduler(), eventId, { reason: 'Field closed' });
    await deliverLateAfterOthers();
    expect((await eventRow(eventId)).status).toBe('canceled');
    expect(await fixtureRow(fixtureId)).toMatchObject({
      status: 'postponed',
      scheduling_event_id: null,
      scheduled_start: null,
    });
  });

  it('§4.6: a late `moved` never overwrites a league manager’s later unschedule', async () => {
    const { fixtureId, eventId } = await scheduledFixture('2027-02-06');
    const { revision } = await t.db
      .selectFrom('fixtures')
      .select('revision')
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    const rescheduled = await t.http
      .patch(`/v1/fixtures/${fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: revision,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-02-13', '18:00'),
          scheduledEnd: at('2027-02-13', '19:00'),
        },
      });
    expect(rescheduled.status, JSON.stringify(rescheduled.body)).toBe(200);
    await claimedByDeadWorker(eventId, 'moved');
    const unscheduled = await t.http
      .patch(`/v1/fixtures/${fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'unschedule',
        expectedRevision: rescheduled.body.fixture.revision,
        reason: 'Venue issue',
      });
    expect(unscheduled.status, JSON.stringify(unscheduled.body)).toBe(200);
    await deliverLateAfterOthers();
    expect((await eventRow(eventId)).status).toBe('canceled');
    expect(await fixtureRow(fixtureId)).toMatchObject({
      status: 'unscheduled',
      scheduling_event_id: null,
    });
  });

  it('§4.12: two moves delivered in reverse order leave the fixture at the latest time', async () => {
    const { fixtureId, eventId } = await scheduledFixture('2027-03-06');
    await events.moveEvent(scheduler(), eventId, {
      scheduledStart: at('2027-03-13', '18:00'),
      scheduledEnd: at('2027-03-13', '19:00'),
      reason: 'First move',
    });
    await claimedByDeadWorker(eventId, 'moved');
    await events.moveEvent(scheduler(), eventId, {
      scheduledStart: at('2027-03-20', '18:00'),
      scheduledEnd: at('2027-03-20', '19:00'),
      reason: 'Second move',
    });
    await deliverLateAfterOthers();
    const fixture = await fixtureRow(fixtureId);
    expect(fixture).toMatchObject({ status: 'scheduled', scheduling_event_id: eventId });
    expect(new Date(fixture.scheduled_start as Date).toISOString()).toBe(at('2027-03-20', '18:00'));
    expect(new Date((await eventRow(eventId)).scheduled_start).toISOString()).toBe(
      at('2027-03-20', '18:00'),
    );
  });

  it('§4.7-12: a fixture command and its scheduling event commit together; a failure after the event step leaves neither', async () => {
    const entries: string[] = [];
    for (const name of ['Owls', 'Hawks']) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        teamName: `${name} ${(teams += 1)}`,
      });
      entries.push(entry.teamEntryId);
    }
    const body = {
      seasonId: season.seasonId,
      homeEntryId: entries[0],
      awayEntryId: entries[1],
      round: 2,
      schedule: {
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        scheduledStart: at('2027-03-27', '18:00'),
        scheduledEnd: at('2027-03-27', '19:00'),
      },
    };
    const operations = t.app.get(OperationsService);
    const transition = operations.transition.bind(operations);
    // the process fails after scheduling created the event, before the fixture recorded it
    const spy = vi.spyOn(operations, 'transition').mockImplementation(async (trx, id, to, data) => {
      if (to === 'succeeded') throw new Error('Connection terminated unexpectedly');
      return transition(trx, id, to, data);
    });
    const crashed = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send(body);
    spy.mockRestore();
    expect(crashed.status).toBe(500);
    const fixtures = await t.db
      .selectFrom('fixtures')
      .select('id')
      .where('home_entry_id', '=', entries[0] as string)
      .execute();
    expect(fixtures).toEqual([]);
    const orphans = await t.db
      .selectFrom('events')
      .select('id')
      .where('source_type', '=', 'fixture')
      .where('scheduled_start', '=', new Date(at('2027-03-27', '18:00')))
      .execute();
    expect(orphans).toEqual([]);
    // a retry with a new key creates exactly one fixture and one event (no reservation conflict)
    const retried = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body.fixture).toMatchObject({ status: 'scheduled' });
  });
});
