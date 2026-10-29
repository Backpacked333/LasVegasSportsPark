import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type CreateExportInput,
  type ListReportExportsQuery,
  type Page,
  type Principal,
  type ReportExport,
  type ReportExportCreated,
  type ReportKey,
  type RevokeExportInput,
} from '@sportspark/contracts';
import { json, type ExportsTable } from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { renderExport, sha256Hex } from '../output/report-output';
import {
  ExportCreated,
  ExportDownloaded,
  ExportExpired,
  ExportExpiryDue,
  ExportRevoked,
} from '../reporting.events';
import { ReportingActions } from '../reporting.actions';
import { ExportMachine } from '../reporting.machines';
import { REPORTING_POLICY, type ReportingPolicy } from '../reporting.policy';
import { REPORTING_SETTING_NAMES } from '../reporting.settings';
import { actorOf, iso, isoOrNull, organizationOf } from '../reporting.shared';
import { ReportRunsService } from './report-runs.service';
import { ReportsService } from './reports.service';

export type ExportRow = Selectable<ExportsTable>;

export const EXPORT_TOKEN_PREFIX = 'spx_';

const ListCursor = z.object({ requestedAt: z.string(), id: z.string() });

export function hashExportToken(token: string): string {
  return createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

export interface ExportDownload {
  exportId: string;
  content: string;
  contentType: string;
  filename: string;
  asOf: string;
  reportRunId: string;
}

/**
 * Exports (SPK-REPORT-007 "exports require independent permission checks and audit"; §4.14
 * "expiring exports"). An export is a requester-bound, single-use download of one stored report
 * run:
 *   - creating it needs the run to be visible (the report's view action) AND the export action of
 *     the report (`reporting.export_operational` or `reporting.export_financial`), checked
 *     separately — a role may read a report yet be refused its export;
 *   - the download re-checks the export action, requires the requester and the one-time token
 *     (only its SHA-256 is stored), refuses after the expiry instant (the database refuses a
 *     download recorded at or after it too) and renders exactly the content authorized (digest);
 *   - creation, download, revocation and expiry are audited; a timer event expires an unused
 *     export at its expiry instant, and a read of one past its expiry marks it expired at once;
 *   - the lifetime is the configured REPORTING_EXPORT_LIFETIME_MINUTES (DEC-060): without one no
 *     export is created (REP-03, rule K-00 (i));
 *   - the requester lists and reads their own exports with `reporting.read_exports`, re-checked on
 *     every request; nobody else's export is ever listed, administrators included (REP-01).
 * Content is the stored run's aggregate result; reports carry no person-level rows (rule G9).
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPORTING_POLICY) private readonly policy: ReportingPolicy,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly authorization: AuthorizationService,
    private readonly reports: ReportsService,
    private readonly runs: ReportRunsService,
  ) {}

  async create(
    principal: Principal,
    input: CreateExportInput,
    correlationId: string | null,
  ): Promise<ReportExportCreated> {
    const organizationId = organizationOf(principal);
    const run = await this.runs.loadVisible(principal, input.reportRunId);
    const definition = this.reports.definition(run.report_key as ReportKey);
    // The independent check: viewing the run is not enough to export it (SPK-REPORT-007).
    await this.authorization.require(principal, definition.exportAction, {
      type: 'report_export',
      organizationId,
      facilityId: run.facility_id,
    });
    if (!principal.accountId) {
      throw errors.accessDenied('An export is bound to the requesting account.');
    }
    // §4.14, DEC-060: the lifetime is a retention decision; without it nothing is exported.
    const lifetimeMinutes = this.policy.exportLifetimeMinutes;
    if (lifetimeMinutes === null) {
      throw errors.validation(
        'No export lifetime is configured, so no export can be created: the retention period is pending decision DEC-060.',
        {
          code: 'EXPORT_LIFETIME_UNCONFIGURED',
          setting: REPORTING_SETTING_NAMES.exportLifetime,
          pendingDecision: 'DEC-060',
        },
      );
    }
    const result = this.runs.resultOf(run);
    const content = renderExport(result, input.format);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + lifetimeMinutes * 60_000);
    const token = `${EXPORT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = newId();
    const row = await this.unitOfWork.run(async ({ trx }) => {
      const inserted = await trx
        .insertInto('exports')
        .values({
          id,
          organization_id: organizationId,
          report_run_id: run.id,
          report_key: run.report_key,
          format: input.format,
          authorized_action: definition.exportAction.id as ExportRow['authorized_action'],
          requested_by: json(snapshotActor(principal)),
          requested_by_account_id: principal.accountId as string,
          requested_by_person_id: principal.personId,
          requested_at: now,
          expires_at: expiresAt,
          download_token_hash: hashExportToken(token),
          row_count: result.rows.length,
          content_digest: sha256Hex(content),
          downloaded_at: null,
          downloaded_by: null,
          expired_at: null,
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'reporting.export_created',
        targetType: 'report_export',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          reportRunId: run.id,
          reportKey: run.report_key,
          format: input.format,
          authorizedAction: definition.exportAction.id,
          asOf: result.asOf,
          parameters: result.parameters,
          metricDefinitions: result.metrics.map((m) => `${m.metricKey}@${m.version}`),
          rowCount: result.rows.length,
          expiresAt: iso(expiresAt),
          lifetimeMinutes,
        },
      });
      await this.outbox.enqueue(trx, ExportCreated, {
        organizationId,
        aggregateType: 'report_export',
        aggregateId: id,
        correlationId,
        payload: {
          exportId: id,
          reportRunId: run.id,
          format: input.format,
          authorizedAction: definition.exportAction.id,
          expiresAt: iso(expiresAt),
        },
      });
      // Durable follow-up: expire the export at its expiry instant even if nobody asks (§4.12).
      await this.outbox.enqueue(trx, ExportExpiryDue, {
        organizationId,
        aggregateType: 'report_export',
        aggregateId: id,
        correlationId,
        availableAt: expiresAt,
        payload: { exportId: id, expiresAt: iso(expiresAt) },
      });
      return inserted;
    });
    return {
      ...this.view(row),
      downloadToken: token,
      downloadPath: `/v1/reports/exports/${id}/download`,
    };
  }

  /**
   * REP-01 (§4.14, SPK-REPORT-007, SCR-S-45): the caller's own exports, newest first (keyset on
   * requested_at, id). Requires `reporting.read_exports` on every request; only exports requested
   * by the caller's account are ever listed — another account's never appear, administrators
   * included. An export past its expiry is marked expired first (the timer's rule), so it lists as
   * expired. Never a token or a download path.
   */
  async list(
    principal: Principal,
    query: ListReportExportsQuery,
    correlationId: string | null,
  ): Promise<Page<ReportExport>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ReportingActions.readExports, {
      type: 'report_export',
      organizationId,
    });
    const accountId = principal.accountId;
    if (!accountId) return { items: [], nextCursor: null };
    await this.expireDue(organizationId, accountId, null, correlationId);
    const cursor = decodeCursor(query.cursor, ListCursor);
    let q = this.unitOfWork
      .reader()
      .selectFrom('exports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('requested_by_account_id', '=', accountId);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<boolean>`(requested_at, id) < (${new Date(cursor.requestedAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q
      .orderBy('requested_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const last = rows.length > query.limit ? page[page.length - 1] : undefined;
    return {
      items: page.map((row) => this.view(row)),
      nextCursor: last ? encodeCursor({ requestedAt: iso(last.requested_at), id: last.id }) : null,
    };
  }

  async get(
    principal: Principal,
    id: string,
    correlationId: string | null = null,
  ): Promise<ReportExport> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ReportingActions.readExports, {
      type: 'report_export',
      id,
      organizationId,
    });
    const row = await this.loadOwn(principal, id);
    if (row.status !== 'ready' || this.clock.now().getTime() < new Date(row.expires_at).getTime()) {
      return this.view(row);
    }
    await this.expireDue(organizationId, row.requested_by_account_id, row.id, correlationId);
    return this.view(await this.loadOwn(principal, id));
  }

  /**
   * Marks the requester's ready exports past their expiry as expired (or only `exportId`), through
   * the timer's own rule (`expireIfDue`: locked, idempotent, audited) — the lazy half of §4.14.
   */
  private async expireDue(
    organizationId: string,
    accountId: string,
    exportId: string | null,
    correlationId: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    let q = this.unitOfWork
      .reader()
      .selectFrom('exports')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('requested_by_account_id', '=', accountId)
      .where('status', '=', 'ready')
      .where('expires_at', '<=', now);
    if (exportId) q = q.where('id', '=', exportId);
    const due = await q.orderBy('id').execute();
    if (due.length === 0) return;
    await this.unitOfWork.run(async ({ trx }) => {
      for (const { id } of due) await this.expireIfDue(trx, organizationId, id, correlationId);
    });
  }

  async download(
    principal: Principal,
    id: string,
    token: string | undefined,
    correlationId: string | null,
  ): Promise<ExportDownload> {
    const organizationId = organizationOf(principal);
    const outcome = await this.unitOfWork.run(async ({ trx }) => {
      const row = await this.loadOwn(principal, id, trx, true);
      if (!token || !this.tokenMatches(row.download_token_hash, token)) {
        throw errors.protectedNotFound('export');
      }
      // Independent re-checks at the moment of disclosure: authority may have ended since creation.
      const run = await this.runs.loadVisible(principal, row.report_run_id);
      await this.authorization.require(principal, row.authorized_action, {
        type: 'report_export',
        organizationId,
        facilityId: run.facility_id,
      });
      const now = this.clock.now();
      if (row.status === 'ready' && now.getTime() >= new Date(row.expires_at).getTime()) {
        await this.expireRow(trx, row, now, correlationId);
        return { kind: 'expired' as const };
      }
      const next = ExportMachine.next(row.status, 'download');
      const result = this.runs.resultOf(run);
      const content = renderExport(result, row.format);
      if (sha256Hex(content) !== row.content_digest) {
        throw errors.internal('The export content no longer matches what was authorized.');
      }
      await trx
        .updateTable('exports')
        .set({
          status: next,
          downloaded_at: now,
          downloaded_by: json(snapshotActor(principal)),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'reporting.export_downloaded',
        targetType: 'report_export',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId,
        details: {
          reportRunId: row.report_run_id,
          reportKey: row.report_key,
          format: row.format,
          asOf: result.asOf,
          contentDigest: row.content_digest,
        },
      });
      await this.outbox.enqueue(trx, ExportDownloaded, {
        organizationId,
        aggregateType: 'report_export',
        aggregateId: row.id,
        correlationId,
        payload: { exportId: row.id, reportRunId: row.report_run_id },
      });
      return {
        kind: 'downloaded' as const,
        download: {
          exportId: row.id,
          content,
          contentType:
            row.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
          filename: `${row.report_key}-${row.report_run_id}.${row.format}`,
          asOf: result.asOf,
          reportRunId: row.report_run_id,
        },
      };
    });
    if (outcome.kind === 'expired') {
      throw errors.invalidTransition('Export', 'expired', 'download');
    }
    return outcome.download;
  }

  async revoke(
    principal: Principal,
    id: string,
    input: RevokeExportInput,
    correlationId: string | null,
  ): Promise<ReportExport> {
    const organizationId = organizationOf(principal);
    const row = await this.unitOfWork.run(async ({ trx }) => {
      const current = await this.loadOwn(principal, id, trx, true);
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = ExportMachine.next(current.status, 'revoke');
      const now = this.clock.now();
      const updated = await trx
        .updateTable('exports')
        .set({
          status: next,
          revoked_at: now,
          revoked_by: json(snapshotActor(principal)),
          revoke_reason: input.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'reporting.export_revoked',
        targetType: 'report_export',
        targetId: current.id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: input.reason,
        correlationId,
        details: { reportRunId: current.report_run_id },
      });
      await this.outbox.enqueue(trx, ExportRevoked, {
        organizationId,
        aggregateType: 'report_export',
        aggregateId: current.id,
        correlationId,
        payload: { exportId: current.id, revokedAt: iso(now) },
      });
      return updated;
    });
    return this.view(row);
  }

  /**
   * Handler of the `reporting.export_expiry_due` timer (idempotent under replay): a still-ready
   * export whose expiry has passed becomes expired; a downloaded, revoked or already expired one is
   * left alone.
   */
  async expireIfDue(
    trx: Trx,
    organizationId: string,
    exportId: string,
    correlationId: string | null,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom('exports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', exportId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status !== 'ready') return false;
    const now = this.clock.now();
    if (now.getTime() < new Date(row.expires_at).getTime()) return false;
    await this.expireRow(trx, row, now, correlationId);
    return true;
  }

  private async expireRow(
    trx: Trx,
    row: ExportRow,
    now: Date,
    correlationId: string | null,
  ): Promise<void> {
    const next = ExportMachine.next(row.status, 'expire');
    await trx
      .updateTable('exports')
      .set({ status: next, expired_at: now, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: systemPrincipal(row.organization_id, 'reporting.expire_export'),
      action: 'reporting.export_expired',
      targetType: 'report_export',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: { reportRunId: row.report_run_id, expiresAt: iso(row.expires_at) },
    });
    await this.outbox.enqueue(trx, ExportExpired, {
      organizationId: row.organization_id,
      aggregateType: 'report_export',
      aggregateId: row.id,
      correlationId,
      payload: { exportId: row.id, expiredAt: iso(now) },
    });
  }

  /** The requester's export; to anyone else it does not exist (§4.10). */
  private async loadOwn(
    principal: Principal,
    id: string,
    trx?: Trx,
    lock = false,
  ): Promise<ExportRow> {
    const organizationId = organizationOf(principal);
    let q = (trx ?? this.unitOfWork.reader())
      .selectFrom('exports')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (lock) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    const isRequester =
      principal.accountId !== null && row?.requested_by_account_id === principal.accountId;
    if (!row || !isRequester) throw errors.protectedNotFound('export');
    return row;
  }

  private tokenMatches(hash: string, token: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(hashExportToken(token), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private view(row: ExportRow): ReportExport {
    return {
      id: row.id,
      reportRunId: row.report_run_id,
      reportKey: row.report_key as ReportKey,
      format: row.format,
      authorizedAction: row.authorized_action,
      status: row.status,
      requestedBy: actorOf(row.requested_by),
      requestedAt: iso(row.requested_at),
      expiresAt: iso(row.expires_at),
      rowCount: row.row_count,
      contentDigest: row.content_digest,
      downloadedAt: isoOrNull(row.downloaded_at),
      expiredAt: isoOrNull(row.expired_at),
      revokedAt: isoOrNull(row.revoked_at),
      revokeReason: row.revoke_reason,
      revision: row.revision,
    };
  }
}
