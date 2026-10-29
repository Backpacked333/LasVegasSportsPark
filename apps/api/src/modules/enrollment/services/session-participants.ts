import { Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';
import { SessionsService } from '../../catalog';
import type { ClosureImpactContribution, ImpactedEventRef } from '../../scheduling';

/** A participant of a catalog session linked to a scheduling event. */
export interface SessionParticipant {
  schedulingEventId: string;
  sessionId: string;
  offeringId: string;
  personId: string;
  via: 'enrollment' | 'booking';
  /** The finance order an enrollment was paid through (enrollment only). */
  orderRef: string | null;
}

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
  ): Promise<SessionParticipant[]> {
    const sessions = await this.sessions.sessionsOfSchedulingEvents(db, organizationId, eventIds);
    if (sessions.length === 0) return [];
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
    const out: SessionParticipant[] = [];
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

  /** Person ids of the participants (SESSION_AUDIENCE_PORT for communications). */
  async participantsOfSchedulingEvent(
    db: Db | Trx,
    organizationId: string,
    eventId: string,
  ): Promise<string[]> {
    const rows = await this.ofSchedulingEvents(db, organizationId, [eventId]);
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
