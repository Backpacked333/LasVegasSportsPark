import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  RelationshipEvidenceImportPayloadSchema,
  systemPrincipal,
  type DecideImportExceptionInput,
  type ImportException,
  type ImportExceptionKindValue,
  type ImportReason,
  type ListImportExceptionsQuery,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
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
import { ImportExceptionMachine } from '../migration.machines';
import { MIGRATION_POLICY, type MigrationPolicy } from '../migration.policy';
import {
  afterKeyset,
  createdAtText,
  IMPORT_REVIEW_CARD,
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

/** Why the batch's Today card no longer has rows awaiting review (R2-LIFECYCLES-07). */
export type ReviewCardSettlement =
  'review_completed' | 'batch_aborted' | 'apply_exceptions_decided';

const SETTLEMENT_REASONS: Record<ReviewCardSettlement, string> = {
  review_completed: 'The import review completed: every exception of the batch is decided.',
  batch_aborted: 'The import batch was aborted: its open exceptions were withdrawn.',
  apply_exceptions_decided: 'Every exception the apply left on the batch is decided.',
};

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
    private readonly operationalExceptions: OperationalExceptions,
  ) {}

  /**
   * Opens (or refreshes the reasons of) the row's live exception of this kind (§5.4).
   *
   * A row has at most one live — open or decided — exception per kind (migration 1281). An open
   * one gets the new reasons; a decided one stays the authority for its kind and is returned
   * unchanged (`created: false`). A withdrawn exception is history and final (§4.6): a problem
   * that comes back after re-validation withdrew it — an authority assignment ended again, the
   * owning module refuses the row at apply — gets a fresh open exception in its owner's queue,
   * so it is counted open, holds the review back and raises its Today card
   * (R4-LIFECYCLES-REVISIONS-01, §4.7 invariant 12).
   *
   * Only validation and abort withdraw exceptions, under the batch row lock; validation holds it
   * here and an apply runs only once neither can (`apply_started_at`), so the live exception the
   * insert conflicted with is still live when it is read back.
   */
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
      // The partial unique index import_exceptions_row_kind_live_unique (its predicate a literal,
      // so PostgreSQL infers that index for a prepared statement too).
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'row_id', 'kind'])
          .where('status', '<>', sql.lit('withdrawn'))
          .doNothing(),
      )
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
      .where('status', '<>', 'withdrawn')
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
    const status = ImportExceptionMachine.next('open', 'withdraw');
    let withdrawn = 0;
    for (const exception of open) {
      if (keep.has(exception.id)) continue;
      // An exception decided meanwhile keeps its decision (`status = 'open'` re-checked). Callers
      // hold the batch lock, which decide() takes first, so this is defence in depth.
      const updated = await trx
        .updateTable('import_exceptions')
        .set({ status, withdrawn_at: this.clock.now(), revision: exception.revision + 1 })
        .where('organization_id', '=', batch.organization_id)
        .where('id', '=', exception.id)
        .where('status', '=', 'open')
        .where('revision', '=', exception.revision)
        .executeTakeFirst();
      withdrawn += Number(updated.numUpdatedRows);
    }
    return withdrawn;
  }

  /**
   * Withdraws every open exception of a batch that is being aborted (R2-LIFECYCLES-07, §4.6):
   * an aborted batch is terminal, so nothing could decide them any more and they would stay in
   * each review owner's queue for good. Runs in the abort's transaction, which holds the batch
   * lock; an exception a reviewer decided first keeps its decision.
   */
  async withdrawAllOpen(trx: Trx, batch: BatchRow): Promise<number> {
    return this.withdrawOthers(trx, batch, new Set());
  }

  /**
   * Resolves the batch's open Today card (`migration.import_review`, §5.11, SPK-UX-006) once no
   * row awaits review any more: the review completed, the batch was aborted, or the last exception
   * an apply left was decided (R2-LIFECYCLES-07). Its queue (`migration`) is not a staff role, so
   * the K-10 own-queue grant never settles it; the module does, in the caller's transaction, as
   * the system (the command that caused it is audited with its own actor and correlation id).
   * Returns how many cards it resolved (0 or 1: the card is deduplicated per batch).
   */
  async settleReviewCard(
    trx: Trx,
    organizationId: string,
    batchId: string,
    settlement: ReviewCardSettlement,
    correlationId: string | null,
  ): Promise<number> {
    const open = await this.operationalExceptions.list(
      organizationId,
      {
        category: IMPORT_REVIEW_CARD.category,
        affectedType: IMPORT_REVIEW_CARD.affectedType,
        affectedId: batchId,
        statuses: ['open', 'acknowledged'],
      },
      trx,
    );
    const system = systemPrincipal(organizationId, IMPORT_REVIEW_CARD.category);
    for (const card of open.items) {
      await this.operationalExceptions.transition(trx, system, card.id, 'resolved', {
        reason: SETTLEMENT_REASONS[settlement],
        resolution: { settlement, batchId },
        correlationId: correlationId ?? undefined,
      });
    }
    return open.items.length;
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
      const located = await trx
        .selectFrom('import_exceptions')
        .select('batch_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!located) throw errors.protectedNotFound('import exception');
      // R2-LIFECYCLES-07 (§4.6, §4.9): the batch row first, then the exception — the order
      // validation and abort take them. Decisions of one batch, its abort and its validation
      // serialize on the batch row: an abort never interleaves with a decision, and the last
      // decision on an applied batch sees every other one committed, so it settles the card.
      const batch = await trx
        .selectFrom('import_batches')
        .select(['status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', located.batch_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const current: ExceptionRow = await trx
        .selectFrom('import_exceptions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
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
      if (batch.status === 'applied') {
        // An applied batch has no review step left: the decision on the last exception its
        // apply left settles the card that announced them (R2-LIFECYCLES-07).
        const counts = await this.counts(trx, organizationId, current.batch_id);
        if (counts.open === 0) {
          await this.settleReviewCard(
            trx,
            organizationId,
            current.batch_id,
            'apply_exceptions_decided',
            correlationId,
          );
        }
      }
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
