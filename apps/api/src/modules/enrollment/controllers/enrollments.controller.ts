import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CancelEnrollmentBody,
  CompleteEnrollmentBody,
  ListEnrollmentsQuery,
  TransferEnrollmentBody,
  TransferPreviewQuery,
  z,
  type CancellationPreview,
  type Enrollment,
  type Page,
  type Principal,
  type TransferPreview,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../enrollment.shared';
import { EnrollmentsService } from '../services/enrollments.service';

const IdParams = z.object({ id: z.uuid() });

/** Enrollments: read, cancel, complete and transfer (SPK-REG-003/010, §4.8). */
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListEnrollmentsQuery) query: ListEnrollmentsQuery,
  ): Promise<Page<Enrollment>> {
    return this.enrollments.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Enrollment> {
    return this.enrollments.get(principal, params.id);
  }

  @Get(':id/cancellation-preview')
  cancellationPreview(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<CancellationPreview> {
    return this.enrollments.cancellationPreview(principal, params.id);
  }

  /** ENR-03 (SPK-REG-010): the read-only preview, against the target offering as it is now. */
  @Get(':id/transfer-preview')
  transferPreview(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodQuery(TransferPreviewQuery) query: TransferPreviewQuery,
  ): Promise<TransferPreview> {
    return this.enrollments.transferPreview(principal, params.id, query.targetOfferingId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Idempotent()
  cancel(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CancelEnrollmentBody) body: z.infer<typeof CancelEnrollmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Enrollment> {
    return this.enrollments.cancel(principal, params.id, body, correlationId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Idempotent()
  complete(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(CompleteEnrollmentBody) body: z.infer<typeof CompleteEnrollmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Enrollment> {
    return this.enrollments.complete(principal, params.id, body, correlationId);
  }

  /** §4.8: `commit: false` previews; `commit: true` commits the previewed change. */
  @Post(':id/transfer')
  @HttpCode(200)
  @Idempotent()
  transfer(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(TransferEnrollmentBody) body: z.infer<typeof TransferEnrollmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<TransferPreview> {
    return this.enrollments.transfer(principal, params.id, body, correlationId);
  }
}
