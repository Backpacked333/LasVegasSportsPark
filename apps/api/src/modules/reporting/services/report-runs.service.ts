import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  ReportResponseSchema,
  z,
  type CreateReportRunInput,
  type ListReportRunsQuery,
  type Page,
  type Principal,
  type ReportKey,
  type ReportReproduction,
  type ReportResponse,
  type ReportRun,
  type ReportRunSummary,
  type ReproduceReportRunInput,
} from '@sportspark/contracts';
import { json, type Db, type ReportRunsTable } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
} from '../../../kernel';
import { resultDigest } from '../output/report-output';
import { ReportRunRecorded } from '../reporting.events';
import { actorOf, iso, organizationOf } from '../reporting.shared';
import { ReportsService, type Evaluation } from './reports.service';

export type ReportRunRow = Selectable<ReportRunsTable>;

const Cursor = z.object({ producedAt: z.string(), id: z.string() });

/**
 * Stored report runs (SPK-REPORT-007 "reports must be reproducible after corrections"). A run is
 * an append-only record of one evaluation: the metric definition versions, the validated
 * parameters with the resolved as-of instant, the actor, the production instant, the row count,
 * the full result and its digest. Reading a run returns it exactly as produced; reproducing a run
 * evaluates the report again at the same as-of instant and records whether the digests match.
 * A run is shown to whoever may view its report now (re-checked on every read); to anyone else it
 * does not exist (§4.10).
 */
