import { systemPrincipal, type DomainEvent } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { createScheduledEvent, EventsService, seedResource } from '../../scheduling';
import { SessionRetimedFollowUp } from '../services/session-retimed-follow-up';
import {
  acknowledge,
  adult,
  drain,
  enrollmentTestApp,
  offering,
  post,
  type Actor,
} from './support';

const HOUR = 3_600_000;

/**
 * R2-JOURNEYS-03 (SPK-AT-009, SPK-COMMS-005): a session booking keeps a copy of its session's
 * times. When scheduling moves the session's event, the catalog moves the session
 * (catalog.session_retimed) and enrollment.follow_session_retimed moves the live bookings, so the
 * family calendar, the notice window and check-in read the new time.
 */
describe('a moved session moves its bookings (R2-JOURNEYS-03, SPK-AT-009)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['pickup_sessions'] });
  });
  afterAll(async () => {
    await t.close();
  });

  const bookingTimes = async (id: string) => {
    const row = await t.db
      .selectFrom('session_bookings')
      .select(['scheduled_start', 'scheduled_end', 'revision', 'status'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return {
      start: new Date(row.scheduled_start).toISOString(),
      end: new Date(row.scheduled_end).toISOString(),
      revision: row.revision,
      status: row.status,
    };
  };

  it('R2-JOURNEYS-03 / SPK-AT-009 / SPK-COMMS-005: a session moved with its scheduling event moves its live bookings and the family calendar, once, from the session as it is now', async () => {
    const pickup = await offering(t, {
      kind: 'pickup',
      basePriceMinor: 0,
      capacityUnits: [{ unit: 'seats', limit: 4 }],
      ageBand: { minAgeYears: 18 },
    });
    const space = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Court R2-03',
    });
    const start = new Date('2026-11-20T02:00:00Z');
    const end = new Date(start.getTime() + HOUR);
    const event = await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      kind: 'session',
      title: 'Pickup night',
      start: start.toISOString(),
      end: end.toISOString(),
      resourceIds: [space.resourceId],
      sourceType: 'catalog.session',
    });
    const sessionId = await createOfferingSessionFixture(t, {
      offeringId: pickup.offeringId,
      scheduledStart: start,
      scheduledEnd: end,
      schedulingEventId: event.id,
    });
    const players: Actor[] = [];
    for (let i = 0; i < 2; i += 1) {
      const actor = await adult(t);
      await acknowledge(t, pickup, actor.personId, actor.personId);
      players.push(actor);
    }
    const [stays, leaves] = players as [Actor, Actor];
    const book = (actor: Actor) =>
      post(t, '/v1/session-bookings', actor.header, {
        offeringId: pickup.offeringId,
        sessionId,
        participantPersonId: actor.personId,
      });
    const live = await book(stays);
    expect(live.status, JSON.stringify(live.body)).toBe(201);
    const gone = await book(leaves);
    expect(gone.status, JSON.stringify(gone.body)).toBe(201);
    const left = await post(
      t,
      `/v1/session-bookings/${gone.body.id as string}/cancel`,
      leaves.header,
      {
        reason: 'cannot make it',
        expectedRevision: gone.body.revision,
      },
    );
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    await drain(t);
    const canceledBefore = await bookingTimes(gone.body.id as string);

    // the scheduler moves the event two hours later
    const movedStart = new Date(start.getTime() + 2 * HOUR);
    const movedEnd = new Date(end.getTime() + 2 * HOUR);
    await t.app.get(EventsService).moveEvent(systemPrincipal(t.organizationId, 'tests'), event.id, {
      scheduledStart: movedStart.toISOString(),
      scheduledEnd: movedEnd.toISOString(),
      reason: 'Court needed for a tournament',
    });
    await drain(t);

    const session = await t.db
      .selectFrom('offering_sessions')
      .select(['scheduled_start'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(new Date(session.scheduled_start).toISOString()).toBe(movedStart.toISOString());
    expect(await bookingTimes(live.body.id as string)).toEqual({
      start: movedStart.toISOString(),
      end: movedEnd.toISOString(),
      revision: (live.body.revision as number) + 1,
      status: 'confirmed',
    });
    // a booking the family canceled keeps the time it was canceled for
    expect(await bookingTimes(gone.body.id as string)).toEqual(canceledBefore);
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['details', 'reason'])
      .where('target_id', '=', live.body.id as string)
      .where('action', '=', 'enrollment.follow_session_retimed')
      .execute();
    expect(audits).toEqual([
      expect.objectContaining({
        reason: 'Court needed for a tournament',
        details: expect.objectContaining({
          previousStart: start.toISOString(),
          scheduledStart: movedStart.toISOString(),
          schedulingEventId: event.id,
        }),
      }),
    ]);
    // the family's calendar and booking read the new time
    const calendar = await t.http
      .get('/v1/me/family-calendar')
      .query({
        from: new Date(start.getTime() - 24 * HOUR).toISOString(),
        to: new Date(start.getTime() + 24 * HOUR).toISOString(),
      })
      .set(stays.header);
    expect(calendar.status).toBe(200);
    expect(
      calendar.body.items
        .filter((i: { sessionId: string; kind: string }) => i.sessionId === sessionId)
        .map((i: { kind: string; start: string }) => [i.kind, i.start]),
    ).toEqual([['session_booking', movedStart.toISOString()]]);
    const view = await t.http
      .get(`/v1/session-bookings/${live.body.id as string}`)
      .set(stays.header);
    expect(view.body.scheduledStart).toBe(movedStart.toISOString());

    // a replayed or late delivery reads the session as it is now and writes nothing
    const delivered = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'catalog.session_retimed')
      .where(sql<boolean>`payload->>'sessionId' = ${sessionId}`)
      .executeTakeFirstOrThrow();
    const stale = {
      id: delivered.id,
      type: delivered.event_type,
      organizationId: t.organizationId,
      correlationId: null,
      payload: {
        ...(delivered.payload as Record<string, unknown>),
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
      },
    } as unknown as DomainEvent<never>;
    const moved = await t.app
      .get(UnitOfWork)
      .run(({ trx }) => t.app.get(SessionRetimedFollowUp).onSessionRetimed(trx, stale));
    expect(moved).toBe(0);
    expect((await bookingTimes(live.body.id as string)).start).toBe(movedStart.toISOString());
  });
});
