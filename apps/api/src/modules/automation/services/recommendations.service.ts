import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type ApplyRecommendationInput,
  type ApproveRecommendationInput,
  type AssistantEvidence,
  type AssistantMissingEvidence,
  type DomainEvent,
  type EventPayload,
  type ListRecommendationsQuery,
  type Page,
  type Principal,
  type Recommendation,
  type RecommendationCommand,
  type RecommendationKindValue,
  type RejectRecommendationInput,
  type SettleRecommendationApplyInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql, type Expression, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  CapabilityService,
  DATABASE,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  actionRegistry,
  assertExpectedRevision,
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { AutomationActions } from '../automation.actions';
import {
  RecommendationApplied,
  RecommendationApplyFailed,
  RecommendationExpired,
  RecommendationExpiryDue,
  RecommendationProposed,
  RecommendationReviewed,
} from '../automation.events';
import { RecommendationMachine, type RecommendationEvent } from '../automation.machines';
import { AUTOMATION_SETTINGS, type AutomationSettings } from '../automation.settings';
import {
  DENIAL_CODES,
  assertEnabled,
  commandOf,
  organizationOf,
  requirePerson,
  toRecommendation,
  unknownApplyOf,
  type ApplySettlementRow,
  type AssistantRequestRow,
  type EvidenceAging,
  type Reader,
  type RecommendationRow,
} from '../automation.shared';
import { ToolRegistry } from '../tools/tool-registry';
import { ApplyFailure, type AppliedCommand, type ApplyContext } from '../tools/tool.types';
import { ToolRunner } from './tool-runner.service';

export interface NewRecommendation {
  kind: RecommendationKindValue;
  title: string;
  summary: string;
  facilityId: string | null;
  payload: Record<string, unknown>;
  command: RecommendationCommand | null;
  evidence: AssistantEvidence[];
  missing: AssistantMissingEvidence[];
}

/** Who owns an apply whose outcome could not be learned (the queue of the owning module's staff). */
const UNKNOWN_OUTCOME_QUEUE: Readonly<Record<RecommendationCommand['actionId'], string>> = {
  'finance.refund': 'finance_operator',
  'scheduling.publish_schedule': 'scheduler',
  'communications.send': 'general_manager',
};

const COMMAND_ACTIONS: ReadonlyArray<RecommendationCommand['actionId']> = [
  'scheduling.publish_schedule',
  'communications.send',
  'finance.refund',
];

const Cursor = z.object({ at: z.string(), id: z.uuid() });

/** The operational exception an unknown apply raises (resolved by its settlement, AUT-03). */
export const APPLY_OUTCOME_UNKNOWN_CATEGORY = 'automation.apply_outcome_unknown';

/** How an apply that did not succeed ended, and what the owning module left behind. */
interface ApplyFailureFacts {
  error: unknown;
  outcome: 'denied' | 'failed' | 'unknown';
  record: { type: string; id: string } | null;
  carried: Readonly<Record<string, unknown>> | null;
}

/** A `{ type, id }` record reference from stored apply details, if well formed. */
function recordOf(value: unknown): { type: string; id: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { type?: unknown; id?: unknown };
  return typeof v.type === 'string' && typeof v.id === 'string' ? { type: v.type, id: v.id } : null;
}

/** What the last failed apply reported for a retry to continue from (`ApplyFailure.carried`). */
function carriedOf(row: RecommendationRow): Readonly<Record<string, unknown>> | null {
  const details = (row.last_apply_error as { details?: unknown } | null)?.details;
  const carried =
    details && typeof details === 'object' ? (details as { carried?: unknown }).carried : null;
  return carried && typeof carried === 'object' && !Array.isArray(carried)
    ? (carried as Record<string, unknown>)
    : null;
}

