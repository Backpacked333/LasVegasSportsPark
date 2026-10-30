import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, type Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import { WorkforceEvents } from '../workforce.events';
import {
  competitionWorld,
  drainOutbox,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

/**
 * Workforce-owned assignment notices (WRK-04; SPK-COMMS-002 `assignment_offer`, "schedule
 * change" and "cancellation", SPK-COMMS-005, SPK-STAFF-002, IF-22): workforce composes the notice
 * from its own `workforce.assignment_changed` in the handler's transaction, keyed on the event id,
 * with the assignment's current practical details.
 */
describe('assignment offer notices (WRK-04)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let referee: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    referee = await staffMember(t, ['official']);
  });
  afterAll(async () => {
    await t.close();
  });

  const noticesFor = (assignmentId: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('subject_type', '=', 'assignment')
      .where('subject_id', '=', assignmentId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();

  const changeEvents = (assignmentId: string) =>
    t.db
      .selectFrom('outbox_events')
      .select(['id', 'payload'])
      .where('event_type', '=', 'workforce.assignment_changed')
      .where('aggregate_id', '=', assignmentId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();

  async function proposal(date: string) {
    return (await proposalOn(date)).id;
  }

  async function proposalOn(
    date: string,
    options: { official?: Actor; from?: string; to?: string; resourceId?: string } = {},
  ): Promise<{ id: string; game: ScheduledFixture }> {
    const game = await scheduleFixture(t, world, {
      date,
      ...(options.from ? { from: options.from } : {}),
      ...(options.to ? { to: options.to } : {}),
      ...(options.resourceId ? { resourceId: options.resourceId } : {}),
    });
    const res = await post(t, '/v1/assignments', leagueManager, {
      personId: (options.official ?? referee).personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.assignment.id as string, game };
  }

  /** Moves the fixture through competition; the outbox is drained unless `drain` is false. */
  async function reschedule(
    game: ScheduledFixture,
    date: string,
    from: string,
    to: string,
    options: { resourceId?: string; drain?: boolean } = {},
  ) {
    const current = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(leagueManager.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${game.fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: current.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [options.resourceId ?? world.pitch.pitchId],
          scheduledStart: at(date, from),
          scheduledEnd: at(date, to),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    if (options.drain !== false) await drainOutbox(t);
  }

  /** Holds back this assignment's pending change events, as a backlog or a failed delivery would. */
  const holdBack = (assignmentId: string) =>
    t.db
      .updateTable('outbox_events')
      .set({ available_at: new Date('2099-01-01T00:00:00Z') })
      .where('event_type', '=', 'workforce.assignment_changed')
      .where('aggregate_id', '=', assignmentId)
      .where('status', '=', 'pending')
      .execute();
  const release = (assignmentId: string) =>
    t.db
      .updateTable('outbox_events')
      .set({ available_at: t.clock.now() })
      .where('event_type', '=', 'workforce.assignment_changed')
      .where('aggregate_id', '=', assignmentId)
      .where('status', '=', 'pending')
      .execute();

  it('SPK-STAFF-002: offering an assignment queues one notice to the assignee', async () => {
    const id = await proposal('2027-01-27');
    await drainOutbox(t);
    // a proposal is not an offer: nobody is told yet
    expect(await noticesFor(id)).toEqual([]);

    const offered = await post(t, `/v1/assignments/${id}/offer`, leagueManager, {});
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    await drainOutbox(t);
    const notices = await noticesFor(id);
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    const offerEvent = (await changeEvents(id)).find(
      (e) => (e.payload as { status: string }).status === 'offered',
    );
    expect(notice).toMatchObject({
      kind: 'assignment_offer',
      category: 'operational',
      protected: false,
      facility_id: t.facilityId,
      source_event_id: offerEvent?.id,
    });
    expect(['queued', 'dispatched']).toContain(notice.status);
    expect(notice.title).toBe('Assignment offered: referee');
    // facility-local time and zone (SPK-SCHED-008)
    expect(notice.body).toContain('Main complex, 2027-01-27 18:00-19:00 (America/Los_Angeles)');
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select(['person_id', 'resolved_basis'])
      .where('notification_id', '=', notice.id)
      .execute();
    expect(recipients).toEqual([{ person_id: referee.personId, resolved_basis: 'explicit' }]);
  });

  it('an offer answered before its notice is composed is not announced', async () => {
    const id = await proposal('2027-01-31');
    await post(t, `/v1/assignments/${id}/offer`, leagueManager, {});
    const declined = await post(t, `/v1/assignments/${id}/decline`, referee, {});
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    await drainOutbox(t);
    expect(await noticesFor(id)).toEqual([]);
  });

  it('a replayed assignment_changed event queues nothing new', async () => {
    const id = await proposal('2027-01-28');
    const offered = await post(t, `/v1/assignments/${id}/offer`, leagueManager, {});
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    await drainOutbox(t);
    expect(await noticesFor(id)).toHaveLength(1);
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null, dispatched_at: null })
      .where('event_type', '=', 'workforce.assignment_changed')
      .where('aggregate_id', '=', id)
      .execute();
    await drainOutbox(t);
    expect(await noticesFor(id)).toHaveLength(1);
  });

  it('SPK-STAFF-002: the assignee is told when staff withdraw accepted work, not when they withdraw it themselves', async () => {
    const byStaff = await proposal('2027-01-29');
    await post(t, `/v1/assignments/${byStaff}/offer`, leagueManager, {});
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${byStaff}/accept`, referee, {})).status).toBe(200);
    const withdrawn = await post(t, `/v1/assignments/${byStaff}/withdraw`, leagueManager, {
      reason: 'Assessor assigned instead',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    await drainOutbox(t);
    const notices = await noticesFor(byStaff);
    expect(notices.map((n) => n.title)).toEqual([
      'Assignment offered: referee',
      'Assignment withdrawn: referee',
    ]);
    expect(notices[1]?.body).toContain('was withdrawn: Assessor assigned instead');

    const bySelf = await proposal('2027-01-30');
    await post(t, `/v1/assignments/${bySelf}/offer`, leagueManager, {});
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${bySelf}/accept`, referee, {})).status).toBe(200);
    const own = await post(t, `/v1/assignments/${bySelf}/withdraw`, referee, {
      reason: 'Injured',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    await drainOutbox(t);
    expect((await noticesFor(bySelf)).map((n) => n.title)).toEqual(['Assignment offered: referee']);
  });
  it('SPK-COMMS-005: an offered and an accepted assignment moved with their fixture tell the assignee the new and the previous time', async () => {
    const offered = await proposalOn('2027-02-06');
    expect((await post(t, `/v1/assignments/${offered.id}/offer`, leagueManager, {})).status).toBe(
      200,
    );
    const accepted = await proposalOn('2027-02-08');
    expect((await post(t, `/v1/assignments/${accepted.id}/offer`, leagueManager, {})).status).toBe(
      200,
    );
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${accepted.id}/accept`, referee, {})).status).toBe(200);
    await drainOutbox(t);

    await reschedule(offered.game, '2027-02-07', '15:00', '16:00');
    await reschedule(accepted.game, '2027-02-09', '10:00', '11:00');

    const offeredNotices = await noticesFor(offered.id);
    expect(offeredNotices.map((n) => [n.kind, n.title])).toEqual([
      ['assignment_offer', 'Assignment offered: referee'],
      ['schedule_changed', 'Assignment rescheduled: referee'],
    ]);
    const move = offeredNotices[1]!;
    expect(move.body).toMatch(/^Your offered referee \(slot 1\) for .+ at Main complex was/);
    expect(move.body).toContain(
      'at Main complex was rescheduled: now 2027-02-07 15:00-16:00 (America/Los_Angeles), previously 2027-02-06 18:00-19:00.',
    );
    expect(move.body).toContain('accept or decline');
    expect(move).toMatchObject({
      category: 'operational',
      protected: false,
      facility_id: t.facilityId,
      subject_type: 'assignment',
      subject_id: offered.id,
      details_before: {
        scheduledStart: at('2027-02-06', '18:00'),
        scheduledEnd: at('2027-02-06', '19:00'),
        timezone: 'America/Los_Angeles',
        slot: 1,
      },
      details_after: {
        scheduledStart: at('2027-02-07', '15:00'),
        scheduledEnd: at('2027-02-07', '16:00'),
      },
    });
    const recipients = await t.db
      .selectFrom('notification_recipients')
      .select('person_id')
      .where('notification_id', '=', move.id)
      .execute();
    expect(recipients).toEqual([{ person_id: referee.personId }]);

    const acceptedNotices = await noticesFor(accepted.id);
    expect(acceptedNotices.map((n) => n.kind)).toEqual(['assignment_offer', 'schedule_changed']);
    expect(acceptedNotices[1]?.body).toContain(
      'now 2027-02-09 10:00-11:00 (America/Los_Angeles), previously 2027-02-08 18:00-19:00. You remain assigned at the new time.',
    );
  });

  it('SPK-COMMS-002: an offer notice delivered after its fixture moved states the current time, never the payload one', async () => {
    const { id, game } = await proposalOn('2027-02-13');
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    // the offer's delivery is held back (a backlog, or a failure being retried)...
    await holdBack(id);
    // ...while the fixture moves from Saturday 18:00 to Sunday 15:00
    await reschedule(game, '2027-02-14', '15:00', '16:00');
    await release(id);
    await drainOutbox(t);

    const notices = await noticesFor(id);
    expect(notices.map((n) => n.kind).sort()).toEqual(['assignment_offer', 'schedule_changed']);
    const offer = notices.find((n) => n.kind === 'assignment_offer')!;
    expect(offer.body).toContain('Main complex, 2027-02-14 15:00-16:00 (America/Los_Angeles)');
    expect(offer.body).not.toContain('2027-02-13');
  });

  it('§4.12: a move delivered after a newer move composes nothing; the newer one tells the current time', async () => {
    const { id, game } = await proposalOn('2027-02-20');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    await reschedule(game, '2027-02-21', '09:00', '10:00');
    await reschedule(game, '2027-02-22', '09:00', '10:00');
    expect((await noticesFor(id)).map((n) => n.kind)).toEqual([
      'assignment_offer',
      'schedule_changed',
      'schedule_changed',
    ]);
    // the first move's event delivered again, late, as a fresh delivery (no consumption record)
    const firstMove = (await changeEvents(id)).find(
      (e) => (e.payload as { previousScheduledStart?: string | null }).previousScheduledStart,
    )!;
    const outbox = t.app.get(Outbox);
    await t.db.transaction().execute(async (trx) => {
      await outbox.enqueue(trx as unknown as Trx, WorkforceEvents.assignmentChanged, {
        organizationId: t.organizationId,
        aggregateType: 'assignment',
        aggregateId: id,
        payload: firstMove.payload as never,
      });
    });
    await drainOutbox(t);
    const notices = await noticesFor(id);
    expect(notices).toHaveLength(3);
    expect(notices[2]?.body).toContain(
      'now 2027-02-22 09:00-10:00 (America/Los_Angeles), previously 2027-02-21 09:00-10:00.',
    );
  });

  it('SPK-COMMS-005: withdrawing moved accepted work supersedes the move notice and names the accepted time', async () => {
    const { id, game } = await proposalOn('2027-02-27');
    await post(t, `/v1/assignments/${id}/offer`, leagueManager, {});
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/accept`, referee, {})).status).toBe(200);
    await drainOutbox(t);
    await reschedule(game, '2027-02-28', '11:00', '12:00');
    const withdrawn = await post(t, `/v1/assignments/${id}/withdraw`, leagueManager, {
      reason: 'Assessor assigned instead',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    await drainOutbox(t);
    const notices = await noticesFor(id);
    expect(notices.map((n) => n.kind)).toEqual([
      'assignment_offer',
      'schedule_changed',
      'cancellation',
    ]);
    const [, move, withdrawal] = notices;
    expect(withdrawal?.title).toBe('Assignment withdrawn: referee');
    expect(withdrawal?.body).toContain(
      'Main complex, 2027-02-28 11:00-12:00 (America/Los_Angeles), was withdrawn: Assessor assigned instead',
    );
    // the move notice went out before the withdrawal: it now points at the withdrawal, and any of
    // its push, email or SMS attempts not yet handed to a provider are never sent (SPK-COMMS-005)
    expect(move).toMatchObject({
      status: 'dispatched',
      superseded_by_notification_id: withdrawal?.id,
    });
  });

  it('SPK-STAFF-003 / SPK-COMMS-005: accepted work withdrawn because its new time conflicts names the accepted and the new time', async () => {
    const official = await staffMember(t, ['official']);
    const other = await proposalOn('2027-03-06', {
      official,
      resourceId: world.pitch.northHalfId,
    });
    const moved = await proposalOn('2027-03-13', {
      official,
      resourceId: world.pitch.southHalfId,
    });
    for (const a of [other, moved]) {
      await post(t, `/v1/assignments/${a.id}/offer`, leagueManager, {});
      await drainOutbox(t);
      expect((await post(t, `/v1/assignments/${a.id}/accept`, official, {})).status).toBe(200);
    }
    await drainOutbox(t);
    await reschedule(moved.game, '2027-03-06', '18:30', '19:30', {
      resourceId: world.pitch.southHalfId,
    });
    const row = await t.db
      .selectFrom('assignments')
      .select('status')
      .where('id', '=', moved.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('withdrawn');
    const notices = await noticesFor(moved.id);
    expect(notices.map((n) => n.kind)).toEqual(['assignment_offer', 'cancellation']);
    const withdrawal = notices[1]!;
    expect(withdrawal.body).toContain(
      'Main complex, 2027-03-13 18:00-19:00 (America/Los_Angeles), was withdrawn: The rescheduled time overlaps another commitment of the person. The activity is now 2027-03-06 18:30-19:30.',
    );
    expect(withdrawal).toMatchObject({
      details_before: { scheduledStart: at('2027-03-13', '18:00') },
      details_after: { scheduledStart: at('2027-03-06', '18:30') },
    });
  });
});
