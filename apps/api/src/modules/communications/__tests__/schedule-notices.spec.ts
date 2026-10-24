import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHandlerRegistry, Outbox, UnitOfWork, type EventHandler } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
  type OrganizationPeople,
} from '../../identity';
import {
  EventsService,
  SchedulePublished,
  SchedulingModule,
  at,
  createScheduledEvent,
  personCommitment,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { CommunicationsModule } from '../communications.module';
import { NotificationsService } from '../services/notifications.service';
import {
  attemptsOf,
  dispatchOutbox,
  inboxOf,
  recipientsOf,
} from '../testing/communications-fixtures';

const key = () => `k-${newId()}`;

describe('schedule notices (SPK-COMMS-002 "schedule publication or change", SPK-COMMS-005 old/new details and obsolete reminders)', () => {
  let t: TestApp;
  let org: string;
  let system: Principal;
  let events: EventsService;
  let notifications: NotificationsService;
  let pitch: PitchFixture;
  let people: OrganizationPeople;
  let adultPlayer: string;
  let staff: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CommunicationsModule, SchedulingModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    events = t.app.get(EventsService);
    notifications = t.app.get(NotificationsService);
    pitch = await seedPitchWithHalves(t.db, { organizationId: org, facilityId: t.facilityId });
    people = await createOrganizationPeople(t, { staffRoles: ['scheduler'] });
    adultPlayer = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: adultPlayer });
    staff = await authHeaderForPerson(t, people.staff.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const noticesFor = (eventId: string) =>
    t.db
      .selectFrom('notifications')
      .selectAll()
      .where('organization_id', '=', org)
      .where('subject_type', '=', 'event')
      .where('subject_id', '=', eventId)
      .orderBy('created_at')
      .execute();

  it('publishing an event notifies committed people (guardians through receive_messages) with the practical details; a move carries old and new; the older notice is marked superseded', async () => {
    const event = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at('2026-11-07', '10:00'),
      end: at('2026-11-07', '11:00'),
      title: 'U10 Lions vs Tigers',
      commitments: [
        personCommitment(people.child.personId, 'participant'),
        personCommitment(adultPlayer, 'participant'),
      ],
    });
    await dispatchOutbox(t.app);
    let notices = await noticesFor(event.id);
    expect(notices).toHaveLength(1);
    const published = notices[0]!;
    expect(published).toMatchObject({
      kind: 'schedule_published',
      category: 'operational',
      status: 'dispatched',
      protected: false,
      facility_id: t.facilityId,
    });
    expect(published.details_after).toMatchObject({
      title: 'U10 Lions vs Tigers',
      scheduledStart: at('2026-11-07', '10:00'),
      status: 'published',
    });
    expect(published.body).toContain('Sat, Nov 7, 10:00 AM to 11:00 AM');
    const recipients = await recipientsOf(t.db, org, published.id);
    expect(recipients.map((r) => `${r.person_id}:${r.resolved_basis}`).sort()).toEqual(
      [`${people.adult.personId}:receive_messages`, `${adultPlayer}:self`].sort(),
    );
    expect(
      (await inboxOf(t.db, org, people.adult.personId)).map((a) => a.notification_id),
    ).toContain(published.id);

    await events.moveEvent(system, event.id, {
      scheduledStart: at('2026-11-07', '14:00'),
      scheduledEnd: at('2026-11-07', '15:00'),
      expectedRevision: event.revision,
      reason: 'Referee availability',
    });
    await dispatchOutbox(t.app);
    notices = await noticesFor(event.id);
    expect(notices).toHaveLength(2);
    const changed = notices[1]!;
    expect(changed).toMatchObject({ kind: 'schedule_changed', status: 'dispatched' });
    expect(changed.details_before).toMatchObject({ scheduledStart: at('2026-11-07', '10:00') });
    expect(changed.details_after).toMatchObject({ scheduledStart: at('2026-11-07', '14:00') });
    expect(changed.body).toContain('Was: Sat, Nov 7, 10:00 AM to 11:00 AM');
    expect(changed.body).toContain('Now: Sat, Nov 7, 2:00 PM to 3:00 PM');
    expect(changed.body).toContain('Reason: Referee availability');
    // the earlier (already delivered) notice now points at the newer one so inboxes can show it
    expect((await noticesFor(event.id))[0]?.superseded_by_notification_id).toBe(changed.id);
    const inbox = await t.http
      .get('/v1/me/inbox?limit=10')
      .set(await authHeaderForPerson(t, people.adult.personId));
    const oldItem = inbox.body.items.find(
      (i: { notificationId: string }) => i.notificationId === published.id,
    );
    expect(oldItem.supersededByNotificationId).toBe(changed.id);
    expect(oldItem.detailsAfter.scheduledStart).toBe(at('2026-11-07', '10:00'));

    // replaying the same scheduling event never composes a second notice (unique source event)
    const sourceEvents = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', '=', event.id)
      .execute();
    expect(sourceEvents).toHaveLength(2);
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null })
      .where(
        'id',
        'in',
        sourceEvents.map((e) => e.id),
      )
      .execute();
    await dispatchOutbox(t.app);
    expect(await noticesFor(event.id)).toHaveLength(2);
  });

  it('SPK-COMMS-005: an unsent reminder about an event is suppressed when a newer change arrives, and the cancellation shows the old details', async () => {
    const event = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-14', '10:00'),
      end: at('2026-11-14', '11:00'),
      title: 'U10 practice',
      commitments: [personCommitment(people.child.personId, 'participant')],
    });
    await dispatchOutbox(t.app);
    // staff schedules a reminder for the day before
    const composed = await t.http
      .post('/v1/notifications')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'schedule_published',
        subject: { type: 'event', id: event.id },
        audience: { subjectPersonIds: [people.child.personId] },
        title: 'Reminder: U10 practice tomorrow',
        body: 'See you at 10:00 on the north half.',
        scheduledFor: '2026-11-13T17:00:00.000Z',
      });
    expect(composed.status).toBe(201);
    const sent = await t.http
      .post(`/v1/notifications/${composed.body.id}/send`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({});
    expect(sent.body.status).toBe('queued');
    await dispatchOutbox(t.app); // the reminder is not due: its delivery request waits
    expect((await notifications.get(system, composed.body.id)).status).toBe('queued');
    expect(await attemptsOf(t.db, org, composed.body.id)).toHaveLength(0);

    await events.cancelEvent(system, event.id, {
      reason: 'Pitch flooded',
      expectedRevision: event.revision,
    });
    await dispatchOutbox(t.app);
    const cancellation = (await noticesFor(event.id)).find((n) => n.kind === 'cancellation')!;
    expect(cancellation).toMatchObject({
      status: 'dispatched',
      supersedes_notification_id: composed.body.id,
    });
    expect(cancellation.details_before).toMatchObject({
      status: 'published',
      title: 'U10 practice',
    });
    expect(cancellation.body).toContain('has been canceled');
    expect(cancellation.body).toContain('Reason: Pitch flooded');
    const reminder = await notifications.get(system, composed.body.id);
    expect(reminder).toMatchObject({
      status: 'suppressed',
      suppressionReason: 'obsolete',
      supersededByNotificationId: cancellation.id,
    });

    // when the reminder's delivery request finally comes due, nothing is sent
    t.clock.set('2026-11-13T18:00:00.000Z');
    await dispatchOutbox(t.app);
    expect(await attemptsOf(t.db, org, composed.body.id)).toHaveLength(0);
    expect((await notifications.get(system, composed.body.id)).status).toBe('suppressed');
    t.clock.set('2026-10-23T12:00:00Z');
  });

  it('SPK-SCHED-005: a draft event produces neither a customer notice nor a calendar entry; the projection follows published facts only', async () => {
    const draft = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-21', '10:00'),
      end: at('2026-11-21', '11:00'),
      status: 'draft',
      commitments: [personCommitment(people.child.personId, 'participant')],
    });
    await dispatchOutbox(t.app);
    expect(await noticesFor(draft.id)).toHaveLength(0);
    const entries = await t.db
      .selectFrom('calendar_entries')
      .selectAll()
      .where('event_id', '=', draft.id)
      .execute();
    expect(entries).toHaveLength(0);
    // a published event is projected with its committed parties and tracks every later change
    const published = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-22', '10:00'),
      end: at('2026-11-22', '11:00'),
      commitments: [personCommitment(people.child.personId, 'participant')],
    });
    await dispatchOutbox(t.app);
    const entry = await t.db
      .selectFrom('calendar_entries')
      .selectAll()
      .where('event_id', '=', published.id)
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ status: 'published', sequence: 0, last_change: 'created' });
    const parties = await t.db
      .selectFrom('calendar_entry_parties')
      .selectAll()
      .where('entry_id', '=', entry.id)
      .execute();
    expect(parties).toEqual([
      expect.objectContaining({ party_type: 'person', party_id: people.child.personId }),
    ]);
  });

  describe('§4.12 reordering: an older scheduling.event_changed processed after a newer one (SPK-COMMS-008, SPK-COMMS-005)', () => {
    /** Makes the notice handler fail once for the next `moved` change of the event (a transient error). */
    function failNextMove(eventId: string): () => void {
      const entry = t.app
        .get(EventHandlerRegistry)
        .handlersFor('scheduling.event_changed')
        .find((h) => h.name === 'communications.schedule_change_notice');
      if (!entry) throw new Error('schedule change handler not registered');
      const original: EventHandler = entry.handler;
      let failed = false;
      entry.handler = async (event, ctx) => {
        const payload = event.payload as { eventId: string; change: string };
        if (!failed && payload.eventId === eventId && payload.change === 'moved') {
          failed = true;
          throw new Error('transient failure');
        }
        return original(event, ctx);
      };
      return () => {
        entry.handler = original;
      };
    }
    const changesOf = (eventId: string) =>
      t.db
        .selectFrom('outbox_events')
        .select(['id', 'status', 'payload'])
        .where('event_type', '=', 'scheduling.event_changed')
        .where('aggregate_id', '=', eventId)
        .execute();
    const entryOf = (eventId: string) =>
      t.db
        .selectFrom('calendar_entries')
        .selectAll()
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow();

    it('SPK-COMMS-008 / SPK-COMMS-005: a late retry of an older move neither rolls the calendar entry back (or bumps SEQUENCE) nor composes a stale notice that supersedes the current one', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at('2026-12-05', '10:00'),
        end: at('2026-12-05', '11:00'),
        title: 'U12 Lions vs Bears',
        commitments: [personCommitment(adultPlayer, 'participant')],
      });
      await dispatchOutbox(t.app);
      const restore = failNextMove(event.id);
      try {
        const moved = await events.moveEvent(system, event.id, {
          scheduledStart: at('2026-12-05', '14:00'),
          scheduledEnd: at('2026-12-05', '15:00'),
          expectedRevision: event.revision,
        });
        await dispatchOutbox(t.app); // the first move's notice handler fails and is retried later
        t.clock.advance(1000);
        await events.moveEvent(system, event.id, {
          scheduledStart: at('2026-12-05', '18:00'),
          scheduledEnd: at('2026-12-05', '19:00'),
          expectedRevision: moved.revision,
        });
        await dispatchOutbox(t.app); // the newer move is applied first
        t.clock.advance(5000);
        await dispatchOutbox(t.app); // the older move's retry arrives last
      } finally {
        restore();
      }
      const changes = await changesOf(event.id);
      expect(changes.every((c) => c.status === 'dispatched')).toBe(true);
      const latest = changes.find(
        (c) =>
          (c.payload as { after?: { scheduledStart?: string } }).after?.scheduledStart ===
          at('2026-12-05', '18:00'),
      );
      expect(await entryOf(event.id)).toMatchObject({
        status: 'published',
        sequence: 1,
        last_source_event_id: latest?.id,
      });
      expect(new Date((await entryOf(event.id)).scheduled_start).toISOString()).toBe(
        at('2026-12-05', '18:00'),
      );
      const changed = (await noticesFor(event.id)).filter((n) => n.kind === 'schedule_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]?.details_after).toMatchObject({
        scheduledStart: at('2026-12-05', '18:00'),
      });
      expect(changed[0]?.superseded_by_notification_id).toBeNull();
      const published = (await noticesFor(event.id)).find((n) => n.kind === 'schedule_published');
      expect(published?.superseded_by_notification_id).toBe(changed[0]?.id);
    });

    it('SPK-COMMS-008 / SPK-COMMS-005: a late retry of a move made before a cancellation leaves the entry canceled and composes no change notice after the cancellation', async () => {
      const event = await createScheduledEvent(events, {
        organizationId: org,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at('2026-12-06', '10:00'),
        end: at('2026-12-06', '11:00'),
        title: 'U12 Lions vs Wolves',
        commitments: [personCommitment(adultPlayer, 'participant')],
      });
      await dispatchOutbox(t.app);
      const restore = failNextMove(event.id);
      try {
        const moved = await events.moveEvent(system, event.id, {
          scheduledStart: at('2026-12-06', '14:00'),
          scheduledEnd: at('2026-12-06', '15:00'),
          expectedRevision: event.revision,
        });
        await dispatchOutbox(t.app);
        t.clock.advance(1000);
        await events.cancelEvent(system, event.id, {
          reason: 'Pitch flooded',
          expectedRevision: moved.revision,
        });
        await dispatchOutbox(t.app);
        t.clock.advance(5000);
        await dispatchOutbox(t.app);
      } finally {
        restore();
      }
      expect((await changesOf(event.id)).every((c) => c.status === 'dispatched')).toBe(true);
      expect(await entryOf(event.id)).toMatchObject({ status: 'canceled', sequence: 1 });
      const kinds = (await noticesFor(event.id)).map((n) => n.kind);
      expect(kinds).toEqual(['schedule_published', 'cancellation']);
    });
  });

  it('a publication group produces a staff summary for schedulers of the facility', async () => {
    const scheduler = await createStaffMemberFixture(t, {
      roles: ['scheduler'],
      facilityIds: [t.facilityId],
    });
    const uow = t.app.get(UnitOfWork);
    const outbox = t.app.get(Outbox);
    const publicationId = newId();
    await uow.run(({ trx }) =>
      outbox.enqueue(trx, SchedulePublished, {
        organizationId: org,
        aggregateType: 'publication',
        aggregateId: publicationId,
        payload: {
          publicationId,
          draftId: newId(),
          facilityId: t.facilityId,
          eventIds: [newId(), newId()],
          changes: [
            { sequence: 1, kind: 'create', eventId: newId() },
            { sequence: 2, kind: 'move', eventId: newId() },
          ],
          remainingObligations: [
            {
              code: 'REFEREE_ASSIGNMENT',
              message: 'Assign referees',
              owner: 'league_manager',
              deadline: null,
            },
          ],
        },
      }),
    );
    await dispatchOutbox(t.app);
    const summary = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('subject_type', '=', 'publication')
      .where('subject_id', '=', publicationId)
      .executeTakeFirstOrThrow();
    expect(summary).toMatchObject({ kind: 'schedule_published', status: 'dispatched' });
    expect(summary.body).toContain('REFEREE_ASSIGNMENT');
    const recipients = await recipientsOf(t.db, org, summary.id);
    expect(recipients.map((r) => r.person_id)).toContain(scheduler.personId);
    expect(recipients.map((r) => r.person_id)).toContain(people.staff.personId);
    expect(recipients.every((r) => r.resolved_basis === 'staff_role')).toBe(true);
  });
});
