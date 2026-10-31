import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  REPORT_QUERY_SCHEMAS,
  systemPrincipal,
  type Principal,
  type ReportKey,
  type ReportResponse,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  UnitOfWork,
  type Clock,
  type Trx,
  listFacilityScope,
} from '../../../kernel';
import type { FacilityRef, ReportContext, ReportDefinition } from '../engine/report-definition';
import { metricsForReport } from '../reporting.metrics';
import {
  dayStartOf,
  REPORTING_POLICY,
  settingUse,
  type ReportingPolicy,
} from '../reporting.policy';
import { iso, organizationOf, toMetricDefinition } from '../reporting.shared';
import { EconomicsReport } from '../reports/economics.report';
import { FinanceReports } from '../reports/finance.reports';
import { OperationsReports } from '../reports/operations.reports';
import { RegistrationReports } from '../reports/registration.reports';
import { RetentionReport } from '../reports/retention.report';
import { ScheduleReports } from '../reports/schedule.reports';
import { UtilizationReport } from '../reports/utilization.report';
import { MetricDefinitionsService } from './metric-definitions.service';

export interface Evaluation {
  response: ReportResponse;
  definition: ReportDefinition;
  facility: FacilityRef | null;
  organizationId: string;
  /** The parameters as validated, with the as-of instant resolved (what a reproduction reruns). */
  parameters: Record<string, unknown>;
}

/**
 * The report engine. Every report — viewed (GET /reports/*) or stored (POST /reports/runs) — goes
 * through `evaluate`: validate the parameters, resolve the facility inside the principal's
 * organization (§4.8: organization scope never comes from the request), authorize the report's
 * view action against the real scope, fix the as-of instant (never in the future; live-only
 * reports refuse a past instant), compute, and wrap the result with the metric definitions, the
 * as-of instant and the module settings used (SPK-REPORT-001, SPK-REPORT-007, REP-03).
 *
 * REP-03 (one snapshot): the metric definitions and the whole computation run inside one
 * read-only repeatable-read `UnitOfWork.run`, and the transaction is handed to every port (the
 * workforce coverage port, the enrollment booking port), so a report never mixes states read
 * before and after another transaction committed. Seeding the metric definitions writes, so it
 * happens before the snapshot opens. Called inside an active transaction (a command or handler),
 * the report reads through that transaction instead. A report whose owning module's query service
 * still reads through its own connection (`consistency: 'owner_reads'`: match readiness, the
 * competition module's ReadinessService) computes outside a transaction, and says so.
 */
