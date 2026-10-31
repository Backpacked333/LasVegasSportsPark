import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import { AuditWriter, type Trx } from '../../../kernel';
import { SessionsService, type CatalogEvents } from '../../catalog';
import { enrollmentSystem } from '../enrollment.shared';

type SessionRetimed = EventPayload<typeof CatalogEvents.sessionRetimed>;

/**
 * R2-JOURNEYS-03 (SPK-AT-009, SPK-COMMS-005, SPK-YOUTH-007): handler
 * `enrollment.follow_session_retimed` on catalog.session_retimed. A session booking keeps a copy
 * of its session's times (the family calendar, the customer notice window and the session's
 * check-in all read it), so when the catalog moves a session to its scheduling event's new times
 * the session's live bookings (pending, confirmed) move with it.
 *
 * The times come from the session as it is now, read in the handler's transaction, never from the
 * payload: a replayed or late delivery of an older move copies the current times, and a session
 * that is no longer scheduled moves nothing. A booking already at those times is left alone, so a
 * replay writes nothing. Each move bumps the booking's revision and is audited.
 *
 * Not moved: the membership period a membership booking was counted in (`membership_period_key`)
 * stays the one of the time it was booked; re-counting it under another period is a policy
 * question (POL-039), recorded as pending in the README.
 */
@Injectable()
export class SessionRetimedFollowUp {
  constructor(
    private readonly sessions: SessionsService,
    private readonly audit: AuditWriter,
  ) {}

  async onSessionRetimed(trx: Trx, event: DomainEvent<SessionRetimed>): Promise<number> {
    const organizationId = event.organizationId;
    const { sessionId, schedulingEventId } = event.payload;
    const session = (
      await this.sessions.sessionsOfSchedulingEvents(trx, organizationId, [schedulingEventId])
    ).find((s) => s.id === sessionId);
    if (!session || session.status !== 'scheduled') return 0;
    const start = new Date(session.scheduledStart);
    const end = new Date(session.scheduledEnd);
    const rows = await trx
      .selectFrom('session_bookings')
      .select(['id', 'revision', 'scheduled_start', 'scheduled_end', 'status'])
      .where('organization_id', '=', organizationId)
      .where('session_id', '=', sessionId)
      .where('status', 'in', ['pending', 'confirmed'])
      .orderBy('id')
      .forUpdate()
      .execute();
    const actor = enrollmentSystem(organizationId, 'enrollment.follow_session_retimed');
    let moved = 0;
    for (const row of rows) {
      const previousStart = new Date(row.scheduled_start);
      const previousEnd = new Date(row.scheduled_end);
      if (previousStart.getTime() === start.getTime() && previousEnd.getTime() === end.getTime()) {
        continue;
      }
      const updated = await trx
        .updateTable('session_bookings')
        .set({ scheduled_start: start, scheduled_end: end, revision: row.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      // The row is locked, so the revision cannot have moved; a miss is a bug, and the delivery
      // retries rather than leaving the booking at the old time.
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error(`session booking ${row.id} changed while it was locked`);
      }
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'enrollment.follow_session_retimed',
        targetType: 'session_booking',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: event.payload.reason,
        correlationId: event.correlationId ?? null,
        details: {
          sessionId,
          schedulingEventId,
          status: row.status,
          previousStart: previousStart.toISOString(),
          previousEnd: previousEnd.toISOString(),
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
          sourceEventId: event.id,
        },
      });
      moved += 1;
    }
    return moved;
  }
}
