import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  ApproveAssessmentTemplateBody,
  CreateAssessmentBody,
  CreateAssessmentTemplateBody,
  CreateProgressionRecommendationBody,
  ParticipantAssessmentsQuery,
  RetireAssessmentTemplateBody,
  ReviewAssessmentBody,
  ShareRecommendationBody,
  SubmitAssessmentBody,
  UpdateAssessmentBody,
  WithdrawAssessmentBody,
  WithdrawRecommendationBody,
  z,
  type Assessment,
  type AssessmentTemplate,
  type Page,
  type Principal,
  type ProgressionRecommendation,
  type YouthFeedback,
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
import { YouthProgressionService } from '../services/youth-progression.service';

const IdParams = z.object({ id: z.uuid() });
const PersonParams = z.object({ personId: z.uuid() });
const NOT_A_RECORD = 'Not a §5.3 record category';

/**
 * Youth development records and progression recommendations (ENR-14; capability
 * youth_progression, DEC-016; DEC-003, DEC-054, DEC-055). Owner Proposed: enrollment.
 */
@Controller()
export class YouthProgressionController {
  constructor(private readonly youth: YouthProgressionService) {}

  @Post('assessment-templates')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  createTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssessmentTemplateBody) body: z.infer<typeof CreateAssessmentTemplateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    return this.youth.createTemplate(principal, body, correlationId);
  }

  @Post('assessment-templates/:id/approve')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  approveTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApproveAssessmentTemplateBody) body: z.infer<typeof ApproveAssessmentTemplateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    return this.youth.approveTemplate(principal, params.id, body, correlationId);
  }

  @Post('assessment-templates/:id/retire')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  retireTemplate(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetireAssessmentTemplateBody) body: z.infer<typeof RetireAssessmentTemplateBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<AssessmentTemplate> {
    return this.youth.retireTemplate(principal, params.id, body, correlationId);
  }

  @Post('assessments')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  createAssessment(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssessmentBody) body: z.infer<typeof CreateAssessmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Assessment> {
    return this.youth.createAssessment(principal, body, correlationId);
  }

  @Patch('assessments/:id')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  updateAssessment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateAssessmentBody) body: z.infer<typeof UpdateAssessmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Assessment> {
    return this.youth.updateAssessment(principal, params.id, body, correlationId);
  }

  @Post('assessments/:id/submit')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  submitAssessment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(SubmitAssessmentBody) body: z.infer<typeof SubmitAssessmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Assessment> {
    return this.youth.submitAssessment(principal, params.id, body, correlationId);
  }

  @Post('assessments/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  withdrawAssessment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawAssessmentBody) body: z.infer<typeof WithdrawAssessmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Assessment> {
    return this.youth.withdrawAssessment(principal, params.id, body, correlationId);
  }

  @Post('assessments/:id/review')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  reviewAssessment(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ReviewAssessmentBody) body: z.infer<typeof ReviewAssessmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Assessment> {
    return this.youth.reviewAssessment(principal, params.id, body, correlationId);
  }

  @Post('progression-recommendations')
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  createRecommendation(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateProgressionRecommendationBody)
    body: z.infer<typeof CreateProgressionRecommendationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    return this.youth.createRecommendation(principal, body, correlationId);
  }

  @Post('progression-recommendations/:id/share')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  shareRecommendation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ShareRecommendationBody) body: z.infer<typeof ShareRecommendationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    return this.youth.shareRecommendation(principal, params.id, body, correlationId);
  }

  @Post('progression-recommendations/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  @NoRecordAuthority(NOT_A_RECORD)
  withdrawRecommendation(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawRecommendationBody) body: z.infer<typeof WithdrawRecommendationBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ProgressionRecommendation> {
    return this.youth.withdrawRecommendation(principal, params.id, body, correlationId);
  }

  @Get('me/youth-feedback')
  myFeedback(@CurrentPrincipal() principal: Principal): Promise<YouthFeedback> {
    return this.youth.myFeedback(principal);
  }

  @Get('participants/:personId/assessments')
  participantAssessments(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(PersonParams) params: z.infer<typeof PersonParams>,
    @ZodQuery(ParticipantAssessmentsQuery) query: ParticipantAssessmentsQuery,
  ): Promise<Page<Assessment>> {
    return this.youth.participantAssessments(principal, params.personId, query);
  }
}
