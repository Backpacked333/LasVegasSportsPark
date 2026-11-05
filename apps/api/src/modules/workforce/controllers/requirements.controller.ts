import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  AssignmentTargetQuery,
  CreateAssignmentRequirementBody,
  UpdateAssignmentRequirementBody,
  z,
  type AssignmentRequirement,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { RequirementsService } from '../services/requirements.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Assignment requirements and coverage (SPK-STAFF-001, SPK-STAFF-002, SPK-UX-006). */
@Controller('assignment-requirements')
export class RequirementsController {
  constructor(private readonly requirements: RequirementsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAssignmentRequirementBody) body: CreateAssignmentRequirementBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentRequirement> {
    return this.requirements.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(AssignmentTargetQuery) query: AssignmentTargetQuery,
  ): Promise<AssignmentRequirement[]> {
    return this.requirements.list(principal, query);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateAssignmentRequirementBody) body: UpdateAssignmentRequirementBody,
    @CorrelationId() correlationId: string,
  ): Promise<AssignmentRequirement> {
    return this.requirements.update(principal, params.id, body, correlationId);
  }
}
