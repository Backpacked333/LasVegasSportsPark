import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateQualificationBody,
  ListQualificationsQuery,
  QualificationDecisionBody,
  QualificationReasonBody,
  z,
  type Principal,
  type Qualification,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { QualificationsService } from '../services/qualifications.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Qualification evidence (SPK-STAFF-001). */
@Controller('qualifications')
export class QualificationsController {
  constructor(private readonly qualifications: QualificationsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateQualificationBody) body: CreateQualificationBody,
    @CorrelationId() correlationId: string,
  ): Promise<Qualification> {
    return this.qualifications.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListQualificationsQuery) query: ListQualificationsQuery,
  ): Promise<Qualification[]> {
    return this.qualifications.list(principal, query);
  }

  @Post(':id/verify')
  @HttpCode(200)
  @Idempotent()
  verify(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(QualificationDecisionBody) body: QualificationDecisionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Qualification> {
    return this.qualifications.verify(principal, params.id, body, correlationId);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Idempotent()
  reject(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(QualificationReasonBody) body: QualificationReasonBody,
    @CorrelationId() correlationId: string,
  ): Promise<Qualification> {
    return this.qualifications.reject(principal, params.id, body, correlationId);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @Idempotent()
  revoke(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(QualificationReasonBody) body: QualificationReasonBody,
    @CorrelationId() correlationId: string,
  ): Promise<Qualification> {
    return this.qualifications.revoke(principal, params.id, body, correlationId);
  }
}
