import { Injectable } from '@nestjs/common';
import { errors, z, type Principal } from '@sportspark/contracts';
import type { RecordReference } from '@sportspark/db';
import { FixturesService } from '../../competition';
import { ApplicationsService, EnrollmentsService, SessionBookingsService } from '../../enrollment';
import {
  CheckoutService,
  CreditsService,
  ObligationsService,
  PaymentsService,
  RefundsService,
} from '../../finance';
import { EventsService } from '../../scheduling';
import { isPermissionError } from '../support.shared';

type Reader = (principal: Principal, id: string) => Promise<unknown>;
const RecordId = z.uuid();

/**
 * SUP-01 (SCR-C-38 "cases about another household's records cannot be opened: not found",
 * §4.10, §4.14): the records a customer links to their own support request are read through the
 * owning module with the CUSTOMER'S principal, so that module's authorization decides. A record
 * the customer may not read, or that does not exist, is not found; a record type no module lets
 * customers read by id is refused as a validation failure (the request can still describe it).
 * Reads run before support's transaction (the owning modules read through the root database).
 */
@Injectable()
export class RelatedRecordsVerifier {
  private readonly readers: Readonly<Record<string, Reader>>;

  constructor(
    applications: ApplicationsService,
    enrollments: EnrollmentsService,
    bookings: SessionBookingsService,
    checkouts: CheckoutService,
    obligations: ObligationsService,
    payments: PaymentsService,
    refunds: RefundsService,
    credits: CreditsService,
    events: EventsService,
    fixtures: FixturesService,
  ) {
    this.readers = {
      application: (p, id) => applications.get(p, id),
      enrollment: (p, id) => enrollments.get(p, id),
      session_booking: (p, id) => bookings.get(p, id),
      checkout: (p, id) => checkouts.get(p, id),
      order: (p, id) => checkouts.getOrder(p, id),
      obligation: (p, id) => obligations.get(p, id),
      payment_attempt: (p, id) => payments.get(p, id),
      refund_attempt: (p, id) => refunds.get(p, id),
      credit: (p, id) => credits.get(p, id),
      scheduling_event: (p, id) => events.getEvent(p, id),
      fixture: (p, id) => fixtures.get(p, id),
    };
  }

  /** The record types a customer may link (read by id through their owning module). */
  get supportedTypes(): string[] {
    return Object.keys(this.readers).sort();
  }

  /** Verifies every reference with the caller's principal; returns them de-duplicated. */
  async verify(principal: Principal, refs: readonly RecordReference[]): Promise<RecordReference[]> {
    const out: RecordReference[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const read = this.readers[ref.type];
      if (!read) {
        throw errors.validation(`A support request cannot link a ${ref.type} record.`, {
          code: 'UNSUPPORTED_RELATED_RECORD',
          type: ref.type,
          supportedTypes: this.supportedTypes,
        });
      }
      // Every linkable record is identified by a UUID: anything else names no record.
      if (!RecordId.safeParse(ref.id).success) throw errors.protectedNotFound(ref.type);
      try {
        await read(principal, ref.id);
      } catch (error) {
        // Another household's record and an unknown id read the same: not found (§4.10).
        if (isPermissionError(error)) throw errors.protectedNotFound(ref.type);
        throw error;
      }
      out.push({ type: ref.type, id: ref.id });
    }
    return out;
  }
}