@Injectable()
export class ReportRunsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly authorization: AuthorizationService,
    private readonly reports: ReportsService,
  ) {}

  async create(
    principal: Principal,
    input: CreateReportRunInput,
    correlationId: string | null,
  ): Promise<ReportRun> {
    const runId = newId();
    const evaluation = await this.reports.evaluate(principal, input.report, input.parameters, {
      runId,
    });
    const row = await this.store(principal, evaluation, runId, {
      correlationId,
      reason: input.reason ?? null,
      reproduces: null,
    });
    return this.toRun(row, await this.metricIds(row));
  }

  async get(principal: Principal, id: string): Promise<ReportRun> {
    const row = await this.loadVisible(principal, id);
    return this.toRun(row, await this.metricIds(row));
  }

  async list(principal: Principal, query: ListReportRunsQuery): Promise<Page<ReportRunSummary>> {
    const organizationId = organizationOf(principal);
    const keys = query.report ? [query.report] : this.reports.keys();
    const visible: ReportKey[] = [];
    for (const key of keys) {
      const definition = this.reports.definition(key);
      const decision = await this.authorization.decide(principal, definition.viewAction, {
        type: 'report_run',
        organizationId,
      });
      const facilityScoped = principal.kind === 'staff' && principal.facilityIds.length > 0;
      if (decision.allowed && !(definition.scope === 'organization' && facilityScoped))
        visible.push(key);
    }
    if (visible.length === 0) {
      if (principal.kind !== 'staff' && principal.kind !== 'system') throw errors.accessDenied();
      return { items: [], nextCursor: null };
    }
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('report_runs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('report_key', 'in', visible)
      .orderBy('produced_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (principal.kind === 'staff' && principal.facilityIds.length > 0) {
      q = q.where('facility_id', 'in', principal.facilityIds);
    }
    if (cursor) {
      q = q.where(
        sql<boolean>`(produced_at, id) < (${new Date(cursor.producedAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const items: ReportRunSummary[] = [];
    for (const row of page) items.push(this.toSummary(row, await this.metricIds(row)));
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ producedAt: iso(last.produced_at), id: last.id }) : null,
    };
  }

  async reproduce(
    principal: Principal,
    id: string,
    input: ReproduceReportRunInput,
    correlationId: string | null,
  ): Promise<ReportReproduction> {
    const original = await this.loadVisible(principal, id);
    const key = original.report_key as ReportKey;
    const definition = this.reports.definition(key);
    if (definition.pointInTime === 'none') {
      throw errors.validation(
        'This report is evaluated live: it cannot be recomputed as of an earlier instant. The stored run is its reproducible record.',
        { code: 'live_only', report: key },
      );
    }
    const runId = newId();
    const evaluation = await this.reports.evaluate(principal, key, original.parameters, {
      runId,
      skipAuthorization: true,
    });
    const digest = resultDigest(evaluation.response);
    const matched = digest === original.result_digest;
    const row = await this.store(principal, evaluation, runId, {
      correlationId,
      reason: input.reason ?? null,
      reproduces: { runId: original.id, matched },
    });
    return {
      originalRunId: original.id,
      originalDigest: original.result_digest,
      reproducedDigest: digest,
      matched,
      explanation: matched
        ? 'The report evaluated again at the same as-of instant produced exactly the stored figures.'
        : `The figures differ: ${definition.pointInTimeNote}`,
      reproducedRun: this.toRun(row, await this.metricIds(row)),
    };
  }

  /** The run if the principal may view its report now; protected not-found otherwise (§4.10). */
  async loadVisible(principal: Principal, id: string): Promise<ReportRunRow> {
    const organizationId = organizationOf(principal);
    const row = await this.unitOfWork
      .reader()
      .selectFrom('report_runs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('report run');
    const definition = this.reports.definition(row.report_key as ReportKey);
    await this.reports.authorizeView(principal, definition, organizationId, row.facility_id, {
      protectedRecord: true,
      recordType: 'report run',
      recordId: row.id,
    });
    return row;
  }

  private async store(
    principal: Principal,
    evaluation: Evaluation,
    runId: string,
    options: {
      correlationId: string | null;
      reason: string | null;
      reproduces: { runId: string; matched: boolean } | null;
    },
  ): Promise<ReportRunRow> {
    const result = evaluation.response;
    const digest = resultDigest(result);
    return this.unitOfWork.run(async ({ trx }) => {
      const row = await trx
        .insertInto('report_runs')
        .values({
          id: runId,
          organization_id: evaluation.organizationId,
          facility_id: evaluation.facility?.id ?? null,
          report_key: result.report.key,
          parameters: json(evaluation.parameters),
          reproducible_as_of: result.asOf,
          produced_at: result.producedAt,
          point_in_time: evaluation.definition.pointInTime,
          access_action: evaluation.definition.viewAction.id,
          requested_by: json(snapshotActor(principal)),
          requested_by_account_id: principal.accountId,
          requested_by_person_id: principal.personId,
          row_count: result.rows.length,
          result: json(result),
          result_digest: digest,
          reproduces_run_id: options.reproduces?.runId ?? null,
          reproduction_matched: options.reproduces?.matched ?? null,
          correlation_id: options.correlationId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (result.metrics.length > 0) {
        await trx
          .insertInto('report_run_metrics')
          .values(
            result.metrics.map((m) => ({
              organization_id: evaluation.organizationId,
              report_run_id: runId,
              metric_definition_id: m.id,
            })),
          )
          .execute();
      }
      await this.audit.record(trx, {
        organizationId: evaluation.organizationId,
        actor: principal,
        action: options.reproduces
          ? 'reporting.report_run_reproduced'
          : 'reporting.report_run_recorded',
        targetType: 'report_run',
        targetId: runId,
        afterRevision: null,
        reason: options.reason,
        correlationId: options.correlationId,
        details: {
          reportKey: result.report.key,
          asOf: result.asOf,
          parameters: evaluation.parameters,
          rowCount: result.rows.length,
          resultDigest: digest,
          metricDefinitions: result.metrics.map((m) => `${m.metricKey}@${m.version}`),
          ...(options.reproduces
            ? { reproducesRunId: options.reproduces.runId, matched: options.reproduces.matched }
            : {}),
        },
      });
      await this.outbox.enqueue(trx, ReportRunRecorded, {
        organizationId: evaluation.organizationId,
        aggregateType: 'report_run',
        aggregateId: runId,
        correlationId: options.correlationId,
        payload: {
          reportRunId: runId,
          reportKey: result.report.key,
          asOf: result.asOf,
          rowCount: result.rows.length,
          resultDigest: digest,
          reproducesRunId: options.reproduces?.runId ?? null,
          reproductionMatched: options.reproduces?.matched ?? null,
        },
      });
      return row;
    });
  }

  async metricIds(row: ReportRunRow): Promise<string[]> {
    const rows = await this.unitOfWork
      .reader()
      .selectFrom('report_run_metrics')
      .select('metric_definition_id')
      .where('organization_id', '=', row.organization_id)
      .where('report_run_id', '=', row.id)
      .orderBy('metric_definition_id')
      .execute();
    return rows.map((r) => r.metric_definition_id);
  }

  resultOf(row: ReportRunRow): ReportResponse {
    return ReportResponseSchema.parse(row.result);
  }

  private toSummary(row: ReportRunRow, metricIds: string[]): ReportRunSummary {
    return {
      id: row.id,
      reportKey: row.report_key as ReportKey,
      facilityId: row.facility_id,
      parameters: row.parameters,
      asOf: iso(row.reproducible_as_of),
      producedAt: iso(row.produced_at),
      pointInTime: row.point_in_time,
      accessAction: row.access_action,
      requestedBy: actorOf(row.requested_by),
      rowCount: row.row_count,
      resultDigest: row.result_digest,
      reproducesRunId: row.reproduces_run_id,
      reproductionMatched: row.reproduction_matched,
      metricDefinitionIds: metricIds,
    };
  }

  private toRun(row: ReportRunRow, metricIds: string[]): ReportRun {
    return { ...this.toSummary(row, metricIds), result: this.resultOf(row) };
  }
}
