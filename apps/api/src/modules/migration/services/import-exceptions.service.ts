import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  RelationshipEvidenceImportPayloadSchema,
  type DecideImportExceptionInput,
  type ImportException,
  type ImportExceptionKindValue,
  type ImportReason,
  type ListImportExceptionsQuery,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MigrationActions } from '../migration.actions';
import { MigrationEvents } from '../migration.events';
import { ImportExceptionMachine } from '../migration.machines';
import { MIGRATION_POLICY, type MigrationPolicy } from '../migration.policy';
import {
  afterKeyset,
  createdAtText,
  keysetPage,
  organizationOf,
  readKeysetCursor,
  toImportException,
  type BatchRow,
  type ExceptionRow,
  type RowRow,
} from '../migration.shared';

const AMBIGUOUS: readonly ImportExceptionKindValue[] = [
  'ambiguous_relationship',
  'ambiguous_balance',
];

/**
 * Import review queues (§5.4 "ambiguous relationships and balances enter review queues"; "each
 * batch must retain ... validation errors, review decisions"). Each exception is owned by the
 * queue of its kind (relationships: support; balances: finance; conflicts and validation errors:
 * the system administrator) and may also be decided by the general manager. A decision is final
 * and carries a reason. Only ambiguity can be accepted, and an accepted resolution can only
 * narrow what was staged (fewer permissions) or state the amount finance approved — it never
 * widens authority (SPK-IAM-007 "without importing unverified permissions").
 */
