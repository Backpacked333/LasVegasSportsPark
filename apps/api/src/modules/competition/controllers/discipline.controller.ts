import { Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import {
  CreateAppealBody,
  CreateDisciplinaryDecisionBody,
  CreateIncidentBody,
  CreateSuspensionBody,
  DecideAppealBody,
  ListIncidentsQuery,
  ListSuspensionsQuery,
  OverturnDecisionBody,
  UpdateIncidentBody,
  UpdateSuspensionBody,
  z,
  type Appeal,
  type DisciplinaryDecision,
  type Incident,
  type Principal,
  type Suspension,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { CorrelationId } from '../competition.shared';
import { DisciplineService } from '../services/discipline.service';

const IdParams = z.object({ id: z.uuid() });

/** Discipline (SPK-DISC-001..005): restricted incidents, decisions, suspensions and appeals. */
@Controller()
export class DisciplineController {
  constructor(private readonly discipline: DisciplineService) {}

  @Post('incidents')
  @Idempotent()
  reportIncident(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateIncidentBody) body: z.infer<typeof CreateIncidentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Incident> {
    return this.discipline.reportIncident(principal, body, correlationId);
  }

  @Get('incidents')
  listIncidents(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListIncidentsQuery) query: z.infer<typeof ListIncidentsQuery>,
  ): Promise<Incident[]> {
    return this.discipline.listIncidents(principal, query);
  }

  @Get('incidents/:id')
  getIncident(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Incident> {
    return this.discipline.getIncident(principal, params.id);
  }

  @Patch('incidents/:id')
  @Idempotent()
  updateIncident(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateIncidentBody) body: z.infer<typeof UpdateIncidentBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Incident> {
    return this.discipline.updateIncident(principal, params.id, body, correlationId);
  }

  @Post('disciplinary-decisions')
  @Idempotent()
  issueDecision(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateDisciplinaryDecisionBody) body: z.infer<typeof CreateDisciplinaryDecisionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DisciplinaryDecision> {
    return this.discipline.issueDecision(principal, body, correlationId);
  }

  @Get('disciplinary-decisions/:id')
  getDecision(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<DisciplinaryDecision> {
    return this.discipline.getDecision(principal, params.id);
  }

  @Post('disciplinary-decisions/:id/overturn')
  @HttpCode(200)
  @Idempotent()
  overturnDecision(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(OverturnDecisionBody) body: z.infer<typeof OverturnDecisionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<DisciplinaryDecision> {
    return this.discipline.overturnDecision(principal, params.id, body, correlationId);
  }

  @Post('suspensions')
  @Idempotent()
  createSuspension(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateSuspensionBody) body: z.infer<typeof CreateSuspensionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Suspension> {
    return this.discipline.createSuspension(principal, body, correlationId);
  }

  @Get('suspensions')
  listSuspensions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListSuspensionsQuery) query: z.infer<typeof ListSuspensionsQuery>,
  ): Promise<Suspension[]> {
    return this.discipline.listSuspensions(principal, query);
  }

  @Get('suspensions/:id')
  getSuspension(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Suspension> {
    return this.discipline.getSuspension(principal, params.id);
  }

  @Patch('suspensions/:id')
  @Idempotent()
  updateSuspension(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateSuspensionBody) body: z.infer<typeof UpdateSuspensionBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Suspension> {
    return this.discipline.updateSuspension(principal, params.id, body, correlationId);
  }

  @Post('appeals')
  @Idempotent()
  createAppeal(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateAppealBody) body: z.infer<typeof CreateAppealBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Appeal> {
    return this.discipline.createAppeal(principal, body, correlationId);
  }

  @Get('appeals/:id')
  getAppeal(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Appeal> {
    return this.discipline.getAppeal(principal, params.id);
  }

  @Post('appeals/:id/decide')
  @HttpCode(200)
  @Idempotent()
  decideAppeal(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(DecideAppealBody) body: z.infer<typeof DecideAppealBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<Appeal> {
    return this.discipline.decideAppeal(principal, params.id, body, correlationId);
  }
}
