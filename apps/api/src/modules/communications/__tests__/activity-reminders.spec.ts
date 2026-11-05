import { systemPrincipal, type Principal } from '@sportspark/contracts';
import { isUniqueViolation } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createAccountFixture, createPersonFixture } from '../../identity';
import {
  EventsService,
  SchedulingModule,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { CommunicationsModule } from '../communications.module';
import { ActivityReminders, COMPOSE_ACTIVITY_REMINDERS_JOB } from '../services/activity-reminders';
import { dispatchOutbox, recipientsOf } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const START = '2026-10-23T12:00:00Z';
const minutes = (n: number) => new Date(new Date(START).getTime() + n * 60_000).toISOString();

/**
 * COM-06 (job): activity reminders (SPK-CAP-001 "remind", SPK-COMMS-002, SPK-COMMS-005; K-06
 * periodic job; IF-43 module settings). The reminder lead time is a communication policy value
 * with no default (DEC-012): unset, nothing is composed.
 */
describe('activity reminders (COM-06, communications.compose_activity_reminders)', () => {
  async function world(env: NodeJS.ProcessEnv) {
    const t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule, SchedulingModule],
      principalResolver: 'module',
      clockStart: START,
      env,
    });
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
    });
    const player = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: player });
    return { t, pitch, player, events: t.app.get(EventsService) };
  }

  const remindersFor = (t: TestApp, eventId: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('kind', '=', 'activity_reminder')
      .where('subject_id', '=', eventId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();

  /** A practice `startMinutes` after the test clock's current instant. */
  async function practice(
    w: { t: TestApp; pitch: PitchFixture; player: string; events: EventsService },
    startMinutes: number,
    half: 'north' | 'south' = 'north',
    player: string = w.player,
  ) {
    const from = (n: number) => new Date(w.t.clock.now().getTime() + n * 60_000).toISOString();
    const event = await createScheduledEvent(w.events, {
      organizationId: w.t.organizationId,
      facilityId: w.t.facilityId,
      resourceIds: [half === 'north' ? w.pitch.northHalfId : w.pitch.southHalfId],
      start: from(startMinutes),
      end: from(startMinutes + 60),
      kind: 'practice',
      title: `Practice +${startMinutes}`,
      commitments: [personCommitment(player, 'participant')],
    });
    await dispatchOutbox(w.t.app); // the calendar projection and the publication notice
    return event;
  }

  describe('without a configured lead time', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => {
      w = await world({});
    });
    afterAll(async () => {
      await w.t.close();
    });

    it('without a configured lead time no reminder is composed', async () => {
      const event = await practice(w, 30);
      const [summary] = await w.t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(summary).toMatchObject({ ran: true, processed: 0, failed: false });
      expect(await remindersFor(w.t, event.id)).toHaveLength(0);
      const marks = await w.t.db.selectFrom('reminder_marks').selectAll().execute();
      expect(marks).toHaveLength(0);
    });
  });

  describe('with COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES set', () => {
    let w: Awaited<ReturnType<typeof world>>;
    let system: Principal;
    beforeAll(async () => {
      w = await world({ COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES: '120' });
      system = systemPrincipal(w.t.organizationId, 'test');
    });
    afterAll(async () => {
      await w.t.close();
    });

    it('with one each event revision is reminded once', async () => {
      const soon = await practice(w, 60);
      const later = await practice(w, 300, 'south');
      const [first] = await w.t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(first).toMatchObject({ ran: true, processed: 1, failed: false });
      await dispatchOutbox(w.t.app);
      const [reminder, ...extra] = await remindersFor(w.t, soon.id);
      expect(extra).toHaveLength(0);
      expect(reminder).toMatchObject({
        category: 'operational',
        subject_type: 'event',
        facility_id: w.t.facilityId,
        status: 'dispatched',
        title: `Reminder: Practice +60`,
      });
      // facility-local wall clock (America/Los_Angeles): 13:00Z is 6:00 AM
      expect(reminder?.body).toContain('6:00 AM');
      expect(
        (await recipientsOf(w.t.db, w.t.organizationId, reminder?.id as string)).map(
          (r) => r.person_id,
        ),
      ).toEqual([w.player]);
      expect(await remindersFor(w.t, later.id)).toHaveLength(0); // outside the lead time

      // a second pass (a replay, or another worker) composes nothing for this revision
      const [second] = await w.t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(second).toMatchObject({ processed: 0 });
      expect(await remindersFor(w.t, soon.id)).toHaveLength(1);

      // the event moves (a new revision): the unsent part of the old reminder is obsolete
      // (SPK-COMMS-005) and the new revision is reminded with its new details
      await w.events.moveEvent(system, soon.id, {
        scheduledStart: minutes(90),
        scheduledEnd: minutes(150),
        expectedRevision: soon.revision,
      });
      await dispatchOutbox(w.t.app);
      const afterMove = await remindersFor(w.t, soon.id);
      expect(afterMove[0]?.superseded_by_notification_id).not.toBeNull();
      const [third] = await w.t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(third).toMatchObject({ processed: 1 });
      const reminders = await remindersFor(w.t, soon.id);
      expect(reminders).toHaveLength(2);
      expect(reminders[1]?.body).toContain('6:30 AM');
      const marks = await w.t.db
        .selectFrom('reminder_marks')
        .select(['event_revision'])
        .where('scheduling_event_id', '=', soon.id)
        .orderBy('event_revision')
        .execute();
      expect(marks.map((m) => m.event_revision)).toEqual([soon.revision, soon.revision + 1]);

      // the later activity comes within the lead time
      w.t.clock.advance(4 * 60 * 60_000);
      const [fourth] = await w.t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(fourth).toMatchObject({ processed: 1 });
      expect(await remindersFor(w.t, later.id)).toHaveLength(1);
    });

    it('two workers running the reminder pass at once compose one reminder per revision (PGlite and PostgreSQL)', async () => {
      const player = await createPersonFixture(w.t, { kind: 'adult' });
      const event = await practice(w, 60, 'north', player);
      const reminders = w.t.app.get(ActivityReminders);
      const now = w.t.clock.now();
      const results = await Promise.all([
        reminders.run({ now, batchSize: 50 }),
        reminders.run({ now, batchSize: 50 }),
      ]);
      expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
      expect(await remindersFor(w.t, event.id)).toHaveLength(1);
    });

    it('the database rejects a second reminder mark for one event revision and any change to a mark', async () => {
      // A mark names a real event of its organization (reminder_marks_event_fk, 1009).
      const event = await practice(w, 900, 'south');
      const values = {
        organization_id: w.t.organizationId,
        scheduling_event_id: event.id,
        event_revision: 1,
        composed_at: w.t.clock.now(),
      };
      await w.t.db.insertInto('reminder_marks').values(values).execute();
      let duplicate: unknown = null;
      try {
        await w.t.db.insertInto('reminder_marks').values(values).execute();
      } catch (error) {
        duplicate = error;
      }
      expect(isUniqueViolation(duplicate)).toBe(true);
      await expect(
        w.t.db
          .updateTable('reminder_marks')
          .set({ event_revision: 2 })
          .where('scheduling_event_id', '=', values.scheduling_event_id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        w.t.db
          .deleteFrom('reminder_marks')
          .where('scheduling_event_id', '=', values.scheduling_event_id)
          .execute(),
      ).rejects.toThrow();
    });
  });
});
