import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditWriter } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { at, createScheduledEvent, EventsService } from '../../scheduling';
import {
  adultCustomer,
  competitionWorld,
  drainOutbox,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

const HOUR = 3_600_000;

/**
 * Time-bounded access follows the assignment on every path (SPK-STAFF-004, §4.14 least
 * privilege): withdrawals decided by follow-ups (a canceled fixture, event or session) end it, a
 * retime moves its window, and an acceptance commits atomically with its grant (§4.7 invariant 12).
 */
describe('temporary access after follow-up changes (SPK-STAFF-004, §4.14, §4.7-12)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
  });
  afterAll(async () => {
    await t.close();
  });

  const me = async (actor: Actor) =>
    (await t.http.get('/v1/me').set(actor.header)).body.principal as {
      kind: string;
      staffRoles: string[];
    };
  const membershipOf = (id: string) =>
    t.db
      .selectFrom('staff_memberships')
      .select(['status', 'effective_to'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  async function acceptedSubstitute(fixtureId: string, person: Actor) {
    const created = await post(t, '/v1/assignments', lm, {
      personId: person.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role: 'referee',
      engagement: 'substitute',
      offer: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const accepted = await post(
      t,
      `/v1/assignments/${created.body.assignment.id}/accept`,
      person,
      {},
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.assignment.access.status).toBe('granted');
    return accepted.body as {
      assignment: {
        id: string;
        scheduledEnd: string;
        access: { status: string; until: string; staffMembershipId: string };
      };
    };
  }

  it('SPK-STAFF-004: a canceled fixture ends the substitute official’s temporary access', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-02-06' });
    const sub = await adultCustomer(t);
    const accepted = await acceptedSubstitute(game.fixtureId, sub);
    expect((await me(sub)).staffRoles).toEqual(['official']);
    const fixture = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(lm.header);
    const canceled = await t.http
      .patch(`/v1/fixtures/${game.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ action: 'cancel', expectedRevision: fixture.body.revision, reason: 'Weather' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
    const after = await t.http.get(`/v1/assignments/${accepted.assignment.id}`).set(sub.header);
    expect(after.body).toMatchObject({ status: 'withdrawn', access: { status: 'ended' } });
    expect((await membershipOf(accepted.assignment.access.staffMembershipId)).status).toBe('ended');
    expect((await me(sub)).kind).toBe('customer');
    // a replayed follow-up changes nothing
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null })
      .where('event_type', '=', 'competition.fixture_changed')
      .where('aggregate_id', '=', game.fixtureId)
      .execute();
    await drainOutbox(t);
    const replayed = await t.http.get(`/v1/assignments/${accepted.assignment.id}`).set(sub.header);
    expect(replayed.body.revision).toBe(after.body.revision);
  });

  it('SPK-STAFF-004 / §4.14: a canceled event ends a temporary coach’s access to team records', async () => {
    const events = t.app.get(EventsService);
    const practice = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [world.pitch.northHalfId],
      start: at('2027-02-14', '09:00'),
      end: at('2027-02-14', '10:30'),
      kind: 'practice',
      title: 'U10 practice',
    });
    const other = await scheduleFixture(t, world, { date: '2027-02-20' });
    const pm = await staffMember(t, ['program_manager', 'league_manager']);
    const coach = await adultCustomer(t);
    const entry = () => t.http.get(`/v1/team-entries/${other.homeEntryId}`).set(coach.header);
    expect((await entry()).status).toBe(404);
    const created = await post(t, '/v1/assignments', pm, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'event',
      targetId: practice.id,
      role: 'head_coach',
      engagement: 'temporary',
      offer: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const accepted = await post(
      t,
      `/v1/assignments/${created.body.assignment.id}/accept`,
      coach,
      {},
    );
    expect(accepted.body.assignment.access.status).toBe('granted');
    expect((await me(coach)).staffRoles).toEqual(['coach']);
    await events.cancelEvent(systemPrincipal(t.organizationId), practice.id, {
      reason: 'Pitch flooded',
    });
    await drainOutbox(t);
    const after = await t.http
      .get(`/v1/assignments/${created.body.assignment.id}`)
      .set(coach.header);
    expect(after.body).toMatchObject({ status: 'withdrawn', access: { status: 'ended' } });
    expect((await me(coach)).kind).toBe('customer');
    expect((await entry()).status).toBe(404);
  });

  it('SPK-STAFF-004: a retime moves the access window with the activity', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-03-06' });
    const sub = await adultCustomer(t);
    const accepted = await acceptedSubstitute(game.fixtureId, sub);
    const trail =
      new Date(accepted.assignment.access.until).getTime() -
      new Date(accepted.assignment.scheduledEnd).getTime();
    const fixture = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(lm.header);
    const newEnd = at('2027-03-13', '19:00');
    const moved = await t.http
      .patch(`/v1/fixtures/${game.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [world.pitch.pitchId],
          scheduledStart: at('2027-03-13', '18:00'),
          scheduledEnd: newEnd,
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    const after = await t.http.get(`/v1/assignments/${accepted.assignment.id}`).set(sub.header);
    const until = new Date(new Date(newEnd).getTime() + trail).toISOString();
    expect(after.body).toMatchObject({ status: 'accepted', access: { status: 'granted', until } });
    const membership = await membershipOf(accepted.assignment.access.staffMembershipId);
    expect(new Date(membership.effective_to as Date).toISOString()).toBe(until);
    const clockAt = t.clock.now();
    t.clock.set(new Date(new Date(at('2027-03-13', '18:30')).getTime()));
    expect((await me(sub)).staffRoles).toEqual(['official']);
    t.clock.set(new Date(new Date(until).getTime() + HOUR));
    expect((await me(sub)).kind).toBe('customer');
    t.clock.set(clockAt);
  });

  it('§4.7-12: an acceptance and its access grant commit together or not at all', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-03-20' });
    const sub = await adultCustomer(t);
    const created = await post(t, '/v1/assignments', lm, {
      personId: sub.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
      engagement: 'substitute',
      offer: true,
    });
    const rowOf = () =>
      t.db
        .selectFrom('assignments')
        .select(['status', 'access_status', 'access_membership_id', 'revision'])
        .where('id', '=', created.body.assignment.id)
        .executeTakeFirstOrThrow();
    const before = await rowOf();
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    // the process fails after identity created the membership, before workforce linked it
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, input) => {
      if (input.action === 'workforce.temporary_access_granted') throw new Error('connection lost');
      return record(trx, input);
    });
    const failed = await post(t, `/v1/assignments/${created.body.assignment.id}/accept`, sub, {});
    spy.mockRestore();
    expect(failed.status).toBe(500);
    // nothing of the acceptance committed: no half-applied state is left behind
    expect(await rowOf()).toEqual(before);
    expect(before.status).toBe('offered');
    const memberships = await t.db
      .selectFrom('staff_memberships')
      .select('id')
      .where('person_id', '=', sub.personId)
      .execute();
    expect(memberships).toEqual([]);
    const running = await t.db
      .selectFrom('operations')
      .select('id')
      .where('kind', '=', 'workforce.accept_assignment')
      .where('status', '=', 'running')
      .execute();
    expect(running).toEqual([]);
    // the retry accepts and grants
    const retried = await post(t, `/v1/assignments/${created.body.assignment.id}/accept`, sub, {});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.assignment.access.status).toBe('granted');
  });
});
