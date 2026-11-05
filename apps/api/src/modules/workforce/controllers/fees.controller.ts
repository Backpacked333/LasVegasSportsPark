import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AdjustFeeBody,
  ApproveFeeBody,
  CreateFeeExportBatchBody,
  CreateFeeSubmissionBody,
  ListFeeSubmissionsQuery,
  RejectFeeBody,
  z,
  type FeeExportBatch,
  type FeeSubmission,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { FeesService } from '../services/fees.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Approved hours and fees, adjustment history and export batches (SPK-STAFF-006, §1.7). */
@Controller()
export class FeesController {
  constructor(private readonly fees: FeesService) {}

  @Post('fee-submissions')
  @Idempotent()
  submit(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateFeeSubmissionBody) body: CreateFeeSubmissionBody,
    @CorrelationId() correlationId: string,
  ): Promise<FeeSubmission> {
    return this.fees.submit(principal, body, correlationId);
  }

  @Get('fee-submissions')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListFeeSubmissionsQuery) query: ListFeeSubmissionsQuery,
  ): Promise<Page<FeeSubmission>> {
    return this.fees.list(principal, query);
  }

  @Get('fee-submissions/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<FeeSubmission> {
    return this.fees.get(principal, params.id);
  }

  @Post('fee-submissions/:id/approve')
  @HttpCode(200)
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ApproveFeeBody) body: ApproveFeeBody,
    @CorrelationId() correlationId: string,
  ): Promise<FeeSubmission> {
    return this.fees.approve(principal, params.id, body, correlationId);
  }

  @Post('fee-submissions/:id/adjust')
  @HttpCode(200)
  @Idempotent()
  adjust(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AdjustFeeBody) body: AdjustFeeBody,
    @CorrelationId() correlationId: string,
  ): Promise<FeeSubmission> {
    return this.fees.adjust(principal, params.id, body, correlationId);
  }

  @Post('fee-submissions/:id/reject')
  @HttpCode(200)
  @Idempotent()
  reject(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(RejectFeeBody) body: RejectFeeBody,
    @CorrelationId() correlationId: string,
  ): Promise<FeeSubmission> {
    return this.fees.reject(principal, params.id, body, correlationId);
  }

  @Post('fee-export-batches')
  @Idempotent()
  export(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateFeeExportBatchBody) body: CreateFeeExportBatchBody,
    @CorrelationId() correlationId: string,
  ): Promise<FeeExportBatch> {
    return this.fees.export(principal, body, correlationId);
  }

  @Get('fee-export-batches/:id')
  getBatch(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<FeeExportBatch> {
    return this.fees.getBatch(principal, params.id);
  }
}