@Injectable()
export class ReportsService {
  private readonly definitions: ReadonlyMap<ReportKey, ReportDefinition>;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPORTING_POLICY) private readonly policy: ReportingPolicy,
    private readonly unitOfWork: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly metricDefinitions: MetricDefinitionsService,
    schedule: ScheduleReports,
    operations: OperationsReports,
    registration: RegistrationReports,
    finance: FinanceReports,
    utilization: UtilizationReport,
    economics: EconomicsReport,
    retention: RetentionReport,
  ) {
    const all: ReportDefinition[] = [
      schedule.dailySchedule,
      schedule.expectedArrivals,
      schedule.attendance,
      operations.matchReadiness,
      operations.uncoveredAssignments,
      registration.waitlistDemand,
      registration.registrationFunnel,
      registration.enrollmentCompleteness,
      finance.outstandingObligations,
      finance.paymentReconciliation,
      operations.maintenanceRestrictions,
      operations.communicationFailures,
      utilization.definition,
      economics.definition,
      retention.definition,
      registration.demand,
    ] as ReportDefinition[];
    this.definitions = new Map(all.map((d) => [d.key, d]));
  }

  definition(key: ReportKey): ReportDefinition {
    const definition = this.definitions.get(key);
    if (!definition) throw errors.notFound('report', key);
    return definition;
  }

  keys(): ReportKey[] {
    return [...this.definitions.keys()];
  }

  /** Authorize viewing a report's figures for the scope (report runs re-check this on every read). */
  async authorizeView(
    principal: Principal,
    definition: ReportDefinition,
    organizationId: string,
    facilityId: string | null,
    options: { protectedRecord?: boolean; recordType?: string; recordId?: string } = {},
  ): Promise<void> {
    await this.authorization.require(principal, definition.viewAction, {
      type: options.recordType ?? 'report',
      id: options.recordId ?? definition.key,
      organizationId,
      facilityId,
      protected: options.protectedRecord ?? false,
    });
    // G2: an organization-wide report would show facilities a facility-scoped principal may not see.
    if (
      definition.scope === 'organization' &&
      listFacilityScope(principal, definition.viewAction)
    ) {
      if (options.protectedRecord) throw errors.protectedNotFound(options.recordType ?? 'report');
      throw errors.accessDenied(
        'This organization-wide report requires organization-wide access.',
        {
          action: definition.viewAction.id,
        },
      );
    }
  }

  async evaluate(
    principal: Principal,
    key: ReportKey,
    rawParameters: unknown,
    options: { runId?: string; skipAuthorization?: boolean } = {},
  ): Promise<Evaluation> {
    const organizationId = organizationOf(principal);
    const definition = this.definition(key);
    const parsed = REPORT_QUERY_SCHEMAS[key].safeParse(rawParameters ?? {});
    if (!parsed.success) {
      throw errors.validation(
        'Report parameters failed validation.',
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      );
    }
    const params = parsed.data as Record<string, unknown>;

    let facility: FacilityRef | null = null;
    if (definition.scope === 'facility') {
      const facilityId = params['facilityId'] as string;
      const row = await this.db
        .selectFrom('facilities')
        .select(['id', 'timezone', 'name'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', facilityId)
        .executeTakeFirst();
      if (!row) throw errors.notFound('facility', facilityId);
      facility = { id: row.id, timezone: row.timezone, name: row.name };
    }
    if (!options.skipAuthorization) {
      await this.authorizeView(principal, definition, organizationId, facility?.id ?? null);
    }

    const now = this.clock.now();
    const asOf = typeof params['asOf'] === 'string' ? new Date(params['asOf']) : now;
    if (asOf.getTime() > now.getTime()) {
      throw errors.validation('A report cannot be evaluated as of a future instant.', {
        asOf: iso(asOf),
        now: iso(now),
      });
    }
    if (definition.pointInTime === 'none' && asOf.getTime() !== now.getTime()) {
      throw errors.validation(
        'This report is evaluated live and cannot be reconstructed as of an earlier instant; read the stored report run instead.',
        { code: 'live_only', report: key },
      );
    }
    const parameters = { ...params, asOf: iso(asOf) };

    await this.metricDefinitions.ensureSeeded(organizationId);
    const metricKeys = metricsForReport(key).map((m) => m.key);
    const consistency = definition.consistency ?? 'snapshot';

    const compute = async (db: Db | Trx, trx: Trx | null) => {
      const metrics = await this.metricDefinitions.activeFor(organizationId, metricKeys, db);
      const ctx: ReportContext = {
        organizationId,
        facility,
        asOf,
        now,
        db,
        trx,
        policy: this.policy,
        dayStart: dayStartOf(this.policy),
        system: systemPrincipal(organizationId, `reporting.${key}`),
      };
      return { metrics, computation: await definition.compute(ctx, params as never) };
    };
    const enclosing = this.unitOfWork.current();
    const { metrics, computation } = enclosing
      ? await compute(enclosing, enclosing)
      : consistency === 'owner_reads'
        ? await compute(this.db, null)
        : await this.unitOfWork.run(
            async ({ trx }) => {
              await sql`set transaction read only`.execute(trx);
              return compute(trx, trx);
            },
            { isolationLevel: 'repeatable read' },
          );
    for (const value of computation.values) {
      if (!metricKeys.includes(value.metric)) {
        throw errors.internal(
          `report ${key} produced a value for ${value.metric}, which it does not define`,
        );
      }
    }
    const settings = (computation.settings ?? definition.settings ?? []).map((s) =>
      settingUse(this.policy, s),
    );
    const consistencyNote =
      consistency === 'owner_reads'
        ? 'Read through the owning module at the request instant, outside a single snapshot.'
        : 'Every source was read in one snapshot.';

    const response: ReportResponse = {
      report: {
        key,
        title: definition.title,
        requirementIds: [...definition.requirementIds],
        accessAction: definition.viewAction.id,
        exportAction: definition.exportAction.id,
      },
      runId: options.runId ?? null,
      asOf: iso(asOf),
      producedAt: iso(now),
      scope: {
        facilityId: facility?.id ?? null,
        timezone: facility?.timezone ?? null,
        from: computation.scope.from,
        to: computation.scope.to,
      },
      parameters,
      freshness: {
        class: options.runId ? 'F3' : 'F1',
        pointInTime: definition.pointInTime,
        note: options.runId
          ? `Snapshot stored at ${iso(now)}. ${consistencyNote} ${definition.pointInTimeNote}`
          : `Read live at ${iso(now)}. ${consistencyNote} ${definition.pointInTimeNote}`,
        consistency,
      },
      settings,
      metrics: metrics.map(toMetricDefinition),
      disclosures: computation.disclosures,
      values: computation.values,
      columns: computation.columns,
      rows: computation.rows,
    };
    return { response, definition, facility, organizationId, parameters };
  }
}
