import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CorrectUniformHandOverBody,
  HandOverUniformBody,
  ListUniformOrdersQuery,
  z,
  type Principal,
  type UniformOrder,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { UniformOrdersService } from '../services/uniform-orders.service';

const IdParams = z.object({ id: z.uuid() });

/** §5.6: handing a uniform over is a facility fact that exists in no source system. */
const NOT_A_RECORD = 'A uniform hand-over is not a §5.3 record category';

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
  @NoRecordAuthority(NOT_A_RECORD)
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
  @NoRecordAuthority(NOT_A_RECORD)
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
