import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  CreateReportRunBody,
  ListReportRunsQuery,
  ReproduceReportRunBody,
  z,
  type Page,
  type Principal,
  type ReportReproduction,
  type ReportRun,
  type ReportRunSummary,
} from '@sportspark/contracts';
import { CurrentPrincipal, Idempotent, ZodBody, ZodParams, ZodQuery } from '../../../kernel';
import { ReportRunsService } from '../services/report-runs.service';
import { CorrelationId } from './correlation.decorator';

const IdParams = z.object({ id: z.uuid() });
type IdParams = z.infer<typeof IdParams>;

/** Stored report runs (SPK-REPORT-007). Every consequential POST is idempotent (§4.9). */
@Controller('reports/runs')
export class ReportRunsController {
  constructor(private readonly runs: ReportRunsService) {}

  @Post()
  @Idempotent()
  create(
    @CurrentPrincipal() principal: Principal,
    @ZodBody(CreateReportRunBody) body: z.infer<typeof CreateReportRunBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ReportRun> {
    return this.runs.create(principal, body, correlationId);
  }

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListReportRunsQuery) query: ListReportRunsQuery,
  ): Promise<Page<ReportRunSummary>> {
    return this.runs.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
  ): Promise<ReportRun> {
    return this.runs.get(principal, params.id);
  }

  @Post(':id/reproduce')
  @HttpCode(201)
  @Idempotent()
  reproduce(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(IdParams) params: IdParams,
    @ZodBody(ReproduceReportRunBody) body: z.infer<typeof ReproduceReportRunBody>,
    @CorrelationId() correlationId: string | null,
  ): Promise<ReportReproduction> {
    return this.runs.reproduce(principal, params.id, body, correlationId);
  }
}
