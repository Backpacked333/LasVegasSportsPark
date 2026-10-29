import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApproveRestrictionBody,
  CreateRestrictionBody,
  ListRestrictionsQuery,
  OperatingStatusQuery,
  ReleaseRestrictionBody,
  WithdrawRestrictionBody,
  z,
  type FacilityOperatingStatus,
  type Principal,
  type Restriction,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  RecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { RestrictionsService } from '../services/restrictions.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Operating restrictions and the per-resource operating status (SPK-FAC-003/004, §4.8, SPK-AT-021). */
@Controller()
export class RestrictionsController {
  constructor(private readonly restrictions: RestrictionsService) {}

  @Post('maintenance-restrictions')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateRestrictionBody) body: CreateRestrictionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Restriction> {
    return this.restrictions.create(principal, body, correlationId);
  }

  @Get('maintenance-restrictions')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListRestrictionsQuery) query: ListRestrictionsQuery,
  ): Promise<Restriction[]> {
    return this.restrictions.list(principal, query);
  }

  @Get('maintenance-restrictions/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Restriction> {
    return this.restrictions.get(principal, params.id);
  }

  @Post('maintenance-restrictions/:id/approve')
  @HttpCode(200)
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveRestrictionBody) body: ApproveRestrictionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Restriction> {
    return this.restrictions.approve(principal, params.id, { ...body, correlationId });
  }

  @Post('maintenance-restrictions/:id/release')
  @HttpCode(200)
  @Idempotent()
  release(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReleaseRestrictionBody) body: ReleaseRestrictionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Restriction> {
    return this.restrictions.release(principal, params.id, { ...body, correlationId });
  }

  /**
   * FAC-01 (SPK-FAC-004): withdraw a proposed restriction, or an approved one with its pending
   * scheduling closure, before it takes effect. §5.6: like approve and release, the command changes
   * the future schedule of an area whose authority scope is not known before the record is read.
   */
  @Post('maintenance-restrictions/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('future_schedule', 'unproven')
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawRestrictionBody) body: WithdrawRestrictionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Restriction> {
    return this.restrictions.withdraw(principal, params.id, { ...body, correlationId });
  }

  @Get('facilities/:id/operating-status')
  operatingStatus(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(OperatingStatusQuery) query: OperatingStatusQuery,
  ): Promise<FacilityOperatingStatus> {
    return this.restrictions.operatingStatus(principal, params.id, query.at);
  }
}
