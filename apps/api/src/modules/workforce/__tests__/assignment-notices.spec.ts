import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  competitionWorld,
  drainOutbox,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

/**
 * Workforce-owned assignment notices (WRK-04; SPK-COMMS-002 `assignment_offer`, SPK-STAFF-002,
 * IF-22): workforce composes the notice from its own `workforce.assignment_changed` in the
 * handler's transaction, keyed on the event id.
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
    const game = await scheduleFixture(t, world, { date });
    const res = await post(t, '/v1/assignments', leagueManager, {
      personId: referee.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.assignment.id as string;
  }

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
});
