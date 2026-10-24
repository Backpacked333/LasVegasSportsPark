import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateDiscountBody,
  EvaluateDiscountsBody,
  ListDiscountsQuery,
  RetireDiscountBody,
  UpdateDiscountBody,
  z,
  type DiscountDefinition,
  type DiscountEvaluation,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { DiscountsService } from '../services/discounts.service';

const IdParams = z.object({ id: z.uuid() });

/** Discount definitions and explainable evaluation (SPK-PAY-003). */
@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateDiscountBody) body: z.infer<typeof CreateDiscountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DiscountDefinition> {
    return this.discounts.create(principal, body, correlationId);
  }

  /** Pure evaluation: no state changes, so no idempotency key is required. */
  @Post('evaluate')
  @HttpCode(200)
  evaluate(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(EvaluateDiscountsBody) body: z.infer<typeof EvaluateDiscountsBody>,
  ): Promise<DiscountEvaluation> {
    return this.discounts.evaluate(principal, body);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListDiscountsQuery) query: ListDiscountsQuery,
  ): Promise<Page<DiscountDefinition>> {
    return this.discounts.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<DiscountDefinition> {
    return this.discounts.get(principal, params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateDiscountBody) body: z.infer<typeof UpdateDiscountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DiscountDefinition> {
    return this.discounts.update(principal, params.id, body, correlationId);
  }

  @Post(':id/retire')
  @HttpCode(200)
  @Idempotent()
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireDiscountBody) body: z.infer<typeof RetireDiscountBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DiscountDefinition> {
    return this.discounts.retire(principal, params.id, body, correlationId);
  }
}