@Injectable()
export class ImportExceptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MIGRATION_POLICY) private readonly policy: MigrationPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  /** Opens (or refreshes the reasons of) the exception of this kind for the row. */
  async open(
    trx: Trx,
    batch: BatchRow,
    row: RowRow,
    kind: ImportExceptionKindValue,
    reasons: ImportReason[],
    phase: 'validation' | 'apply',
    correlationId: string | null,
  ): Promise<{ id: string; created: boolean }> {
    const id = newId();
    const inserted = await trx
      .insertInto('import_exceptions')
      .values({
        id,
        organization_id: batch.organization_id,
        batch_id: batch.id,
        row_id: row.id,
        kind,
        phase,
        reasons: json(reasons),
        review_owner_role: this.policy.exceptionOwners[kind],
        decision: null,
        resolution: null,
        decision_reason: null,
        decided_by: null,
        decided_by_person_id: null,
        decided_at: null,
        withdrawn_at: null,
      })
      .onConflict((oc) => oc.columns(['organization_id', 'row_id', 'kind']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      await this.outbox.enqueue(trx, MigrationEvents.exceptionRaised, {
        organizationId: batch.organization_id,
        aggregateType: 'import_exception',
        aggregateId: id,
        correlationId,
        payload: {
          exceptionId: id,
          batchId: batch.id,
          kind,
          reviewOwnerRole: this.policy.exceptionOwners[kind],
        },
      });
      return { id, created: true };
    }
    const existing = await trx
      .selectFrom('import_exceptions')
      .select(['id', 'status', 'revision'])
      .where('organization_id', '=', batch.organization_id)
      .where('row_id', '=', row.id)
      .where('kind', '=', kind)
      .executeTakeFirstOrThrow();
    if (existing.status === 'open') {
      await trx
        .updateTable('import_exceptions')
        .set({ reasons: json(reasons), revision: existing.revision + 1 })
        .where('id', '=', existing.id)
        .execute();
    }
    return { id: existing.id, created: false };
  }

  /** Withdraws the batch's open exceptions that re-validation no longer raises. */
  async withdrawOthers(trx: Trx, batch: BatchRow, keep: ReadonlySet<string>): Promise<number> {
    const open = await trx
      .selectFrom('import_exceptions')
      .select(['id', 'revision'])
      .where('organization_id', '=', batch.organization_id)
      .where('batch_id', '=', batch.id)
      .where('status', '=', 'open')
      .execute();
    let withdrawn = 0;
    for (const exception of open) {
      if (keep.has(exception.id)) continue;
      ImportExceptionMachine.next('open', 'withdraw');
      await trx
        .updateTable('import_exceptions')
        .set({
          status: 'withdrawn',
          withdrawn_at: this.clock.now(),
          revision: exception.revision + 1,
        })
        .where('id', '=', exception.id)
        .where('revision', '=', exception.revision)
        .execute();
      withdrawn += 1;
    }
    return withdrawn;
  }

  async counts(
    db: Db | Trx,
    organizationId: string,
    batchId: string,
  ): Promise<{ open: number; decided: number; withdrawn: number }> {
    const rows = await db
      .selectFrom('import_exceptions')
      .select(['status', db.fn.countAll<number>().as('n')])
      .where('organization_id', '=', organizationId)
      .where('batch_id', '=', batchId)
      .groupBy('status')
      .execute();
    const out = { open: 0, decided: 0, withdrawn: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  async list(
    principal: Principal,
    query: ListImportExceptionsQuery,
  ): Promise<Page<ImportException>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.readExceptions, {
      type: 'import_exception',
      organizationId,
      protected: true,
    });
    // MIG-01: keyset paging, newest first (created_at desc, id desc).
    const cursor = readKeysetCursor(query.cursor);
    let q = this.db
      .selectFrom('import_exceptions as e')
      .innerJoin('import_rows as r', (join) =>
        join.onRef('r.organization_id', '=', 'e.organization_id').onRef('r.id', '=', 'e.row_id'),
      )
      .selectAll('e')
      .select([
        'r.entity_type as row_entity_type',
        'r.external_id as row_external_id',
        'r.payload as row_payload',
      ])
      .select(createdAtText('e.created_at').as('created_at_text'))
      .where('e.organization_id', '=', organizationId)
      .orderBy('e.created_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(query.limit + 1);
    if (query.batchId) q = q.where('e.batch_id', '=', query.batchId);
    if (query.status) q = q.where('e.status', '=', query.status);
    if (query.kind) q = q.where('e.kind', '=', query.kind);
    if (query.reviewOwnerRole) q = q.where('e.review_owner_role', '=', query.reviewOwnerRole);
    if (cursor) q = q.where(afterKeyset('e.created_at', 'e.id', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return {
      items: page.rows.map((r) =>
        toImportException(r, {
          entityType: r.row_entity_type,
          externalId: r.row_external_id,
          payload: r.row_payload,
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async decide(
    principal: Principal,
    id: string,
    input: DecideImportExceptionInput,
    correlationId: string | null,
  ): Promise<ImportException> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current: ExceptionRow | undefined = await trx
        .selectFrom('import_exceptions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.protectedNotFound('import exception');
      await this.authorization.require(principal, MigrationActions.decideException, {
        type: 'import_exception',
        id,
        organizationId,
        protected: true,
      });
      const ownsQueue =
        principal.kind === 'system' ||
        principal.staffRoles.includes('general_manager') ||
        principal.staffRoles.includes(current.review_owner_role as never);
      if (!ownsQueue) {
        throw errors.accessDenied(
          `This exception belongs to the ${current.review_owner_role} review queue.`,
          { reviewOwnerRole: current.review_owner_role },
        );
      }
      if (input.expectedRevision !== current.revision) {
        throw errors.staleRevision(input.expectedRevision, current.revision);
      }
      ImportExceptionMachine.next(current.status, 'decide');
      const batch = await trx
        .selectFrom('import_batches')
        .select(['status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.batch_id)
        .executeTakeFirstOrThrow();
      if (batch.status === 'aborted') {
        throw errors.invalidTransition('ImportBatch', 'aborted', 'decide_exception');
      }
      if (input.decision === 'accept' && batch.status === 'applied') {
        // An applied batch is history: accepting now would change nothing. Re-import instead.
        throw errors.invalidTransition('ImportBatch', 'applied', 'accept_exception');
      }
      const row = await trx
        .selectFrom('import_rows')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.row_id)
        .executeTakeFirstOrThrow();
      if (input.decision === 'accept') {
        if (!AMBIGUOUS.includes(current.kind)) {
          throw errors.validation(
            'Only ambiguity can be accepted; a validation error or a conflict is rejected or deferred.',
            { kind: current.kind },
          );
        }
        this.checkResolution(current, row, input);
      }
      const now = this.clock.now();
      await trx
        .updateTable('import_exceptions')
        .set({
          status: 'decided',
          decision: input.decision,
          resolution: input.resolution ? json(input.resolution) : null,
          decision_reason: input.reason,
          decided_by: json(snapshotActor(principal)),
          decided_by_person_id: principal.personId,
          decided_at: now,
          revision: current.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MigrationActions.decideException.id,
        targetType: 'import_exception',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        details: {
          batchId: current.batch_id,
          kind: current.kind,
          decision: input.decision,
          resolution: input.resolution ?? null,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.exceptionDecided, {
        organizationId,
        aggregateType: 'import_exception',
        aggregateId: id,
        correlationId,
        payload: { exceptionId: id, batchId: current.batch_id, decision: input.decision },
      });
      const updated = await trx
        .selectFrom('import_exceptions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toImportException(updated, {
        entityType: row.entity_type,
        externalId: row.external_id,
        payload: row.payload,
      });
    });
  }

  private checkResolution(
    current: ExceptionRow,
    row: RowRow,
    input: DecideImportExceptionInput,
  ): void {
    const resolution = input.resolution;
    if (!resolution) return;
    if (resolution.permissions) {
      if (current.kind !== 'ambiguous_relationship') {
        throw errors.validation('Permissions are only resolved for an ambiguous relationship.');
      }
      const staged = RelationshipEvidenceImportPayloadSchema.safeParse(row.payload);
      const allowed = new Set(staged.success ? staged.data.permissions : []);
      const widened = resolution.permissions.filter((p) => !allowed.has(p));
      if (widened.length > 0) {
        throw errors.validation('A review can narrow the staged permissions, never add to them.', {
          permissions: widened,
        });
      }
    }
    if (resolution.amountMinor !== undefined && current.kind !== 'ambiguous_balance') {
      throw errors.validation('An amount is only resolved for an ambiguous balance.');
    }
  }
}
