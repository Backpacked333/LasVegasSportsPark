import { newId, systemPrincipal, type DomainEvent } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  drain,
  get,
  journeyApp,
  ok,
  post,
  staff,
  together,
  type Actor,
} from '../../../__tests__/journeys/support';
import { AuditWriter, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { COMPOSE_ACTIVITY_REMINDERS_JOB } from '../../communications';
import { createEnrollmentFixture } from '../../enrollment';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../../identity';
import { at, createScheduledEvent, EventsService, seedPitchWithHalves } from '../../scheduling';
import { SESSION_CANCELED_EVENT_REASON, SessionsService } from '../services/sessions.service';
import { createOfferingFixture, createProgramFixture } from '../testing/catalog-fixtures';

const DAY = '2027-01-16';
const NEXT = '2027-01-23';

type FollowedEvent = DomainEvent<{
  eventId: string;
  change: string;
  reason: string | null;
  closureId: string | null;
}>;

/**
 * R2-JOURNEYS-02 and R2-JOURNEYS-03 over the assembled application: a catalog session follows the
 * scheduling event that reserves its space in both directions (§4.2: scheduling is the authority
 * for the event). Canceling the session in the catalog cancels the event through scheduling's
 * port, so the reservation, the calendar projection, the families' notices and the reminders all
 * agree (SPK-AT-009 consistent publication, SPK-COMMS-002 cancellation); moving the event moves
 * the session (SPK-AT-009, SPK-COMMS-005, SPK-YOUTH-007).
 */
describe('catalog sessions follow their scheduling events (assembled application)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let manager: Actor;

  beforeAll(async () => {
    t = await journeyApp({
      clockStart: '2027-01-10T20:00:00Z',
      // SPK-COMMS-002 "remind": a week's lead time, so a still-published event would be reminded.
      env: { COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES: '10080' },
    });
    scheduler = await staff(t, ['scheduler']);
    manager = await staff(t, ['program_manager']);
  });
  afterAll(async () => {
    await t?.close();
  });

  async function youthOffering() {
    const programId = await createProgramFixture(t, {});
    return createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
      programId,
      basePriceMinor: 10_000,
    });
  }

  async function weeklyEvents(
    offeringId: string,
    resourceId: string,
    count: number,
    extra: Record<string, unknown> = {},
  ) {
    return ok<{ id: string; revision: number; eventIds: string[] }>(
      post(t, '/v1/event-series', scheduler.header, {
        facilityId: t.facilityId,
        kind: 'session',
        title: 'U10 clinic',
        recurrence: { frequency: 'weekly', interval: 1, startDate: DAY, count },
        localStartTime: '10:00',
        durationMinutes: 60,
        resourceIds: [resourceId],
        sourceType: 'offering',
        sourceId: offeringId,
        ...extra,
      }),
      201,
    );
  }

  async function linkedSession(
    offeringId: string,
    eventId: string,
    day: string,
    sequence: number,
    actor: Actor = scheduler,
  ) {
    return ok<{ id: string; revision: number }>(
      post(t, `/v1/offerings/${offeringId}/sessions`, actor.header, {
        scheduledStart: at(day, '10:00'),
        scheduledEnd: at(day, '11:00'),
        schedulingEventId: eventId,
        sequence,
      }),
      201,
    );
  }

  async function enrolledFamily(offeringId: string) {
    const parent = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: parent });
    const kid = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, { actorPersonId: parent, subjectPersonId: kid });
    await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: kid,
      payerPersonId: parent,
      orderRef: newId(),
    });
    return { parent, kid, header: await authHeaderForPerson(t, parent) };
  }

  const eventRow = (eventId: string) =>
    t.db
      .selectFrom('events')
      .select(['status', 'cancel_reason', 'scheduled_start', 'scheduled_end', 'revision'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
  const sessionRow = (sessionId: string) =>
    t.db
      .selectFrom('offering_sessions')
      .select(['status', 'scheduled_start', 'scheduled_end', 'revision'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
  const cancelAudit = (sessionId: string) =>
    t.db
      .selectFrom('audit_records')
      .select(['details'])
      .where('target_id', '=', sessionId)
      .where('action', '=', 'catalog.session_canceled')
      .execute();
  const changeDelivery = async (eventId: string, change: string, nth = 0) => {
    const rows = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', '=', eventId)
      .where(sql<boolean>`payload->>'change' = ${change}`)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    const row = rows[nth];
    if (!row) throw new Error(`no ${change} delivery for ${eventId}`);
    return {
      id: row.id,
      type: row.event_type,
      organizationId: row.organization_id,
      correlationId: row.correlation_id,
      payload: row.payload,
    } as unknown as FollowedEvent;
  };
  const replay = (delivery: FollowedEvent) =>
    t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(SessionsService).followSchedulingEvent(trx, delivery));

  it('R2-JOURNEYS-02 / SPK-AT-009 / SPK-COMMS-002 / §4.14: a session canceled in the catalog cancels its scheduling event: the space is released, the family is told once without the staff-only reason, no reminder follows and a replacement session can take the slot', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-02',
    });
    const offering = await youthOffering();
    const series = await weeklyEvents(offering.offeringId, pitch.northHalfId, 1);
    const eventId = series.eventIds[0] as string;
    const session = await linkedSession(offering.offeringId, eventId, DAY, 1);
    const family = await enrolledFamily(offering.offeringId);
    await drain(t);

    // a staff-only reason (the child-safe session view hides it, §4.14)
    const internalReason = 'Coach Smith suspended; Emma (age 7) injured';
    const canceled = await ok<{ status: string; cancelReason: string }>(
      post(t, `/v1/sessions/${session.id}/cancel`, manager.header, {
        reason: internalReason,
        expectedRevision: session.revision,
      }),
    );
    expect(canceled).toMatchObject({ status: 'canceled', cancelReason: internalReason });
    await drain(t);

    // scheduling: the event and its reservations are released with a customer-safe reason; the
    // staff reason stays with the catalog session and its audit record
    expect(await eventRow(eventId)).toMatchObject({
      status: 'canceled',
      cancel_reason: SESSION_CANCELED_EVENT_REASON,
    });
    const reasons = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', 'in', [session.id, eventId])
      .where('action', 'in', ['catalog.session_canceled', 'scheduling.event_canceled'])
      .orderBy('action')
      .execute();
    expect(reasons).toEqual([
      { action: 'catalog.session_canceled', reason: internalReason },
      { action: 'scheduling.event_canceled', reason: SESSION_CANCELED_EVENT_REASON },
    ]);
    const reservations = await t.db
      .selectFrom('reservations')
      .select('status')
      .where('event_id', '=', eventId)
      .execute();
    expect(reservations.length).toBeGreaterThan(0);
    expect(reservations.every((r) => r.status === 'released')).toBe(true);
    // the calendar projection (and the ICS feeds built on it) no longer shows a live event
    const projected = await t.db
      .selectFrom('calendar_entries')
      .select('status')
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(projected.status).toBe('canceled');
    // the catalog cancel records what it did with the event; the follow-up cancels nothing twice
    const audits = await cancelAudit(session.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({
      schedulingEvent: { id: eventId, outcome: 'canceled' },
    });
    expect(await replay(await changeDelivery(eventId, 'canceled'))).toBe(0);

    // the guardian is told once, never with the staff-only reason
    const inbox = await ok<{ items: Array<{ title: string; body: string }> }>(
      get(t, '/v1/me/inbox', family.header),
    );
    const notices = inbox.items.filter((n) => n.title.startsWith('Canceled: U10 clinic'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain(SESSION_CANCELED_EVENT_REASON);
    const delivered = await t.db
      .selectFrom('notifications')
      .selectAll()
      .where('subject_id', '=', eventId)
      .execute();
    expect(delivered.length).toBeGreaterThan(0);
    for (const text of [JSON.stringify(inbox), JSON.stringify(delivered)]) {
      expect(text).not.toContain('Emma');
      expect(text).not.toContain('suspended');
    }

    // no reminder is composed for the canceled activity
    await t.runPeriodicJobs([COMPOSE_ACTIVITY_REMINDERS_JOB]);
    await drain(t);
    const reminders = await t.db
      .selectFrom('notifications')
      .select('id')
      .where('kind', '=', 'activity_reminder')
      .where('subject_id', '=', eventId)
      .execute();
    expect(reminders).toEqual([]);

    // "cancel + add" (catalog README): the replacement takes the same slot without a conflict
    const replacement = await weeklyEvents(offering.offeringId, pitch.northHalfId, 1);
    await linkedSession(offering.offeringId, replacement.eventIds[0] as string, DAY, 2);
  });

  it('R2-JOURNEYS-02 / SPK-COMMS-002 (kept_shared): when one of two sessions sharing an event is canceled, its family hears nothing more about that event; the other family is still told of its change', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-02 audience',
    });
    const first = await youthOffering();
    const second = await youthOffering();
    const series = await weeklyEvents(first.offeringId, pitch.northHalfId, 1);
    const eventId = series.eventIds[0] as string;
    const canceledSession = await linkedSession(first.offeringId, eventId, DAY, 1);
    await linkedSession(second.offeringId, eventId, DAY, 1);
    const leaving = await enrolledFamily(first.offeringId);
    const staying = await enrolledFamily(second.offeringId);
    await drain(t);
    await ok(
      post(t, `/v1/sessions/${canceledSession.id}/cancel`, manager.header, {
        reason: 'Merged into the other group',
        expectedRevision: canceledSession.revision,
      }),
    );
    await drain(t);
    expect((await eventRow(eventId)).status).toBe('published');

    // the shared event moves: only the family of the session that still uses it is told
    const revision = (
      await t.db
        .selectFrom('event_series')
        .select('revision')
        .where('id', '=', series.id)
        .executeTakeFirstOrThrow()
    ).revision;
    await ok(
      post(t, `/v1/event-series/${series.id}/edits`, scheduler.header, {
        scope: 'one',
        occurrenceIndex: 0,
        changes: { localStartTime: '12:00' },
        expectedRevision: revision,
        reason: 'Pitch needed for a tournament',
      }),
    );
    await drain(t);
    const changed = async (family: { header: Record<string, string> }) =>
      (
        await ok<{ items: Array<{ title: string }> }>(get(t, '/v1/me/inbox', family.header))
      ).items.filter((n) => n.title.startsWith('Schedule changed: U10 clinic'));
    expect(await changed(staying)).toHaveLength(1);
    expect(await changed(leaving)).toEqual([]);
  });

  it('R2-JOURNEYS-02: sessions sharing one event keep it until the last is canceled, also when both are canceled at once', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-02 shared',
    });
    const first = await youthOffering();
    const second = await youthOffering();
    // one booking of the pitch serves two offerings' sessions
    const series = await weeklyEvents(first.offeringId, pitch.northHalfId, 2);
    const [eventA, eventB] = series.eventIds as [string, string];

    // one after the other: the first cancel keeps the event, the second releases it
    const a1 = await linkedSession(first.offeringId, eventA, DAY, 1);
    const a2 = await linkedSession(second.offeringId, eventA, DAY, 1);
    await ok(
      post(t, `/v1/sessions/${a1.id}/cancel`, manager.header, {
        reason: 'Merged into the other group',
        expectedRevision: a1.revision,
      }),
    );
    expect((await eventRow(eventA)).status).toBe('published');
    expect((await cancelAudit(a1.id))[0]?.details).toMatchObject({
      schedulingEvent: { id: eventA, outcome: 'kept_shared' },
    });
    await ok(
      post(t, `/v1/sessions/${a2.id}/cancel`, manager.header, {
        reason: 'Coach ill',
        expectedRevision: a2.revision,
      }),
    );
    expect((await eventRow(eventA)).status).toBe('canceled');

    // both at once (PGlite and TEST_DATABASE_URL): the first cancel stays uncommitted after it
    // decided to keep the event while the second decides; under PostgreSQL that overlap is real,
    // and only the per-event lock makes the second see the first's cancel. The event is released
    // exactly once, by whichever cancel commits last.
    const b1 = await linkedSession(first.offeringId, eventB, NEXT, 2);
    const b2 = await linkedSession(second.offeringId, eventB, NEXT, 2);
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    let decided!: () => void;
    const firstDecided = new Promise<void>((resolve) => (decided = resolve));
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, input) => {
      if (input.action === 'catalog.session_canceled' && input.targetId === b1.id) {
        decided();
        if (t.database.concurrent) await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return record(trx, input);
    });
    let r1: Awaited<ReturnType<typeof post>>;
    let r2: Awaited<ReturnType<typeof post>>;
    try {
      const firstCancel = post(t, `/v1/sessions/${b1.id}/cancel`, manager.header, {
        reason: 'Weather',
        expectedRevision: b1.revision,
      }).then((res) => res);
      // PGlite runs one transaction at a time, so there the second simply follows the first
      await (t.database.concurrent ? firstDecided : firstCancel);
      [r1, r2] = await together(
        () => firstCancel,
        () =>
          post(t, `/v1/sessions/${b2.id}/cancel`, manager.header, {
            reason: 'Weather',
            expectedRevision: b2.revision,
          }).then((res) => res),
      );
    } finally {
      spy.mockRestore();
    }
    expect([r1.status, r2.status], JSON.stringify([r1.body, r2.body])).toEqual([200, 200]);
    expect((await eventRow(eventB)).status).toBe('canceled');
    const outcomes = [...(await cancelAudit(b1.id)), ...(await cancelAudit(b2.id))].map(
      (r) => (r.details as { schedulingEvent: { outcome: string } }).schedulingEvent.outcome,
    );
    expect(outcomes.sort()).toEqual(['canceled', 'kept_shared']);
    await drain(t);
    const changes = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'scheduling.event_changed')
      .where('aggregate_id', '=', eventB)
      .where(sql<boolean>`payload->>'change' = 'canceled'`)
      .execute();
    expect(changes).toHaveLength(1);
  });

  it("R2-JOURNEYS-02 / §4.2: a session linked to a fixture's event never cancels the fixture's event", async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-02 fixture',
    });
    const offering = await youthOffering();
    const series = await weeklyEvents(offering.offeringId, pitch.pitchId, 1, {
      sourceType: 'fixture',
      sourceId: newId(),
    });
    const eventId = series.eventIds[0] as string;
    const session = await linkedSession(offering.offeringId, eventId, DAY, 1);
    await ok(
      post(t, `/v1/sessions/${session.id}/cancel`, manager.header, {
        reason: 'Clinic dropped',
        expectedRevision: session.revision,
      }),
    );
    expect((await sessionRow(session.id)).status).toBe('canceled');
    expect((await eventRow(eventId)).status).toBe('published');
    expect((await cancelAudit(session.id))[0]?.details).toMatchObject({
      schedulingEvent: { id: eventId, outcome: 'kept_owned_elsewhere' },
    });
  });

  it("R2-JOURNEYS-02 / §4.9: when scheduling refuses the event's cancel, nothing is canceled", async () => {
    const eastFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: eastFacilityId,
        organization_id: t.organizationId,
        slug: `east-${eastFacilityId.slice(-6)}`,
        name: 'East complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    const eastPitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: eastFacilityId,
      name: 'East pitch',
    });
    // a program manager for the home facility only: catalog authority, no event authority at East
    const localManager = await createStaffMemberFixture(t, {
      roles: ['program_manager'],
      facilityIds: [t.facilityId],
    });
    const local: Actor = {
      personId: localManager.personId,
      accountId: localManager.accountId,
      header: await authHeaderForPerson(t, localManager.personId),
    };
    const offering = await youthOffering();
    const series = await ok<{ eventIds: string[] }>(
      post(t, '/v1/event-series', scheduler.header, {
        facilityId: eastFacilityId,
        kind: 'session',
        title: 'U10 clinic (East)',
        recurrence: { frequency: 'weekly', interval: 1, startDate: DAY, count: 1 },
        localStartTime: '10:00',
        durationMinutes: 60,
        resourceIds: [eastPitch.northHalfId],
        sourceType: 'offering',
        sourceId: offering.offeringId,
      }),
      201,
    );
    const eventId = series.eventIds[0] as string;
    const session = await linkedSession(offering.offeringId, eventId, DAY, 1);
    const refused = await post(t, `/v1/sessions/${session.id}/cancel`, local.header, {
      reason: 'Coach ill',
      expectedRevision: session.revision,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await sessionRow(session.id)).toMatchObject({ status: 'scheduled', revision: 1 });
    expect((await eventRow(eventId)).status).toBe('published');
    expect(await cancelAudit(session.id)).toEqual([]);
    const emitted = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'catalog.session_canceled')
      .where(sql<boolean>`payload->>'sessionId' = ${session.id}`)
      .execute();
    expect(emitted).toEqual([]);
  });

  it('R2-JOURNEYS-03 / SPK-AT-009 / SPK-COMMS-005 / SPK-YOUTH-007: a moved scheduling event moves its catalog session, idempotently and never back to an older time', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-03',
    });
    const offering = await youthOffering();
    const series = await weeklyEvents(offering.offeringId, pitch.northHalfId, 2);
    const [firstEvent, secondEvent] = series.eventIds as [string, string];
    const first = await linkedSession(offering.offeringId, firstEvent, DAY, 1);
    const second = await linkedSession(offering.offeringId, secondEvent, NEXT, 2);
    const family = await enrolledFamily(offering.offeringId);
    await drain(t);

    const seriesRevision = async () =>
      (
        await t.db
          .selectFrom('event_series')
          .select('revision')
          .where('id', '=', series.id)
          .executeTakeFirstOrThrow()
      ).revision;
    // the scheduler moves the second occurrence two hours later
    await ok(
      post(t, `/v1/event-series/${series.id}/edits`, scheduler.header, {
        scope: 'one',
        occurrenceIndex: 1,
        changes: { localStartTime: '12:00' },
        expectedRevision: await seriesRevision(),
        reason: 'Pitch needed for a tournament',
      }),
    );
    await drain(t);

    const moved = await eventRow(secondEvent);
    expect(new Date(moved.scheduled_start).toISOString()).toBe(at(NEXT, '12:00'));
    const session = await sessionRow(second.id);
    expect(new Date(session.scheduled_start).toISOString()).toBe(at(NEXT, '12:00'));
    expect(new Date(session.scheduled_end).toISOString()).toBe(at(NEXT, '13:00'));
    expect(session).toMatchObject({ status: 'scheduled', revision: 2 });
    // the untouched occurrence keeps its time
    expect(new Date((await sessionRow(first.id)).scheduled_start).toISOString()).toBe(
      at(DAY, '10:00'),
    );
    // audited and published for the modules that copy session times
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['details', 'reason', 'before_revision', 'after_revision'])
      .where('target_id', '=', second.id)
      .where('action', '=', 'catalog.session_retimed')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      reason: 'Pitch needed for a tournament',
      before_revision: 1,
      after_revision: 2,
      details: {
        previousStart: at(NEXT, '10:00'),
        scheduledStart: at(NEXT, '12:00'),
        schedulingEventId: secondEvent,
        change: 'moved',
      },
    });
    const retimed = await t.db
      .selectFrom('outbox_events')
      .select(['payload'])
      .where('event_type', '=', 'catalog.session_retimed')
      .where(sql<boolean>`payload->>'sessionId' = ${second.id}`)
      .execute();
    expect(retimed.map((r) => r.payload)).toEqual([
      {
        sessionId: second.id,
        offeringId: offering.offeringId,
        sequence: 2,
        schedulingEventId: secondEvent,
        previousStart: at(NEXT, '10:00'),
        previousEnd: at(NEXT, '11:00'),
        scheduledStart: at(NEXT, '12:00'),
        scheduledEnd: at(NEXT, '13:00'),
        revision: 2,
        reason: 'Pitch needed for a tournament',
      },
    ]);

    // the family calendar and the desk's session list read the new time
    const calendar = await ok<{ items: Array<{ sessionId: string; start: string; kind: string }> }>(
      get(
        t,
        `/v1/me/family-calendar?from=${at('2027-01-22', '00:00')}&to=${at('2027-01-25', '00:00')}`,
        family.header,
      ),
    );
    expect(
      calendar.items.filter((i) => i.sessionId === second.id).map((i) => [i.kind, i.start]),
    ).toEqual([['enrollment_session', at(NEXT, '12:00')]]);
    const desk = await ok<{ items: Array<{ sessionId: string; scheduledStart: string }> }>(
      get(
        t,
        `/v1/sessions?facilityId=${t.facilityId}&from=${at('2027-01-22', '00:00')}&to=${at('2027-01-25', '00:00')}`,
        scheduler.header,
      ),
    );
    expect(desk.items.find((i) => i.sessionId === second.id)?.scheduledStart).toBe(
      at(NEXT, '12:00'),
    );

    // replay of the same delivery changes nothing
    const firstMove = await changeDelivery(secondEvent, 'moved', 0);
    expect(await replay(firstMove)).toBe(0);

    // a later move wins over a late redelivery of the earlier one (§4.12, §4.6)
    await ok(
      post(t, `/v1/event-series/${series.id}/edits`, scheduler.header, {
        scope: 'one',
        occurrenceIndex: 1,
        changes: { localStartTime: '14:00' },
        expectedRevision: await seriesRevision(),
      }),
    );
    await drain(t);
    expect(new Date((await sessionRow(second.id)).scheduled_start).toISOString()).toBe(
      at(NEXT, '14:00'),
    );
    expect(await replay(firstMove)).toBe(0);
    expect(await sessionRow(second.id)).toMatchObject({ revision: 3 });
    expect(new Date((await sessionRow(second.id)).scheduled_start).toISOString()).toBe(
      at(NEXT, '14:00'),
    );
  });

  it('R2-JOURNEYS-03: a canceled session does not follow a later move of its event', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-03 shared',
    });
    const first = await youthOffering();
    const second = await youthOffering();
    const series = await weeklyEvents(first.offeringId, pitch.southHalfId, 1);
    const eventId = series.eventIds[0] as string;
    const kept = await linkedSession(first.offeringId, eventId, DAY, 1);
    const dropped = await linkedSession(second.offeringId, eventId, DAY, 1);
    await ok(
      post(t, `/v1/sessions/${dropped.id}/cancel`, manager.header, {
        reason: 'Too few players',
        expectedRevision: dropped.revision,
      }),
    );
    const revision = (
      await t.db
        .selectFrom('event_series')
        .select('revision')
        .where('id', '=', series.id)
        .executeTakeFirstOrThrow()
    ).revision;
    await ok(
      post(t, `/v1/event-series/${series.id}/edits`, scheduler.header, {
        scope: 'one',
        occurrenceIndex: 0,
        changes: { localStartTime: '09:00' },
        expectedRevision: revision,
      }),
    );
    await drain(t);
    expect(new Date((await sessionRow(kept.id)).scheduled_start).toISOString()).toBe(
      at(DAY, '09:00'),
    );
    const canceled = await sessionRow(dropped.id);
    expect(canceled.status).toBe('canceled');
    expect(new Date(canceled.scheduled_start).toISOString()).toBe(at(DAY, '10:00'));
  });

  it('R2-JOURNEYS-03 / SPK-AT-009: a session linked to a draft event that is moved while still a draft, then published through a schedule draft, ends up at the published times', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-03 draft',
    });
    const offering = await youthOffering();
    const events = t.app.get(EventsService);
    const draft = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [pitch.northHalfId],
      start: at(DAY, '10:00'),
      end: at(DAY, '11:00'),
      kind: 'session',
      title: 'U10 clinic (draft)',
      sourceType: 'offering',
      sourceId: offering.offeringId,
      status: 'draft',
    });
    const session = await linkedSession(offering.offeringId, draft.id, DAY, 1);

    // a move of a draft event emits no event_changed: the session keeps its time for now
    await t.app.get(UnitOfWork).run(() =>
      events.moveEvent(systemPrincipal(t.organizationId, 'tests'), draft.id, {
        scheduledStart: at(DAY, '12:00'),
        scheduledEnd: at(DAY, '13:30'),
        reason: 'Draft reshuffle',
      }),
    );
    await drain(t);
    expect(new Date((await sessionRow(session.id)).scheduled_start).toISOString()).toBe(
      at(DAY, '10:00'),
    );

    // publication of the draft ('published', not 'moved') gives the session the published times
    const scheduleDraft = await ok<{ id: string }>(
      post(t, '/v1/schedule-drafts', scheduler.header, {
        facilityId: t.facilityId,
        name: 'Publish the clinic',
        changes: [{ kind: 'create', targetEventId: draft.id }],
      }),
      201,
    );
    await ok(post(t, `/v1/schedule-drafts/${scheduleDraft.id}/publish`, scheduler.header, {}));
    await drain(t);
    const published = await eventRow(draft.id);
    expect(published.status).toBe('published');
    const followed = await sessionRow(session.id);
    expect(new Date(followed.scheduled_start).toISOString()).toBe(at(DAY, '12:00'));
    expect(new Date(followed.scheduled_end).toISOString()).toBe(at(DAY, '13:30'));
    expect(followed).toMatchObject({ status: 'scheduled', revision: 2 });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['details'])
      .where('target_id', '=', session.id)
      .where('action', '=', 'catalog.session_retimed')
      .execute();
    expect(audit.map((a) => a.details)).toEqual([
      expect.objectContaining({
        previousStart: at(DAY, '10:00'),
        scheduledStart: at(DAY, '12:00'),
        scheduledEnd: at(DAY, '13:30'),
        change: 'published',
      }),
    ]);
    // replaying the publication changes nothing
    expect(await replay(await changeDelivery(draft.id, 'published'))).toBe(0);
  });

  it("R2-JOURNEYS-03 / SPK-AT-009: a linked session is created at its event's times; other times, an unknown event and a canceled event are refused and nothing is written", async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-03 link',
    });
    const offering = await youthOffering();
    const series = await weeklyEvents(offering.offeringId, pitch.northHalfId, 1);
    const eventId = series.eventIds[0] as string;
    const attempt = (body: Record<string, unknown>) =>
      post(t, `/v1/offerings/${offering.offeringId}/sessions`, scheduler.header, {
        scheduledStart: at(DAY, '10:00'),
        scheduledEnd: at(DAY, '11:00'),
        schedulingEventId: eventId,
        sequence: 1,
        ...body,
      });

    // part of the booking (10:30-11:00 inside 10:00-11:00), or a longer one, would be overwritten
    // with the event's whole span on its next change
    for (const times of [
      { scheduledStart: at(DAY, '10:30') },
      { scheduledEnd: at(DAY, '12:00') },
    ]) {
      const refused = await attempt(times);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          path: 'scheduledStart',
          eventScheduledStart: at(DAY, '10:00'),
          eventScheduledEnd: at(DAY, '11:00'),
        },
      });
    }
    const unknown = await attempt({ schedulingEventId: newId() });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(400);
    expect(unknown.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { path: 'schedulingEventId' },
    });
    const sessionsOf = () =>
      t.db
        .selectFrom('offering_sessions')
        .select('id')
        .where('offering_id', '=', offering.offeringId)
        .execute();
    expect(await sessionsOf()).toEqual([]);

    // at the event's times the session is created; once it is canceled with its event, no new
    // session can be linked to the canceled event
    const session = await ok<{ id: string; revision: number }>(attempt({}), 201);
    await ok(
      post(t, `/v1/sessions/${session.id}/cancel`, manager.header, {
        reason: 'Clinic dropped',
        expectedRevision: session.revision,
      }),
    );
    expect((await eventRow(eventId)).status).toBe('canceled');
    const onCanceled = await attempt({ sequence: 2 });
    expect(onCanceled.status, JSON.stringify(onCanceled.body)).toBe(400);
    expect(onCanceled.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { path: 'schedulingEventId', eventStatus: 'canceled' },
    });
    expect(await sessionsOf()).toHaveLength(1);
  });

  it('R2-JOURNEYS-03: a session created while its event is being moved ends at the moved times (PGlite and TEST_DATABASE_URL)', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch R2-03 race',
    });
    const offering = await youthOffering();
    const series = await weeklyEvents(offering.offeringId, pitch.southHalfId, 1);
    const eventId = series.eventIds[0] as string;
    const seriesRevision = async () =>
      (
        await t.db
          .selectFrom('event_series')
          .select('revision')
          .where('id', '=', series.id)
          .executeTakeFirstOrThrow()
      ).revision;

    // The creation checks the event's times (10:00) and then stays uncommitted while the event is
    // moved and the move's delivery is handled. Under PostgreSQL that overlap is real: without the
    // per-event lock the handler would find no session yet and the new session would keep the old
    // time for good; with it the handler waits for the creation and then retimes it.
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    let checked!: () => void;
    const creationChecked = new Promise<void>((resolve) => (checked = resolve));
    let moved!: () => void;
    const eventMoved = new Promise<void>((resolve) => (moved = resolve));
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, input) => {
      if (input.action === 'catalog.session_created' && t.database.concurrent) {
        checked();
        await eventMoved;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return record(trx, input);
    });
    let created: { id: string };
    try {
      const creation = linkedSession(offering.offeringId, eventId, DAY, 1);
      // PGlite runs one transaction at a time, so there the move simply follows the creation
      await (t.database.concurrent ? creationChecked : creation);
      await ok(
        post(t, `/v1/event-series/${series.id}/edits`, scheduler.header, {
          scope: 'one',
          occurrenceIndex: 0,
          changes: { localStartTime: '15:00' },
          expectedRevision: await seriesRevision(),
        }),
      );
      moved();
      await drain(t);
      created = await creation;
    } finally {
      spy.mockRestore();
    }
    await drain(t);
    const row = await sessionRow(created.id);
    expect(new Date(row.scheduled_start).toISOString()).toBe(at(DAY, '15:00'));
    expect(new Date(row.scheduled_end).toISOString()).toBe(at(DAY, '16:00'));
  });
});
