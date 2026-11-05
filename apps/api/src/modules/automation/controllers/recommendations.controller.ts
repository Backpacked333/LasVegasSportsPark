import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApplyRecommendationBody,
  ApproveRecommendationBody,
  ListRecommendationsQuery,
  RejectRecommendationBody,
  SettleRecommendationApplyBody,
  z,
  type ApplyRecommendationInput,
  type ApproveRecommendationInput,
  type Page,
  type Principal,
  type Recommendation,
  type RejectRecommendationInput,
  type SettleRecommendationApplyInput,
} from '@sportspark/contracts';
import {
  CurrentPrincipal,
  Idempotent,
  NoRecordAuthority,
  ZodBody,
  ZodParams,
  ZodQuery,
} from '../../../kernel';
import { RecommendationsService } from '../services/recommendations.service';
import { AutomationEnabledGuard } from './automation-enabled.guard';
import { CorrelationId } from './request-context.decorators';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/**
 * Reviewable recommendations (SPK-AUTO-003). Approve, reject and apply are idempotent, zod-
 * validated and require the expected revision; apply runs the owning module's command with the
 * reviewer's own principal.
 */
@Controller('recommendations')
@UseGuards(AutomationEnabledGuard)
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListRecommendationsQuery) query: ListRecommendationsQuery,
  ): Promise<Page<Recommendation>> {
    return this.recommendations.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<Recommendation> {
    return this.recommendations.get(principal, params.id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ApproveRecommendationBody) body: ApproveRecommendationInput,
    @CorrelationId() correlationId: string,
  ): Promise<Recommendation> {
    return this.recommendations.approve(principal, params.id, body, correlationId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Idempotent()
  reject(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(RejectRecommendationBody) body: RejectRecommendationInput,
    @CorrelationId() correlationId: string,
  ): Promise<Recommendation> {
    return this.recommendations.reject(principal, params.id, body, correlationId);
  }

  @Post(':id/apply')
  @HttpCode(200)
  @Idempotent()
  apply(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ApplyRecommendationBody) body: ApplyRecommendationInput,
    @CorrelationId() correlationId: string,
  ): Promise<Recommendation> {
    return this.recommendations.apply(principal, params.id, body, correlationId);
  }

  /**
   * AUT-03 (§4.11, §4.12): record the reconciled outcome of an apply whose outcome was unknown.
   * Never gated by the organization's capability switch; never runs the command again.
   */
  @Post(':id/settle-apply')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority('Records the reconciled outcome of an apply already run')
  settleApply(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(SettleRecommendationApplyBody) body: SettleRecommendationApplyInput,
    @CorrelationId() correlationId: string,
  ): Promise<Recommendation> {
    return this.recommendations.settleApply(principal, params.id, body, correlationId);
  }
}
