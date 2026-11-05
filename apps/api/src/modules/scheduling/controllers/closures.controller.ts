import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApplyClosureBody,
  ClosureImpactQuery,
  CreateClosureBody,
  LiftClosureBody,
  ListClosuresQuery,
  WithdrawClosureBody,
  z,
  type Closure,
  type ClosureImpact,
  type Principal,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { ClosuresService } from '../services/closures.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Closures with impact preview, apply, lift and withdraw (SPK-SCHED-009, SPK-FAC-003/004). */
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

  /**
   * SCH-01 (SPK-FAC-003): pending -> withdrawn. A closure owned by a maintenance restriction
   * answers RESOURCE_CONFLICT `OWNED_BY_RESTRICTION`; facilities withdraws it with its restriction
   * (§4.2). §5.6: the closure's schedule authority is not known before the record is read.
   */
  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('future_schedule', 'unproven')
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawClosureBody) body: WithdrawClosureBody,
    @CorrelationId() correlationId: string,
  ): Promise<Closure> {
    return this.closures.withdrawClosure(
      principal,
      params.id,
      { reason: body.reason, expectedRevision: body.expectedRevision, correlationId },
      { refuseRestrictionOwned: true },
    );
  }
}

/** SCH-01 (SPK-SCHED-009): closure impact preview that creates nothing. */
@Controller('closure-impact')
export class ClosureImpactController {
  constructor(private readonly closures: ClosuresService) {}

  @Get()
  preview(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ClosureImpactQuery) query: ClosureImpactQuery,
  ): Promise<ClosureImpact> {
    return this.closures.previewImpact(principal, {
      facilityId: query.facilityId,
      resourceId: query.resourceId ?? null,
      interval: { start: query.start, end: query.end },
    });
  }
}
