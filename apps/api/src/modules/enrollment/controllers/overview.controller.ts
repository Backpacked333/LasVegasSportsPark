import { Controller, Get } from '@nestjs/common';
import {
  ListWaitlistQueueQuery,
  OfferingAvailabilityQuery,
  OfferingEnrollmentSummariesQuery,
  OfferingSuggestionsQuery,
  ParticipantActivitiesQuery,
  z,
  type OfferingAvailabilityList,
  type OfferingEnrollmentSummaries,
  type OfferingSuggestions,
  type ParticipantActivities,
  type Principal,
  type WaitlistQueuePage,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { EnrollmentOverviewService } from '../services/enrollment-overview.service';

const PersonParams = z.object({ personId: z.uuid() });

/**
 * Read-only overview reads for the park UI (programs overview and camp readiness, registrations
 * home, person record activities, customer discover and camp week picker). Nothing is written,
 * so no idempotency key is taken.
 */
@Controller()
export class EnrollmentOverviewController {
  constructor(private readonly overview: EnrollmentOverviewService) {}

  @Get('offering-enrollment-summaries')
  summaries(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(OfferingEnrollmentSummariesQuery) query: OfferingEnrollmentSummariesQuery,
  ): Promise<OfferingEnrollmentSummaries> {
    return this.overview.summaries(principal, query.offeringIds);
  }

  @Get('waitlist-queue')
  waitlistQueue(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListWaitlistQueueQuery) query: ListWaitlistQueueQuery,
  ): Promise<WaitlistQueuePage> {
    return this.overview.waitlistQueue(principal, query);
  }

  @Get('participants/:personId/activities')
  activities(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(PersonParams) params: z.infer<typeof PersonParams>,
    @ZodQuery(ParticipantActivitiesQuery) query: ParticipantActivitiesQuery,
  ): Promise<ParticipantActivities> {
    return this.overview.activities(principal, params.personId, query);
  }

  @Get('me/offering-suggestions')
  suggestions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(OfferingSuggestionsQuery) query: OfferingSuggestionsQuery,
  ): Promise<OfferingSuggestions> {
    return this.overview.suggestions(principal, query);
  }

  @Get('offering-availability')
  availability(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(OfferingAvailabilityQuery) query: OfferingAvailabilityQuery,
  ): Promise<OfferingAvailabilityList> {
    return this.overview.availability(principal, query.offeringIds);
  }
}
