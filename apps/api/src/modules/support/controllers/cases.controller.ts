import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  AddCaseNoteBody,
  AssignCaseBody,
  LinkCaseActionBody,
  ListCasesQuery,
  OpenCaseBody,
  RequestRefundBody,
  ResendNotificationBody,
  SettleCaseActionBody,
  TransitionCaseBody,
  UpdateCaseBody,
  z,
  type AddCaseNoteInput,
  type AssignCaseInput,
  type Case,
  type CaseActionOutcome,
  type CaseDetail,
  type LinkCaseActionInput,
  type OpenCaseInput,
  type Page,
  type Principal,
  type RequestRefundInput,
  type ResendNotificationInput,
  type SettleCaseActionInput,
  type TransitionCaseInput,
  type UpdateCaseInput,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CaseActionsService } from '../services/case-actions.service';
import { CasesService } from '../services/cases.service';
import { CorrelationId, IdempotencyKeyHeader } from './request-context.decorators';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;
const ActionParams = z.object({ id: z.uuid(), actionId: z.uuid() });
type ActionParams = z.infer<typeof ActionParams>;

/**
 * Support cases (SPK-SUPPORT-002) and their actions (SPK-SUPPORT-003). Every command is
 * idempotent and zod-validated and acts with the operator's own principal.
 */
@Controller('cases')
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly actions: CaseActionsService,
  ) {}

  @Post()
  @Idempotent()
  open(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(OpenCaseBody) body: OpenCaseInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseDetail> {
    return this.cases.open(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListCasesQuery) query: ListCasesQuery,
  ): Promise<Page<Case>> {
    return this.cases.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<CaseDetail> {
    return this.cases.get(principal, params.id);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(UpdateCaseBody) body: UpdateCaseInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseDetail> {
    return this.cases.update(principal, params.id, body, correlationId);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Idempotent()
  assign(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AssignCaseBody) body: AssignCaseInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseDetail> {
    return this.cases.assign(principal, params.id, body, correlationId);
  }

  @Post(':id/transition')
  @HttpCode(200)
  @Idempotent()
  transition(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(TransitionCaseBody) body: TransitionCaseInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseDetail> {
    return this.cases.transition(principal, params.id, body, correlationId);
  }

  @Post(':id/notes')
  @Idempotent()
  addNote(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AddCaseNoteBody) body: AddCaseNoteInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseDetail> {
    return this.cases.addNote(principal, params.id, body, correlationId);
  }

  @Post(':id/actions')
  @Idempotent()
  link(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(LinkCaseActionBody) body: LinkCaseActionInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseActionOutcome> {
    return this.actions.link(principal, params.id, body, correlationId);
  }

  @Post(':id/resend-notification')
  @Idempotent()
  resendNotification(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ResendNotificationBody) body: ResendNotificationInput,
    @IdempotencyKeyHeader() requestKey: string,
    @CorrelationId() correlationId: string,
  ): Promise<CaseActionOutcome> {
    return this.actions.resendNotification(principal, params.id, body, requestKey, correlationId);
  }

  @Post(':id/request-refund')
  @Idempotent()
  requestRefund(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(RequestRefundBody) body: RequestRefundInput,
    @IdempotencyKeyHeader() requestKey: string,
    @CorrelationId() correlationId: string,
  ): Promise<CaseActionOutcome> {
    return this.actions.requestRefund(principal, params.id, body, requestKey, correlationId);
  }

  @Post(':id/actions/:actionId/settle')
  @HttpCode(200)
  @Idempotent()
  settle(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(ActionParams) params: ActionParams,
    @ZodBody(SettleCaseActionBody) body: SettleCaseActionInput,
    @CorrelationId() correlationId: string,
  ): Promise<CaseActionOutcome> {
    return this.actions.settleUnknown(principal, params.id, params.actionId, body, correlationId);
  }
}
