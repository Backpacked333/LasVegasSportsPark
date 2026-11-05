import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AdjustCapacityPoolBody,
  CreateCapacityPoolBody,
  ListCapacityPoolsQuery,
  SyncOfferingPoolsBody,
  z,
  type CapacityPool,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { CapacityService } from '../services/capacity.service';

const IdParams = z.object({ id: z.uuid() });

/** Capacity pools (SPK-REG-005, SPK-YOUTH-002): staff configuration and inspection. */
@Controller()
export class CapacityController {
  constructor(private readonly capacity: CapacityService) {}

  @Post('capacity-pools')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateCapacityPoolBody) body: z.infer<typeof CreateCapacityPoolBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CapacityPool> {
    return this.capacity.createPool(principal, body, correlationId);
  }

  @Get('capacity-pools')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListCapacityPoolsQuery) query: ListCapacityPoolsQuery,
  ): Promise<CapacityPool[]> {
    return this.capacity.listPools(principal, query);
  }

  @Post('capacity-pools/:id/adjust')
  @HttpCode(200)
  @Idempotent()
  adjust(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AdjustCapacityPoolBody) body: z.infer<typeof AdjustCapacityPoolBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CapacityPool> {
    return this.capacity.adjustPool(principal, params.id, body, correlationId);
  }

  @Post('offerings/:id/capacity-pools/sync')
  @HttpCode(200)
  @Idempotent()
  sync(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SyncOfferingPoolsBody) body: z.infer<typeof SyncOfferingPoolsBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CapacityPool[]> {
    return this.capacity.syncOfferingPools(principal, params.id, body, correlationId);
  }
}
