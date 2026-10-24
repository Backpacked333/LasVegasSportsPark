import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type AdjustFeeBody,
  type ApproveFeeBody,
  type CreateFeeExportBatchBody,
  type CreateFeeSubmissionBody,
  type FeeExportBatch,
  type FeeExportLine,
  type FeeSubmission,
  type ListFeeSubmissionsQuery,
  type Page,
  type Principal,
  type RejectFeeBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import { FeeSubmissionMachine, type FeeSubmissionEvent } from '../workforce.state-machines';
import {
  computeFeeAmount,
  iso,
  organizationOf,
  toFeeExportBatch,
  toFeeSubmission,
  type AssignmentRow,
  type FeeAdjustmentRow,
  type FeeSubmissionRow,
} from '../workforce.shared';

const Cursor = z.object({ submittedAt: z.string(), id: z.string() });

/**
 * Approved hours and fees (SPK-STAFF-006): assignment, rate basis, submitted amount, approver,
 * adjustment history and export status. These records support payment administration; nothing
 * here executes payroll (§1.7, DEC-052). Rules:
 *  - the assignee submits for their own completed assignment, once (a rejected submission may be
 *    followed by a new one);
 *  - finance approves as submitted, adjusts (each change appends a `fee_adjustments` row that the
 *    database keeps immutable) or rejects; nobody approves their own fee;
 *  - an export batch records exactly what was handed over, immutably, and marks the submissions
 *    exported; a submission is exported at most once and only in its own currency.
 */
