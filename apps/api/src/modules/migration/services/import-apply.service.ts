import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type ApplyImportBatchInput,
  type ImportBatch,
  type ImportReason,
  type ImportRowOutcomeValue,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db, type MappedEntityType } from '@sportspark/db';
import {
  AuditWriter,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
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
  applyCorrelationId,
  countOutcomes,
  importPrincipal,
  MAPPING_COLUMN,
  reason,
  type BatchRow,
  type MappingRow,
  type RowRow,
} from '../migration.shared';
import { ImportBatchesService } from './import-batches.service';
import { ImportContextBuilder, inDependencyOrder } from './import-context';
import { ImportExceptionsService } from './import-exceptions.service';
import {
  ImportPlanner,
  rowKey,
  type CreateValues,
  type PlanningContext,
  type RowPlan,
} from './import-planner';
import { ImportTargets, type TargetContext } from './import-targets';

interface Executed {
  outcome: ImportRowOutcomeValue;
  internalId: string | null;
}

/**
 * Applies a reviewed batch (§5.4, §4.7 invariants 5 and 11, SPK-AT-024).
 *
 * - One apply per source system at a time: the batch takes an apply lock (a partial unique index
 *   per source) with a lease renewed by every row; a crashed apply is resumed by applying again
 *   after the lease, and rows that already have an outcome are not touched again.
 * - Idempotent per external id: every row is re-planned against the current mappings, so a
 *   snapshot imported twice matches everything the first import created and creates, charges and
 *   sends nothing. A creation is preceded by a reserved (`pending`) mapping whose id is the
 *   correlation id given to the owning module; a creation that committed before its mapping was
 *   linked is found again through that module's audit record instead of being created twice.
 * - Records are created only through the owning modules' public commands with the import system
 *   principal and an import reason. Obligations and credits are opening balances: no payment
 *   attempt and no customer notice exists for them (finance records the subledger facts only).
 * - The multi-step command is a durable operation (`migration.apply_batch`) readable at
 *   GET /v1/operations/{id}; a refused row becomes an apply-phase exception, never a silent drop.
 */
