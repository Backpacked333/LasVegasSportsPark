import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload, Principal } from '@sportspark/contracts';
import type { RegistrationIntent } from '@sportspark/db';
import { CLOCK, FacilityDirectory, type Clock, type Trx } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { NotificationsService, type ComposeInput } from '../../communications';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import type { EnrollmentEvents } from '../enrollment.events';
import { BOOKING_INTENTS } from '../enrollment.policy';
import { enrollmentSystem } from '../enrollment.shared';

/** A local date and time in the facility's zone, for notice copy (SPK-SCHED-008). */
export function localDateTime(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
}

/**
 * Enrollment-owned customer notices (ENR-09, SPK-COMMS-002; IF-22): communications does not
 * import enrollment, so enrollment composes its own notices in the handler's transaction through
 * `NotificationsService.composeAndQueueIn`, with the event id as `sourceEventId` (one notice per
 * event, a replay composes nothing new) and the participant as the protected subject: recipients
 * are the participant (an active adult) and the holders of `receive_messages` over them, resolved
 * and re-checked by communications from current authority (SPK-COMMS-003). Plain operational copy
 * (its wording is not a policy value; the communication policy is DEC-012).
 */
@Injectable()
export class EnrollmentNotices {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly teamEntries: TeamEntryQueryPort,
    private readonly facilities: FacilityDirectory,
    private readonly notifications: NotificationsService,
  ) {}

  private async offeringFacts(trx: Trx, organizationId: string, offeringId: string | null) {
    if (!offeringId) return null;
    const snapshot = await this.offerings.getOffering(
      organizationId,
      offeringId,
      this.clock.now(),
      trx,
    );
    if (!snapshot) return null;
    const facility = (
      await this.facilities.describe(organizationId, [snapshot.offering.facilityId], trx)
    ).get(snapshot.offering.facilityId);
    return {
      name: snapshot.offering.name,
      facilityId: snapshot.offering.facilityId,
      timezone: facility?.timezone ?? null,
    };
  }

  private async compose(
    trx: Trx,
    principal: Principal,
    event: DomainEvent<unknown>,
    input: Omit<ComposeInput, 'sourceEventId' | 'correlationId'>,
  ): Promise<void> {
    await this.notifications.composeAndQueueIn(trx, principal, {
      ...input,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  /** enrollment.waitlist_offer_made → `waitlist_offer`: the offering and the expiry, local time. */
  async waitlistOffer(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.waitlistOfferMade>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const entry = await trx
      .selectFrom('waitlist_entries')
      .select(['offering_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.waitlistEntryId)
      .executeTakeFirst();
    const offering = await this.offeringFacts(trx, organizationId, entry?.offering_id ?? null);
    const expiresAt = new Date(event.payload.expiresAt);
    const until = offering?.timezone
      ? `${localDateTime(expiresAt, offering.timezone)} (${offering.timezone})`
      : expiresAt.toISOString();
    await this.compose(
      trx,
      enrollmentSystem(organizationId, 'enrollment.notify_waitlist_offer'),
      event,
      {
        kind: 'waitlist_offer',
        facilityId: offering?.facilityId,
        subject: { type: 'waitlist_offer', id: event.payload.offerId },
        audience: { subjectPersonIds: [event.payload.participantPersonId] },
        protected: true,
        title: 'A place is available',
        body: `A place in ${offering?.name ?? 'the activity you are waiting for'} is held until ${until}. Accept the offer before then; afterwards the place is offered to the next person waiting.`,
      },
    );
  }

  /** enrollment.placement_assigned → `placement`: the team's name. */
  async placementAssigned(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.placementAssigned>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const placement = await trx
      .selectFrom('placement_requests')
      .select(['offering_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.placementRequestId)
      .executeTakeFirst();
    const entry = await this.teamEntries.findTeamEntry(
      organizationId,
      event.payload.teamEntryId,
      trx,
    );
    const offering = await this.offeringFacts(trx, organizationId, placement?.offering_id ?? null);
    await this.compose(
      trx,
      enrollmentSystem(organizationId, 'enrollment.notify_placement'),
      event,
      {
        kind: 'placement',
        facilityId: offering?.facilityId,
        subject: { type: 'placement_request', id: event.payload.placementRequestId },
        audience: { subjectPersonIds: [event.payload.participantPersonId] },
        protected: true,
        title: 'Team placement confirmed',
        body: `The placement on ${entry?.teamName ?? 'a team'} is confirmed. The team's schedule appears in the app.`,
      },
    );
  }

  /**
   * R2-JOURNEYS-04 (SPK-COMMS-002 "Registration outcome", SPK-AT-023): enrollment.enrollment_confirmed
   * → `registration_outcome`. A registration confirmed through its basket (paid through the
   * checkout, possibly long after the family left the app, or owing nothing) is announced to the
   * participant and the holders of `receive_messages` over them, once per confirmation event. The
   * enrollment is read now (deliveries arrive late): one canceled or transferred meanwhile is not
   * announced as confirmed. A rental or party is not announced here: it is confirmed only when
   * fully staffed, by its booking's own lifecycle (SPK-COND-003).
   */
  async enrollmentConfirmed(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.enrollmentConfirmed>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const enrollment = await trx
      .selectFrom('enrollments')
      .select(['id', 'intent', 'status', 'participant_person_id', 'offering_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.enrollmentId)
      .executeTakeFirst();
    if (!enrollment || enrollment.status !== 'confirmed') return;
    if (BOOKING_INTENTS.includes(enrollment.intent)) return;
    const offering = await this.offeringFacts(trx, organizationId, enrollment.offering_id);
    const copy = registrationConfirmedCopy(enrollment.intent, offering?.name ?? 'the activity');
    await this.compose(
      trx,
      enrollmentSystem(organizationId, 'enrollment.notify_registration_confirmed'),
      event,
      {
        kind: 'registration_outcome',
        facilityId: offering?.facilityId,
        subject: { type: 'enrollment', id: enrollment.id },
        audience: { subjectPersonIds: [enrollment.participant_person_id] },
        protected: true,
        ...copy,
      },
    );
  }

  /**
   * Stage-6 rework of R2-JOURNEYS-01 (SPK-AT-009 families are told, SPK-COMMS-002 cancellations):
   * enrollment.session_booking_changed for a booking that enrollment.follow_session_canceled
   * canceled because the facility canceled its session (`cancel_cause = 'session_canceled'`) →
   * `cancellation`, one per booking (its own change event, so a replay composes nothing new). A
   * session canceled in the catalog emits no scheduling change, so without this the booked family
   * heard nothing; on the closure path communications' "Canceled:" notice reaches them too, and this
   * one adds what happened to what they booked with (returned, or reviewed by staff when it was
   * kept). A booking the family canceled itself is not announced here.
   */
  async sessionBookingCanceled(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.sessionBookingChanged>>,
  ): Promise<void> {
    if (event.payload.status !== 'canceled') return;
    const organizationId = event.organizationId;
    const booking = await trx
      .selectFrom('session_bookings')
      .select([
        'id',
        'offering_id',
        'participant_person_id',
        'status',
        'cancel_cause',
        'scheduled_start',
        'entitlement_basis',
        'credit_disposition',
      ])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.bookingId)
      .executeTakeFirst();
    if (!booking || booking.status !== 'canceled' || booking.cancel_cause !== 'session_canceled') {
      return;
    }
    const makeupReturned =
      booking.entitlement_basis === 'makeup'
        ? !!(await trx
            .selectFrom('makeup_redemptions')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('session_booking_id', '=', booking.id)
            .where('kind', '=', 'reversal')
            .executeTakeFirst())
        : false;
    const offering = await this.offeringFacts(trx, organizationId, booking.offering_id);
    const start = new Date(booking.scheduled_start);
    const when = offering?.timezone
      ? `${localDateTime(start, offering.timezone)} (${offering.timezone})`
      : start.toISOString();
    const outcome = canceledBookingOutcome(
      booking.entitlement_basis,
      booking.credit_disposition,
      makeupReturned,
    );
    await this.compose(
      trx,
      enrollmentSystem(organizationId, 'enrollment.notify_session_booking_canceled'),
      event,
      {
        kind: 'cancellation',
        facilityId: offering?.facilityId,
        subject: { type: 'session_booking', id: booking.id },
        audience: { subjectPersonIds: [booking.participant_person_id] },
        protected: true,
        title: 'Session canceled',
        body: `The ${offering?.name ?? 'booked'} session on ${when} was canceled by the facility, so the booking is canceled.${outcome ? ` ${outcome}` : ''}`,
      },
    );
  }

  /** enrollment.application_decided → `registration_outcome`. */
  async applicationDecided(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.applicationDecided>>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    if (event.payload.status !== 'accepted' && event.payload.status !== 'declined') return;
    const offering = await this.offeringFacts(trx, organizationId, event.payload.offeringId);
    const accepted = event.payload.status === 'accepted';
    await this.compose(trx, enrollmentSystem(organizationId, 'enrollment.notify_outcome'), event, {
      kind: 'registration_outcome',
      facilityId: offering?.facilityId,
      subject: { type: 'application', id: event.payload.applicationId },
      audience: { subjectPersonIds: [event.payload.participantPersonId] },
      protected: true,
      title: accepted ? 'Registration approved' : 'Registration not approved',
      body: accepted
        ? `The registration for ${offering?.name ?? 'the activity'} was approved. Complete it in the app to keep the place.`
        : `The registration for ${offering?.name ?? 'the activity'} was not approved. Contact the facility for details.`,
    });
  }

  /**
   * enrollment.waitlist_left → `registration_outcome` when offer generation retired an entry no
   * offer could ever be accepted for (CAPABILITIES-04, SPK-YOUTH-004, GAPS-TRIAGE-01), or the
   * facility canceled the session it waited for (R2-JOURNEYS-01): the family
   * learns that they no longer wait, why, and what to do instead. Other departures send nothing
   * here: the family withdrew or declined, staff removed the entry with their own reason, or the
   * participant already holds the place (`equivalent_entitlement`).
   */
  async waitlistRetired(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof EnrollmentEvents.waitlistLeft>>,
  ): Promise<void> {
    if (event.payload.status !== 'removed') return;
    const organizationId = event.organizationId;
    const entry = await trx
      .selectFrom('waitlist_entries')
      .select(['offering_id', 'participant_person_id', 'removal_reason', 'status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', event.payload.waitlistEntryId)
      .executeTakeFirst();
    const copy = entry?.removal_reason ? RETIREMENT_NOTICES.get(entry.removal_reason) : undefined;
    if (!entry || entry.status !== 'removed' || !copy) return;
    const offering = await this.offeringFacts(trx, organizationId, entry.offering_id);
    await this.compose(
      trx,
      enrollmentSystem(organizationId, 'enrollment.notify_waitlist_retired'),
      event,
      {
        kind: 'registration_outcome',
        facilityId: offering?.facilityId,
        subject: { type: 'waitlist_entry', id: event.payload.waitlistEntryId },
        audience: { subjectPersonIds: [entry.participant_person_id] },
        protected: true,
        title: 'No longer on the waitlist',
        body: copy(offering?.name ?? 'the activity you were waiting for'),
      },
    );
  }
}

/**
 * R2-JOURNEYS-04 (SPK-COMMS-002 "Registration outcome") copy per intent (plain operational copy).
 * Only offerings with catalog sessions put anything in the family calendar (catalog sessions and
 * session bookings; SPK-YOUTH-007): a league or team registration has fixtures instead, published
 * with the team's schedule (competition), and an individual league player is placed on a team
 * first (the placement notice follows; SPK-PLACE-002, SPK-PLACE-003).
 */
export function registrationConfirmedCopy(
  intent: RegistrationIntent,
  name: string,
): { title: string; body: string } {
  switch (intent) {
    case 'membership':
      return { title: 'Membership confirmed', body: `The membership ${name} is confirmed.` };
    case 'package_purchase':
      return {
        title: 'Session package confirmed',
        body: `The session package ${name} is confirmed; its sessions can be booked in the app.`,
      };
    case 'individual_league':
      return {
        title: 'Registration confirmed',
        body: `The registration for ${name} is confirmed. You are told when a team placement is made; the team's fixtures then appear in the app once its schedule is published.`,
      };
    case 'join_team':
    case 'create_team_entry':
      return {
        title: 'Registration confirmed',
        body: `The registration for ${name} is confirmed. The team's fixtures appear in the app once its schedule is published.`,
      };
    default:
      return {
        title: 'Registration confirmed',
        body: `The registration for ${name} is confirmed. Its sessions appear in the family calendar.`,
      };
  }
}

/**
 * What a session cancellation did with what the booking was paid with (plain operational copy):
 * returned, or kept and reviewed by staff (the owned
 * `enrollment.canceled_session_entitlement_pending` exception; POL-007, POL-041, DEC-003 pending).
 * A booking that cost nothing says nothing more.
 */
export function canceledBookingOutcome(
  basis: string,
  disposition: string | null,
  makeupReturned: boolean,
): string | null {
  if (basis === 'makeup') {
    return makeupReturned
      ? 'The makeup can be used for another session.'
      : 'Staff review what happens to the makeup.';
  }
  const what =
    basis === 'package' ? 'package credit' : basis === 'membership' ? 'membership session' : null;
  // An unlimited membership counts no session, so nothing was used or kept.
  if (!what || disposition === null) return null;
  return disposition === 'returned'
    ? `The ${what} was given back.`
    : `Staff review what happens to the ${what}.`;
}

/** Notice copy per retirement reason (`WaitlistRetirementReason` other than an equivalent place). */
const RETIREMENT_NOTICES = new Map<string, (offeringName: string) => string>([
  [
    'session_payment_unavailable',
    (name) =>
      `The session of ${name} you were waiting for now has a price, and a single session cannot be paid for in the app yet, so you are no longer on its waitlist. A session that owes nothing can still be booked.`,
  ],
  [
    'booking_required',
    (name) =>
      `${name} is requested as a booking with its space, equipment and staff, not from a waitlist, so you are no longer on its waitlist. Request the booking instead.`,
  ],
  [
    'session_canceled',
    (name) =>
      `The session of ${name} you were waiting for was canceled by the facility, so you are no longer on its waitlist.`,
  ],
  [
    'makeup_redemption_required',
    (name) =>
      `A makeup seat in ${name} is taken by redeeming the makeup for a session with a free seat, not from a waitlist, so you are no longer on its waitlist.`,
  ],
]);
