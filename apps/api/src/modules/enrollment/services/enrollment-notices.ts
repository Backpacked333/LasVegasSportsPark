import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent, EventPayload, Principal } from '@sportspark/contracts';
import { CLOCK, FacilityDirectory, type Clock, type Trx } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { NotificationsService, type ComposeInput } from '../../communications';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import type { EnrollmentEvents } from '../enrollment.events';
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
}