@Injectable()
export class ImportApplyService {
  private readonly logger = new Logger(ImportApplyService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MIGRATION_POLICY) private readonly policy: MigrationPolicy,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly batches: ImportBatchesService,
    private readonly contexts: ImportContextBuilder,
    private readonly exceptions: ImportExceptionsService,
    private readonly targets: ImportTargets,
    private readonly operationalExceptions: OperationalExceptions,
  ) {}

  async apply(
    principal: Principal,
    id: string,
    input: ApplyImportBatchInput,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    const claim = await this.claim(principal, id, input, correlationId);
    if (claim.kind === 'already_applied') return this.batches.view(this.db, claim.batch);
    try {
      await this.applyRows(claim.batch, claim.operationId, correlationId);
      return await this.finish(principal, claim.batch, claim.operationId, correlationId);
    } catch (error) {
      await this.release(claim.batch, claim.operationId, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lock
  // -------------------------------------------------------------------------------------------

  private leaseUntil(): Date {
    return new Date(this.clock.now().getTime() + this.policy.applyLeaseMinutes * 60_000);
  }

  private async claim(
    principal: Principal,
    id: string,
    input: ApplyImportBatchInput,
    correlationId: string | null,
  ): Promise<
    | { kind: 'already_applied'; batch: BatchRow }
    | { kind: 'claimed'; batch: BatchRow; operationId: string }
  > {
    return this.uow.run(async ({ trx }) => {
      const batch = await this.batches.authorized(
        trx,
        principal,
        id,
        MigrationActions.applyBatch,
        true,
      );
      // A second apply of an applied batch changes nothing (§5.4 repeatable imports).
      if (batch.status === 'applied') return { kind: 'already_applied' as const, batch };
      if (input.expectedRevision !== undefined && input.expectedRevision !== batch.revision) {
        throw errors.staleRevision(input.expectedRevision, batch.revision);
      }
      ImportBatchMachine.next(batch.status, 'apply');
      const now = this.clock.now();
      if (
        batch.apply_lock_operation_id &&
        batch.apply_lock_until &&
        new Date(batch.apply_lock_until).getTime() > now.getTime()
      ) {
        throw errors.resourceConflict('This batch is being applied.', {
          code: 'APPLY_IN_PROGRESS',
          operationId: batch.apply_lock_operation_id,
        });
      }
      const resumed = batch.apply_started_at !== null;
      const operationId = await this.operations.create(trx, {
        organizationId: batch.organization_id,
        kind: 'migration.apply_batch',
        requestedBy: principal,
        correlationId,
        input: { batchId: batch.id, resumed },
        status: 'running',
      });
      try {
        await trx
          .updateTable('import_batches')
          .set({
            apply_lock_operation_id: operationId,
            apply_lock_until: this.leaseUntil(),
            apply_started_at: batch.apply_started_at ?? now,
            revision: batch.revision + 1,
          })
          .where('id', '=', batch.id)
          .where('revision', '=', batch.revision)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('Another batch of this source system is being applied.', {
            code: 'SOURCE_APPLY_IN_PROGRESS',
            sourceSystem: batch.source_system,
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: MigrationActions.applyBatch.id,
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        operationId,
        details: { phase: resumed ? 'resumed' : 'started' },
      });
      const claimed = await this.batches.load(trx, batch.organization_id, batch.id);
      return { kind: 'claimed' as const, batch: claimed as BatchRow, operationId };
    });
  }

  private async release(batch: BatchRow, operationId: string, error: unknown): Promise<void> {
    try {
      await this.uow.run(async ({ trx }) => {
        await trx
          .updateTable('import_batches')
          .set({ apply_lock_operation_id: null, apply_lock_until: null })
          .where('id', '=', batch.id)
          .where('apply_lock_operation_id', '=', operationId)
          .where('status', '=', 'reviewed')
          .execute();
        await this.operations.transition(trx, operationId, 'failed', {
          error: {
            code: DomainError.is(error) ? error.code : 'INTERNAL_ERROR',
            message: DomainError.is(error)
              ? error.message
              : 'The apply stopped; apply again to resume it.',
          },
        });
      });
    } catch (releaseError) {
      this.logger.warn(
        `could not release apply lock of batch ${batch.id}: ${String(releaseError)}`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------------------------

  private async applyRows(batch: BatchRow, operationId: string, correlationId: string | null) {
    const rows = await this.contexts.rowsOf(batch);
    const ctx = await this.contexts.build(batch, rows);
    const planner = new ImportPlanner(ctx);
    for (const row of inDependencyOrder(rows)) {
      if (row.outcome !== null) {
        // Applied by an earlier, interrupted attempt: its outcome is a fact.
        ImportContextBuilder.notePerson(
          ctx,
          row,
          { outcome: row.outcome, reasons: [], action: { type: 'none' } },
          null,
          true,
        );
        continue;
      }
      const plan = planner.plan(row);
      const executed = await this.execute(batch, operationId, row, plan, ctx, correlationId);
      ImportContextBuilder.notePerson(
        ctx,
        row,
        { ...plan, outcome: executed.outcome },
        executed.internalId,
        executed.outcome !== 'exception' && executed.outcome !== 'skipped',
      );
    }
  }

  private async execute(
    batch: BatchRow,
    operationId: string,
    row: RowRow,
    plan: RowPlan,
    ctx: PlanningContext,
    correlationId: string | null,
  ): Promise<Executed> {
    const action = plan.action;
    if (action.type === 'none') {
      await this.uow.run(async ({ trx }) => {
        if (plan.exception) {
          await this.exceptions.open(
            trx,
            batch,
            row,
            plan.exception.kind,
            plan.exception.reasons,
            'apply',
            correlationId,
          );
        }
        await this.record(trx, batch, operationId, row, plan.outcome, plan.reasons, null);
      });
      return { outcome: plan.outcome, internalId: null };
    }
    if (action.type === 'match') {
      const mapping = ctx.mappings.get(rowKey(row.entity_type, row.external_id)) as MappingRow;
      await this.uow.run(async ({ trx }) => {
        await this.touchMapping(trx, mapping, batch, row.payload_hash);
        await this.record(trx, batch, operationId, row, 'matched', plan.reasons, mapping.id);
      });
      return { outcome: 'matched', internalId: mapping.internal_id };
    }
    try {
      return action.type === 'create'
        ? await this.create(batch, operationId, row, plan, action.values, ctx)
        : await this.update(batch, operationId, row, plan, action.values, ctx);
    } catch (error) {
      if (!DomainError.is(error) || error.httpStatus >= 500) throw error;
      // The owning module refused the record: the row becomes a reviewable exception (§5.4).
      const kind =
        error.code === 'VALIDATION_FAILED' || error.code === 'NOT_FOUND'
          ? 'validation'
          : 'conflict';
      const reasons: ImportReason[] = [
        reason('owning_module_refused', error.message, {
          code: error.code,
          details: error.details,
        }),
      ];
      await this.uow.run(async ({ trx }) => {
        await this.exceptions.open(trx, batch, row, kind, reasons, 'apply', correlationId);
        await this.record(trx, batch, operationId, row, 'exception', reasons, null);
      });
      return { outcome: 'exception', internalId: null };
    }
  }

  private targetContext(batch: BatchRow, mapping: MappingRow, row: RowRow): TargetContext {
    return {
      organizationId: batch.organization_id,
      principal: importPrincipal(batch.organization_id, batch.id),
      correlationId: applyCorrelationId(mapping.id),
      reason: `import: ${batch.source_system} batch ${batch.id}, ${row.entity_type} ${row.external_id}`,
    };
  }

  private personId(ctx: PlanningContext, externalId: string): string {
    const ref = ctx.persons.get(externalId);
    if (!ref?.internalId || !ref.resolvable) {
      throw errors.validation(`Person ${externalId} has not been imported.`, { externalId });
    }
    return ref.internalId;
  }

  private async create(
    batch: BatchRow,
    operationId: string,
    row: RowRow,
    plan: RowPlan,
    values: CreateValues,
    ctx: PlanningContext,
  ): Promise<Executed> {
    const entityType = row.entity_type as MappedEntityType;
    if (values.entityType === 'relationship_evidence') {
      const actorPersonId = this.personId(ctx, values.actorExternalId);
      const subjectPersonId = this.personId(ctx, values.subjectExternalId);
      return this.uow.run(async ({ trx }) => {
        const mapping = await this.reserveMapping(trx, batch, row);
        const tctx = this.targetContext(batch, mapping, row);
        const [actor, subject] = await Promise.all([
          this.targets.findPerson(batch.organization_id, actorPersonId, trx),
          this.targets.findPerson(batch.organization_id, subjectPersonId, trx),
        ]);
        if (!actor || actor.status !== 'active' || !subject || subject.status !== 'active') {
          throw errors.validation('Both people of a relationship must be active.');
        }
        if (actor.kind === 'child') {
          throw errors.validation('A child cannot hold authority over another person.');
        }
        const result = await this.targets.ensureRelationship(trx, tctx, {
          actorPersonId,
          subjectPersonId,
          kind: values.kind,
          permissions: values.permissions,
          effectiveFrom: values.effectiveFrom ? new Date(values.effectiveFrom) : undefined,
          effectiveTo: values.effectiveTo ? new Date(values.effectiveTo) : null,
        });
        const outcome: ImportRowOutcomeValue = result.created
          ? 'created'
          : result.grantsCreated > 0
            ? 'updated'
            : 'matched';
        const reasons = result.created
          ? plan.reasons
          : [
              ...plan.reasons,
              reason(
                'relationship_already_recorded',
                'SportsPark already recorded this relationship; only missing grants were added.',
                { grantsCreated: result.grantsCreated },
              ),
            ];
        const linked = await this.linkMapping(trx, mapping, batch, row, result.relationshipId);
        await this.record(trx, batch, operationId, row, outcome, reasons, linked.id);
        return { outcome, internalId: result.relationshipId };
      });
    }

    const mapping = await this.uow.run(({ trx }) => this.reserveMapping(trx, batch, row));
    const tctx = this.targetContext(batch, mapping, row);
    let internalId: string | null =
      mapping.status === 'linked'
        ? mapping.internal_id
        : await this.targets.recover(
            batch.organization_id,
            entityType as Exclude<MappedEntityType, 'relationship_evidence'>,
            tctx.correlationId,
          );
    const recovered = internalId !== null;
    if (!internalId) internalId = await this.createRecord(tctx, mapping, values, ctx);
    // Bring the record to every staged fact the creation itself cannot carry (a person's status,
    // household members), also after a recovered creation.
    if (values.entityType === 'person') {
      await this.targets.syncPerson(tctx, internalId, values.person);
    } else if (values.entityType === 'household') {
      await this.targets.syncHousehold(
        tctx,
        internalId,
        values.memberExternalIds.map((id) => this.personId(ctx, id)),
      );
    }
    const reasons = recovered
      ? [
          ...plan.reasons,
          reason(
            'recovered_after_interruption',
            'Created by an interrupted earlier apply; linked, not created again.',
          ),
        ]
      : plan.reasons;
    const created = internalId;
    await this.uow.run(async ({ trx }) => {
      const linked = await this.linkMapping(trx, mapping, batch, row, created);
      await this.record(trx, batch, operationId, row, 'created', reasons, linked.id);
    });
    return { outcome: 'created', internalId: created };
  }

  private async createRecord(
    tctx: TargetContext,
    mapping: MappingRow,
    values: CreateValues,
    ctx: PlanningContext,
  ): Promise<string> {
    switch (values.entityType) {
      case 'person':
        return this.targets.createPerson(tctx, values.person);
      case 'household':
        return this.targets.createHousehold(tctx, values.name);
      case 'program':
        return this.targets.createProgram(tctx, values.program);
      case 'open_obligation':
        return this.targets.createOpeningObligation(tctx, {
          mappingId: mapping.id,
          debtorPersonId: this.personId(ctx, values.debtorExternalId),
          amountMinor: values.amountMinor,
          currency: values.currency,
          dueAt: values.dueAt,
          description: values.description,
        });
      case 'credit':
        return this.targets.issueOpeningCredit(tctx, {
          ownerPersonId: this.personId(ctx, values.ownerExternalId),
          amountMinor: values.amountMinor,
          currency: values.currency,
          expiresAt: values.expiresAt,
          permittedUses: values.permittedUses,
        });
      default:
        throw errors.internal(`no creation for ${values.entityType}`);
    }
  }

  private async update(
    batch: BatchRow,
    operationId: string,
    row: RowRow,
    plan: RowPlan,
    values: CreateValues,
    ctx: PlanningContext,
  ): Promise<Executed> {
    const mapping = ctx.mappings.get(rowKey(row.entity_type, row.external_id)) as MappingRow;
    const internalId = mapping.internal_id as string;
    const tctx = this.targetContext(batch, mapping, row);
    const reasons = [...plan.reasons];
    let changed: boolean;
    switch (values.entityType) {
      case 'person':
        changed = (await this.targets.syncPerson(tctx, internalId, values.person)) === 'updated';
        break;
      case 'household': {
        const synced = await this.targets.syncHousehold(
          tctx,
          internalId,
          values.memberExternalIds.map((id) => this.personId(ctx, id)),
        );
        changed = synced.result === 'updated';
        if (synced.notInSource.length > 0) {
          reasons.push(
            reason(
              'members_not_in_source',
              'Members the source no longer lists are kept; removal is a staff decision.',
              {
                personIds: synced.notInSource,
              },
            ),
          );
        }
        if (synced.name !== values.name) {
          reasons.push(reason('name_not_updated', 'Household names are not changed by an import.'));
        }
        break;
      }
      case 'program':
        changed = (await this.targets.syncProgram(tctx, internalId, values.program)) === 'updated';
        break;
      case 'relationship_evidence': {
        const actorPersonId = this.personId(ctx, values.actorExternalId);
        const subjectPersonId = this.personId(ctx, values.subjectExternalId);
        const outcome = await this.uow.run(async ({ trx }) => {
          const result = await this.targets.ensureRelationship(trx, tctx, {
            actorPersonId,
            subjectPersonId,
            kind: values.kind,
            permissions: values.permissions,
          });
          const out: ImportRowOutcomeValue = result.grantsCreated > 0 ? 'updated' : 'matched';
          await this.touchMapping(trx, mapping, batch, row.payload_hash);
          await this.record(trx, batch, operationId, row, out, reasons, mapping.id);
          return out;
        });
        return { outcome, internalId };
      }
      default:
        throw errors.internal(`no update for ${values.entityType}`);
    }
    const outcome: ImportRowOutcomeValue = changed ? 'updated' : 'matched';
    await this.uow.run(async ({ trx }) => {
      await this.touchMapping(trx, mapping, batch, row.payload_hash);
      await this.record(trx, batch, operationId, row, outcome, reasons, mapping.id);
    });
    return { outcome, internalId };
  }

  // -------------------------------------------------------------------------------------------
  // Mappings and row outcomes
  // -------------------------------------------------------------------------------------------

  private async reserveMapping(trx: Trx, batch: BatchRow, row: RowRow): Promise<MappingRow> {
    const entityType = row.entity_type as MappedEntityType;
    const find = () =>
      trx
        .selectFrom('external_mappings')
        .selectAll()
        .where('organization_id', '=', batch.organization_id)
        .where('source_system', '=', batch.source_system)
        .where('entity_type', '=', entityType)
        .where('external_id', '=', row.external_id)
        .forUpdate()
        .executeTakeFirst();
    const existing = await find();
    if (existing) return existing;
    await trx
      .insertInto('external_mappings')
      .values({
        id: newId(),
        organization_id: batch.organization_id,
        source_system: batch.source_system,
        entity_type: entityType,
        external_id: row.external_id,
        person_id: null,
        household_id: null,
        relationship_id: null,
        program_id: null,
        obligation_id: null,
        credit_id: null,
        applied_payload_hash: null,
        first_seen_batch_id: batch.id,
        last_seen_batch_id: batch.id,
        // §5.3: extraction provenance of the record's first import.
        provenance: json({
          batchId: batch.id,
          rowSequence: row.sequence,
          snapshotTakenAt: new Date(batch.snapshot_taken_at).toISOString(),
          transformationVersion: batch.transformation_version,
          extraction: batch.extraction,
        }),
        linked_at: null,
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'source_system', 'entity_type', 'external_id']).doNothing(),
      )
      .execute();
    return (await find()) as MappingRow;
  }

  private async linkMapping(
    trx: Trx,
    mapping: MappingRow,
    batch: BatchRow,
    row: RowRow,
    internalId: string,
  ): Promise<MappingRow> {
    const column = MAPPING_COLUMN[mapping.entity_type];
    if (mapping.status === 'linked') {
      if (mapping.internal_id !== internalId) {
        throw errors.internal('The mapping is linked to a different record.');
      }
      await this.touchMapping(trx, mapping, batch, row.payload_hash);
      return mapping;
    }
    await trx
      .updateTable('external_mappings')
      .set({
        status: 'linked',
        [column]: internalId,
        linked_at: this.clock.now(),
        applied_payload_hash: row.payload_hash,
        last_seen_batch_id: batch.id,
        revision: mapping.revision + 1,
      })
      .where('id', '=', mapping.id)
      .where('revision', '=', mapping.revision)
      .execute();
    return (await trx
      .selectFrom('external_mappings')
      .selectAll()
      .where('id', '=', mapping.id)
      .executeTakeFirst()) as MappingRow;
  }

  private async touchMapping(trx: Trx, mapping: MappingRow, batch: BatchRow, payloadHash: string) {
    await trx
      .updateTable('external_mappings')
      .set((eb) => ({
        last_seen_batch_id: batch.id,
        applied_payload_hash: payloadHash,
        revision: eb('revision', '+', 1),
      }))
      .where('id', '=', mapping.id)
      .execute();
  }

  /** Records a row's final outcome and renews the apply lease (refused if the lock was lost). */
  private async record(
    trx: Trx,
    batch: BatchRow,
    operationId: string,
    row: RowRow,
    outcome: ImportRowOutcomeValue,
    reasons: ImportReason[],
    mappingId: string | null,
  ): Promise<void> {
    const lease = await trx
      .updateTable('import_batches')
      .set({ apply_lock_until: this.leaseUntil() })
      .where('id', '=', batch.id)
      .where('apply_lock_operation_id', '=', operationId)
      .executeTakeFirst();
    if (Number(lease.numUpdatedRows) === 0) {
      throw errors.resourceConflict('The apply lock was taken over; this apply stops.', {
        code: 'APPLY_LOCK_LOST',
      });
    }
    const updated = await trx
      .updateTable('import_rows')
      .set({
        outcome,
        reasons: json(reasons),
        mapping_id:
          outcome === 'created' || outcome === 'matched' || outcome === 'updated'
            ? mappingId
            : null,
        applied_at: this.clock.now(),
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('outcome', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw errors.resourceConflict('This row was already applied.', {
        code: 'ROW_ALREADY_APPLIED',
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------------------------

  private async finish(
    principal: Principal,
    claimed: BatchRow,
    operationId: string,
    correlationId: string | null,
  ): Promise<ImportBatch> {
    return this.uow.run(async ({ trx }) => {
      const batch = (await this.batches.load(
        trx,
        claimed.organization_id,
        claimed.id,
        true,
      )) as BatchRow;
      if (batch.apply_lock_operation_id !== operationId) {
        throw errors.resourceConflict('The apply lock was taken over; this apply stops.', {
          code: 'APPLY_LOCK_LOST',
        });
      }
      const outcomes = await trx
        .selectFrom('import_rows')
        .select('outcome')
        .where('organization_id', '=', batch.organization_id)
        .where('batch_id', '=', batch.id)
        .execute();
      if (outcomes.some((o) => o.outcome === null)) {
        throw errors.internal('Some rows have no outcome yet; apply again to resume.');
      }
      const counts = countOutcomes(outcomes.map((o) => o.outcome));
      const now = this.clock.now();
      const status = ImportBatchMachine.next(batch.status, 'apply');
      await trx
        .updateTable('import_batches')
        .set({
          status,
          created_count: counts.created,
          matched_count: counts.matched,
          updated_count: counts.updated,
          skipped_count: counts.skipped,
          exception_count: counts.exception,
          applied_at: now,
          applied_by: json(snapshotActor(principal)),
          applied_operation_id: operationId,
          apply_lock_operation_id: null,
          apply_lock_until: null,
          revision: batch.revision + 1,
        })
        .where('id', '=', batch.id)
        .where('revision', '=', batch.revision)
        .execute();
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { batchId: batch.id, counts },
      });
      await this.audit.record(trx, {
        organizationId: batch.organization_id,
        actor: principal,
        action: MigrationActions.applyBatch.id,
        targetType: 'import_batch',
        targetId: batch.id,
        beforeRevision: batch.revision,
        afterRevision: batch.revision + 1,
        correlationId,
        operationId,
        details: { phase: 'completed', counts },
      });
      await this.outbox.enqueue(trx, MigrationEvents.batchApplied, {
        organizationId: batch.organization_id,
        aggregateType: 'import_batch',
        aggregateId: batch.id,
        correlationId,
        operationId,
        payload: { batchId: batch.id, sourceSystem: batch.source_system, counts },
      });
      const open = await this.exceptions.counts(trx, batch.organization_id, batch.id);
      if (open.open > 0) {
        await this.operationalExceptions.raise(trx, {
          organizationId: batch.organization_id,
          category: 'migration.import_review',
          severity: 'warning',
          title: `Applied import batch from ${batch.source_system} left ${open.open} rows for review`,
          affectedType: 'import_batch',
          affectedId: batch.id,
          ownerQueue: 'migration',
          dedupeKey: `migration.import_review:${batch.id}`,
          details: { batchId: batch.id, openExceptions: open.open },
        });
      }
      const updated = await this.batches.load(trx, batch.organization_id, batch.id);
      return this.batches.view(trx, updated as BatchRow);
    });
  }
}