/**
 * Reviewable recommendations (SPK-AUTO-003, SPK-AUTO-004). A recommendation is seen, approved,
 * rejected and applied by its requester, or by a person who holds the action of its command on
 * its target — nobody else learns it exists (§4.10). Applying requires an explicit approval and is
 * done by the approving reviewer: the owning module's normal command runs with the reviewer's own
 * principal, outside any automation transaction, and the module's own authorization, validation
 * and invariants decide. The assistant never approves or applies anything itself.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTOMATION_SETTINGS) private readonly settings: AutomationSettings,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly capabilities: CapabilityService,
    private readonly registry: ToolRegistry,
    private readonly runner: ToolRunner,
  ) {}

  /** SPK-AUTO-002: stored evidence is shown with its freshness at the instant it is read. */
  private aging(): EvidenceAging {
    return { now: this.clock.now(), maxAgeMinutes: this.settings.evidenceMaxAgeMinutes };
  }

  /**
   * Recommendations of one organization as the API shows them, with the settlements of their
   * unknown applies (AUT-03), read in one query.
   */
  async present(reader: Reader, rows: readonly RecommendationRow[]): Promise<Recommendation[]> {
    const first = rows[0];
    if (!first) return [];
    const settlements: ApplySettlementRow[] = await reader
      .selectFrom('recommendation_apply_settlements')
      .selectAll()
      .where('organization_id', '=', first.organization_id)
      .where(
        'recommendation_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('settled_at')
      .orderBy('id')
      .execute();
    const aging = this.aging();
    return rows.map((row) =>
      toRecommendation(
        row,
        aging,
        settlements.filter((s) => s.recommendation_id === row.id),
      ),
    );
  }

  private async presentOne(reader: Reader, row: RecommendationRow): Promise<Recommendation> {
    const [one] = await this.present(reader, [row]);
    return one as Recommendation;
  }

  // -------------------------------------------------------------------------------------------
  // Creation (from a completed assistant request, inside its transaction)
  // -------------------------------------------------------------------------------------------

  async createInTrx(
    trx: Trx,
    request: AssistantRequestRow,
    items: readonly NewRecommendation[],
    ctx: { correlationId: string | null; operationId: string },
  ): Promise<string[]> {
    const ids: string[] = [];
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.settings.recommendationTtlMinutes * 60_000);
    for (const item of items) {
      const id = newId();
      await trx
        .insertInto('recommendations')
        .values({
          id,
          organization_id: request.organization_id,
          assistant_request_id: request.id,
          facility_id: item.facilityId,
          kind: item.kind,
          title: item.title.slice(0, 200),
          summary: item.summary.slice(0, 4000),
          payload: json(item.payload),
          command_action_id: item.command?.actionId ?? null,
          command: item.command
            ? json({ input: item.command.input, target: item.command.target })
            : null,
          evidence: json(item.evidence),
          missing_evidence: json(item.missing),
          requester: json(request.requester),
          requester_account_id: request.requester_account_id,
          requester_person_id: request.requester_person_id,
          proposed_at: now,
          expires_at: expiresAt,
          reviewed_by: null,
          reviewed_by_account_id: null,
          reviewed_by_person_id: null,
          reviewed_at: null,
          review_decision: null,
          review_reason: null,
          apply_operation_id: null,
          apply_started_at: null,
          applied_by: null,
          applied_by_account_id: null,
          applied_by_person_id: null,
          applied_at: null,
          applied_audit_record_id: null,
          applied_command_operation_id: null,
          applied_record_type: null,
          applied_record_id: null,
          last_apply_error: null,
          expired_at: null,
        })
        .execute();
      await this.outbox.enqueue(trx, RecommendationProposed, {
        organizationId: request.organization_id,
        aggregateType: 'recommendation',
        aggregateId: id,
        payload: {
          recommendationId: id,
          assistantRequestId: request.id,
          kind: item.kind,
          commandActionId: item.command?.actionId ?? null,
          facilityId: item.facilityId,
          expiresAt: expiresAt.toISOString(),
        },
        correlationId: ctx.correlationId,
        operationId: ctx.operationId,
      });
      // Durable timer: an unreviewed or unapplied proposal expires (evidence ages).
      await this.outbox.enqueue(trx, RecommendationExpiryDue, {
        organizationId: request.organization_id,
        aggregateType: 'recommendation',
        aggregateId: id,
        payload: { recommendationId: id },
        correlationId: ctx.correlationId,
        operationId: ctx.operationId,
        availableAt: expiresAt,
      });
      ids.push(id);
    }
    return ids;
  }

  async rowsForRequest(
    reader: Reader,
    organizationId: string,
    requestId: string,
  ): Promise<RecommendationRow[]> {
    return reader
      .selectFrom('recommendations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('assistant_request_id', '=', requestId)
      .orderBy('proposed_at')
      .orderBy('id')
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<Recommendation> {
    assertEnabled(this.settings);
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row || !(await this.visibility(principal, row))) {
      throw errors.protectedNotFound('recommendation');
    }
    return this.presentOne(this.db, row);
  }

  /** The viewer's own recommendations and those whose command they may run on its target. */
  async list(principal: Principal, query: ListRecommendationsQuery): Promise<Page<Recommendation>> {
    assertEnabled(this.settings);
    const organizationId = organizationOf(principal);
    const reviewable = COMMAND_ACTIONS.filter((a) =>
      (actionRegistry.get(a)?.staffRoles ?? []).some((r) => principal.staffRoles.includes(r)),
    );
    const personId = principal.personId;
    if (!personId && reviewable.length === 0) return { items: [], nextCursor: null };
    const items: RecommendationRow[] = [];
    let cursor = decodeCursor(query.cursor, Cursor);
    let last: RecommendationRow | undefined;
    let exhausted = false;
    // Visibility also depends on facility scope, so rows are filtered after reading, in chunks.
    for (let chunk = 0; chunk < 10 && items.length <= query.limit && !exhausted; chunk += 1) {
      let q = this.db
        .selectFrom('recommendations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where((eb) => {
          const ors: Expression<SqlBool>[] = [];
          if (personId) ors.push(eb('requester_person_id', '=', personId));
          if (reviewable.length) ors.push(eb('command_action_id', 'in', reviewable));
          return eb.or(ors);
        })
        .orderBy('proposed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.limit + 1);
      if (query.status) q = q.where('status', '=', query.status);
      if (query.kind) q = q.where('kind', '=', query.kind);
      if (cursor) {
        q = q.where(
          sql<SqlBool>`(proposed_at, id) < (${new Date(cursor.at)}::timestamptz, ${cursor.id}::uuid)`,
        );
      }
      const rows = await q.execute();
      exhausted = rows.length <= query.limit;
      for (const row of rows) {
        last = row;
        cursor = { at: new Date(row.proposed_at).toISOString(), id: row.id };
        if (await this.visibility(principal, row)) {
          items.push(row);
          if (items.length > query.limit) break;
        }
      }
    }
    const hasMore = items.length > query.limit;
    const page = items.slice(0, query.limit);
    const tail = page.at(-1);
    return {
      items: await this.present(this.db, page),
      nextCursor:
        hasMore && tail
          ? encodeCursor({ at: new Date(tail.proposed_at).toISOString(), id: tail.id })
          : !exhausted && last
            ? encodeCursor({ at: new Date(last.proposed_at).toISOString(), id: last.id })
            : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Review (SPK-AUTO-003)
  // -------------------------------------------------------------------------------------------

  approve(
    principal: Principal,
    id: string,
    body: ApproveRecommendationInput,
    correlationId: string | null,
  ): Promise<Recommendation> {
    return this.review(principal, id, 'approve', body, correlationId);
  }

  reject(
    principal: Principal,
    id: string,
    body: RejectRecommendationInput,
    correlationId: string | null,
  ): Promise<Recommendation> {
    return this.review(principal, id, 'reject', body, correlationId);
  }

  private async review(
    principal: Principal,
    id: string,
    event: Extract<RecommendationEvent, 'approve' | 'reject'>,
    body: ApproveRecommendationInput | RejectRecommendationInput,
    correlationId: string | null,
  ): Promise<Recommendation> {
    assertEnabled(this.settings);
    const person = requirePerson(principal);
    const organizationId = person.organizationId;
    const outcome = await this.uow.run(async ({ trx }) => {
      const row = await this.loadVisibleForUpdate(trx, principal, organizationId, id, 'review');
      // AUT-02 (DEC-016): approving commits the organization to a change the assistant proposed;
      // a rejection is never gated (K-12 capability rule).
      if (event === 'approve') await this.capabilities.require(organizationId, 'assistant', trx);
      assertExpectedRevision(body.expectedRevision, row.revision);
      const now = this.clock.now();
      if (this.isDue(row, now)) {
        await this.expireInTrx(trx, row, now, correlationId);
        return { expired: true as const };
      }
      const next = RecommendationMachine.next(row.status, event);
      const updated = await trx
        .updateTable('recommendations')
        .set({
          status: next,
          reviewed_by: json(snapshotActor(principal)),
          reviewed_by_account_id: person.accountId,
          reviewed_by_person_id: person.personId,
          reviewed_at: now,
          review_decision: event === 'approve' ? 'approved' : 'rejected',
          review_reason: body.reason ?? null,
          review_policy_references: json(body.policyReferences ?? []),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirst();
      ensureUpdated(updated ? 1 : 0, () =>
        errors.staleRevision(body.expectedRevision, row.revision + 1),
      );
      const result = updated as RecommendationRow;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: AutomationActions.reviewRecommendation.id,
        targetType: 'recommendation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: result.revision,
        reason: body.reason ?? null,
        correlationId,
        details: {
          decision: event === 'approve' ? 'approved' : 'rejected',
          kind: row.kind,
          commandActionId: row.command_action_id,
          reviewerIsRequester: row.requester_person_id === person.personId,
          policyReferences: body.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, RecommendationReviewed, {
        organizationId,
        aggregateType: 'recommendation',
        aggregateId: id,
        payload: {
          recommendationId: id,
          decision: event === 'approve' ? 'approved' : 'rejected',
          revision: result.revision,
        },
        correlationId,
      });
      return { expired: false as const, row: result };
    });
    if (outcome.expired) throw errors.invalidTransition('Recommendation', 'expired', event);
    return this.presentOne(this.db, outcome.row);
  }

  // -------------------------------------------------------------------------------------------
  // Apply (SPK-AUTO-003, SPK-AUTO-004): the owning module's command with the reviewer's principal
  // -------------------------------------------------------------------------------------------

  async apply(
    principal: Principal,
    id: string,
    body: ApplyRecommendationInput,
    correlationId: string | null,
  ): Promise<Recommendation> {
    assertEnabled(this.settings);
    const person = requirePerson(principal);
    const organizationId = person.organizationId;
    const startedAt = this.clock.now();

    // 1. Claim the approved recommendation (one apply at a time, §4.7 invariant 5).
    const claim = await this.uow.run(async ({ trx }) => {
      const row = await this.loadVisibleForUpdate(trx, principal, organizationId, id, 'apply');
      // AUT-02 (DEC-016): applying runs a change the assistant proposed, a new commitment.
      await this.capabilities.require(organizationId, 'assistant', trx);
      const command = commandOf(row);
      if (!command) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'This recommendation is informational: there is no command to apply.',
          {
            details: {
              machine: 'Recommendation',
              from: row.status,
              event: 'apply',
              kind: row.kind,
            },
          },
        );
      }
      assertExpectedRevision(body.expectedRevision, row.revision);
      if (this.isDue(row, startedAt)) {
        await this.expireInTrx(trx, row, startedAt, correlationId);
        return { expired: true as const };
      }
      RecommendationMachine.next(row.status, 'apply');
      if (row.reviewed_by_account_id !== person.accountId) {
        throw errors.accessDenied(
          'Only the reviewer who approved this recommendation can apply it.',
          {
            action: AutomationActions.applyRecommendation.id,
          },
        );
      }
      if (row.apply_operation_id) {
        throw errors.resourceConflict(
          'This recommendation is being applied, or an earlier apply has no known outcome yet.',
          { code: 'APPLY_IN_PROGRESS', operationId: row.apply_operation_id },
        );
      }
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'automation.apply_recommendation',
        requestedBy: principal,
        correlationId,
        input: { recommendationId: id, commandActionId: command.actionId },
        status: 'running',
      });
      const claimed = await trx
        .updateTable('recommendations')
        .set({
          apply_operation_id: operationId,
          apply_started_at: startedAt,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirst();
      ensureUpdated(claimed ? 1 : 0, () =>
        errors.staleRevision(body.expectedRevision, row.revision + 1),
      );
      return { expired: false as const, row: claimed as RecommendationRow, command, operationId };
    });
    if (claim.expired) throw errors.invalidTransition('Recommendation', 'expired', 'apply');
    const { command, operationId } = claim;

    // 2. The owning module's command, outside any automation transaction (§4.11).
    const tool = this.registry.command(command.actionId);
    if (!tool) throw errors.internal(`no command tool for ${command.actionId}`);
    const ctx: ApplyContext = {
      correlationId,
      reason: body.reason ?? null,
      policyReferences: body.policyReferences ?? [],
      startedAt,
      carried: carriedOf(claim.row),
    };
    let applied: AppliedCommand | null = null;
    let failure: ApplyFailureFacts | null = null;
    try {
      applied = await tool.apply(principal, command.input, ctx);
    } catch (thrown) {
      // A tool may know more than the owning module's error says (ApplyFailure): the outcome, the
      // record the module made, and what a retry continues from (kept until a later report).
      const signal = thrown instanceof ApplyFailure ? thrown : null;
      const error = signal ? signal.error : thrown;
      const facts = {
        record: signal?.options.record ?? null,
        carried: signal?.options.carried ?? ctx.carried,
      };
      if (signal?.options.outcome) {
        if (signal.options.outcome === 'unknown') {
          this.logger.warn(`apply of recommendation ${id}: the command's outcome is not known`);
        }
        failure = { error, outcome: signal.options.outcome, ...facts };
      } else if (DomainError.is(error) && error.httpStatus < 500) {
        const recorded = tool.effectRecordedDespiteError
          ? await tool.effectRecordedDespiteError(principal, command.input, ctx)
          : false;
        failure = {
          error,
          outcome: recorded ? 'unknown' : DENIAL_CODES.has(error.code) ? 'denied' : 'failed',
          ...facts,
        };
      } else {
        this.logger.error(`apply of recommendation ${id} has no known outcome: ${String(error)}`);
        failure = { error, outcome: 'unknown', ...facts };
      }
    }

    // 3. Record the outcome.
    if (applied) {
      const row = await this.completeApplied(
        principal,
        claim.row,
        command,
        operationId,
        applied,
        ctx,
      );
      return this.presentOne(this.db, row);
    }
    const f = failure as NonNullable<typeof failure>;
    await this.completeFailed(principal, claim.row, command, operationId, f, ctx);
    if (f.outcome === 'unknown') {
      throw new DomainError(
        'RESOURCE_CONFLICT',
        'The outcome of applying this recommendation is not known yet; it stays claimed until the owning module’s records are reconciled.',
        {
          details: { code: 'APPLY_OUTCOME_UNKNOWN', operationId },
          nextAction: 'await_reconciliation',
        },
      );
    }
    throw f.error;
  }

  private async completeApplied(
    principal: Principal,
    claimed: RecommendationRow,
    command: RecommendationCommand,
    operationId: string,
    applied: AppliedCommand,
    ctx: ApplyContext,
  ): Promise<RecommendationRow> {
    const organizationId = claimed.organization_id;
    return this.uow.run(async ({ trx }) => {
      const row = await this.lockClaimed(trx, claimed, operationId);
      const now = this.clock.now();
      const auditId = await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: AutomationActions.applyRecommendation.id,
        targetType: 'recommendation',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: ctx.reason,
        correlationId: ctx.correlationId,
        operationId,
        details: {
          outcome: 'applied',
          commandActionId: command.actionId,
          commandOperationId: applied.commandOperationId,
          record: applied.record,
          policyReferences: ctx.policyReferences,
        },
      });
      const updated = await trx
        .updateTable('recommendations')
        .set({
          status: RecommendationMachine.next(row.status, 'apply'),
          applied_by: json(snapshotActor(principal)),
          applied_by_account_id: principal.accountId,
          applied_by_person_id: principal.personId,
          applied_at: now,
          applied_audit_record_id: auditId,
          applied_command_operation_id: applied.commandOperationId,
          applied_record_type: applied.record.type,
          applied_record_id: applied.record.id,
          last_apply_error: null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          recommendationId: row.id,
          commandActionId: command.actionId,
          commandOperationId: applied.commandOperationId,
          record: applied.record,
          ...applied.result,
        },
      });
      await this.runner.recordApply(trx, {
        organizationId,
        assistantRequestId: row.assistant_request_id,
        recommendationId: row.id,
        tool: command.actionId,
        actionId: command.actionId,
        reviewer: principal,
        arguments: command.input,
        outcome: 'succeeded',
        errorCode: null,
        errorMessage: null,
        resultRefs: [applied.record],
        correlationId: ctx.correlationId,
        operationId,
      });
      await this.outbox.enqueue(trx, RecommendationApplied, {
        organizationId,
        aggregateType: 'recommendation',
        aggregateId: row.id,
        payload: {
          recommendationId: row.id,
          commandActionId: command.actionId,
          commandOperationId: applied.commandOperationId,
          record: applied.record,
        },
        correlationId: ctx.correlationId,
        operationId,
      });
      return updated;
    });
  }

  private async completeFailed(
    principal: Principal,
    claimed: RecommendationRow,
    command: RecommendationCommand,
    operationId: string,
    failure: ApplyFailureFacts,
    ctx: ApplyContext,
  ): Promise<void> {
    const organizationId = claimed.organization_id;
    const domain = DomainError.is(failure.error) ? failure.error : null;
    const code =
      failure.outcome === 'unknown' ? 'APPLY_OUTCOME_UNKNOWN' : (domain?.code ?? 'INTERNAL_ERROR');
    const message =
      failure.outcome === 'unknown'
        ? 'The owning module did not report an outcome; its records must be checked.'
        : (domain?.message ?? 'The command failed.');
    await this.uow.run(async ({ trx }) => {
      const row = await this.lockClaimed(trx, claimed, operationId);
      const lastError = {
        code,
        message,
        details: {
          operationId,
          commandErrorCode: domain?.code ?? null,
          outcome: failure.outcome,
          ...(failure.record ? { record: failure.record } : {}),
          ...(failure.carried ? { carried: failure.carried } : {}),
        },
      };
      // A refused or failed command releases the claim (nothing happened); an unknown outcome keeps
      // it, so the recommendation can never be applied twice (§4.7 invariant 5).
      await trx
        .updateTable('recommendations')
        .set({
          ...(failure.outcome === 'unknown'
            ? {}
            : { apply_operation_id: null, apply_started_at: null }),
          last_apply_error: json(lastError),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.id)
        .where('revision', '=', row.revision)
        .executeTakeFirstOrThrow();
      await this.operations.transition(
        trx,
        operationId,
        failure.outcome === 'unknown' ? 'recovery_required' : 'failed',
        { error: { code, message, details: lastError.details } },
      );
      await this.runner.recordApply(trx, {
        organizationId,
        assistantRequestId: row.assistant_request_id,
        recommendationId: row.id,
        tool: command.actionId,
        actionId: command.actionId,
        reviewer: principal,
        arguments: command.input,
        outcome: failure.outcome,
        errorCode: domain?.code ?? code,
        errorMessage: message.slice(0, 2000),
        resultRefs: failure.record ? [failure.record] : [],
        correlationId: ctx.correlationId,
        operationId,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: AutomationActions.applyRecommendation.id,
        targetType: 'recommendation',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: ctx.reason,
        correlationId: ctx.correlationId,
        operationId,
        details: {
          outcome: failure.outcome,
          commandActionId: command.actionId,
          errorCode: domain?.code ?? code,
        },
      });
      if (failure.outcome === 'unknown') {
        await this.exceptions.raise(trx, {
          organizationId,
          facilityId: row.facility_id,
          category: APPLY_OUTCOME_UNKNOWN_CATEGORY,
          severity: 'high',
          title: 'An applied recommendation has no known outcome',
          affectedType: 'recommendation',
          affectedId: row.id,
          ownerQueue: UNKNOWN_OUTCOME_QUEUE[command.actionId],
          dedupeKey: `automation.apply_outcome_unknown:${row.id}`,
          details: { operationId, commandActionId: command.actionId },
        });
      }
      await this.outbox.enqueue(trx, RecommendationApplyFailed, {
        organizationId,
        aggregateType: 'recommendation',
        aggregateId: row.id,
        payload: {
          recommendationId: row.id,
          commandActionId: command.actionId,
          errorCode: domain?.code ?? code,
          outcome: failure.outcome,
        },
        correlationId: ctx.correlationId,
        operationId,
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Settlement of an unknown apply (AUT-03; §4.11 "unknown kept explicit until reconciled")
  // -------------------------------------------------------------------------------------------

  /**
   * POST /v1/recommendations/{id}/settle-apply (`automation.settle_apply`: system administrator,
   * general manager). Only an apply whose outcome the owning module did not report (claim held,
   * operation `recovery_required`) is settled, once, from the owning module's records:
   * `applied` → the recommendation becomes applied by the approving reviewer who ran it, the
   * operation succeeds; `not_applied` → the claim is released (the recommendation may be applied
   * again or expire), the operation fails. Either way the settlement is recorded append-only with
   * its evidence, the `automation.apply_outcome_unknown` exception is resolved, and the outcome is
   * audited and announced. Never gated by the capability switch (a reconciliation ends what was
   * already done) and never re-runs the command.
   */
  async settleApply(
    principal: Principal,
    id: string,
    body: SettleRecommendationApplyInput,
    correlationId: string | null,
  ): Promise<Recommendation> {
    assertEnabled(this.settings);
    const person = requirePerson(principal);
    const organizationId = person.organizationId;
    const row = await this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('recommendation');
      const command = commandOf(row);
      const target = {
        type: 'recommendation',
        id,
        organizationId,
        facilityId: command?.target.facilityId ?? row.facility_id,
      };
      const decision = await this.authorization.decide(
        principal,
        AutomationActions.settleApply,
        target,
      );
      if (!decision.allowed) {
        // §4.10: someone who cannot see the recommendation does not learn that it exists.
        const visible = (await this.visibility(principal, row)) !== null;
        await this.authorization.require(principal, AutomationActions.settleApply, {
          ...target,
          protected: !visible,
        });
      }
      assertExpectedRevision(body.expectedRevision, row.revision);
      const unknown = unknownApplyOf(row);
      if (!command || !unknown) {
        if (command && row.status === 'approved' && row.apply_operation_id) {
          throw errors.resourceConflict(
            'This recommendation is being applied; its outcome is not reported as unknown.',
            { code: 'APPLY_IN_PROGRESS', operationId: row.apply_operation_id },
          );
        }
        throw new DomainError(
          'INVALID_TRANSITION',
          'Only an apply whose outcome is unknown can be settled.',
          {
            details: {
              machine: 'Recommendation',
              from: row.status,
              event: 'settle_apply',
              code: 'APPLY_OUTCOME_NOT_UNKNOWN',
            },
          },
        );
      }
      const operationId = unknown.operationId;
      const now = this.clock.now();
      const settlementId = newId();
      const applied = body.outcome === 'applied';
      const record = recordOf(unknown.details['record']);
      const auditId = await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: AutomationActions.settleApply.id,
        targetType: 'recommendation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: body.reason,
        correlationId,
        operationId,
        details: {
          settlementId,
          outcome: body.outcome,
          commandActionId: command.actionId,
          applyOperationId: operationId,
          record,
          policyReferences: body.policyReferences ?? [],
        },
      });
      // The fact first: the database accepts it only for the claim whose outcome is unknown, and
      // accepts the recommendation's change below only with it (migration 1401).
      await trx
        .insertInto('recommendation_apply_settlements')
        .values({
          id: settlementId,
          organization_id: organizationId,
          recommendation_id: id,
          apply_operation_id: operationId,
          outcome: body.outcome,
          evidence: body.evidence,
          reason: body.reason,
          policy_references: json(body.policyReferences ?? []),
          settled_by: json(snapshotActor(principal)),
          settled_by_account_id: person.accountId,
          settled_by_person_id: person.personId,
          settled_at: now,
          audit_record_id: auditId,
          correlation_id: correlationId,
        })
        .execute();
      let updated: RecommendationRow;
      if (applied) {
        // SPK-AUTO-003: applied by the approving reviewer whose principal ran the command (the
        // apply's tool log names it); the settler is recorded on the settlement.
        const ran = await this.applyPrincipalOf(trx, row, operationId);
        updated = await trx
          .updateTable('recommendations')
          .set({
            status: RecommendationMachine.next(row.status, 'apply'),
            applied_by: json(ran.snapshot),
            applied_by_account_id: ran.accountId,
            applied_by_person_id: ran.personId,
            applied_at: now,
            applied_audit_record_id: auditId,
            applied_command_operation_id: null,
            applied_record_type: record?.type ?? null,
            applied_record_id: record?.id ?? null,
            last_apply_error: null,
            revision: row.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', row.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        const carried = carriedOf(row);
        updated = await trx
          .updateTable('recommendations')
          .set({
            apply_operation_id: null,
            apply_started_at: null,
            last_apply_error: json({
              code: 'APPLY_SETTLED_NOT_APPLIED',
              message:
                'Reconciled: the command did not take effect. The recommendation may be applied again.',
              details: {
                operationId,
                outcome: 'not_applied',
                settlementId,
                commandErrorCode: unknown.details['commandErrorCode'] ?? null,
                ...(record ? { record } : {}),
                ...(carried ? { carried } : {}),
              },
            }),
            revision: row.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', row.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
        // The expiry timer fired while the claim was held and did nothing: re-arm it, so a
        // released proposal past its expiry expires now and a current one at its instant.
        await this.outbox.enqueue(trx, RecommendationExpiryDue, {
          organizationId,
          aggregateType: 'recommendation',
          aggregateId: id,
          payload: { recommendationId: id },
          correlationId,
          operationId,
          availableAt: new Date(Math.max(now.getTime(), new Date(row.expires_at).getTime())),
        });
      }
      await this.operations.transition(
        trx,
        operationId,
        applied ? 'succeeded' : 'failed',
        applied
          ? {
              result: {
                recommendationId: id,
                commandActionId: command.actionId,
                settlementId,
                outcome: 'applied',
                record,
              },
            }
          : {
              error: {
                code: 'APPLY_SETTLED_NOT_APPLIED',
                message: 'Reconciled: the command did not take effect.',
                details: { recommendationId: id, settlementId },
              },
            },
      );
      const open = await this.exceptions.list(
        organizationId,
        {
          category: APPLY_OUTCOME_UNKNOWN_CATEGORY,
          affectedType: 'recommendation',
          affectedId: id,
          statuses: ['open', 'acknowledged'],
        },
        trx,
      );
      for (const exception of open.items) {
        await this.exceptions.transition(trx, principal, exception.id, 'resolved', {
          reason: body.reason,
          resolution: { settlementId, outcome: body.outcome, recommendationId: id },
          correlationId: correlationId ?? undefined,
        });
      }
      if (applied) {
        await this.outbox.enqueue(trx, RecommendationApplied, {
          organizationId,
          aggregateType: 'recommendation',
          aggregateId: id,
          payload: {
            recommendationId: id,
            commandActionId: command.actionId,
            commandOperationId: null,
            record,
            settlementId,
          },
          correlationId,
          operationId,
        });
      } else {
        await this.outbox.enqueue(trx, RecommendationApplyFailed, {
          organizationId,
          aggregateType: 'recommendation',
          aggregateId: id,
          payload: {
            recommendationId: id,
            commandActionId: command.actionId,
            errorCode: 'APPLY_SETTLED_NOT_APPLIED',
            outcome: 'failed',
            settlementId,
          },
          correlationId,
          operationId,
        });
      }
      return updated;
    });
    return this.presentOne(this.db, row);
  }

  /** The principal an apply ran under: its apply-phase tool log entry, else the approving reviewer. */
  private async applyPrincipalOf(
    trx: Trx,
    row: RecommendationRow,
    operationId: string,
  ): Promise<{ snapshot: Record<string, unknown>; accountId: string; personId: string | null }> {
    const invocation = await trx
      .selectFrom('tool_invocations')
      .select(['principal', 'principal_account_id', 'principal_person_id'])
      .where('organization_id', '=', row.organization_id)
      .where('recommendation_id', '=', row.id)
      .where('phase', '=', 'apply')
      .where('operation_id', '=', operationId)
      .orderBy('sequence', 'desc')
      .executeTakeFirst();
    if (invocation && invocation.principal_account_id === row.reviewed_by_account_id) {
      return {
        snapshot: invocation.principal as Record<string, unknown>,
        accountId: invocation.principal_account_id,
        personId: invocation.principal_person_id,
      };
    }
    return {
      snapshot: (row.reviewed_by ?? {}) as Record<string, unknown>,
      accountId: row.reviewed_by_account_id as string,
      personId: row.reviewed_by_person_id,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------------------------

  /** Outbox handler `automation.expire_recommendation`: idempotent under replay. */
  async onExpiryDue(
    trx: Trx,
    event: DomainEvent<EventPayload<typeof RecommendationExpiryDue>>,
  ): Promise<void> {
    const row = await this.load(trx, event.organizationId, event.payload.recommendationId, true);
    const now = this.clock.now();
    if (row && this.isDue(row, now)) {
      await this.expireInTrx(trx, row, now, event.correlationId);
    }
  }

  private isDue(row: RecommendationRow, now: Date): boolean {
    return (
      (row.status === 'proposed' || row.status === 'approved') &&
      row.apply_operation_id === null &&
      new Date(row.expires_at).getTime() <= now.getTime()
    );
  }

  private async expireInTrx(
    trx: Trx,
    row: RecommendationRow,
    now: Date,
    correlationId: string | null,
  ): Promise<void> {
    const status = RecommendationMachine.next(row.status, 'expire');
    await trx
      .updateTable('recommendations')
      .set({ status, expired_at: now, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirstOrThrow();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: systemPrincipal(row.organization_id, 'automation.expiry'),
      action: 'automation.recommendation_expired',
      targetType: 'recommendation',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: { from: row.status, expiresAt: new Date(row.expires_at).toISOString() },
    });
    await this.outbox.enqueue(trx, RecommendationExpired, {
      organizationId: row.organization_id,
      aggregateType: 'recommendation',
      aggregateId: row.id,
      payload: { recommendationId: row.id, expiredAt: now.toISOString() },
      correlationId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async load(
    reader: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<RecommendationRow | undefined> {
    let q = reader
      .selectFrom('recommendations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /**
   * Requester: the self-only automation action. Anyone else: the action of the command on its
   * stored target (facility scope included). Neither: the recommendation does not exist for them.
   */
  private async visibility(
    principal: Principal,
    row: RecommendationRow,
  ): Promise<'requester' | 'reviewer' | null> {
    if (principal.organizationId !== row.organization_id) return null;
    const asRequester = await this.authorization.decide(principal, AutomationActions.readRequest, {
      type: 'recommendation',
      id: row.id,
      organizationId: row.organization_id,
      subjectPersonIds: [row.requester_person_id],
      protected: true,
    });
    if (asRequester.allowed) return 'requester';
    const command = commandOf(row);
    if (!command) return null;
    const asReviewer = await this.authorization.decide(principal, command.actionId, {
      type: command.target.type,
      id: command.target.id,
      organizationId: row.organization_id,
      facilityId: command.target.facilityId,
    });
    return asReviewer.allowed ? 'reviewer' : null;
  }

  private async loadVisibleForUpdate(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    id: string,
    purpose: 'review' | 'apply',
  ): Promise<RecommendationRow> {
    const row = await this.load(trx, organizationId, id, true);
    const visibility = row ? await this.visibility(principal, row) : null;
    if (!row || !visibility) throw errors.protectedNotFound('recommendation');
    const action =
      purpose === 'review'
        ? AutomationActions.reviewRecommendation
        : AutomationActions.applyRecommendation;
    if (visibility === 'requester') {
      await this.authorization.require(principal, action, {
        type: 'recommendation',
        id,
        organizationId,
        subjectPersonIds: [row.requester_person_id],
        protected: true,
      });
    } else {
      const command = commandOf(row) as RecommendationCommand;
      await this.authorization.require(principal, command.actionId, {
        type: command.target.type,
        id: command.target.id,
        organizationId,
        facilityId: command.target.facilityId,
      });
    }
    return row;
  }

  private async lockClaimed(
    trx: Trx,
    claimed: RecommendationRow,
    operationId: string,
  ): Promise<RecommendationRow> {
    const row = await this.load(trx, claimed.organization_id, claimed.id, true);
    if (!row || row.apply_operation_id !== operationId || row.status !== 'approved') {
      throw errors.internal('the apply claim of the recommendation was lost');
    }
    return row;
  }
}
