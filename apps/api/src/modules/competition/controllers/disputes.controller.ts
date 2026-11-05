import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateDisputeBody,
  DecideDisputeBody,
  z,
  type Dispute,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { DisputesService } from '../services/disputes.service';

const IdParams = z.object({ id: z.uuid() });

/** Disputes (SPK-RESULT-005). */
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post('fixtures/:id/disputes')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CreateDisputeBody) body: z.infer<typeof CreateDisputeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Dispute> {
    return this.disputes.create(principal, params.id, body, correlationId);
  }

  @Get('fixtures/:id/disputes')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Dispute[]> {
    return this.disputes.listForFixture(principal, params.id);
  }

  @Get('disputes/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Dispute> {
    return this.disputes.get(principal, params.id);
  }

  @Post('disputes/:id/decide')
  @HttpCode(200)
  @Idempotent()
  decide(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DecideDisputeBody) body: z.infer<typeof DecideDisputeBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Dispute> {
    return this.disputes.decide(principal, params.id, body, correlationId);
  }
}
