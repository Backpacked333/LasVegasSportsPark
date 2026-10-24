import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ListCostInputsQuery,
  RecordCostInputBody,
  WithdrawCostInputBody,
  z,
  type CostInput,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CostInputsService } from '../services/cost-inputs.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Agreed cost inputs (SPK-REPORT-004). Every consequential POST is idempotent (§4.9). */
@Controller('reports/cost-inputs')
export class CostInputsController {
  constructor(private readonly costs: CostInputsService) {}

  @Post()
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordCostInputBody) body: z.infer<typeof RecordCostInputBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CostInput> {
    return this.costs.record(principal, body, correlationId);
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListCostInputsQuery) query: ListCostInputsQuery,
  ): Promise<{ items: CostInput[] }> {
    return { items: await this.costs.list(principal, query) };
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(WithdrawCostInputBody) body: z.infer<typeof WithdrawCostInputBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<CostInput> {
    return this.costs.withdraw(principal, params.id, body, correlationId);
  }
}
