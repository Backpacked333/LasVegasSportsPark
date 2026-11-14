import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CorrectUniformHandOverBody,
  HandOverUniformBody,
  ListUniformOrdersQuery,
  z,
  type Principal,
  type UniformOrder,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { UniformOrdersService } from '../services/uniform-orders.service';

const IdParams = z.object({ id: z.uuid() });

/**
 * Uniform orders of a class or a team, and their hand-over (SPK-REG-012, proposed amendment
 * PA-07; capability `uniforms`).
 */
@Controller('uniform-orders')
export class UniformOrdersController {
  constructor(private readonly uniforms: UniformOrdersService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListUniformOrdersQuery) query: ListUniformOrdersQuery,
  ): Promise<UniformOrder[]> {
    return this.uniforms.list(principal, query);
  }

  @Post(':id/hand-over')
  @HttpCode(200)
  @Idempotent()
  handOver(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(HandOverUniformBody) body: z.infer<typeof HandOverUniformBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<UniformOrder> {
    return this.uniforms.handOver(principal, params.id, body, correlationId);
  }

  @Post(':id/hand-over-corrections')
  @HttpCode(200)
  @Idempotent()
  correctHandOver(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CorrectUniformHandOverBody) body: z.infer<typeof CorrectUniformHandOverBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<UniformOrder> {
    return this.uniforms.correctHandOver(principal, params.id, body, correlationId);
  }
}
