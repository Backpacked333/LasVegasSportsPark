import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AddBasketLineBody,
  CompleteBasketBody,
  CreateBasketBody,
  HoldBasketBody,
  ReleaseBasketBody,
  RemoveBasketLineBody,
  z,
  type Basket,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { BasketsService } from '../services/baskets.service';

const IdParams = z.object({ id: z.uuid() });
const LineParams = z.object({ id: z.uuid(), lineId: z.uuid() });

/** Household baskets and holds (SPK-REG-004/005/006/007/009). */
@Controller('baskets')
export class BasketsController {
  constructor(private readonly baskets: BasketsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateBasketBody) body: z.infer<typeof CreateBasketBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.create(principal, body, correlationId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Basket> {
    return this.baskets.get(principal, params.id);
  }

  @Post(':id/lines')
  @Idempotent()
  addLine(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(AddBasketLineBody) body: z.infer<typeof AddBasketLineBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.addLine(principal, params.id, body, correlationId);
  }

  @Post(':id/lines/:lineId/remove')
  @HttpCode(200)
  @Idempotent()
  removeLine(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(LineParams) params: z.infer<typeof LineParams>,
    @ZodBody(RemoveBasketLineBody) body: z.infer<typeof RemoveBasketLineBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.removeLine(principal, params.id, params.lineId, body, correlationId);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @Idempotent()
  hold(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(HoldBasketBody) body: z.infer<typeof HoldBasketBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.hold(principal, params.id, body, correlationId);
  }

  @Post(':id/release')
  @HttpCode(200)
  @Idempotent()
  release(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReleaseBasketBody) body: z.infer<typeof ReleaseBasketBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.release(principal, params.id, body, correlationId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Idempotent()
  complete(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CompleteBasketBody) body: z.infer<typeof CompleteBasketBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Basket> {
    return this.baskets.complete(principal, params.id, body, correlationId);
  }
}
