import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, OutboxDispatcher, type Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import { WorkforceEvents } from '../workforce.events';
import {
  competitionWorld,
  drainOutbox,
  expectPgError,
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
  const HELD = new Date('2099-01-01T00:00:00Z');
  /** Holds back the delivery of this assignment's notices: they stay queued, unsent. */
  const holdDeliveries = (assignmentId: string) =>
    t.db
      .updateTable('outbox_events')
      .set({ available_at: HELD })
      .where('event_type', '=', 'communications.delivery_requested')
      .where('status', '=', 'pending')
      .where(
        'aggregate_id',
        'in',
        t.db
          .selectFrom('notifications')
          .select(sql<string>`id::text`.as('id'))
          .where('subject_type', '=', 'assignment')
          .where('subject_id', '=', assignmentId),
      )
      .execute();
  const releaseDeliveries = () =>
    t.db
      .updateTable('outbox_events')
      .set({ available_at: t.clock.now() })
      .where('event_type', '=', 'communications.delivery_requested')
      .where('status', '=', 'pending')
      .where('available_at', '=', HELD)
      .execute();
  /** Drains the outbox while `hold` keeps some events back before every batch. */
  async function drainHolding(hold: () => Promise<unknown>) {
    const dispatcher = t.app.get(OutboxDispatcher);
    for (let i = 0; i < 20; i += 1) {
      await hold();
      if ((await dispatcher.runOnce(100)).claimed === 0) return;
    }
  }
  const told = async (assignmentId: string) =>
    (await noticesFor(assignmentId)).map((n) => [n.kind, n.status, n.title]);
  const titleOf = async (assignmentId: string) =>
    (
      await t.db
        .selectFrom('assignments')
        .select('target_title')
        .where('id', '=', assignmentId)
        .executeTakeFirstOrThrow()
    ).target_title;

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

  it('SPK-COMMS-002: an offer notice delivered after its fixture moved states the current time, and no move of an offer nobody was told of is announced', async () => {
    const { id, game } = await proposalOn('2027-02-13');
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    // the offer's delivery is held back (a backlog, or a failure being retried)...
    await holdBack(id);
    // ...while the fixture moves from Saturday 18:00 to Sunday 15:00
    await reschedule(game, '2027-02-14', '15:00', '16:00');
    await release(id);
    await drainOutbox(t);

    // the assignee was never told Saturday: one offer notice, at the current time, and no
    // "rescheduled, previously Saturday" about an offer they had not heard of
    const notices = await noticesFor(id);
    expect(notices.map((n) => n.kind)).toEqual(['assignment_offer']);
    expect(notices[0]?.body).toContain(
      'Main complex, 2027-02-14 15:00-16:00 (America/Los_Angeles)',
    );
    expect(notices[0]?.body).not.toContain('2027-02-13');
  });

  it('SPK-COMMS-005: after two moves whose first notice lagged, the move notice names the time the assignee was told, not an intermediate one', async () => {
    const { id, game } = await proposalOn('2027-05-01');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    // May 1 (told by the offer) -> May 2, its notice event lagging -> May 3
    await reschedule(game, '2027-05-02', '09:00', '10:00', { drain: false });
    await drainHolding(() => holdBack(id));
    await reschedule(game, '2027-05-03', '09:00', '10:00', { drain: false });
    await drainHolding(() => holdBack(id));
    expect((await changeEvents(id)).length).toBe(4); // proposal, offer, two moves
    await release(id);
    await drainOutbox(t);

    const notices = await noticesFor(id);
    expect(notices.map((n) => n.kind)).toEqual(['assignment_offer', 'schedule_changed']);
    expect(notices[0]?.body).toContain('2027-05-01 18:00-19:00');
    const move = notices[1]!;
    expect(move.body).toContain(
      'now 2027-05-03 09:00-10:00 (America/Los_Angeles), previously 2027-05-01 18:00-19:00.',
    );
    expect(move.body).not.toContain('2027-05-02');
    expect(move).toMatchObject({
      details_before: { scheduledStart: at('2027-05-01', '18:00') },
      details_after: { scheduledStart: at('2027-05-03', '09:00') },
    });
  });

  it('SPK-COMMS-005: a move notice that was suppressed unsent is not the "previous" time of the next one', async () => {
    const { id, game } = await proposalOn('2027-05-08');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/accept`, referee, {})).status).toBe(200);
    await drainOutbox(t);
    // the May 9 move notice is composed but its delivery waits; the May 10 move replaces it
    await reschedule(game, '2027-05-09', '09:00', '10:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    await reschedule(game, '2027-05-10', '09:00', '10:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    await releaseDeliveries();
    await drainOutbox(t);

    const notices = await noticesFor(id);
    expect(notices.map((n) => [n.kind, n.status])).toEqual([
      ['assignment_offer', 'dispatched'],
      ['schedule_changed', 'suppressed'],
      ['schedule_changed', 'dispatched'],
    ]);
    expect(notices[1]?.superseded_by_notification_id).toBe(notices[2]?.id);
    expect(notices[2]?.body).toContain(
      'now 2027-05-10 09:00-10:00 (America/Los_Angeles), previously 2027-05-08 18:00-19:00. You remain assigned at the new time.',
    );
  });

  it('SPK-COMMS-005: a move undone before its notice went out never arrives; the assignee is told the time stands', async () => {
    const { id, game } = await proposalOn('2027-06-19');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/accept`, referee, {})).status).toBe(200);
    await drainOutbox(t);
    await reschedule(game, '2027-06-20', '10:00', '11:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    await reschedule(game, '2027-06-19', '18:00', '19:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    await releaseDeliveries();
    await drainOutbox(t);

    const notices = await noticesFor(id);
    expect(notices.map((n) => [n.kind, n.status, n.title])).toEqual([
      ['assignment_offer', 'dispatched', 'Assignment offered: referee'],
      ['schedule_changed', 'suppressed', 'Assignment rescheduled: referee'],
      ['schedule_changed', 'dispatched', 'Assignment time unchanged: referee'],
    ]);
    expect(notices[2]?.body).toContain(
      'stays at 2027-06-19 18:00-19:00 (America/Los_Angeles). You remain assigned.',
    );
    expect(notices[2]?.body).not.toContain('2027-06-20');
  });

  it('SPK-COMMS-005: an offer withdrawn by staff while its move notice waits unsent suppresses that notice and tells the assignee the offer is gone', async () => {
    const { id, game } = await proposalOn('2027-05-15');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    await reschedule(game, '2027-05-16', '10:00', '11:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    expect(await told(id)).toEqual([
      ['assignment_offer', 'dispatched', 'Assignment offered: referee'],
      ['schedule_changed', 'queued', 'Assignment rescheduled: referee'],
    ]);
    const withdrawn = await post(t, `/v1/assignments/${id}/withdraw`, leagueManager, {
      reason: 'Assessor assigned instead',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    // the withdrawal's notice is composed while the move notice still waits
    await drainHolding(() => holdDeliveries(id));
    await releaseDeliveries();
    await drainOutbox(t);

    const notices = await noticesFor(id);
    expect(notices.map((n) => [n.kind, n.status])).toEqual([
      ['assignment_offer', 'dispatched'],
      // "accept or decline it" never arrives after the offer is gone
      ['schedule_changed', 'suppressed'],
      ['cancellation', 'dispatched'],
    ]);
    const [, move, withdrawal] = notices;
    expect(move?.superseded_by_notification_id).toBe(withdrawal?.id);
    expect(withdrawal?.title).toBe('Assignment offer withdrawn: referee');
    // named by the time the assignee was told (the offer), with the activity's current time
    expect(withdrawal?.body).toBe(
      `The offer of the referee (slot 1) for ${await titleOf(id)} at Main complex, 2027-05-15 18:00-19:00 (America/Los_Angeles), was withdrawn: Assessor assigned instead. You no longer need to answer it. The activity is now 2027-05-16 10:00-11:00.`,
    );
  });

  it('SPK-STAFF-002: an offer withdrawn because its fixture was canceled is told; an offer withdrawn before its notice was composed is not', async () => {
    const told1 = await proposalOn('2027-05-22');
    expect((await post(t, `/v1/assignments/${told1.id}/offer`, leagueManager, {})).status).toBe(
      200,
    );
    await drainOutbox(t);
    const untold = await proposalOn('2027-05-23');
    expect((await post(t, `/v1/assignments/${untold.id}/offer`, leagueManager, {})).status).toBe(
      200,
    );
    expect(
      (
        await post(t, `/v1/assignments/${untold.id}/withdraw`, leagueManager, {
          reason: 'Posted by mistake',
        })
      ).status,
    ).toBe(200);
    await drainOutbox(t);
    expect(await noticesFor(untold.id)).toEqual([]);

    const fixture = await t.http
      .get(`/v1/fixtures/${told1.game.fixtureId}`)
      .set(leagueManager.header);
    const canceled = await t.http
      .patch(`/v1/fixtures/${told1.game.fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ action: 'cancel', expectedRevision: fixture.body.revision, reason: 'Weather' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
    const notices = await noticesFor(told1.id);
    expect(notices.map((n) => n.kind)).toEqual(['assignment_offer', 'cancellation']);
    expect(notices[1]?.body).toContain(
      'Main complex, 2027-05-22 18:00-19:00 (America/Los_Angeles), was withdrawn: The fixture was canceled. You no longer need to answer it.',
    );
  });

  it("SPK-COMMS-005: the assignee's own decline is confirmed only to make a waiting move notice obsolete", async () => {
    const { id, game } = await proposalOn('2027-05-29');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    await reschedule(game, '2027-05-30', '10:00', '11:00', { drain: false });
    await drainHolding(() => holdDeliveries(id));
    expect((await post(t, `/v1/assignments/${id}/decline`, referee, {})).status).toBe(200);
    await drainHolding(() => holdDeliveries(id));
    await releaseDeliveries();
    await drainOutbox(t);
    expect((await noticesFor(id)).map((n) => [n.kind, n.status, n.title])).toEqual([
      ['assignment_offer', 'dispatched', 'Assignment offered: referee'],
      ['schedule_changed', 'suppressed', 'Assignment rescheduled: referee'],
      ['cancellation', 'dispatched', 'Decline recorded: referee'],
    ]);

    // nothing waiting: a decline composes nothing
    const other = await proposal('2027-05-31');
    expect((await post(t, `/v1/assignments/${other}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${other}/decline`, referee, {})).status).toBe(200);
    await drainOutbox(t);
    expect((await noticesFor(other)).map((n) => n.kind)).toEqual(['assignment_offer']);
  });

  it('SPK-COMMS-005: move and withdrawal notices carry the practical details clients read for schedule notices, so they expire once the activity is over', async () => {
    const { id, game } = await proposalOn('2027-06-05');
    await post(t, `/v1/assignments/${id}/offer`, leagueManager, {});
    await drainOutbox(t);
    expect((await post(t, `/v1/assignments/${id}/accept`, referee, {})).status).toBe(200);
    await reschedule(game, '2027-06-06', '10:00', '11:00');
    expect(
      (
        await post(t, `/v1/assignments/${id}/withdraw`, leagueManager, {
          reason: 'Assessor assigned instead',
        })
      ).status,
    ).toBe(200);
    await drainOutbox(t);
    const [, move, withdrawal] = await noticesFor(id);
    const title = await titleOf(id);
    for (const [details, start, status] of [
      [move?.details_before, at('2027-06-05', '18:00'), 'accepted'],
      [move?.details_after, at('2027-06-06', '10:00'), 'accepted'],
      [withdrawal?.details_before, at('2027-06-06', '10:00'), 'accepted'],
      [withdrawal?.details_after, at('2027-06-06', '10:00'), 'withdrawn'],
    ] as const) {
      expect(details).toMatchObject({
        title,
        status,
        scheduledStart: start,
        scheduledEnd: expect.any(String),
        timezone: 'America/Los_Angeles',
        facilityId: t.facilityId,
        resources: [],
        summary: expect.stringContaining('(America/Los_Angeles): referee (slot 1) for '),
      });
    }
    expect((move?.details_after as { summary: string }).summary).toBe(
      `2027-06-06 10:00-11:00 (America/Los_Angeles): referee (slot 1) for ${title} at Main complex, accepted`,
    );
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

  it('migration 0705: what an assignee was told is append-only and ordered once per assignment', async () => {
    const id = await proposal('2027-06-12');
    expect((await post(t, `/v1/assignments/${id}/offer`, leagueManager, {})).status).toBe(200);
    await drainOutbox(t);
    const [record] = await t.db
      .selectFrom('assignment_notices')
      .selectAll()
      .where('assignment_id', '=', id)
      .execute();
    expect(record).toMatchObject({
      sequence: 1,
      notice_kind: 'assignment_offer',
      notification_id: (await noticesFor(id))[0]?.id,
    });
    // a told notice is a fact: never rewritten, never deleted
    await expectPgError(
      t.db
        .updateTable('assignment_notices')
        .set({ stated_start: new Date(at('2027-06-13', '18:00')) })
        .where('id', '=', record!.id)
        .execute(),
      '23001',
    );
    await expectPgError(
      t.db.deleteFrom('assignment_notices').where('id', '=', record!.id).execute(),
      '23001',
    );
    // two notices can never take one place in the assignment's order
    await expectPgError(
      t.db
        .insertInto('assignment_notices')
        .values({
          ...record!,
          id: newId(),
          notification_id: newId(),
          source_event_id: newId(),
        })
        .execute(),
      '23505',
    );
  });
});
