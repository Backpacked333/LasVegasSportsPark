import { Inject, Injectable } from '@nestjs/common';
import {
  ControlTotalsSchema,
  errors,
  newId,
  type AbortImportBatchInput,
  type AppendImportRowsInput,
  type CreateImportBatchInput,
  type CsvDocument,
  type ImportBatch,
  type ImportRow,
  type ListImportBatchesQuery,
  type ListImportRowsQuery,
  type Page,
  type Principal,
  type ReviewImportBatchInput,
  type StagedRow,
  type ValidateImportBatchInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MigrationActions } from '../migration.actions';
import { MigrationEvents } from '../migration.events';
import { ImportBatchMachine } from '../migration.machines';
import { MIGRATION_POLICY, type MigrationPolicy } from '../migration.policy';
import {
  countOutcomes,
  organizationOf,
  toImportBatch,
  toImportRow,
  type BatchRow,
  type Reader,
} from '../migration.shared';
import { batchChecksum, payloadHash } from '../staging/checksum';
import { compareControlTotals } from '../staging/control-totals';
import { csvToStagedRows } from '../staging/csv';
import { ImportContextBuilder, inDependencyOrder } from './import-context';
import { ImportExceptionsService } from './import-exceptions.service';
import { ImportPlanner, type RowPlan } from './import-planner';

const INSERT_CHUNK = 250;

/**
 * Import batches (§5.4): staging, validation (dry run), review and abort. A batch is protected
 * (it carries customer-private data): a caller without migration authority receives NOT_FOUND.
 *
 * Staging records the snapshot exactly as received; nothing is interpreted yet. Validation seals
 * the batch — the checksum over the staged rows is computed once and must equal the declared one,
 * as must the declared row count — and plans every row with the same rules the apply uses: the
 * planned outcome and its reasons are stored on each row, ambiguity, conflicts and validation
 * errors open review exceptions, exceptions that no longer apply are withdrawn, and the control
 * totals are compared without netting. Review is complete once every exception is decided.
 */
