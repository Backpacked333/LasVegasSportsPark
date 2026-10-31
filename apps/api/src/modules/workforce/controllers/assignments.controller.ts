import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  AssignmentTransitionBody,
  CreateAssignmentBody,
  CreateReplacementBody,
  DeclineAssignmentBody,
  ListAssignmentsQuery,
  WithdrawAssignmentBody,
  z,
  type Assignment,
  type AssignmentOutcome,
  type Page,
  type Principal,
  type ReplacementList,
  type ReplacementOutcome,
  type StaffAssignment,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { AssignmentsService } from '../services/assignments.service';
import { ReplacementsService } from '../services/replacements.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/**
 * Assignments (§4.6 Assignment machine, §4.8 `POST /v1/assignments/{id}/accept`, SPK-STAFF-002..004)
 * and the replacement workflow (SPK-STAFF-003, SPK-AT-012).
 */
@Controller('assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly replacements: ReplacementsService,
  ) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssignmentBody) body: CreateAssignmentBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListAssignmentsQuery) query: ListAssignmentsQuery,
  ): Promise<Page<StaffAssignment>> {
    return this.assignments.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<Assignment> {
    return this.assignments.get(principal, params.id);
  }

  @Post(':id/offer')
  @HttpCode(200)
  @Idempotent()
  offer(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AssignmentTransitionBody) body: AssignmentTransitionBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.offer(principal, params.id, body, correlationId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @Idempotent()
  accept(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AssignmentTransitionBody) body: AssignmentTransitionBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.accept(principal, params.id, body, correlationId);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @Idempotent()
  decline(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(DeclineAssignmentBody) body: DeclineAssignmentBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.decline(principal, params.id, body, correlationId);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @Idempotent()
  withdraw(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(WithdrawAssignmentBody) body: WithdrawAssignmentBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.withdraw(principal, params.id, body, correlationId);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Idempotent()
  complete(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(AssignmentTransitionBody) body: AssignmentTransitionBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentOutcome> {
    return this.assignments.complete(principal, params.id, body, correlationId);
  }

  @Get(':id/replacements')
  candidates(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<ReplacementList> {
    return this.replacements.candidates(principal, params.id);
  }

  @Post(':id/replacements')
  @Idempotent()
  replace(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(CreateReplacementBody) body: CreateReplacementBody,
    @CorrelationId() correlationId: string,
  ): Promise<ReplacementOutcome> {
    return this.replacements.replace(principal, params.id, body, correlationId);
  }
}
