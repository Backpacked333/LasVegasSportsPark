import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AcceptWaitlistOfferBody,
  DeclineWaitlistOfferBody,
  JoinWaitlistBody,
  ListWaitlistQuery,
  RemoveWaitlistEntryBody,
  WithdrawWaitlistBody,
  z,
  type Principal,
  type WaitlistAcceptance,
  type WaitlistEntry,
  type WaitlistOffer,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { WaitlistService } from '../services/waitlist.service';

const IdParams = z.object({ id: z.uuid() });

/** Waitlists and offers (SPK-REG-008, §4.8 `POST /v1/waitlist-offers/{id}/accept`). */
@Controller()
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post('waitlist-entries')
  @Idempotent()
  join(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(JoinWaitlistBody) body: z.infer<typeof JoinWaitlistBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaitlistEntry> {
    return this.waitlist.join(principal, body, correlationId);
  }

  @Get('waitlist-entries')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListWaitlistQuery) query: ListWaitlistQuery,
  ): Promise<WaitlistEntry[]> {
    return this.waitlist.list(principal, query);
  }

  @Get('waitlist-entries/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<WaitlistEntry> {
    return this.waitlist.get(principal, params.id);
  }

  @Post('waitlist-entries/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawWaitlistBody) body: z.infer<typeof WithdrawWaitlistBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaitlistEntry> {
    return this.waitlist.withdraw(principal, params.id, body, correlationId);
  }

  @Post('waitlist-entries/:id/remove')
  @HttpCode(200)
  @Idempotent()
  remove(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RemoveWaitlistEntryBody) body: z.infer<typeof RemoveWaitlistEntryBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaitlistEntry> {
    return this.waitlist.remove(principal, params.id, body, correlationId);
  }

  @Get('waitlist-offers/:id')
  getOffer(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<WaitlistOffer> {
    return this.waitlist.getOfferFor(principal, params.id);
  }

  @Post('waitlist-offers/:id/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AcceptWaitlistOfferBody) body: z.infer<typeof AcceptWaitlistOfferBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaitlistAcceptance> {
    return this.waitlist.accept(principal, params.id, body, correlationId);
  }

  @Post('waitlist-offers/:id/decline')
  @HttpCode(200)
  @Idempotent()
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DeclineWaitlistOfferBody) body: z.infer<typeof DeclineWaitlistOfferBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<WaitlistOffer> {
    return this.waitlist.decline(principal, params.id, body, correlationId);
  }
}
