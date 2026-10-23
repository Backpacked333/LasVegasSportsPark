import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApplyClosureBody,
  CreateClosureBody,
  LiftClosureBody,
  ListClosuresQuery,
  z,
  type Closure,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { ClosuresService } from '../services/closures.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Closures with impact preview, apply and lift (SPK-SCHED-009, SPK-FAC-003/004). */
@Controller('closures')
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateClosureBody) body: CreateClosureBody,
    @CorrelationId() correlationId: string,
  ): Promise<Closure> {
    return this.closures.createClosure(principal, { ...body, correlationId });
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListClosuresQuery) query: z.infer<typeof ListClosuresQuery>,
  ): Promise<Closure[]> {
    return this.closures.listClosures(principal, query.facilityId, query.status);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Closure> {
    return this.closures.getClosure(principal, params.id);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @Idempotent()
  apply(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApplyClosureBody) body: ApplyClosureBody,
    @CorrelationId() correlationId: string,
  ): Promise<Closure> {
    return this.closures.applyClosure(principal, params.id, { ...body, correlationId });
  }

  @Post(':id/lift')
  @HttpCode(200)
  @Idempotent()
  lift(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(LiftClosureBody) body: LiftClosureBody,
    @CorrelationId() correlationId: string,
  ): Promise<Closure> {
    return this.closures.liftClosure(principal, params.id, { ...body, correlationId });
  }
}
