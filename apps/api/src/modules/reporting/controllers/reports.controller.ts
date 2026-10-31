import { Controller, Get, Query } from '@nestjs/common';
import {
  ListMetricDefinitionsQuery,
  z,
  type MetricDefinitionHistory,
  type MetricDefinition,
  type Principal,
  type ReportKey,
  type ReportResponse,
} from '@sportspark/contracts';
import { CurrentPrincipal, ZodParams, ZodQuery } from '../../../kernel';
import { MetricDefinitionsService } from '../services/metric-definitions.service';
import { ReportsService } from '../services/reports.service';

const MetricKeyParams = z.object({ key: z.string().regex(/^MET-\d{3}$/) });
type MetricKeyParams = z.infer<typeof MetricKeyParams>;
type RawQuery = Record<string, unknown>;

/**
 * Report views (SPK-REPORT-002..006): every GET evaluates the report live through the engine,
 * which validates the parameters against the report's schema, authorizes the report's view action
 * and answers with the metric definitions and the as-of instant. Nothing is stored; POST
 * /reports/runs stores an evaluation for reproduction and export (SPK-REPORT-007).
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly definitions: MetricDefinitionsService,
  ) {}

  private async view(
    principal: Principal,
    key: ReportKey,
    query: RawQuery,
  ): Promise<ReportResponse> {
    return (await this.reports.evaluate(principal, key, query)).response;
  }

  @Get('metric-definitions')
  async listDefinitions(
    @CurrentPrincipal() principal: Principal,
    @ZodQuery(ListMetricDefinitionsQuery) query: ListMetricDefinitionsQuery,
  ): Promise<{ items: MetricDefinition[] }> {
    return { items: await this.definitions.list(principal, query) };
  }

  @Get('metric-definitions/:key')
  definitionHistory(
    @CurrentPrincipal() principal: Principal,
    @ZodParams(MetricKeyParams) params: MetricKeyParams,
  ): Promise<MetricDefinitionHistory> {
    return this.definitions.history(principal, params.key);
  }

  @Get('daily-schedule')
  dailySchedule(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'daily_schedule', q);
  }

  @Get('expected-arrivals')
  expectedArrivals(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'expected_arrivals', q);
  }

  @Get('attendance')
  attendance(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'attendance', q);
  }

  @Get('match-readiness')
  matchReadiness(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'match_readiness', q);
  }

  @Get('uncovered-assignments')
  uncoveredAssignments(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'uncovered_assignments', q);
  }

  @Get('waitlist-demand')
  waitlistDemand(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'waitlist_demand', q);
  }

  @Get('registration-funnel')
  registrationFunnel(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'registration_funnel', q);
  }

  @Get('enrollment-completeness')
  enrollmentCompleteness(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'enrollment_completeness', q);
  }

  @Get('outstanding-obligations')
  outstandingObligations(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'outstanding_obligations', q);
  }

  @Get('payment-reconciliation')
  paymentReconciliation(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'payment_reconciliation', q);
  }

  @Get('maintenance-restrictions')
  maintenanceRestrictions(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'maintenance_restrictions', q);
  }

  @Get('communication-failures')
  communicationFailures(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'communication_failures', q);
  }

  @Get('utilization')
  utilization(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'utilization', q);
  }

  @Get('economics')
  economics(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'economics', q);
  }

  @Get('retention')
  retention(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'retention', q);
  }

  @Get('demand')
  demand(@CurrentPrincipal() p: Principal, @Query() q: RawQuery) {
    return this.view(p, 'demand', q);
  }
}
