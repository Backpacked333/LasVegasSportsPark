import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  systemPrincipal,
  type CaseAction,
  type CaseActionOutcome,
  type LinkCaseActionInput,
  type Principal,
  type RequestRefundInput,
  type ResendNotificationInput,
  type SettleCaseActionInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type CaseActionStatus } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuditWriter,
  CLOCK,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  actionRegistry,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions, NotificationsService } from '../../communications';
import { FinanceActions, RefundsService } from '../../finance';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { SupportActions } from '../support.actions';
import { CaseActionRecorded } from '../support.events';
import { CaseActionMachine } from '../support.machines';
import { organizationOf, toCaseAction, type CaseActionRow, type CaseRow } from '../support.shared';
import { CasesService } from './cases.service';

interface RecordActionInput {
  row: CaseRow;
  actor: Principal;
  actionId: string;
  status: CaseActionStatus;
  via: 'linked' | 'helper';
  commandOperationId?: string | null;
  auditRecordId?: string | null;
  supportOperationId?: string | null;
  record?: { type: string; id: string } | null;
  requestKey?: string | null;
  input?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown } | null;
  note?: string | null;
}

/**
 * Case actions (SPK-SUPPORT-003: "support actions use normal authorized commands; a support note
 * cannot substitute for an actual refund, permission change, or transfer"). Either the operator
 * ran the owning module's command and links its evidence (operation or audit record of their own
 * command), or a helper runs that module's exported command with the operator's own principal —
 * so the owning module's authorization, invariants and audit apply unchanged — and links the
 * outcome. Support never writes another module's records and never needs customer credentials.
 */
