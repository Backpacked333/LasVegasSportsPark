import { Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload } from '@sportspark/contracts';
import type { Trx } from '../../../kernel';
import type { CatalogEvents } from '../../catalog';
import { CapacityService } from './capacity.service';
import { SessionBookingsService } from './session-bookings.service';
import { WaitlistService } from './waitlist.service';

type SessionCanceled = EventPayload<typeof CatalogEvents.sessionCanceled>;

/**
 * R2-JOURNEYS-01 (SPK-AT-009 consistent publication after the approved resolution,
 * SPK-COND-001/002, SPK-YOUTH-004, SPK-REG-008, §4.12): handler `enrollment.follow_session_canceled`
 * on catalog.session_canceled, whether staff canceled the session in the catalog or a closure's
 * `cancel_affected` canceled its scheduling event (catalog.follow_scheduling_event). In the
 * handler's transaction:
 *
 * 1. the session's live bookings are locked first (a customer cancellation locks its booking
 *    before the pools, so the same order never deadlocks against it);
 * 2. the session's capacity pools close (every offering pool locked in id order, as holds and
 *    offer generation lock them), so no hold, booking or offer takes a seat again;
 * 3. its live waitlist entries leave the queue with reason `session_canceled` (an open offer is
 *    declined) and each family is told;
 * 4. its live bookings are canceled with cause `session_canceled`: the customer notice window does
 *    not apply, a makeup redemption is reversed, and a package credit or membership session that
 *    no approved policy returns raises one owned exception per booking (POL-007, POL-041; whether
 *    a makeup is issued for the lost session stays DEC-003).
 *
 * Idempotent under replay: only active pools, live entries and live bookings move.
 */
@Injectable()
export class SessionCanceledFollowUp {
  constructor(
    private readonly capacity: CapacityService,
    private readonly waitlist: WaitlistService,
    private readonly bookings: SessionBookingsService,
  ) {}

  async onSessionCanceled(trx: Trx, event: DomainEvent<SessionCanceled>): Promise<void> {
    const organizationId = event.organizationId;
    const { sessionId, offeringId, reason } = event.payload;
    const correlationId = event.correlationId ?? null;
    await this.bookings.lockLiveOfSession(trx, organizationId, sessionId);
    await this.capacity.closeSessionPools(
      trx,
      organizationId,
      offeringId,
      sessionId,
      reason,
      correlationId,
    );
    await this.waitlist.retireForCanceledSession(
      trx,
      organizationId,
      offeringId,
      sessionId,
      correlationId,
    );
    await this.bookings.cancelForCanceledSession(
      trx,
      organizationId,
      sessionId,
      reason,
      correlationId,
    );
  }
}
