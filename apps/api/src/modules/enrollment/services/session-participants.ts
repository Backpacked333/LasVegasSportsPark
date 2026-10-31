import { Injectable } from '@nestjs/common';
import type { BookingStatusValue as BookingStatus, Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Trx } from '../../../kernel';
import { SessionsService } from '../../catalog';
import type { ClosureImpactContribution, ImpactedEventRef } from '../../scheduling';

/** A participant of a catalog session, or the booker of a rental or party, of a scheduling event. */
export interface SessionParticipant {
  schedulingEventId: string;
  /** The catalog session; null for a rental or party booking (ENR-13). */
  sessionId: string | null;
  offeringId: string;
  personId: string;
  via: 'enrollment' | 'booking';
  /** The finance order the participation was paid through (an enrollment or a paid booking). */
  orderRef: string | null;
}

/** Bookings whose booker is told of their events' changes (a booking just ended by one too). */
const AUDIENCE_BOOKING_STATUSES: BookingStatus[] = [
  'held',
  'awaiting_staff',
  'confirmed',
  'canceled',
];
/** Bookings a closure still affects. */
const LIVE_BOOKING_STATUSES: BookingStatus[] = ['held', 'awaiting_staff', 'confirmed'];

/**
 * Who takes part in the catalog sessions behind scheduling events (SPK-AT-009, SPK-SCHED-009,
 * SPK-COMMS-002): participants of the offering's live enrollments (pending or confirmed) and of
 * the session's live bookings (pickup, trial, makeup). Communications addresses cancellation and
 * change notices to them (their guardians through `receive_messages`), and a closure preview names
 * them as affected customers with the orders their participation was paid through. Reads go
 * through the caller's executor (an outbox handler's or the closure's transaction).
 */
@Injectable()
export class SessionParticipants {
  constructor(private readonly sessions: SessionsService) {}

  async ofSchedulingEvents(
    db: Db | Trx,
    organizationId: string,
    eventIds: readonly string[],
    bookingStatuses: readonly BookingStatus[] = LIVE_BOOKING_STATUSES,
  ): Promise<SessionParticipant[]> {
    const booked = await this.bookersOf(db, organizationId, eventIds, bookingStatuses);
    const sessions = await this.sessions.sessionsOfSchedulingEvents(db, organizationId, eventIds);
    if (sessions.length === 0) return booked;
    const offeringIds = [...new Set(sessions.map((s) => s.offeringId))];
    const enrollments = await db
      .selectFrom('enrollments')
      .select(['offering_id', 'participant_person_id', 'order_ref'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', offeringIds)
      .where('status', 'in', ['pending', 'confirmed'])
      .orderBy('id')
      .execute();
    const bookings = await db
      .selectFrom('session_bookings')
      .select(['session_id', 'participant_person_id'])
      .where('organization_id', '=', organizationId)
      .where(
        'session_id',
        'in',
        sessions.map((s) => s.id),
      )
      .where('status', 'in', ['pending', 'confirmed'])
      .orderBy('id')
      .execute();
    const out: SessionParticipant[] = [...booked];
    for (const session of sessions) {
      for (const e of enrollments.filter((x) => x.offering_id === session.offeringId)) {
        out.push({
          schedulingEventId: session.schedulingEventId,
          sessionId: session.id,
          offeringId: session.offeringId,
          personId: e.participant_person_id,
          via: 'enrollment',
          orderRef: e.order_ref,
        });
      }
      for (const b of bookings.filter((x) => x.session_id === session.id)) {
        out.push({
          schedulingEventId: session.schedulingEventId,
          sessionId: session.id,
          offeringId: session.offeringId,
          personId: b.participant_person_id,
          via: 'booking',
          orderRef: null,
        });
      }
    }
    return out;
  }

  /**
   * ASYNC-01 (ENR-13, SPK-SCHED-009): a rental or party event commits no person, so its booker is
   * found through the booking that reserves it, with the order a paid booking went through.
   */
  private async bookersOf(
    db: Db | Trx,
    organizationId: string,
    eventIds: readonly string[],
    statuses: readonly BookingStatus[],
  ): Promise<SessionParticipant[]> {
    if (eventIds.length === 0 || statuses.length === 0) return [];
    const rows = await db
      .selectFrom('bookings')
      .leftJoin('enrollments', (join) =>
        join
          .onRef('enrollments.organization_id', '=', 'bookings.organization_id')
          .onRef('enrollments.id', '=', 'bookings.enrollment_id'),
      )
      .select([
        'bookings.offering_id as offering_id',
        'bookings.booker_person_id as booker_person_id',
        'bookings.scheduling_event_ids as scheduling_event_ids',
        'enrollments.order_ref as order_ref',
      ])
      .where('bookings.organization_id', '=', organizationId)
      .where(
        sql<boolean>`bookings.scheduling_event_ids && array[${sql.join([...eventIds])}]::uuid[]`,
      )
      .where('bookings.status', 'in', [...statuses])
      .orderBy('bookings.id')
      .execute();
    const wanted = new Set(eventIds);
    const out: SessionParticipant[] = [];
    for (const row of rows) {
      for (const eventId of row.scheduling_event_ids) {
        if (!wanted.has(eventId)) continue;
        out.push({
          schedulingEventId: eventId,
          sessionId: null,
          offeringId: row.offering_id,
          personId: row.booker_person_id,
          via: 'booking',
          orderRef: row.order_ref ?? null,
        });
      }
    }
    return out;
  }

  /** Person ids of the participants (SESSION_AUDIENCE_PORT for communications). */
  async participantsOfSchedulingEvent(
    db: Db | Trx,
    organizationId: string,
    eventId: string,
  ): Promise<string[]> {
    // A booking the change itself just ended (a closure) still hears about it.
    const rows = await this.ofSchedulingEvents(
      db,
      organizationId,
      [eventId],
      AUDIENCE_BOOKING_STATUSES,
    );
    return [...new Set(rows.map((r) => r.personId))].sort();
  }

  /** SPK-SCHED-009: affected customers and the orders their participation was paid through. */
  async closureImpact(
    db: Db | Trx,
    organizationId: string,
    events: readonly ImpactedEventRef[],
  ): Promise<ClosureImpactContribution> {
    const rows = await this.ofSchedulingEvents(
      db,
      organizationId,
      events.map((e) => e.eventId),
    );
    return {
      customers: rows.map((r) => ({
        personId: r.personId,
        eventIds: [r.schedulingEventId],
        via: [r.via],
      })),
      obligations: rows
        .filter((r) => r.orderRef)
        .map((r) => ({ type: 'order', id: r.orderRef as string, eventIds: [r.schedulingEventId] })),
    };
  }
}