@Injectable()
export class FeesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
  ) {}

  async submit(
    principal: Principal,
    body: CreateFeeSubmissionBody,
    correlationId: string | null,
  ): Promise<FeeSubmission> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const assignment = await trx
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', body.assignmentId)
        .executeTakeFirst();
      if (!assignment) throw errors.protectedNotFound('assignment');
      await this.authorization.require(principal, WorkforceActions.viewAssignments, {
        type: 'assignment',
        id: assignment.id,
        organizationId,
        facilityId: assignment.facility_id,
        subjectPersonIds: [assignment.person_id],
        protected: true,
      });
      await this.authorization.require(principal, WorkforceActions.submitFee, {
        type: 'fee_submission',
        organizationId,
        facilityId: assignment.facility_id,
        subjectPersonIds: [assignment.person_id],
      });
      if (assignment.status !== 'completed') {
        throw errors.invalidTransition('Assignment', assignment.status, 'submit_fee');
      }
      const id = newId();
      const now = this.clock.now();
      try {
        await trx
          .insertInto('fee_submissions')
          .values({
            id,
            organization_id: organizationId,
            assignment_id: assignment.id,
            person_id: assignment.person_id,
            rate_basis: json(body.rateBasis),
            computed_amount_minor: computeFeeAmount(body.rateBasis),
            submitted_amount_minor: body.submittedAmountMinor,
            currency: body.currency,
            note: body.note ?? null,
            submitted_by: json(snapshotActor(principal)),
            submitted_at: now,
            approved_amount_minor: null,
            approver: null,
            approver_person_id: null,
            approved_at: null,
            rejected_at: null,
            rejection_reason: null,
            export_batch_id: null,
            exported_at: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A fee submission already exists for this assignment.', {
            conflicts: [{ code: 'fee_already_submitted', assignmentId: assignment.id }],
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: WorkforceActions.submitFee.id,
        targetType: 'fee_submission',
        targetId: id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          assignmentId: assignment.id,
          submittedAmountMinor: body.submittedAmountMinor,
          computedAmountMinor: computeFeeAmount(body.rateBasis),
          currency: body.currency,
          rateBasis: body.rateBasis.kind,
        },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.feeSubmitted, {
        organizationId,
        aggregateType: 'fee_submission',
        aggregateId: id,
        correlationId,
        payload: {
          feeSubmissionId: id,
          assignmentId: assignment.id,
          personId: assignment.person_id,
          submittedAmountMinor: body.submittedAmountMinor,
          currency: body.currency,
        },
      });
      return this.view(trx, organizationId, id);
    });
  }

  approve(
    principal: Principal,
    id: string,
    body: ApproveFeeBody,
    correlationId: string | null,
  ): Promise<FeeSubmission> {
    return this.decide(principal, id, 'approve', body, null, correlationId);
  }

  adjust(
    principal: Principal,
    id: string,
    body: AdjustFeeBody,
    correlationId: string | null,
  ): Promise<FeeSubmission> {
    return this.decide(principal, id, 'adjust', body, body.amountMinor, correlationId);
  }

  reject(
    principal: Principal,
    id: string,
    body: RejectFeeBody,
    correlationId: string | null,
  ): Promise<FeeSubmission> {
    return this.decide(principal, id, 'reject', body, null, correlationId);
  }

  async get(principal: Principal, id: string): Promise<FeeSubmission> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('fee_submission');
    await this.authorization.require(principal, WorkforceActions.readFees, {
      type: 'fee_submission',
      id,
      organizationId,
      subjectPersonIds: [row.person_id],
      protected: true,
    });
    return this.view(this.db, organizationId, id);
  }

  async list(principal: Principal, query: ListFeeSubmissionsQuery): Promise<Page<FeeSubmission>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, WorkforceActions.readFees, {
      type: 'fee_submission',
      organizationId,
      subjectPersonIds: query.personId ? [query.personId] : [],
      protected: query.personId !== undefined,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('fee_submissions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('submitted_at')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.currency) q = q.where('currency', '=', query.currency);
    if (query.personId) q = q.where('person_id', '=', query.personId);
    if (cursor) {
      q = q.where(
        sql<boolean>`(submitted_at, id) > (${new Date(cursor.submittedAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, query.limit);
    const adjustments = await this.adjustmentsOf(
      this.db,
      organizationId,
      page.map((r) => r.id),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toFeeSubmission(r, adjustments)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ submittedAt: iso(last.submitted_at), id: last.id })
          : null,
    };
  }

  /** Fee records of one person's assignments (the workspace's "approved hours or fees"). */
  async forAssignments(
    db: Db | Trx,
    organizationId: string,
    assignmentIds: string[],
  ): Promise<Map<string, FeeSubmission>> {
    const out = new Map<string, FeeSubmission>();
    if (assignmentIds.length === 0) return out;
    const rows = await db
      .selectFrom('fee_submissions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('assignment_id', 'in', assignmentIds)
      .orderBy('submitted_at')
      .execute();
    const adjustments = await this.adjustmentsOf(
      db,
      organizationId,
      rows.map((r) => r.id),
    );
    // The live submission wins over earlier rejected ones.
    for (const row of rows) {
      const current = out.get(row.assignment_id);
      if (!current || current.status === 'rejected') {
        out.set(row.assignment_id, toFeeSubmission(row, adjustments));
      }
    }
    return out;
  }

  async export(
    principal: Principal,
    body: CreateFeeExportBatchBody,
    correlationId: string | null,
  ): Promise<FeeExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, WorkforceActions.exportFees, {
      type: 'fee_export_batch',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      let q = trx
        .selectFrom('fee_submissions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('currency', '=', body.currency)
        .where('status', 'in', ['approved', 'adjusted'])
        .orderBy('submitted_at')
        .orderBy('id')
        .forUpdate();
      if (body.submissionIds) q = q.where('id', 'in', body.submissionIds);
      const rows = await q.execute();
      if (body.submissionIds) {
        const found = new Set(rows.map((r) => r.id));
        const ineligible = body.submissionIds.filter((sid) => !found.has(sid));
        if (ineligible.length > 0) {
          throw errors.validation(
            `Only approved or adjusted ${body.currency} submissions that are not yet exported can be exported.`,
            { ineligibleSubmissionIds: ineligible },
          );
        }
      }
      if (rows.length === 0) {
        throw errors.validation(`No approved ${body.currency} fee submissions await export.`);
      }
      const assignments = await trx
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where(
          'id',
          'in',
          rows.map((r) => r.assignment_id),
        )
        .execute();
      const byId = new Map<string, AssignmentRow>(assignments.map((a) => [a.id, a]));
      const lines: FeeExportLine[] = rows.map((r) => {
        const a = byId.get(r.assignment_id) as AssignmentRow;
        return {
          feeSubmissionId: r.id,
          assignmentId: r.assignment_id,
          personId: r.person_id,
          role: a.role,
          targetType: a.target_type,
          targetId: a.target_id,
          scheduledStart: iso(a.scheduled_start),
          amountMinor: r.approved_amount_minor as number,
          currency: r.currency,
        };
      });
      const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
      if (!Number.isSafeInteger(total)) throw errors.validation('The batch total is too large.');
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'workforce.export_fees',
        requestedBy: principal,
        correlationId,
        input: { currency: body.currency, submissionIds: rows.map((r) => r.id) },
        status: 'running',
      });
      const batchId = newId();
      const now = this.clock.now();
      await trx
        .insertInto('fee_export_batches')
        .values({
          id: batchId,
          organization_id: organizationId,
          currency: body.currency,
          submission_count: rows.length,
          total_minor: total,
          lines: json(lines),
          note: body.note ?? null,
          created_by: json(snapshotActor(principal)),
          created_by_person_id: principal.personId,
          operation_id: operationId,
        })
        .execute();
      for (const row of rows) {
        const next = FeeSubmissionMachine.next(row.status, 'export');
        const result = await trx
          .updateTable('fee_submissions')
          .set({
            status: next,
            export_batch_id: batchId,
            exported_at: now,
            revision: row.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', row.id)
          .where('revision', '=', row.revision)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) {
          throw errors.staleRevision(row.revision, row.revision + 1);
        }
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: WorkforceActions.exportFees.id,
        targetType: 'fee_export_batch',
        targetId: batchId,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        operationId,
        details: { currency: body.currency, submissionCount: rows.length, totalMinor: total },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.feesExported, {
        organizationId,
        aggregateType: 'fee_export_batch',
        aggregateId: batchId,
        correlationId,
        operationId,
        payload: {
          batchId,
          currency: body.currency,
          submissionIds: rows.map((r) => r.id),
          totalMinor: total,
        },
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { batchId, submissionCount: rows.length, totalMinor: total },
      });
      const batch = await trx
        .selectFrom('fee_export_batches')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', batchId)
        .executeTakeFirstOrThrow();
      return toFeeExportBatch(batch);
    });
  }

  async getBatch(principal: Principal, id: string): Promise<FeeExportBatch> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, WorkforceActions.exportFees, {
      type: 'fee_export_batch',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('fee_export_batches')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('fee_export_batch', id);
    return toFeeExportBatch(row);
  }

  private async decide(
    principal: Principal,
    id: string,
    event: Exclude<FeeSubmissionEvent, 'export'>,
    body: { expectedRevision?: number; reason?: string },
    amountMinor: number | null,
    correlationId: string | null,
  ): Promise<FeeSubmission> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.protectedNotFound('fee_submission');
      await this.authorization.require(principal, WorkforceActions.readFees, {
        type: 'fee_submission',
        id,
        organizationId,
        subjectPersonIds: [current.person_id],
        protected: true,
      });
      await this.authorization.require(principal, WorkforceActions.approveFee, {
        type: 'fee_submission',
        id,
        organizationId,
      });
      if (current.person_id === principal.personId) {
        throw errors.accessDenied('Nobody approves, adjusts or rejects their own fee.');
      }
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = FeeSubmissionMachine.next(current.status, event);
      const now = this.clock.now();
      const actor = json(snapshotActor(principal));
      let sequence: number | null = null;
      let approvedAmount = current.approved_amount_minor;
      if (event === 'approve') approvedAmount = current.submitted_amount_minor;
      if (event === 'adjust') {
        const previous = current.approved_amount_minor ?? current.submitted_amount_minor;
        const last = await trx
          .selectFrom('fee_adjustments')
          .select((eb) => eb.fn.max('sequence').as('max'))
          .where('organization_id', '=', organizationId)
          .where('fee_submission_id', '=', id)
          .executeTakeFirst();
        sequence = Number(last?.max ?? 0) + 1;
        await trx
          .insertInto('fee_adjustments')
          .values({
            id: newId(),
            organization_id: organizationId,
            fee_submission_id: id,
            sequence,
            previous_amount_minor: previous,
            adjusted_amount_minor: amountMinor as number,
            currency: current.currency,
            reason: body.reason as string,
            adjusted_by: actor,
            adjusted_by_person_id: principal.personId,
            adjusted_at: now,
          })
          .execute();
        approvedAmount = amountMinor;
      }
      const approving = event === 'approve' || event === 'adjust';
      await trx
        .updateTable('fee_submissions')
        .set({
          status: next,
          approved_amount_minor: approving ? approvedAmount : current.approved_amount_minor,
          approver: approving ? actor : undefined,
          approver_person_id: approving ? principal.personId : undefined,
          approved_at: approving ? now : undefined,
          rejected_at: event === 'reject' ? now : undefined,
          rejection_reason: event === 'reject' ? (body.reason ?? null) : undefined,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `workforce.fee_${next}`,
        targetType: 'fee_submission',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          event,
          approvedAmountMinor: approving ? approvedAmount : null,
          adjustmentSequence: sequence,
          currency: current.currency,
        },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.feeDecided, {
        organizationId,
        aggregateType: 'fee_submission',
        aggregateId: id,
        correlationId,
        payload: {
          feeSubmissionId: id,
          assignmentId: current.assignment_id,
          status: next,
          approvedAmountMinor: approving ? approvedAmount : null,
          currency: current.currency,
          adjustmentSequence: sequence,
        },
      });
      return this.view(trx, organizationId, id);
    });
  }

  private async view(db: Db | Trx, organizationId: string, id: string): Promise<FeeSubmission> {
    const row = (await this.load(db, organizationId, id)) as FeeSubmissionRow;
    const adjustments = await this.adjustmentsOf(db, organizationId, [id]);
    return toFeeSubmission(row, adjustments);
  }

  private async adjustmentsOf(
    db: Db | Trx,
    organizationId: string,
    ids: string[],
  ): Promise<FeeAdjustmentRow[]> {
    if (ids.length === 0) return [];
    return db
      .selectFrom('fee_adjustments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fee_submission_id', 'in', ids)
      .orderBy('sequence')
      .execute();
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<FeeSubmissionRow | undefined> {
    let q = db
      .selectFrom('fee_submissions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
}
