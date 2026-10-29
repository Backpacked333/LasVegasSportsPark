import { AsyncResource } from 'node:async_hooks';
import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditWriter, EventHandlerRegistry, type EventHandler } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createProgramFixture } from '../../catalog';
import { StaffMembershipsService } from '../../identity';
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

  it('§4.12 / §4.6: a late retry of an older move never retimes an assignment back; assignments follow the event’s current time', async () => {
    const events = t.app.get(EventsService);
    const system = systemPrincipal(t.organizationId);
    const practice = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [world.pitch.southHalfId],
      start: at('2027-02-21', '09:00'),
      end: at('2027-02-21', '10:00'),
      kind: 'practice',
      title: 'U12 practice',
    });
    const pm = await staffMember(t, ['program_manager']);
    const coach = await adultCustomer(t);
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
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    await drainOutbox(t);

    // the workforce follow-up fails once on the first move (a transient error) and is retried later
    const entry = t.app
      .get(EventHandlerRegistry)
      .handlersFor('scheduling.event_changed')
      .find((h) => h.name === 'workforce.follow_event');
    if (!entry) throw new Error('workforce.follow_event not registered');
    const original: EventHandler = entry.handler;
    let failed = false;
    entry.handler = async (event, ctx) => {
      const payload = event.payload as { eventId: string; change: string };
      if (!failed && payload.eventId === practice.id && payload.change === 'moved') {
        failed = true;
        throw new Error('transient failure');
      }
      return original(event, ctx);
    };
    try {
      const first = await events.moveEvent(system, practice.id, {
        scheduledStart: at('2027-02-21', '11:00'),
        scheduledEnd: at('2027-02-21', '12:00'),
        expectedRevision: practice.revision,
      });
      await drainOutbox(t); // the first move's follow-up fails
      await events.moveEvent(system, practice.id, {
        scheduledStart: at('2027-02-21', '15:00'),
        scheduledEnd: at('2027-02-21', '16:00'),
        expectedRevision: first.revision,
      });
      await drainOutbox(t); // the newer move is applied first
      t.clock.advance(60_000);
      await drainOutbox(t); // the older move's retry arrives last
    } finally {
      entry.handler = original;
    }
    expect(failed).toBe(true);
    const after = await t.http
      .get(`/v1/assignments/${created.body.assignment.id}`)
      .set(coach.header);
    expect(after.body).toMatchObject({
      status: 'accepted',
      scheduledStart: at('2027-02-21', '15:00'),
      scheduledEnd: at('2027-02-21', '16:00'),
    });
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

  it('§4.12 / §4.6: a fixture_changed delivered after a newer reschedule never retimes the assignment or its access back', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-03-20' });
    const sub = await adultCustomer(t);
    const accepted = await acceptedSubstitute(game.fixtureId, sub);
    await drainOutbox(t);
    const trail =
      new Date(accepted.assignment.access.until).getTime() -
      new Date(accepted.assignment.scheduledEnd).getTime();
    // The delivery that will arrive late: the fixture's change from before the reschedule.
    const stale = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'competition.fixture_changed')
      .where('aggregate_id', '=', game.fixtureId)
      .orderBy('occurred_at', 'desc')
      .executeTakeFirstOrThrow();
    const fixture = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(lm.header);
    const newStart = at('2027-03-27', '18:00');
    const newEnd = at('2027-03-27', '19:00');
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
          scheduledStart: newStart,
          scheduledEnd: newEnd,
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    // A retry (or a second change committed in the same instant) delivers the older change last.
    await t.db
      .insertInto('outbox_events')
      .values({
        id: newId(),
        organization_id: stale.organization_id,
        event_type: stale.event_type,
        aggregate_type: stale.aggregate_type,
        aggregate_id: stale.aggregate_id,
        payload: json(stale.payload),
        occurred_at: stale.occurred_at,
        correlation_id: stale.correlation_id,
        available_at: t.clock.now(),
      })
      .execute();
    await drainOutbox(t);
    const after = await t.http.get(`/v1/assignments/${accepted.assignment.id}`).set(sub.header);
    const until = new Date(new Date(newEnd).getTime() + trail).toISOString();
    expect(after.body).toMatchObject({
      status: 'accepted',
      scheduledStart: newStart,
      scheduledEnd: newEnd,
      access: { status: 'granted', until },
    });
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

  const assignmentRow = (id: string) =>
    t.db
      .selectFrom('assignments')
      .select(['status', 'access_status', 'access_membership_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const membershipsOfPerson = (personId: string) =>
    t.db
      .selectFrom('staff_memberships')
      .select(['id', 'status'])
      .where('person_id', '=', personId)
      .execute();
  // A second request sent from inside a running command must not inherit its async context.
  const outside = AsyncResource.bind(<T>(fn: () => T): T => fn());

  async function offeredSubstitute(fixtureId: string, person: Actor): Promise<string> {
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
    return created.body.assignment.id as string;
  }

  it('SPK-STAFF-004 / §4.14: a withdrawal sent while the access grant is in flight ends that access', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-04-03' });
    const sub = await adultCustomer(t);
    const id = await offeredSubstitute(game.fixtureId, sub);
    const memberships = t.app.get(StaffMembershipsService);
    const create = memberships.create.bind(memberships);
    let withdrawal: Promise<Awaited<ReturnType<typeof post>>> | null = null;
    // identity has written the membership; the league manager's withdrawal arrives now
    const spy = vi.spyOn(memberships, 'create').mockImplementation(async (...args) => {
      const membership = await create(...args);
      if (!withdrawal) {
        withdrawal = outside(async () =>
          post(t, `/v1/assignments/${id}/withdraw`, lm, { reason: 'Removed by the league' }),
        );
        await Promise.race([withdrawal, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      }
      return membership;
    });
    try {
      const accepted = await post(t, `/v1/assignments/${id}/accept`, sub, {});
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(withdrawal).not.toBeNull();
      const withdrawn = await withdrawal!;
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const row = await assignmentRow(id);
    expect(row).toMatchObject({ status: 'withdrawn', access_status: 'ended' });
    expect(row.access_membership_id).not.toBeNull();
    expect(await membershipsOfPerson(sub.personId)).toEqual([
      { id: row.access_membership_id, status: 'ended' },
    ]);
    expect((await me(sub)).kind).toBe('customer');
  });

  it('SPK-STAFF-004 / §4.14 under concurrency: an acceptance racing a withdrawal never leaves a withdrawn assignment with live staff access', async () => {
    for (const date of ['2027-04-05', '2027-04-06', '2027-04-07', '2027-04-08']) {
      const game = await scheduleFixture(t, world, { date });
      const sub = await adultCustomer(t);
      const id = await offeredSubstitute(game.fixtureId, sub);
      await Promise.all([
        post(t, `/v1/assignments/${id}/accept`, sub, {}),
        post(t, `/v1/assignments/${id}/withdraw`, lm, { reason: 'Removed by the league' }),
      ]);
      const row = await assignmentRow(id);
      const live = (await membershipsOfPerson(sub.personId)).filter((m) => m.status !== 'ended');
      if (row.status === 'withdrawn') expect(live).toEqual([]);
      else expect(row).toMatchObject({ status: 'accepted', access_status: 'granted' });
    }
  });

  it('SPK-STAFF-004: a canceled session ends the temporary coach’s access', async () => {
    const pm = await staffMember(t, ['program_manager']);
    const programId = await createProgramFixture(t);
    const offering = await createOfferingFixture(t, {
      programId,
      responsibleManagerPersonId: pm.personId,
    });
    const session = await post(t, `/v1/offerings/${offering.offeringId}/sessions`, pm, {
      scheduledStart: at('2027-04-12', '16:00'),
      scheduledEnd: at('2027-04-12', '17:00'),
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const coach = await adultCustomer(t);
    const created = await post(t, '/v1/assignments', pm, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'session',
      targetId: session.body.id,
      offeringId: offering.offeringId,
      role: 'instructor',
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
    const canceled = await post(t, `/v1/sessions/${session.body.id}/cancel`, pm, {
      reason: 'Instructor course',
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
    expect(await assignmentRow(created.body.assignment.id)).toMatchObject({
      status: 'withdrawn',
      access_status: 'ended',
    });
    expect((await me(coach)).kind).toBe('customer');
  });

  it('SPK-STAFF-004: a reschedule into a conflict withdraws the substitute and ends the access', async () => {
    const sub = await adultCustomer(t);
    const x = await scheduleFixture(t, world, {
      date: '2027-04-10',
      resourceId: world.pitch.northHalfId,
    });
    const y = await scheduleFixture(t, world, {
      date: '2027-04-17',
      resourceId: world.pitch.southHalfId,
    });
    const accepted = await acceptedSubstitute(y.fixtureId, sub);
    const regular = await post(t, '/v1/assignments', lm, {
      personId: sub.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: x.fixtureId,
      role: 'referee',
      offer: true,
    });
    expect(regular.status, JSON.stringify(regular.body)).toBe(201);
    expect(
      (await post(t, `/v1/assignments/${regular.body.assignment.id}/accept`, sub, {})).status,
    ).toBe(200);
    const fixture = await t.http.get(`/v1/fixtures/${y.fixtureId}`).set(lm.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${y.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [world.pitch.southHalfId],
          scheduledStart: at('2027-04-10', '18:30'),
          scheduledEnd: at('2027-04-10', '19:30'),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    expect(await assignmentRow(accepted.assignment.id)).toMatchObject({
      status: 'withdrawn',
      access_status: 'ended',
    });
    expect((await membershipOf(accepted.assignment.access.staffMembershipId)).status).toBe('ended');
    expect((await me(sub)).kind).toBe('customer');
  });

  it('§4.7-12: an identity call that fails after writing leaves no membership behind, and the failure is recorded', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-04-24' });
    const sub = await adultCustomer(t);
    const id = await offeredSubstitute(game.fixtureId, sub);
    const memberships = t.app.get(StaffMembershipsService);
    const create = memberships.create.bind(memberships);
    // identity wrote the membership, then the call failed without a definite answer
    const spy = vi.spyOn(memberships, 'create').mockImplementation(async (...args) => {
      await create(...args);
      throw new Error('socket hang up');
    });
    let accepted: Awaited<ReturnType<typeof post>>;
    try {
      accepted = await post(t, `/v1/assignments/${id}/accept`, sub, {});
    } finally {
      spy.mockRestore();
    }
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.assignment.access).toMatchObject({ status: 'failed' });
    expect(await membershipsOfPerson(sub.personId)).toEqual([]);
    const operation = await t.db
      .selectFrom('operations')
      .select('status')
      .where('id', '=', accepted.body.operationId)
      .executeTakeFirstOrThrow();
    expect(operation.status).toBe('recovery_required');
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'workforce.temporary_access_failed')
      .where('affected_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(exception.status).toBe('open');
    expect((await me(sub)).kind).toBe('customer');
  });

  it('SPK-STAFF-004 / §4.14: temporary access at another facility never extends the person’s facility-scoped roles there', async () => {
    const annex = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: annex,
        organization_id: t.organizationId,
        slug: `annex-${annex.slice(0, 8)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    const annexManager = await staffMember(t, ['league_manager'], { facilityIds: [annex] });
    const other = await scheduleFixture(t, world, { date: '2027-04-30' });
    const game = await scheduleFixture(t, world, { date: '2027-05-01' });
    const requirement = () =>
      post(t, '/v1/assignment-requirements', annexManager, {
        targetType: 'fixture',
        targetId: other.fixtureId,
        kind: 'official',
        role: 'referee',
        requiredCount: 2,
      });
    expect((await requirement()).status).toBe(403);
    const accepted = await acceptedSubstitute(game.fixtureId, annexManager);
    expect(accepted.assignment.access.status).toBe('granted');
    expect((await me(annexManager)).staffRoles).toEqual(['league_manager', 'official']);
    // identity keeps each role at its own membership's facilities: league manager at the annex
    // only, official at the main facility only (§2.1, §4.3)
    expect((await requirement()).status).toBe(403);
    const listed = await t.http
      .get(`/v1/assignments?targetType=fixture&targetId=${game.fixtureId}`)
      .set(annexManager.header);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items).toEqual([]);
  });
});
