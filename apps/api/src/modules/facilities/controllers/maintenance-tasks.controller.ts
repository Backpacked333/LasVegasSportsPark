import { Controller, Get, Patch, Post } from '@nestjs/common';
import {
  ListMaintenanceTasksQuery,
  RecordInspectionBody,
  ReportMaintenanceTaskBody,
  UpdateMaintenanceTaskBody,
  z,
  type Inspection,
  type MaintenanceTask,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { MaintenanceTasksService } from '../services/maintenance-tasks.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });

/** Maintenance records and inspections (SPK-FAC-002/004). */
@Controller('maintenance-tasks')
export class MaintenanceTasksController {
  constructor(private readonly tasks: MaintenanceTasksService) {}

  @Post()
  @Idempotent()
  report(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(ReportMaintenanceTaskBody) body: ReportMaintenanceTaskBody,
    @CorrelationId() correlationId: string,
  ): Promise<MaintenanceTask> {
    return this.tasks.reportIssue(principal, { ...body, correlationId });
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMaintenanceTasksQuery) query: ListMaintenanceTasksQuery,
  ): Promise<Page<MaintenanceTask>> {
    return this.tasks.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<MaintenanceTask> {
    return this.tasks.get(principal, params.id);
  }

  @Patch(':id')
  @Idempotent()
  update(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(UpdateMaintenanceTaskBody) body: UpdateMaintenanceTaskBody,
    @CorrelationId() correlationId: string,
  ): Promise<MaintenanceTask> {
    return this.tasks.update(principal, params.id, body, correlationId);
  }

  @Post(':id/inspections')
  @Idempotent()
  recordInspection(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
    @ZodBody(RecordInspectionBody) body: RecordInspectionBody,
    @CorrelationId() correlationId: string,
  ): Promise<Inspection> {
    return this.tasks.recordInspection(principal, params.id, body, correlationId);
  }

  @Get(':id/inspections')
  listInspections(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: z.infer<typeof IdParams>,
  ): Promise<Inspection[]> {
    return this.tasks.listInspections(principal, params.id);
  }
}