@Injectable()
export class ImportBatchesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MIGRATION_POLICY) private readonly policy: MigrationPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: ImportExceptionsService,
    private readonly contexts: ImportContextBuilder,
    private readonly operationalExceptions: OperationalExceptions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async load(db: Reader, organizationId: string, id: string, forUpdate = false) {
    let q = db
      .selectFrom('import_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Loads a batch the principal may act on, or NOT_FOUND (protected record, §4.10). */
  async authorized(
    db: Reader,
    principal: Principal,
    id: string,
    action: (typeof MigrationActions)[keyof typeof MigrationActions],
    forUpdate = false,
  ): Promise<BatchRow> {
    const organizationId = organizationOf(principal);
    const batch = await this.load(db, organizationId, id, forUpdate);
    if (!batch) throw errors.protectedNotFound('import batch');
    await this.authorization.require(principal, action, {
      type: 'import_batch',
      id,
      organizationId,
      protected: true,
    });
    return batch;
  }

  async view(db: Reader, batch: BatchRow): Promise<ImportBatch> {
    const exceptions = await this.exceptions.counts(db, batch.organization_id, batch.id);
    const same = batch.checksum
      ? await db
          .selectFrom('import_batches')
          .select('id')
          .where('organization_id', '=', batch.organization_id)
          .where('source_system', '=', batch.source_system)
          .where('checksum', '=', batch.checksum)
          .where('id', '<>', batch.id)
          .orderBy('received_at')
          .execute()
      : [];
    return toImportBatch(batch, { exceptions, sameChecksumBatchIds: same.map((s) => s.id) });
  }

  async get(principal: Principal, id: string): Promise<ImportBatch> {
    const batch = await this.authorized(this.db, principal, id, MigrationActions.readBatch);
    return this.view(this.db, batch);
  }

  async list(principal: Principal, query: ListImportBatchesQuery): Promise<Page<ImportBatch>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.readBatch, {
      type: 'import_batch',
      organizationId,
      protected: true,
    });
    let q = this.db
      .selectFrom('import_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('received_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit);
    if (query.sourceSystem) q = q.where('source_system', '=', query.sourceSystem);
    if (query.status) q = q.where('status', '=', query.status);
    const rows = await q.execute();
    const items: ImportBatch[] = [];
    for (const row of rows) items.push(await this.view(this.db, row));
    return { items, nextCursor: null };
  }

  async rows(
    principal: Principal,
    id: string,
    query: ListImportRowsQuery,
  ): Promise<Page<ImportRow>> {
    const batch = await this.authorized(this.db, principal, id, MigrationActions.readBatch);
    let q = this.db
      .selectFrom('import_rows as r')
      .leftJoin('external_mappings as m', (join) =>
        join
          .onRef('m.organization_id', '=', 'r.organization_id')
          .onRef('m.id', '=', 'r.mapping_id'),
      )
      .selectAll('r')
      .select('m.internal_id as mapped_internal_id')
      .where('r.organization_id', '=', batch.organization_id)
      .where('r.batch_id', '=', batch.id)
      .orderBy('r.sequence')
      .limit(query.limit);
    if (query.entityType) q = q.where('r.entity_type', '=', query.entityType);
    if (query.outcome) q = q.where('r.outcome', '=', query.outcome);
    if (query.plannedOutcome) q = q.where('r.planned_outcome', '=', query.plannedOutcome);
    if (query.cursor && /^\d+$/.test(query.cursor))
      q = q.where('r.sequence', '>', Number(query.cursor));
    const rows = await q.execute();
    const items = rows.map((r) => toImportRow(r, r.mapped_internal_id ?? null));
    const last = rows[rows.length - 1];
    return {
      items,
      nextCursor: rows.length === query.limit && last ? String(last.sequence) : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Staging
  // -------------------------------------------------------------------------------------------

  private stagedRows(rows: readonly StagedRow[], csv: readonly CsvDocument[]): StagedRow[] {
    const all = [...rows];
    for (const document of csv) all.push(...csvToStagedRows(document.entityType, document.content));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const row of all) {
      const k = `${row.entityType}:${row.externalId}`;
      if (seen.has(k)) duplicates.push(k);
      seen.add(k);
    }
    if (duplicates.length > 0) {
      throw errors.validation('The snapshot lists the same external record more than once.', {
        code: 'DUPLICATE_EXTERNAL_ID',
        duplicates: duplicates.slice(0, 50),
      });
    }
    return all;
  }

  private async insertRows(
    trx: Trx,
    batch: { id: string; organization_id: string },
    rows: readonly StagedRow[],
    firstSequence: number,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      try {
        await trx
          .insertInto('import_rows')
          .values(
            chunk.map((row, j) => ({
              id: newId(),
              organization_id: batch.organization_id,
              batch_id: batch.id,
              sequence: firstSequence + i + j,
              entity_type: row.entityType,
              external_id: row.externalId,
              payload: json(row.payload),
              payload_hash: payloadHash(row.payload),
              planned_outcome: null,
              outcome: null,
              mapping_id: null,
              applied_at: null,
            })),
          )
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('An external record of this batch is already staged.', {
            code: 'DUPLICATE_EXTERNAL_ID',
          });
        }
        throw error;
      }
    }
  }

  async stage(
    principal: Principal,
    input: CreateImportBatchInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.stageBatch, {
      type: 'import_batch',
      organizationId,
    });
    const now = this.clock.now();
    const snapshotTakenAt = new Date(input.snapshotTakenAt);
    if (snapshotTakenAt.getTime() > now.getTime()) {
      throw errors.validation('snapshotTakenAt cannot be in the future.', {
        path: 'snapshotTakenAt',
      });
    }
    const rows = this.stagedRows(input.rows, input.csv);
    if (rows.length > this.policy.maxRowsPerBatch) {
      throw errors.validation(`A batch holds at most ${this.policy.maxRowsPerBatch} rows.`);
    }
    if (input.rowCount !== undefined && rows.length > input.rowCount) {
      throw errors.validation('More rows were staged than the declared row count.', {
        declared: input.rowCount,
        staged: rows.length,
      });
    }
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      await trx
        .insertInto('import_batches')
        .values({
          id,
          organization_id: organizationId,
          source_system: input.sourceSystem,
          snapshot_taken_at: snapshotTakenAt,
          received_at: now,
          transformation_version: input.transformationVersion,
          declared_checksum: input.checksum ?? null,
          declared_row_count: input.rowCount ?? null,
          checksum: null,
          extraction: json(input.extraction),
          control_totals: json(input.controlTotals),
          row_count: rows.length,
          validated_at: null,
          validated_by: null,
          reviewed_at: null,
          reviewed_by: null,
          review_reason: null,
          apply_started_at: null,
          apply_lock_operation_id: null,
          apply_lock_until: null,
          applied_operation_id: null,
          applied_at: null,
          applied_by: null,
          aborted_at: null,
          aborted_by: null,
          abort_reason: null,
          submitted_by: json(snapshotActor(principal)),
          submitted_by_person_id: principal.personId,
        })
        .execute();
      await this.insertRows(trx, { id, organization_id: organizationId }, rows, 1);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MigrationActions.stageBatch.id,
        targetType: 'import_batch',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          sourceSystem: input.sourceSystem,
          snapshotTakenAt: snapshotTakenAt.toISOString(),
          transformationVersion: input.transformationVersion,
          rowCount: rows.length,
          declaredChecksum: input.checksum ?? null,
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.batchReceived, {
        organizationId,
        aggregateType: 'import_batch',
        aggregateId: id,
        correlationId,
        payload: { batchId: id, sourceSystem: input.sourceSystem, rowCount: rows.length },
      });
      const batch = await this.load(trx, organizationId, id);
      return this.view(trx, batch as BatchRow);
    });
  }

  async append(
    principal: Principal,
    id: string,
    input: AppendImportRowsInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    const rows = this.stagedRows(input.rows, input.csv);
    return this.uow.run(async ({ trx }) => {
      const batch = await this.authorized(trx, principal, id, MigrationActions.stageBatch, true);
      if (batch.status !== 'received') {
        throw errors.invalidTransition('ImportBatch', batch.status, 'append_rows');
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== batch.revision) {
        throw errors.staleRevision(input.expectedRevision, batch.revision);
      }
      const total = batch.row_count + rows.length;
      if (total > this.policy.maxRowsPerBatch) {
        throw errors.validation(`A batch holds at most ${this.policy.maxRowsPerBatch} rows.`);
      }
      if (batch.declared_row_count !== null && total > batch.declared_row_count) {
        throw errors.validation('More rows were staged than the declared row count.', {
          declared: batch.declared_row_count,
          staged: total,
        });
      }
      await this.insertRows(trx, batch, rows, batch.row_count + 1);
      await trx
        .updateTable('import_batches')
        .set({ row_count: total, revision: batch.revision + 1 })
        .where('id', '=', batch.id)
        .where('revision', '=', batch.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: 'migration.append_rows',
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { appended: rows.length, rowCount: total },
      });
      const updated = await this.load(trx, batch.organization_id, batch.id);
      return this.view(trx, updated as BatchRow);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Validation (dry run)
  // -------------------------------------------------------------------------------------------

  async validate(
    principal: Principal,
    id: string,
    input: ValidateImportBatchInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    const loaded = await this.authorized(this.db, principal, id, MigrationActions.validateBatch);
    if (input.expectedRevision !== undefined && input.expectedRevision !== loaded.revision) {
      throw errors.staleRevision(input.expectedRevision, loaded.revision);
    }
    ImportBatchMachine.next(loaded.status, 'validate');
    if (loaded.apply_started_at) {
      throw errors.invalidTransition('ImportBatch', 'apply_started', 'validate');
    }
    const rows = await this.contexts.rowsOf(loaded);
    const checksum = batchChecksum(
      rows.map((r) => ({
        entityType: r.entity_type,
        externalId: r.external_id,
        payloadHash: r.payload_hash,
      })),
    );
    if (loaded.checksum && loaded.checksum !== checksum) {
      throw errors.internal('The staged rows no longer match the sealed checksum.');
    }
    if (loaded.declared_checksum && loaded.declared_checksum !== checksum) {
      throw errors.validation('The staged rows do not match the declared checksum.', {
        code: 'CHECKSUM_MISMATCH',
        declared: loaded.declared_checksum,
        computed: checksum,
      });
    }
    if (loaded.declared_row_count !== null && loaded.declared_row_count !== rows.length) {
      throw errors.validation('The staged rows do not match the declared row count.', {
        code: 'ROW_COUNT_MISMATCH',
        declared: loaded.declared_row_count,
        staged: rows.length,
      });
    }

    const ctx = await this.contexts.build(loaded, rows);
    const planner = new ImportPlanner(ctx);
    const plans = new Map<string, RowPlan>();
    for (const row of inDependencyOrder(rows)) {
      const plan = planner.plan(row);
      plans.set(row.id, plan);
      ImportContextBuilder.notePerson(ctx, row, plan, null, true);
    }
    const plannedCounts = countOutcomes([...plans.values()].map((p) => p.outcome));
    const totals = compareControlTotals(
      ControlTotalsSchema.parse(loaded.control_totals),
      rows.map((r) => ({ entityType: r.entity_type, payload: r.payload })),
    );

    return this.uow.run(async ({ trx }) => {
      const batch = await this.load(trx, loaded.organization_id, loaded.id, true);
      if (!batch || batch.revision !== loaded.revision) {
        throw errors.staleRevision(loaded.revision, batch?.revision ?? loaded.revision);
      }
      const keep = new Set<string>();
      let raised = 0;
      for (const row of rows) {
        const plan = plans.get(row.id) as RowPlan;
        await trx
          .updateTable('import_rows')
          .set({
            planned_outcome: plan.outcome,
            reasons: json(plan.reasons),
            revision: row.revision + 1,
          })
          .where('id', '=', row.id)
          .where('revision', '=', row.revision)
          .execute();
        if (plan.exception) {
          const opened = await this.exceptions.open(
            trx,
            batch,
            row,
            plan.exception.kind,
            plan.exception.reasons,
            'validation',
            correlationId,
          );
          keep.add(opened.id);
          if (opened.created) raised += 1;
        }
      }
      await this.exceptions.withdrawOthers(trx, batch, keep);
      const now = this.clock.now();
      const status = ImportBatchMachine.next(batch.status, 'validate');
      await trx
        .updateTable('import_batches')
        .set({
          status,
          checksum,
          planned_counts: json(plannedCounts),
          validation_summary: json({
            checksum: { declared: batch.declared_checksum, computed: checksum, matches: true },
            rowCount: { declared: batch.declared_row_count, staged: rows.length },
            controlTotals: {
              checked: totals.checked,
              balanced: totals.discrepancies.length === 0,
              discrepancies: totals.discrepancies,
            },
          }),
          validated_at: now,
          validated_by: json(snapshotActor(principal)),
          reviewed_at: null,
          reviewed_by: null,
          review_reason: null,
          revision: batch.revision + 1,
        })
        .where('id', '=', batch.id)
        .where('revision', '=', batch.revision)
        .execute();
      const counts = await this.exceptions.counts(trx, batch.organization_id, batch.id);
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: MigrationActions.validateBatch.id,
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          checksum,
          plannedCounts,
          openExceptions: counts.open,
          newExceptions: raised,
          controlTotalDiscrepancies: totals.discrepancies.length,
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.batchValidated, {
        organizationId: batch.organization_id,
        aggregateType: 'import_batch',
        aggregateId: batch.id,
        correlationId,
        payload: { batchId: batch.id, plannedCounts, openExceptions: counts.open },
      });
      if (counts.open > 0) {
        // §5.11 "import discrepancies" are owned operational issues (SPK-UX-006).
        await this.operationalExceptions.raise(trx, {
          organizationId: batch.organization_id,
          category: 'migration.import_review',
          severity: 'warning',
          title: `Import batch from ${batch.source_system} has ${counts.open} rows awaiting review`,
          affectedType: 'import_batch',
          affectedId: batch.id,
          ownerQueue: 'migration',
          dedupeKey: `migration.import_review:${batch.id}`,
          details: { batchId: batch.id, openExceptions: counts.open },
        });
      }
      const updated = await this.load(trx, batch.organization_id, batch.id);
      return this.view(trx, updated as BatchRow);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Review and abort
  // -------------------------------------------------------------------------------------------

  async review(
    principal: Principal,
    id: string,
    input: ReviewImportBatchInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.uow.run(async ({ trx }) => {
      const batch = await this.authorized(trx, principal, id, MigrationActions.reviewBatch, true);
      if (input.expectedRevision !== batch.revision) {
        throw errors.staleRevision(input.expectedRevision, batch.revision);
      }
      const status = ImportBatchMachine.next(batch.status, 'review');
      const counts = await this.exceptions.counts(trx, batch.organization_id, batch.id);
      if (counts.open > 0) {
        throw errors.resourceConflict(
          'Every import exception must be decided before the review completes.',
          {
            code: 'OPEN_EXCEPTIONS',
            open: counts.open,
          },
        );
      }
      await trx
        .updateTable('import_batches')
        .set({
          status,
          reviewed_at: this.clock.now(),
          reviewed_by: json(snapshotActor(principal)),
          review_reason: input.reason ?? null,
          revision: batch.revision + 1,
        })
        .where('id', '=', batch.id)
        .where('revision', '=', batch.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: MigrationActions.reviewBatch.id,
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { decidedExceptions: counts.decided },
      });
      await this.outbox.enqueue(trx, MigrationEvents.batchReviewed, {
        organizationId: batch.organization_id,
        aggregateType: 'import_batch',
        aggregateId: batch.id,
        correlationId,
        payload: { batchId: batch.id },
      });
      const updated = await this.load(trx, batch.organization_id, batch.id);
      return this.view(trx, updated as BatchRow);
    });
  }

  async abort(
    principal: Principal,
    id: string,
    input: AbortImportBatchInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.uow.run(async ({ trx }) => {
      const batch = await this.authorized(trx, principal, id, MigrationActions.abortBatch, true);
      if (input.expectedRevision !== batch.revision) {
        throw errors.staleRevision(input.expectedRevision, batch.revision);
      }
      if (batch.apply_started_at) {
        // §5.8: records an apply created are real; recovery hands back authority, it never
        // pretends they do not exist. The batch is resumed to completion instead.
        throw errors.invalidTransition('ImportBatch', 'apply_started', 'abort');
      }
      const status = ImportBatchMachine.next(batch.status, 'abort');
      await trx
        .updateTable('import_batches')
        .set({
          status,
          aborted_at: this.clock.now(),
          aborted_by: json(snapshotActor(principal)),
          abort_reason: input.reason,
          revision: batch.revision + 1,
        })
        .where('id', '=', batch.id)
        .where('revision', '=', batch.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: MigrationActions.abortBatch.id,
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, MigrationEvents.batchAborted, {
        organizationId: batch.organization_id,
        aggregateType: 'import_batch',
        aggregateId: batch.id,
        correlationId,
        payload: { batchId: batch.id },
      });
      const updated = await this.load(trx, batch.organization_id, batch.id);
      return this.view(trx, updated as BatchRow);
    });
  }
}
