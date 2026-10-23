import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApprovePolicyVersionBody,
  CreatePolicyVersionBody,
  ListAcknowledgmentsQuery,
  ListPolicyVersionsQuery,
  RecordAcknowledgmentBody,
  RetirePolicyVersionBody,
  WithdrawAcknowledgmentBody,
  z,
  type Acknowledgment,
  type Approval,
  type Page,
  type PolicyVersion,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../catalog.shared';
import { AcknowledgmentsService } from '../services/acknowledgments.service';
import { PoliciesService } from '../services/policies.service';

const IdParams = z.object({ id: z.uuid() });

/** Policy versions, approvals and acknowledgments (§4.4 Policies, SPK-REG-002, SPK-REG-009). */
@Controller()
export class PoliciesController {
  constructor(
    private readonly policies: PoliciesService,
    private readonly acknowledgments: AcknowledgmentsService,
  ) {}

  @Post('policy-versions')
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreatePolicyVersionBody) body: z.infer<typeof CreatePolicyVersionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PolicyVersion> {
    return this.policies.createPolicyVersion(principal, body, correlationId);
  }

  @Get('policy-versions')
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListPolicyVersionsQuery) query: ListPolicyVersionsQuery,
  ): Promise<Page<PolicyVersion>> {
    return this.policies.list(principal, query);
  }

  @Get('policy-versions/:id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<PolicyVersion> {
    return this.policies.get(principal, params.id);
  }

  @Get('policy-versions/:id/approvals')
  approvals(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Approval[]> {
    return this.policies.listApprovals(principal, params.id);
  }

  @Post('policy-versions/:id/approve')
  @HttpCode(200)
  @Idempotent()
  approve(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(ApprovePolicyVersionBody) body: z.infer<typeof ApprovePolicyVersionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PolicyVersion> {
    return this.policies.approve(principal, params.id, body, correlationId);
  }

  @Post('policy-versions/:id/retire')
  @HttpCode(200)
  @Idempotent()
  retire(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RetirePolicyVersionBody) body: z.infer<typeof RetirePolicyVersionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<PolicyVersion> {
    return this.policies.retire(principal, params.id, body, correlationId);
  }

  @Post('acknowledgments')
  @Idempotent()
  record(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(RecordAcknowledgmentBody) body: z.infer<typeof RecordAcknowledgmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.acknowledgments.record(principal, body, correlationId);
  }

  @Get('acknowledgments')
  listAcknowledgments(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAcknowledgmentsQuery) query: ListAcknowledgmentsQuery,
  ): Promise<Acknowledgment[]> {
    return this.acknowledgments.list(principal, query);
  }

  @Post('acknowledgments/:id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(WithdrawAcknowledgmentBody) body: z.infer<typeof WithdrawAcknowledgmentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Acknowledgment> {
    return this.acknowledgments.withdraw(principal, params.id, body, correlationId);
  }
}
