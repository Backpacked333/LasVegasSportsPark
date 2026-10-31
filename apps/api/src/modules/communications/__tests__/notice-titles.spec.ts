import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { NOTICE_TITLE_MAX, noticeTitle } from '../communications.shared';
import { COMPOSE_ACTIVITY_REMINDERS_JOB } from '../services/activity-reminders';
import { NotificationsService } from '../services/notifications.service';
import { dispatchOutbox } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

const START = '2026-10-23T12:00:00Z';

/**
 * R2-TENANCY-INPUT-02 (SPK-COMMS-002, SPK-COMMS-005): an event title or team name may be 200
 * characters, the compose limit for a whole notice title. The words around it stay; the name is
 * shortened with an ellipsis, so a schedule change, a cancellation and a reminder are still composed
 * (they used to fail ComposeNotificationBody inside the handler or the job). One reminder that
 * cannot be composed never stalls the others.
 */
describe('notice titles built from stored names (R2-TENANCY-INPUT-02)', () => {
  it('R2-TENANCY-INPUT-02: noticeTitle keeps the prefix and suffix, shortens only the name, and never splits a surrogate pair', () => {
    expect(noticeTitle('Canceled: ', 'Pitch 1')).toBe('Canceled: Pitch 1');
    const long = 'x'.repeat(200);
    const title = noticeTitle('Schedule changed: ', long);
    expect(title).toHaveLength(NOTICE_TITLE_MAX);
    expect(title.startsWith('Schedule changed: x')).toBe(true);
    expect(title.endsWith('x…')).toBe(true);
    const asked = noticeTitle('', long, ': are you available?');
    expect(asked).toHaveLength(NOTICE_TITLE_MAX);
    expect(asked.endsWith('…: are you available?')).toBe(true);
    const emoji = noticeTitle('Reminder: ', '\u{1F3C6}'.repeat(100));
    expect(emoji.length).toBeLessThanOrEqual(NOTICE_TITLE_MAX);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji)).toBe(false);
  });

  describe('through the schedule notices and the reminder job', () => {
    let t: TestApp;
    let pitch: PitchFixture;
    let player: string;
    let events: EventsService;

    beforeAll(async () => {
      t = await createTestApp({
        configure: withDeclaredPortDoubles,
        imports: [CommunicationsModule, SchedulingModule],
        principalResolver: 'module',
        clockStart: START,
        env: { COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES: '120' },
      });
      pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
      });
      player = await createPersonFixture(t, { kind: 'adult' });
      await createAccountFixture(t, { personId: player });
      events = t.app.get(EventsService);
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      await t?.close();
    });

    const from = (n: number) => new Date(t.clock.now().getTime() + n * 60_000).toISOString();
    const noticesOf = (eventId: string) =>
      t.db
        .selectFrom('notifications')
        .select(['kind', 'title'])
        .where('subject_id', '=', eventId)
        .orderBy('created_at')
        .orderBy('id')
        .execute();

    it('R2-TENANCY-INPUT-02 / SPK-COMMS-002 / SPK-COMMS-005: an event with a 200-character title is announced when moved, reminded and canceled, each title within the limit', async () => {
      const name = `Under-12 ${'Development League '.repeat(12)}`.slice(0, 200);
      expect(name).toHaveLength(200);
      const event = await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.northHalfId],
        start: from(60),
        end: from(120),
        kind: 'practice',
        title: name,
        commitments: [personCommitment(player, 'participant')],
      });
      await dispatchOutbox(t.app);
      const system = systemPrincipal(t.organizationId, 'test');
      await events.moveEvent(system, event.id, {
        scheduledStart: from(90),
        scheduledEnd: from(150),
        reason: 'Pitch swap',
      });
      await dispatchOutbox(t.app);
      const [summary] = await t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(summary).toMatchObject({ ran: true, processed: 1, failed: false });
      await events.cancelEvent(system, event.id, { reason: 'Weather' });
      await dispatchOutbox(t.app);

      const notices = await noticesOf(event.id);
      const byKind = new Map(notices.map((n) => [n.kind, n.title]));
      for (const [kind, prefix] of [
        ['schedule_changed', 'Schedule changed: '],
        ['activity_reminder', 'Reminder: '],
        ['cancellation', 'Canceled: '],
      ] as const) {
        const title = byKind.get(kind);
        expect(title, kind).toBeDefined();
        expect(title!.length, kind).toBeLessThanOrEqual(NOTICE_TITLE_MAX);
        expect(title!.startsWith(`${prefix}Under-12 Development League`), kind).toBe(true);
        expect(title!.endsWith('…'), kind).toBe(true);
      }
    });

    it('R2-TENANCY-INPUT-02 / SPK-UX-006: a reminder that cannot be composed raises an owned exception and the next activity is still reminded', async () => {
      const other = await createPersonFixture(t, { kind: 'adult' });
      await createAccountFixture(t, { personId: other });
      const failing = await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.southHalfId],
        start: from(30),
        end: from(60),
        kind: 'practice',
        title: 'Breaks the composer',
        commitments: [personCommitment(other, 'participant')],
      });
      const next = await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.northHalfId],
        start: from(30),
        end: from(60),
        kind: 'practice',
        title: 'Still reminded',
        commitments: [personCommitment(player, 'participant')],
      });
      await dispatchOutbox(t.app);
      const notifications = t.app.get(NotificationsService);
      const compose = notifications.composeAndQueueIn.bind(notifications);
      const spy = vi
        .spyOn(notifications, 'composeAndQueueIn')
        .mockImplementation(async (trx, principal, input) => {
          if (input.title === 'Reminder: Breaks the composer') throw new Error('composer failed');
          return compose(trx, principal, input);
        });
      try {
        const [summary] = await t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
        expect(summary).toMatchObject({ ran: true, processed: 1, failed: false });
      } finally {
        spy.mockRestore();
      }
      expect((await noticesOf(next.id)).map((n) => n.kind)).toContain('activity_reminder');
      expect((await noticesOf(failing.id)).map((n) => n.kind)).not.toContain('activity_reminder');
      const raised = await t.db
        .selectFrom('operational_exceptions')
        .select(['category', 'owner_queue', 'status', 'affected_id'])
        .where('category', '=', 'communications.activity_reminder_failed')
        .execute();
      expect(raised).toEqual([
        {
          category: 'communications.activity_reminder_failed',
          owner_queue: 'support_operator',
          status: 'open',
          affected_id: failing.id,
        },
      ]);
      // nothing was marked for the failed entry, so the next run reminds it
      const [retry] = await t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
      expect(retry).toMatchObject({ processed: 1 });
      expect((await noticesOf(failing.id)).map((n) => n.kind)).toContain('activity_reminder');
    });
  });
});
