import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type FamilyCalendar,
  type FamilyCalendarItem,
  type FamilyCalendarQuery,
  type Principal,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, CLOCK, DATABASE, type Clock } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { RelationshipAuthority } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { organizationOf } from '../enrollment.shared';
import { CatalogSessions } from './catalog-sessions';
import { EnrollmentsService } from './enrollments.service';

/** Upper bound on a calendar window so one request stays a bounded, paginated-style read (§4.5). */
const MAX_WINDOW_DAYS = 120;

/**
 * Family coordination (SPK-YOUTH-007). One calendar for the acting adult and every person they
 * currently hold `view` over: sessions of active enrollments and session bookings (pickup, trial,
 * makeup). Overlapping commitments are highlighted, never prevented — a parent may knowingly accept
 * an overlap; physical resource and staffing conflicts are enforced separately (scheduling,
 * capacity pools). Authority comes from identity's current grants, never from household
 * membership (§4.5), and is re-checked per person through the kernel authorization path.
 */
@Injectable()
export class FamilyCalendarService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly authorities: RelationshipAuthority,
    private readonly enrollments: EnrollmentsService,
    private readonly sessions: CatalogSessions,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
  ) {}

  async get(principal: Principal, query: FamilyCalendarQuery): Promise<FamilyCalendar> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.authenticationRequired();
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to.getTime() <= from.getTime())
      throw errors.validation('to must be after from.', { path: 'to' });
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
      throw errors.validation(`A calendar window spans at most ${MAX_WINDOW_DAYS} days.`, {
        path: 'to',
      });
    }
    const authorities = await this.authorities.authoritiesOf(organizationId, principal.personId);
    const candidates = [
      principal.personId,
      ...authorities.filter((a) => a.permissions.includes('view')).map((a) => a.subjectPersonId),
    ];
    const personIds: string[] = [];
    for (const personId of [...new Set(candidates)]) {
      const decision = await this.authorization.decide(
        principal,
        EnrollmentActions.readFamilyCalendar,
        {
          type: 'family_calendar',
          organizationId,
          subjectPersonIds: [personId],
          protected: true,
        },
      );
      if (decision.allowed) personIds.push(personId);
    }

    const items: FamilyCalendarItem[] = [];
    const titles = new Map<string, string>();
    const titleOf = async (offeringId: string): Promise<string> => {
      if (!titles.has(offeringId)) {
        const snapshot = await this.offerings.getOffering(
          organizationId,
          offeringId,
          this.clock.now(),
        );
        titles.set(offeringId, snapshot?.offering.name ?? 'Activity');
      }
      return titles.get(offeringId) as string;
    };

    const enrollments = await this.enrollments.activeEnrollmentsOf(
      this.db,
      organizationId,
      personIds,
    );
    const sessionsByOffering = new Map<string, Awaited<ReturnType<CatalogSessions['list']>>>();
    for (const enrollment of enrollments) {
      if (!sessionsByOffering.has(enrollment.offering_id)) {
        sessionsByOffering.set(
          enrollment.offering_id,
          await this.sessions.list(organizationId, enrollment.offering_id),
        );
      }
      for (const session of sessionsByOffering.get(enrollment.offering_id) ?? []) {
        if (session.status !== 'scheduled') continue;
        const start = new Date(session.scheduledStart);
        const end = new Date(session.scheduledEnd);
        if (end <= from || start >= to) continue;
        items.push({
          id: `enrollment:${enrollment.id}:${session.id}`,
          personId: enrollment.participant_person_id,
          kind: 'enrollment_session',
          enrollmentId: enrollment.id,
          sessionBookingId: null,
          offeringId: enrollment.offering_id,
          sessionId: session.id,
          title: await titleOf(enrollment.offering_id),
          start: start.toISOString(),
          end: end.toISOString(),
          status: enrollment.status,
        });
      }
    }

    if (personIds.length > 0) {
      const bookings = await this.db
        .selectFrom('session_bookings')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('participant_person_id', 'in', personIds)
        .where('status', 'in', ['pending', 'confirmed'])
        .where('scheduled_start', '<', to)
        .where('scheduled_end', '>', from)
        .orderBy('scheduled_start')
        .execute();
      for (const booking of bookings) {
        items.push({
          id: `booking:${booking.id}`,
          personId: booking.participant_person_id,
          kind: 'session_booking',
          enrollmentId: null,
          sessionBookingId: booking.id,
          offeringId: booking.offering_id,
          sessionId: booking.session_id,
          title: await titleOf(booking.offering_id),
          start: new Date(booking.scheduled_start).toISOString(),
          end: new Date(booking.scheduled_end).toISOString(),
          status: booking.status,
        });
      }
    }

    items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      participantPersonIds: personIds,
      items,
      overlaps: overlapsOf(items),
    };
  }
}

/** Every pair of commitments whose time ranges intersect (half-open), across the whole family. */
export function overlapsOf(items: readonly FamilyCalendarItem[]): FamilyCalendar['overlaps'] {
  const out: FamilyCalendar['overlaps'] = [];
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i] as FamilyCalendarItem;
    for (let j = i + 1; j < items.length; j += 1) {
      const b = items[j] as FamilyCalendarItem;
      if (b.start >= a.end) break; // sorted by start: nothing later can overlap a
      if (a.start < b.end && b.start < a.end) {
        out.push({
          itemIds: [a.id, b.id],
          personIds: [...new Set([a.personId, b.personId])],
          start: a.start > b.start ? a.start : b.start,
          end: a.end < b.end ? a.end : b.end,
        });
      }
    }
  }
  return out;
}
