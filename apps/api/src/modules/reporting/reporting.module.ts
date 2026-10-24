import { Module, type OnModuleInit } from '@nestjs/common';
import type { EventPayload } from '@sportspark/contracts';
import { EventHandlerRegistry, runWithTransaction } from '../../kernel';
import { CompetitionModule } from '../competition';
import { WorkforceModule } from '../workforce';
import { CostInputsController } from './controllers/cost-inputs.controller';
import { ExportsController } from './controllers/exports.controller';
import { ReportRunsController } from './controllers/report-runs.controller';
import { ReportsController } from './controllers/reports.controller';
import { ExportExpiryDue } from './reporting.events';
import { DEFAULT_REPORTING_POLICY, REPORTING_POLICY } from './reporting.policy';
import { EconomicsReport } from './reports/economics.report';
import { FinanceReports } from './reports/finance.reports';
import { OperationsReports } from './reports/operations.reports';
import { RegistrationReports } from './reports/registration.reports';
import { RetentionReport } from './reports/retention.report';
import { ScheduleReports } from './reports/schedule.reports';
import { UtilizationReport } from './reports/utilization.report';
import { CostInputsService } from './services/cost-inputs.service';
import { ExportsService } from './services/exports.service';
import { MetricDefinitionsService } from './services/metric-definitions.service';
import { ReportRunsService } from './services/report-runs.service';
import { ReportsService } from './services/reports.service';

/**
 * ReportingModule (specification §3.20 SPK-REPORT-001..007, §4.2 "Reporting: derived metrics and
 * exports", §4.14 expiring exports, §1.2 success measures). Owns metric definitions, report runs,
 * exports and agreed cost inputs. It never writes another module's records: it reads them through
 * the read-only views of migration 1300 and through the competition module's ReadinessService and
 * the workforce module's ASSIGNMENT_COVERAGE_PORT. Its one durable follow-up is the export expiry
 * timer (`reporting.export_expiry_due` → handler `reporting.expire_export`). See README.md.
 */
@Module({
  imports: [CompetitionModule, WorkforceModule],
  providers: [
    // Policy values left to operators (§6.6): proposed defaults, replaceable by approval.
    { provide: REPORTING_POLICY, useValue: DEFAULT_REPORTING_POLICY },
    MetricDefinitionsService,
    ScheduleReports,
    OperationsReports,
    RegistrationReports,
    FinanceReports,
    UtilizationReport,
    EconomicsReport,
    RetentionReport,
    ReportsService,
    ReportRunsService,
    ExportsService,
    CostInputsService,
  ],
  controllers: [ReportsController, ReportRunsController, ExportsController, CostInputsController],
  exports: [
    REPORTING_POLICY,
    MetricDefinitionsService,
    ReportsService,
    ReportRunsService,
    ExportsService,
    CostInputsService,
  ],
})
export class ReportingModule implements OnModuleInit {
  constructor(
    private readonly registry: EventHandlerRegistry,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit(): void {
    // §4.14 expiring exports: at its expiry instant an unused export becomes expired, even if
    // nobody asks for it again. Idempotent under replay (only a still-ready export changes).
    this.registry.on<EventPayload<typeof ExportExpiryDue>>(
      ExportExpiryDue.type,
      'reporting.expire_export',
      (event, ctx) =>
        runWithTransaction(ctx.trx, async () => {
          await this.exports.expireIfDue(
            ctx.trx,
            event.organizationId,
            event.payload.exportId,
            event.correlationId,
          );
        }),
    );
  }
}
