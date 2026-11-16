import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptTeamPlaceOfferBody,
  DeclineTeamPlaceOfferBody,
  OfferTeamPlaceBody,
  SeasonWaitingListsQuery,
  WaitTeamEntryBody,
  WithdrawTeamPlaceOfferBody,
  z,
  type Principal,
  type SeasonWaitingLists,
  type TeamEntry,
  type TeamEntryPlaceOffer,
  type TeamPlaceOfferOutcome,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { TeamWaitlistService } from '../services/team-waitlist.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Team waiting list (SPK-COMP-006, proposed amendment PA-10; capability `team_waitlist`): staff
 * make an entry wait and offer it a freed place; the captain accepts or declines; either side
 * withdraws. The captain withdraws a waiting entry through `POST /team-entries/:id/withdraw`.
 */
@Controller()
export class TeamWaitlistController {
  constructor(private readonly waitlist: TeamWaitlistService) {}

  @Post('team-entries/:id/wait')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('team')
  wait(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WaitTeamEntryBody) body: z.infer<typeof WaitTeamEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamEntry> {
    return this.waitlist.wait(principal, params.id, body, correlationId);
  }

  @Post('team-entries/:id/place-offers')
  @Idempotent()
  @RecordAuthority('team')
  offer(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OfferTeamPlaceBody) body: z.infer<typeof OfferTeamPlaceBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    return this.waitlist.offer(principal, params.id, body, correlationId);
  }

  @Get('team-entries/:id/place-offers')
  offers(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<TeamEntryPlaceOffer[]> {
    return this.waitlist.offersOfEntry(principal, params.id);
  }

  @Post('team-entry-place-offers/:id/accept')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('team')
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptTeamPlaceOfferBody) body: z.infer<typeof AcceptTeamPlaceOfferBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    return this.waitlist.accept(principal, params.id, body, correlationId);
  }

  @Post('team-entry-place-offers/:id/decline')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('team')
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineTeamPlaceOfferBody) body: z.infer<typeof DeclineTeamPlaceOfferBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    return this.waitlist.decline(principal, params.id, body, correlationId);
  }

  @Post('team-entry-place-offers/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('team')
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawTeamPlaceOfferBody) body: z.infer<typeof WithdrawTeamPlaceOfferBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    return this.waitlist.withdrawOffer(principal, params.id, body, correlationId);
  }

  /** The waiting lists of a season, per division and in order, with the free places of each. */
  @Get('seasons/:id/waiting-list')
  seasonLists(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(SeasonWaitingListsQuery) query: z.infer<typeof SeasonWaitingListsQuery>,
  ): Promise<SeasonWaitingLists> {
    return this.waitlist.seasonLists(principal, params.id, query);
  }
}