@Injectable()
export class CaseActionsService {
  private readonly logger = new Logger(CaseActionsService.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly cases: CasesService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly notifications: NotificationsService,
    private readonly refunds: RefundsService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  // -------------------------------------------------------------------------------------------
  // POST /cases/{id}/actions: link a command the operator ran
  // -------------------------------------------------------------------------------------------

  async link(
    principal: Principal,
    caseId: string,
    input: LinkCaseActionInput,
    correlationId: string | null,
  ): Promise<CaseActionOutcome> {
    const organizationId = organizationOf(principal);
    try {
      return await this.uow.run(async ({ trx }) => {
        const row = await this.cases.loadWorkable(
          trx,
          principal,
          organizationId,
          caseId,
          'link_action',
          SupportActions.linkAction,
        );
        const definition = actionRegistry.get(input.actionId as `${string}.${string}`);
        if (!definition) {
          throw errors.validation(`${input.actionId} is not a registered command.`, {
            code: 'UNKNOWN_ACTION',
          });
        }
        if (definition.id.startsWith('support.')) {
          throw errors.validation('Link the owning module’s command, not a support action.', {
            code: 'SUPPORT_ACTION_NOT_LINKABLE',
          });
        }
        const evidence = await this.verifyEvidence(trx, principal.accountId, organizationId, input);
        const action = await this.record(trx, {
          row,
          actor: principal,
          actionId: definition.id,
          status: 'succeeded',
          via: 'linked',
          commandOperationId: input.operationId ?? null,
          auditRecordId: evidence.auditRecordId,
          record: input.record ?? evidence.record,
          input: evidence.summary,
          note: input.note ?? null,
        });
        await this.afterRecord(trx, row, action, principal, correlationId, input.reason ?? null);
        return { case: await this.cases.detail(trx, organizationId, caseId), action };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict('This command outcome is already linked to the case.', {
          code: 'ACTION_ALREADY_LINKED',
        });
      }
      throw error;
    }
  }

  /**
   * The evidence must be the operator's own command in this organization: an audit record of the
   * named action, or an operation whose audit trail records that action. A failed or compensated
   * operation produced no outcome to link.
   */
  private async verifyEvidence(
    trx: Trx,
    expectedAccountId: string | null,
    organizationId: string,
    input: { actionId: string; operationId?: string; auditRecordId?: string },
  ): Promise<{
    auditRecordId: string | null;
    record: { type: string; id: string } | null;
    summary: Record<string, unknown>;
  }> {
    const summary: Record<string, unknown> = {};
    let auditRecordId: string | null = null;
    let record: { type: string; id: string } | null = null;
    if (input.operationId) {
      const operation = await trx
        .selectFrom('operations')
        .select(['id', 'organization_id', 'kind', 'status', 'requested_by'])
        .where('id', '=', input.operationId)
        .executeTakeFirst();
      if (!operation || operation.organization_id !== organizationId) {
        throw errors.notFound('operation', input.operationId);
      }
      const requester = operation.requested_by as { accountId?: string | null };
      if (!expectedAccountId || requester.accountId !== expectedAccountId) {
        throw errors.accessDenied('Only the operator who ran a command may link it to a case.', {
          code: 'NOT_OPERATORS_COMMAND',
        });
      }
      if (operation.status === 'failed' || operation.status === 'compensated') {
        throw errors.resourceConflict(
          `The operation ${operation.status}: there is no command outcome to link.`,
          { code: 'OPERATION_NOT_EFFECTIVE', status: operation.status },
        );
      }
      const audited = await trx
        .selectFrom('audit_records')
        .select(['id', 'target_type', 'target_id'])
        .where('organization_id', '=', organizationId)
        .where('operation_id', '=', operation.id)
        .where('action', '=', input.actionId)
        .orderBy('occurred_at')
        .executeTakeFirst();
      if (!audited) {
        throw errors.validation(
          `The operation has no audit record of ${input.actionId}; link the command it actually ran.`,
          { code: 'ACTION_NOT_IN_OPERATION' },
        );
      }
      summary['operationKind'] = operation.kind;
      summary['operationStatus'] = operation.status;
      record = { type: audited.target_type, id: audited.target_id };
    }
    if (input.auditRecordId) {
      const audited = await trx
        .selectFrom('audit_records')
        .select([
          'id',
          'organization_id',
          'action',
          'actor',
          'target_type',
          'target_id',
          'operation_id',
        ])
        .where('id', '=', input.auditRecordId)
        .executeTakeFirst();
      if (!audited || audited.organization_id !== organizationId) {
        throw errors.notFound('audit record', input.auditRecordId);
      }
      const actor = audited.actor as { accountId?: string | null };
      if (!expectedAccountId || actor.accountId !== expectedAccountId) {
        throw errors.accessDenied('Only the operator who ran a command may link it to a case.', {
          code: 'NOT_OPERATORS_COMMAND',
        });
      }
      if (audited.action !== input.actionId) {
        throw errors.validation(
          `The audit record is of ${audited.action}, not ${input.actionId}.`,
          { code: 'ACTION_MISMATCH' },
        );
      }
      if (input.operationId && audited.operation_id && audited.operation_id !== input.operationId) {
        throw errors.validation('The audit record belongs to another operation.', {
          code: 'OPERATION_MISMATCH',
        });
      }
      auditRecordId = audited.id;
      record = { type: audited.target_type, id: audited.target_id };
    }
    return { auditRecordId, record, summary };
  }

  // -------------------------------------------------------------------------------------------
  // POST /cases/{id}/resend-notification → communications (one transaction)
  // -------------------------------------------------------------------------------------------

  async resendNotification(
    principal: Principal,
    caseId: string,
    input: ResendNotificationInput,
    requestKey: string,
    correlationId: string | null,
  ): Promise<CaseActionOutcome> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.cases.loadWorkable(
        trx,
        principal,
        organizationId,
        caseId,
        'resend_notification',
        SupportActions.linkAction,
      );
      const subject = row.subject_person_id;
      if (!subject) {
        throw errors.validation('The case names no subject person to resend to.', {
          code: 'CASE_HAS_NO_SUBJECT',
        });
      }
      // Communications authorizes the read (communications.read_notification) and the resend
      // (compose + send) against the operator's principal; recipients are resolved from current
      // permissions, so a person without authority is not re-addressed (SPK-COMMS-003).
      const original = await this.notifications.deliveries(principal, input.notificationId);
      const addressed =
        original.recipients.some(
          (r) => r.personId === subject || r.subjectPersonIds.includes(subject),
        ) ||
        original.notification.audience.subjectPersonIds.includes(subject) ||
        original.notification.audience.personIds.includes(subject);
      if (!addressed) {
        throw errors.validation('The notification was not addressed to the case subject.', {
          code: 'NOT_ADDRESSED_TO_SUBJECT',
        });
      }
      const supportOperationId = await this.operations.create(trx, {
        organizationId,
        kind: 'support.resend_notification',
        requestedBy: principal,
        correlationId,
        input: { caseId, notificationId: input.notificationId },
        status: 'running',
      });
      const pending = await this.record(trx, {
        row,
        actor: principal,
        actionId: CommunicationsActions.send.id,
        status: 'requested',
        via: 'helper',
        supportOperationId,
        requestKey,
        input: { notificationId: input.notificationId },
      });
      const n = original.notification;
      const resent = await this.notifications.composeAndQueueIn(trx, principal, {
        kind: n.kind,
        category: n.category,
        facilityId: n.facilityId ?? undefined,
        subject: n.subject ?? undefined,
        audience: { subjectPersonIds: [subject] },
        title: n.title,
        body: n.body,
        detailsBefore: n.detailsBefore ?? undefined,
        detailsAfter: n.detailsAfter ?? undefined,
        protected: n.protected,
        reason: input.reason,
        correlationId,
      });
      const composedAudit = await trx
        .selectFrom('audit_records')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('target_type', '=', 'notification')
        .where('target_id', '=', resent.id)
        .where('action', '=', CommunicationsActions.compose.id)
        .executeTakeFirstOrThrow();
      const suppressed = resent.status === 'suppressed';
      const action = await this.complete(trx, organizationId, pending, {
        status: suppressed ? 'failed' : 'succeeded',
        commandOperationId: resent.operation_id,
        auditRecordId: composedAudit.id,
        record: { type: 'notification', id: resent.id },
        error: suppressed
          ? {
              code: 'NOTIFICATION_SUPPRESSED',
              message: `Communications suppressed the resend (${resent.suppression_reason ?? 'unknown'}).`,
            }
          : null,
      });
      await this.operations.transition(
        trx,
        supportOperationId,
        suppressed ? 'failed' : 'succeeded',
        {
          ...(suppressed
            ? {
                error: {
                  code: 'NOTIFICATION_SUPPRESSED',
                  message: resent.suppression_reason ?? '',
                },
              }
            : { result: { caseActionId: action.id, notificationId: resent.id } }),
        },
      );
      await this.afterRecord(trx, row, action, principal, correlationId, input.reason);
      return { case: await this.cases.detail(trx, organizationId, caseId), action };
    });
  }

  // -------------------------------------------------------------------------------------------
  // POST /cases/{id}/request-refund → finance.refund (three steps, never one transaction)
  // -------------------------------------------------------------------------------------------

  /**
   * Finance's refund command reserves funds in its own transaction and then calls the payment
   * provider outside any transaction (§4.11), so it cannot run inside support's unit of work.
   * Support records the intent first (case action `requested`, support operation `running`),
   * calls finance with the operator's principal, then records the outcome. If the outcome cannot
   * be learned (the process failed between the steps) the action stays `unknown`, an owned
   * exception asks finance to check, and a retry with the same idempotency key is refused rather
   * than requesting a second refund (§4.7 invariant 5).
   */
  async requestRefund(
    principal: Principal,
    caseId: string,
    input: RequestRefundInput,
    requestKey: string,
    correlationId: string | null,
  ): Promise<CaseActionOutcome> {
    const organizationId = organizationOf(principal);
    const intent = await this.uow.run(async ({ trx }) => {
      const row = await this.cases.loadWorkable(
        trx,
        principal,
        organizationId,
        caseId,
        'request_refund',
        SupportActions.linkAction,
      );
      const existing = await trx
        .selectFrom('case_actions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('case_id', '=', caseId)
        .where('request_key', '=', requestKey)
        .executeTakeFirst();
      if (existing) {
        if (existing.status === 'requested' || existing.status === 'unknown') {
          throw errors.refundPending({
            code: 'REFUND_OUTCOME_NOT_RECORDED',
            caseActionId: existing.id,
            message: 'This refund request has no recorded outcome; review it before retrying.',
          });
        }
        return { kind: 'replay' as const, action: toCaseAction(existing) };
      }
      const supportOperationId = await this.operations.create(trx, {
        organizationId,
        kind: 'support.request_refund',
        requestedBy: principal,
        correlationId,
        input: { caseId, paymentAttemptId: input.paymentAttemptId, amountMinor: input.amountMinor },
        status: 'running',
      });
      const pending = await this.record(trx, {
        row,
        actor: principal,
        actionId: FinanceActions.refund.id,
        status: 'requested',
        via: 'helper',
        supportOperationId,
        requestKey,
        input: { paymentAttemptId: input.paymentAttemptId, amountMinor: input.amountMinor },
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: SupportActions.linkAction.id,
        targetType: 'support_case',
        targetId: caseId,
        reason: input.reason,
        correlationId,
        operationId: supportOperationId,
        details: { helper: 'request_refund', caseActionId: pending.id, status: 'requested' },
      });
      return { kind: 'pending' as const, pending, supportOperationId };
    });
    if (intent.kind === 'replay') {
      return {
        case: await this.cases.detail(this.uowReader(), organizationId, caseId),
        action: intent.action,
      };
    }
    const { pending, supportOperationId } = intent;

    let refund: Awaited<ReturnType<RefundsService['request']>>;
    try {
      // Finance authorizes `finance.refund` for this principal and enforces the refundable
      // ceiling (§4.7 invariant 6); support adds no authority of its own.
      refund = await this.refunds.request(
        principal,
        input.paymentAttemptId,
        { amountMinor: input.amountMinor, reason: input.reason },
        correlationId,
      );
    } catch (error) {
      // A refusal is `failed` only when finance recorded no refund for this request; a refund
      // reserved before a later step failed makes the outcome `unknown`, never `failed`.
      const recorded = await this.refundAuditFor(principal, input, pending, correlationId);
      if (DomainError.is(error) && !recorded) {
        await this.settleHelper(principal, caseId, pending, supportOperationId, correlationId, {
          status: 'failed',
          error: { code: error.code, message: error.message, details: error.details },
        });
        throw error;
      }
      await this.settleHelper(principal, caseId, pending, supportOperationId, correlationId, {
        status: 'unknown',
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'The refund request did not report an outcome; finance must check the payment.',
        },
      });
      throw error;
    }
    const evidence = refund.operationId
      ? null
      : await this.refundAuditFor(principal, input, pending, correlationId);
    const action = await this.settleHelper(
      principal,
      caseId,
      pending,
      supportOperationId,
      correlationId,
      {
        status: 'succeeded',
        commandOperationId: refund.operationId,
        auditRecordId: evidence,
        record: { type: 'refund_attempt', id: refund.id },
        result: { refundId: refund.id, status: refund.status },
      },
    );
    return {
      case: await this.cases.detail(this.uowReader(), organizationId, caseId),
      action,
    };
  }

  private async settleHelper(
    principal: Principal,
    caseId: string,
    pending: CaseAction,
    supportOperationId: string,
    correlationId: string | null,
    outcome: {
      status: 'succeeded' | 'failed' | 'unknown';
      commandOperationId?: string | null;
      auditRecordId?: string | null;
      record?: { type: string; id: string } | null;
      error?: { code: string; message: string; details?: unknown } | null;
      result?: Record<string, unknown>;
    },
  ): Promise<CaseAction> {
    const organizationId = organizationOf(principal);
    try {
      return await this.uow.run(async ({ trx }) => {
        const row = await this.cases.loadForUpdate(trx, organizationId, caseId);
        if (!row) throw errors.internal('case vanished');
        const action = await this.complete(trx, organizationId, pending, {
          status: outcome.status,
          commandOperationId: outcome.commandOperationId ?? null,
          auditRecordId: outcome.auditRecordId ?? null,
          record: outcome.record ?? null,
          error: outcome.error ?? null,
        });
        await this.operations.transition(
          trx,
          supportOperationId,
          outcome.status === 'succeeded'
            ? 'succeeded'
            : outcome.status === 'failed'
              ? 'failed'
              : 'recovery_required',
          outcome.status === 'succeeded'
            ? { result: { caseActionId: action.id, ...(outcome.result ?? {}) } }
            : { error: outcome.error ?? { code: 'UNKNOWN', message: 'unknown' } },
        );
        if (outcome.status === 'unknown') {
          await this.exceptions.raise(trx, {
            organizationId,
            facilityId: row.facility_id,
            category: 'support.helper_outcome_unknown',
            severity: 'high',
            title: `A refund requested from support case "${row.title.slice(0, 80)}" has no recorded outcome`,
            affectedType: 'case_action',
            affectedId: action.id,
            ownerQueue: 'finance_operator',
            dedupeKey: unknownOutcomeKey(action.id),
            details: { caseId, caseActionId: action.id, supportOperationId },
          });
        }
        await this.afterRecord(trx, row, action, principal, correlationId, null);
        return action;
      });
    } catch (error) {
      // The outcome could not be recorded: the action stays `requested` (never assumed), the
      // support operation stays running, and a retry with the same key is refused above.
      this.logger.error(
        `could not record the outcome of case action ${pending.id}: ${String(error)}`,
      );
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // POST /cases/{id}/actions/{actionId}/settle: record the outcome of an unknown helper action
  // -------------------------------------------------------------------------------------------

  /**
   * CaseActionMachine `unknown → succeeded | failed`: a reviewer records what the owning module
   * reports. A succeeded outcome must be evidenced by the command the helper ran — its operation
   * or audit record, by the same operator — so a note can never stand in for it; the support
   * operation and the owned exception are settled with it (SPK-SUPPORT-003, §4.12).
   */
  async settleUnknown(
    principal: Principal,
    caseId: string,
    caseActionId: string,
    input: SettleCaseActionInput,
    correlationId: string | null,
  ): Promise<CaseActionOutcome> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.cases.loadWorkable(
        trx,
        principal,
        organizationId,
        caseId,
        'settle_action',
        SupportActions.linkAction,
        { allowClosed: true },
      );
      const current = await trx
        .selectFrom('case_actions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('case_id', '=', caseId)
        .where('id', '=', caseActionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('case action', caseActionId);
      if (current.status !== 'unknown') {
        throw errors.invalidTransition('CaseAction', current.status, 'settle');
      }
      let evidence: Awaited<ReturnType<CaseActionsService['verifyEvidence']>> | null = null;
      if (input.outcome === 'succeeded') {
        const helperActor = current.actor as { accountId?: string | null };
        evidence = await this.verifyEvidence(trx, helperActor.accountId ?? null, organizationId, {
          actionId: current.action_id,
          operationId: input.operationId,
          auditRecordId: input.auditRecordId,
        });
      }
      const action = await this.complete(trx, organizationId, toCaseAction(current), {
        status: input.outcome,
        commandOperationId: input.operationId ?? null,
        auditRecordId: evidence?.auditRecordId ?? null,
        record: input.record ?? evidence?.record ?? null,
        error:
          input.outcome === 'failed'
            ? { code: 'NO_EFFECT_CONFIRMED', message: input.reason }
            : null,
      });
      if (current.support_operation_id) {
        await this.operations.transition(
          trx,
          current.support_operation_id,
          input.outcome === 'succeeded' ? 'succeeded' : 'failed',
          input.outcome === 'succeeded'
            ? { result: { caseActionId: action.id, settledBy: 'review' } }
            : { error: { code: 'NO_EFFECT_CONFIRMED', message: input.reason } },
        );
      }
      const open = await trx
        .selectFrom('operational_exceptions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('dedupe_key', '=', unknownOutcomeKey(current.id))
        .where('status', 'in', ['open', 'acknowledged'])
        .executeTakeFirst();
      if (open) {
        // The exception support raised is resolved because its underlying question is answered.
        await this.exceptions.transition(
          trx,
          systemPrincipal(organizationId, 'support.case_actions'),
          open.id,
          'resolved',
          {
            reason: `Outcome recorded by review: ${input.outcome}`,
            resolution: { caseActionId: current.id, outcome: input.outcome },
            correlationId: correlationId ?? undefined,
          },
        );
      }
      await this.afterRecord(trx, row, action, principal, correlationId, input.reason);
      return { case: await this.cases.detail(trx, organizationId, caseId), action };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async record(trx: Trx, input: RecordActionInput): Promise<CaseAction> {
    const id = newId();
    const now = this.clock.now();
    const terminal = input.status !== 'requested';
    await trx
      .insertInto('case_actions')
      .values({
        id,
        organization_id: input.row.organization_id,
        case_id: input.row.id,
        action_id: input.actionId,
        via: input.via,
        status: input.status,
        command_operation_id: input.commandOperationId ?? null,
        audit_record_id: input.auditRecordId ?? null,
        support_operation_id: input.supportOperationId ?? null,
        record_type: input.record?.type ?? null,
        record_id: input.record?.id ?? null,
        request_key: input.requestKey ?? null,
        input: json(input.input ?? {}),
        error: input.error ? json(input.error) : null,
        note: input.note ?? null,
        actor: json(snapshotActor(input.actor)),
        actor_person_id: await this.knownPerson(
          trx,
          input.row.organization_id,
          input.actor.personId,
        ),
        requested_at: now,
        completed_at: terminal ? now : null,
      })
      .execute();
    return toCaseAction(await this.loadAction(trx, input.row.organization_id, id));
  }

  private async complete(
    trx: Trx,
    organizationId: string,
    pending: CaseAction,
    outcome: {
      status: 'succeeded' | 'failed' | 'unknown';
      commandOperationId?: string | null;
      auditRecordId?: string | null;
      record?: { type: string; id: string } | null;
      error?: { code: string; message: string; details?: unknown } | null;
    },
  ): Promise<CaseAction> {
    const event =
      outcome.status === 'succeeded'
        ? 'succeed'
        : outcome.status === 'failed'
          ? 'fail'
          : 'lose_outcome';
    const current = await this.loadAction(trx, organizationId, pending.id);
    const to = CaseActionMachine.next(current.status, event);
    const result = await trx
      .updateTable('case_actions')
      .set({
        status: to,
        command_operation_id: outcome.commandOperationId ?? current.command_operation_id,
        audit_record_id: outcome.auditRecordId ?? current.audit_record_id,
        record_type: outcome.record?.type ?? current.record_type,
        record_id: outcome.record?.id ?? current.record_id,
        error: outcome.error ? json(outcome.error) : null,
        completed_at: this.clock.now(),
        revision: current.revision + 1,
      })
      .where('id', '=', pending.id)
      .where('revision', '=', current.revision)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw errors.staleRevision(current.revision, current.revision + 1);
    }
    return toCaseAction(await this.loadAction(trx, current.organization_id, pending.id));
  }

  private async afterRecord(
    trx: Trx,
    row: CaseRow,
    action: CaseAction,
    principal: Principal,
    correlationId: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.cases.appendEvent(trx, row, {
      kind: 'action_link',
      caseActionId: action.id,
      details: {
        actionId: action.actionId,
        status: action.status,
        record: action.record,
        commandOperationId: action.commandOperationId,
      },
      actor: principal,
    });
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor: principal,
      action: SupportActions.linkAction.id,
      targetType: 'support_case',
      targetId: row.id,
      reason,
      correlationId,
      operationId: action.supportOperationId,
      details: {
        caseActionId: action.id,
        actionId: action.actionId,
        status: action.status,
        commandOperationId: action.commandOperationId,
        auditRecordId: action.auditRecordId,
      },
    });
    await this.outbox.enqueue(trx, CaseActionRecorded, {
      organizationId: row.organization_id,
      aggregateType: 'support_case',
      aggregateId: row.id,
      payload: {
        caseId: row.id,
        caseActionId: action.id,
        actionId: action.actionId,
        status: action.status,
        commandOperationId: action.commandOperationId,
      },
      correlationId,
      operationId: action.supportOperationId,
    });
  }

  /**
   * The audit record of the `finance.refund` this helper call ran (the kernel audit table,
   * read-only): the same operator, payment and amount, carried by this request's correlation id
   * (or, without one, recorded since the intent and not yet linked). Evidence that finance executed it.
   */
  private async refundAuditFor(
    principal: Principal,
    input: RequestRefundInput,
    pending: CaseAction,
    correlationId: string | null,
  ): Promise<string | null> {
    let q = this.uow
      .reader()
      .selectFrom('audit_records')
      .select('id')
      .where('organization_id', '=', organizationOf(principal))
      .where('action', '=', FinanceActions.refund.id)
      .where('target_type', '=', 'refund_attempt')
      .where('occurred_at', '>=', new Date(pending.requestedAt))
      .where(sql<SqlBool>`actor->>'accountId' = ${principal.accountId ?? ''}`)
      .where(sql<SqlBool>`details->>'paymentAttemptId' = ${input.paymentAttemptId}`)
      .where(sql<SqlBool>`details->>'amountMinor' = ${String(input.amountMinor)}`);
    q = correlationId
      ? q.where('correlation_id', '=', correlationId)
      : q.where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('case_actions')
                .select('case_actions.id')
                .whereRef('case_actions.audit_record_id', '=', 'audit_records.id'),
            ),
          ),
        );
    const row = await q.orderBy('occurred_at').executeTakeFirst();
    return row?.id ?? null;
  }

  private async loadAction(trx: Trx, organizationId: string, id: string): Promise<CaseActionRow> {
    const row = await trx
      .selectFrom('case_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.internal('case action vanished');
    return row;
  }

  private async knownPerson(
    trx: Trx,
    organizationId: string,
    personId: string | null,
  ): Promise<string | null> {
    if (!personId) return null;
    // §4.2: identity's person directory, never its tables.
    const person = await this.persons.findPerson(organizationId, personId, trx);
    return person?.id ?? null;
  }

  private uowReader() {
    return this.uow.reader();
  }
}

/** Dedupe key of the exception raised when a helper action's outcome is unknown. */
function unknownOutcomeKey(caseActionId: string): string {
  return `support:case_action:${caseActionId}:unknown`;
}
