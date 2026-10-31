import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  systemPrincipal,
  type CaseAction,
  type CaseActionOutcome,
  type DomainEvent,
  type EventPayload,
  type LinkCaseActionInput,
  type Principal,
  type RequestRefundInput,
  type ResendNotificationInput,
  type SettleCaseActionInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type CaseActionStatus, type Db } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuditReader,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  ExceptionActions,
  OperationalExceptions,
  OperationsService,
  Outbox,
  OutboxHistory,
  UnitOfWork,
  actionRegistry,
  snapshotActor,
  type AuditRecord,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CommunicationsActions, NotificationsService } from '../../communications';
import { FinanceActions, RefundRequested, RefundsService } from '../../finance';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { SupportActions } from '../support.actions';
import { CaseActionRecorded, HelperOutcomeDue } from '../support.events';
import { CaseActionMachine } from '../support.machines';
import { SUPPORT_POLICY, type SupportPolicy } from '../support.policy';
import { organizationOf, toCaseAction, type CaseActionRow, type CaseRow } from '../support.shared';
import { AuditEvidence } from './audit-evidence';
import { CasesService } from './cases.service';
import { ExceptionQueuesService } from './exception-queues.service';

/** The queue that owns the question "what happened to this refund?" (finance, §5.11). */
const REFUND_OUTCOME_QUEUE = 'finance_operator';

/** SUP-04: the periodic job that settles helper requests left `requested`. */
export const SETTLE_STALE_CASE_ACTIONS_JOB = 'support.settle_stale_case_actions';
/** SUP-04: the exception raised once per helper request whose outcome no module reports yet. */
export const CASE_ACTION_STALE_CATEGORY = 'support.case_action_stale';
const HELPER_OUTCOME_UNKNOWN_CATEGORY = 'support.helper_outcome_unknown';
/** Keyset bound above every UUID, for the exclusive outbox-history position just before an instant. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** Finance refund states in which a refund moved no money and holds no reservation. */
const REFUND_NO_EFFECT: readonly string[] = ['failed', 'canceled'];

/** What a refund helper asked finance for, as recorded with its intent (case_actions.input). */
interface RefundRequestOf {
  organizationId: string;
  caseActionId: string;
  accountId: string | null;
  paymentAttemptId: string;
  amountMinor: string;
  requestedAt: Date;
  correlationId: string | null;
}

/** The audit record that evidences a command, as verifyEvidence found it. */
interface EvidenceAudit {
  id: string;
  targetType: string;
  targetId: string;
  operationId: string | null;
  occurredAt: Date;
  details: Record<string, unknown>;
}

/** What the kernel reports of an operation (SUP-02: read through OperationsService). */
interface OperationFacts {
  kind: string;
  status: string;
}

/** The owning module's outcome of a helper request, as support records it. */
interface OwnerOutcome {
  status: 'succeeded' | 'failed';
  commandOperationId?: string | null;
  auditRecordId?: string | null;
  record?: { type: string; id: string } | null;
  error?: { code: string; message: string; details?: unknown } | null;
}

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

  /** SUP-04: the job's keyset position across passes (in memory; restarts when exhausted). */
  private staleAfter: { requestedAt: Date; id: string } | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
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
    private readonly authorization: AuthorizationService,
    private readonly queues: ExceptionQueuesService,
    @Inject(SUPPORT_POLICY) private readonly policy: SupportPolicy,
    private readonly auditReader: AuditReader,
    private readonly auditEvidence: AuditEvidence,
    private readonly outboxHistory: OutboxHistory,
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
    // The kernel's operation read uses the root database: read it before support's transaction.
    const operation = input.operationId
      ? await this.operationFacts(organizationId, input.operationId)
      : null;
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
        const evidence = await this.verifyEvidence(
          trx,
          principal.accountId,
          organizationId,
          input,
          operation,
        );
        if (definition.id === FinanceActions.refund.id && evidence.audit) {
          await this.assertNotAnOutstandingHelpersRefund(trx, organizationId, evidence.audit);
        }
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
   * operation produced no outcome to link. Kernel records are read through the kernel's APIs
   * (SUP-02): who requested the operation through `OperationsService.requestedBy`, its status as
   * prefetched by `operationFacts`, the audit record through `AuditEvidence`.
   */
  private async verifyEvidence(
    trx: Trx,
    expectedAccountId: string | null,
    organizationId: string,
    input: { actionId: string; operationId?: string; auditRecordId?: string },
    operation: OperationFacts | null,
  ): Promise<{
    auditRecordId: string | null;
    record: { type: string; id: string } | null;
    summary: Record<string, unknown>;
    /** The audit record of the action that evidences the command (named, or the operation's). */
    audit: EvidenceAudit | null;
  }> {
    const summary: Record<string, unknown> = {};
    let auditRecordId: string | null = null;
    let record: { type: string; id: string } | null = null;
    let audit: EvidenceAudit | null = null;
    if (input.operationId) {
      const requester = await this.operations.requestedBy(organizationId, input.operationId, trx);
      if (!requester || !operation) throw errors.notFound('operation', input.operationId);
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
      const audited = await this.auditEvidence.ofOperation(
        organizationId,
        input.operationId,
        input.actionId,
        trx,
      );
      if (!audited) {
        throw errors.validation(
          `The operation has no audit record of ${input.actionId}; link the command it actually ran.`,
          { code: 'ACTION_NOT_IN_OPERATION' },
        );
      }
      summary['operationKind'] = operation.kind;
      summary['operationStatus'] = operation.status;
      record = { type: audited.targetType, id: audited.targetId };
      audit = evidenceAudit(audited);
    }
    if (input.auditRecordId) {
      const audited = await this.auditEvidence.byId(organizationId, input.auditRecordId, trx);
      if (!audited) throw errors.notFound('audit record', input.auditRecordId);
      if (!expectedAccountId || audited.actor.accountId !== expectedAccountId) {
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
      if (input.operationId && audited.operationId && audited.operationId !== input.operationId) {
        throw errors.validation('The audit record belongs to another operation.', {
          code: 'OPERATION_MISMATCH',
        });
      }
      auditRecordId = audited.id;
      record = { type: audited.targetType, id: audited.targetId };
      audit = evidenceAudit(audited);
    }
    return { auditRecordId, record, summary, audit };
  }

  /**
   * An operation's kind and status through the kernel (`OperationsService.find`, which reads the
   * root database, so this runs before support's transaction). The lookup is attributed to the
   * system: the caller's own authority is decided on the case and by the requester check.
   */
  private async operationFacts(
    organizationId: string,
    operationId: string,
  ): Promise<OperationFacts | null> {
    try {
      const operation = await this.operations.find(
        systemPrincipal(organizationId, 'support.case_actions'),
        operationId,
      );
      return { kind: operation.kind, status: operation.status };
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return null;
      throw error;
    }
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
      // SUP-02: the compose's audit record through the kernel's AuditReader (IF-44).
      const [composedAudit] = await this.auditReader.forTarget(
        organizationId,
        'notification',
        resent.id,
        { actions: [CommunicationsActions.compose.id], limit: 1 },
        trx,
      );
      if (!composedAudit) throw errors.internal('the resend left no compose audit record');
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
   * Support records the intent first (case action `requested`, support operation `running`) with
   * a delayed `support.helper_outcome_due` follow-up in the same transaction, calls finance with
   * the operator's principal, then records the outcome. If finance gives no answer the action is
   * `unknown` at once; if the process fails before any outcome is recorded, the follow-up moves the
   * action to `unknown` after the grace period (§4.7 invariant 12). Either way an owned exception
   * asks finance to check, and a retry with the same idempotency key is refused rather than
   * requesting a second refund (§4.7 invariant 5).
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
      // support-migration-06 (§4.7 invariant 12, §4.11 "record durable follow-up"): committed with
      // the intent, so an outcome that is never recorded still reaches an owner.
      await this.outbox.enqueue(trx, HelperOutcomeDue, {
        organizationId,
        aggregateType: 'support_case',
        aggregateId: caseId,
        payload: { caseId, caseActionId: pending.id, supportOperationId },
        correlationId,
        operationId: supportOperationId,
        availableAt: new Date(
          this.clock.now().getTime() + this.policy.helperOutcomeGraceMinutes * 60_000,
        ),
        failureOwner: 'support_operator',
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
        const current = await this.loadAction(trx, organizationId, pending.id);
        // The overdue follow-up (markOverdue) or a reviewer may have recorded the outcome while
        // finance was still answering (support-migration-06): a reviewed outcome stands, and a
        // second `unknown` changes nothing.
        if (current.status === 'succeeded' || current.status === 'failed') {
          return toCaseAction(current);
        }
        if (current.status === 'unknown' && outcome.status === 'unknown') {
          return toCaseAction(current);
        }
        const wasUnknown = current.status === 'unknown';
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
          await this.raiseUnknownOutcome(trx, row, action, supportOperationId);
        } else {
          await this.resolveStale(
            trx,
            systemPrincipal(organizationId, 'support.case_actions'),
            organizationId,
            action.id,
            `Outcome recorded from finance's response: ${outcome.status}`,
          );
        }
        if (outcome.status !== 'unknown' && wasUnknown) {
          // Finance's own answer settles the question support raised; no person asserts it.
          await this.resolveUnknownOutcome(
            trx,
            systemPrincipal(organizationId, 'support.case_actions'),
            organizationId,
            action.id,
            `Outcome recorded from finance's response: ${outcome.status}`,
            outcome.status,
            correlationId,
          );
        }
        await this.afterRecord(trx, row, action, principal, correlationId, null);
        return action;
      });
    } catch (error) {
      // The outcome could not be recorded: the action stays `requested` (never assumed) and a
      // retry with the same key is refused above; the `support.helper_outcome_due` follow-up
      // committed with the intent makes it `unknown` with an owned exception after the grace
      // period (§4.7 invariant 12).
      this.logger.error(
        `could not record the outcome of case action ${pending.id}: ${String(error)}`,
      );
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // support.helper_outcome_due: a helper request whose outcome was never recorded
  // -------------------------------------------------------------------------------------------

  /**
   * support-migration-06 (§4.7 invariant 12, §4.11): handles the follow-up enqueued with a
   * helper's intent. An action still `requested` after the grace period lost its outcome (the
   * process failed before recording it): CaseActionMachine `requested → unknown`, the support
   * operation `running → recovery_required`, and the owning module's queue gets the same exception
   * as an outcome that was never reported, so a reviewer can settle it. Any other state means the
   * outcome was recorded: nothing happens (idempotent under replay).
   */
  async markOverdue(trx: Trx, event: DomainEvent<EventPayload<typeof HelperOutcomeDue>>) {
    const organizationId = event.organizationId;
    const { caseId, caseActionId, supportOperationId } = event.payload;
    // Same lock order as settleHelper and settleUnknown: the case, then the action.
    const row = await this.cases.loadForUpdate(trx, organizationId, caseId);
    if (!row) return;
    const current = await trx
      .selectFrom('case_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('case_id', '=', caseId)
      .where('id', '=', caseActionId)
      .forUpdate()
      .executeTakeFirst();
    if (!current || current.status !== 'requested') return;
    const error = {
      code: 'OUTCOME_NOT_RECORDED',
      message:
        'No outcome was recorded for this helper request within the grace period; the owning module must confirm what happened.',
    };
    const action = await this.complete(trx, organizationId, toCaseAction(current), {
      status: 'unknown',
      error,
    });
    // While the action is `requested` its coordinating operation is still running (both are
    // recorded together); a terminal operation is left as it is (SUP-02: no read of the table).
    await this.transitionUnlessTerminal(trx, supportOperationId, 'recovery_required', { error });
    await this.raiseUnknownOutcome(trx, row, action, supportOperationId);
    // The unknown-outcome exception now owns the question a stale-request exception asked.
    await this.resolveStale(
      trx,
      systemPrincipal(organizationId, 'support.case_actions'),
      organizationId,
      action.id,
      'Superseded: the request is now unknown with the finance-owned exception',
    );
    await this.afterRecord(
      trx,
      row,
      action,
      systemPrincipal(organizationId, 'support.case_actions'),
      event.correlationId,
      null,
    );
  }

  // -------------------------------------------------------------------------------------------
  // support.settle_stale_case_actions (SUP-04): helper requests left `requested`
  // -------------------------------------------------------------------------------------------

  /**
   * SUP-04 (SPK-SUPPORT-002, §4.11 "unknown kept explicit until reconciled", §4.12): one pass of
   * the periodic job. Every helper request still `requested` `staleSeconds` after its intent has
   * its owning module's outcome read — for a refund, the `finance.refund` that request ran (by
   * the request's correlation id, through finance's RefundsService and the kernel's audit and
   * outbox reads) — and recorded: `succeeded` with that command's evidence, or `failed` when
   * finance recorded only failed or canceled refunds for it. Without an outcome the request stays
   * `requested` (never assumed) and one `support.case_action_stale` exception asks its owner;
   * the next run reads again. Each request is one small transaction under the job's system
   * principal; the keyset position survives passes and restarts once every due request was read.
   */
  async settleStale(context: {
    now: Date;
    batchSize: number;
    staleSeconds: number;
  }): Promise<{ processed: number; remaining: number }> {
    const cutoff = new Date(context.now.getTime() - context.staleSeconds * 1000);
    let q = this.db
      .selectFrom('case_actions')
      .select(['id', 'organization_id', 'case_id', 'requested_at'])
      .where('via', '=', 'helper')
      .where('status', '=', 'requested')
      .where('requested_at', '<=', cutoff)
      .orderBy('requested_at')
      .orderBy('id')
      .limit(context.batchSize + 1);
    const after = this.staleAfter;
    if (after) {
      q = q.where(
        sql<SqlBool>`(requested_at, id) > (${after.requestedAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const due = await q.execute();
    const batch = due.slice(0, context.batchSize);
    let processed = 0;
    for (const action of batch) {
      const settled = await this.uow.run(({ trx }) =>
        this.settleOneStale(trx, action.organization_id, action.case_id, action.id),
      );
      if (settled) processed += 1;
    }
    const last = batch[batch.length - 1];
    const more = due.length > context.batchSize;
    this.staleAfter =
      more && last ? { requestedAt: new Date(last.requested_at), id: last.id } : null;
    return { processed, remaining: more ? due.length - batch.length : 0 };
  }

  private async settleOneStale(
    trx: Trx,
    organizationId: string,
    caseId: string,
    caseActionId: string,
  ): Promise<boolean> {
    // Same lock order as settleHelper and markOverdue: the case, then the action.
    const row = await this.cases.loadForUpdate(trx, organizationId, caseId);
    if (!row) return false;
    const current = await trx
      .selectFrom('case_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('case_id', '=', caseId)
      .where('id', '=', caseActionId)
      .forUpdate()
      .executeTakeFirst();
    if (!current || current.status !== 'requested') return false;
    const actor = systemPrincipal(organizationId, SETTLE_STALE_CASE_ACTIONS_JOB);
    const outcome = await this.ownerOutcome(trx, current);
    if (!outcome) {
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: row.facility_id,
        category: CASE_ACTION_STALE_CATEGORY,
        severity: 'warning',
        title: `A ${current.action_id} requested from support case "${row.title.slice(0, 80)}" has no recorded outcome yet`,
        affectedType: 'case_action',
        affectedId: current.id,
        ownerQueue: this.outcomeQueue(current.action_id),
        dedupeKey: staleKey(current.id),
        details: {
          caseId: row.id,
          caseActionId: current.id,
          actionId: current.action_id,
          supportOperationId: current.support_operation_id,
          requestedAt: new Date(current.requested_at).toISOString(),
        },
      });
      return false;
    }
    const action = await this.complete(trx, organizationId, toCaseAction(current), outcome);
    if (current.support_operation_id) {
      await this.transitionUnlessTerminal(
        trx,
        current.support_operation_id,
        outcome.status,
        outcome.status === 'succeeded'
          ? { result: { caseActionId: action.id, settledBy: SETTLE_STALE_CASE_ACTIONS_JOB } }
          : { error: outcome.error ?? { code: 'NO_EFFECT', message: 'no effect' } },
      );
    }
    await this.resolveStale(
      trx,
      actor,
      organizationId,
      current.id,
      `Outcome recorded from the owning module: ${outcome.status}`,
    );
    await this.afterRecord(trx, row, action, actor, null, null);
    return true;
  }

  /**
   * The owning module's outcome of a helper request, or null while it reports none. A refund
   * helper reads the refunds its request ran (RefundsService through the request's correlation
   * id): an effective one is the outcome (unless it already evidences another case action, which
   * a reviewer must untangle), and only failed or canceled ones mean `failed`. A resend is
   * recorded with its request in one transaction, so no other helper is ever left `requested`
   * with an outcome to read; communications exposes no lookup of a resend by correlation id.
   */
  private async ownerOutcome(trx: Trx, current: CaseActionRow): Promise<OwnerOutcome | null> {
    if (current.action_id !== FinanceActions.refund.id) return null;
    const matches = await this.refundAuditsOf(await this.refundRequestOf(trx, current), trx);
    if (matches.length === 0) return null;
    let failed: { id: string; status: string } | null = null;
    for (const match of matches) {
      const refund = await this.refunds.load(trx, current.organization_id, match.targetId);
      if (!refund) continue;
      if (REFUND_NO_EFFECT.includes(refund.status)) {
        failed ??= { id: refund.id, status: refund.status };
        continue;
      }
      const elsewhere = await trx
        .selectFrom('case_actions')
        .select('id')
        .where('organization_id', '=', current.organization_id)
        .where('id', '<>', current.id)
        .where((eb) =>
          eb.or([
            eb('audit_record_id', '=', match.id),
            ...(refund.operation_id ? [eb('command_operation_id', '=', refund.operation_id)] : []),
          ]),
        )
        .executeTakeFirst();
      if (elsewhere) return null;
      return {
        status: 'succeeded',
        commandOperationId: refund.operation_id,
        auditRecordId: match.id,
        record: { type: 'refund_attempt', id: refund.id },
      };
    }
    if (!failed) return null;
    return {
      status: 'failed',
      record: { type: 'refund_attempt', id: failed.id },
      error: {
        code: 'REFUND_NOT_EFFECTIVE',
        message: `Finance recorded the refund this request ran as ${failed.status}.`,
      },
    };
  }

  /** The queue that owns the outcome of a helper's command (§5.11). */
  private outcomeQueue(actionId: string): string {
    return actionId === FinanceActions.refund.id ? REFUND_OUTCOME_QUEUE : 'support_operator';
  }

  /** The exception that asks the owning module what happened to a helper request. */
  private async raiseUnknownOutcome(
    trx: Trx,
    row: CaseRow,
    action: CaseAction,
    supportOperationId: string,
  ): Promise<void> {
    await this.exceptions.raise(trx, {
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      category: HELPER_OUTCOME_UNKNOWN_CATEGORY,
      severity: 'high',
      title: `A refund requested from support case "${row.title.slice(0, 80)}" has no recorded outcome`,
      affectedType: 'case_action',
      affectedId: action.id,
      ownerQueue: REFUND_OUTCOME_QUEUE,
      dedupeKey: unknownOutcomeKey(action.id),
      details: { caseId: row.id, caseActionId: action.id, supportOperationId },
    });
  }

  /** Resolves the open unknown-outcome exception of a case action, as `actor`. */
  private async resolveUnknownOutcome(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    caseActionId: string,
    reason: string,
    outcome: 'succeeded' | 'failed',
    correlationId: string | null,
  ): Promise<void> {
    const open = await this.openUnknownOutcome(trx, organizationId, caseActionId);
    if (!open) return;
    // The kernel authorizes `exceptions.manage` for `actor`, enforces the lifecycle and audits.
    await this.exceptions.transition(trx, actor, open.id, 'resolved', {
      reason,
      resolution: { caseActionId, outcome },
      correlationId: correlationId ?? undefined,
    });
  }

  private async openUnknownOutcome(trx: Trx, organizationId: string, caseActionId: string) {
    return this.openExceptionOf(trx, organizationId, caseActionId, HELPER_OUTCOME_UNKNOWN_CATEGORY);
  }

  /** The open exception of `category` about a case action (kernel list, K-10 / IF-29). */
  private async openExceptionOf(
    trx: Trx,
    organizationId: string,
    caseActionId: string,
    category: string,
  ) {
    const page = await this.exceptions.list(
      organizationId,
      {
        statuses: ['open', 'acknowledged'],
        category,
        affectedType: 'case_action',
        affectedId: caseActionId,
        limit: 1,
      },
      trx,
    );
    return page.items[0] ?? null;
  }

  /** Resolves the open stale-request exception of a case action, if any (SUP-04). */
  private async resolveStale(
    trx: Trx,
    actor: Principal,
    organizationId: string,
    caseActionId: string,
    reason: string,
  ): Promise<void> {
    const open = await this.openExceptionOf(
      trx,
      organizationId,
      caseActionId,
      CASE_ACTION_STALE_CATEGORY,
    );
    if (!open) return;
    await this.exceptions.transition(trx, actor, open.id, 'resolved', {
      reason,
      resolution: { caseActionId },
    });
  }

  private async transitionUnlessTerminal(
    trx: Trx,
    operationId: string,
    to: 'succeeded' | 'failed' | 'recovery_required',
    data: { result?: unknown; error?: { code: string; message: string; details?: unknown } },
  ): Promise<void> {
    try {
      await this.operations.transition(trx, operationId, to, data);
    } catch (error) {
      if (DomainError.is(error) && error.code === 'INVALID_TRANSITION') return;
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // POST /cases/{id}/actions/{actionId}/settle: record the outcome of an unknown helper action
  // -------------------------------------------------------------------------------------------

  /**
   * CaseActionMachine `unknown → succeeded | failed`: a reviewer records what the owning module
   * reports (SPK-SUPPORT-003, §4.12).
   *
   * - Recording the outcome answers the owning module's open question, so the reviewer needs the
   *   kernel's `exceptions.manage` in the case's facility scope and must see that exception's queue;
   *   the exception is resolved with the reviewer's own principal, which the kernel authorizes and
   *   audits (support-migration-04, §4.14 least privilege, §5.11).
   * - A succeeded outcome must be evidenced by the command this helper request ran — its operation
   *   or audit record, by the same operator, recorded after the request and, for a refund, of the
   *   same payment and amount under the request's correlation id — and not already linked to
   *   another case action, so neither a note nor an unrelated command stands in for it
   *   (support-migration-08).
   * - A failed outcome of a refund is refused while finance holds a refund for this request that is
   *   not failed or canceled (support-migration-04, §4.7 invariant 5): finance's record wins over a
   *   reviewer's statement.
   */
  async settleUnknown(
    principal: Principal,
    caseId: string,
    caseActionId: string,
    input: SettleCaseActionInput,
    correlationId: string | null,
  ): Promise<CaseActionOutcome> {
    const organizationId = organizationOf(principal);
    const operation = input.operationId
      ? await this.operationFacts(organizationId, input.operationId)
      : null;
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
      await this.authorization.require(principal, ExceptionActions.manage, {
        type: 'operational_exception',
        organizationId,
        facilityId: row.facility_id,
      });
      const current = await trx
        .selectFrom('case_actions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('case_id', '=', caseId)
        .where('id', '=', caseActionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('case action', caseActionId);
      const open = await this.openUnknownOutcome(trx, organizationId, current.id);
      const queue = open?.owner_queue ?? REFUND_OUTCOME_QUEUE;
      const configured = await this.queues.configured(trx, organizationId);
      if (!this.queues.visibleTo(principal, this.queues.resolve(queue, configured))) {
        throw errors.accessDenied('This outcome belongs to a queue outside your scope.', {
          queue,
        });
      }
      if (current.status !== 'unknown') {
        throw errors.invalidTransition('CaseAction', current.status, 'settle');
      }
      const isRefund = current.via === 'helper' && current.action_id === FinanceActions.refund.id;
      let evidence: Awaited<ReturnType<CaseActionsService['verifyEvidence']>> | null = null;
      let record: { type: string; id: string } | null = input.record ?? null;
      if (input.outcome === 'succeeded') {
        const helperActor = current.actor as { accountId?: string | null };
        evidence = await this.verifyEvidence(
          trx,
          helperActor.accountId ?? null,
          organizationId,
          {
            actionId: current.action_id,
            operationId: input.operationId,
            auditRecordId: input.auditRecordId,
          },
          operation,
        );
        if (current.via === 'helper') {
          await this.assertEvidenceOfRequest(trx, current, evidence.audit, isRefund);
          record = evidence.record;
        } else {
          record = input.record ?? evidence.record;
        }
      } else if (isRefund) {
        record = await this.assertNoRefundRecorded(trx, current);
      }
      if (current.via === 'helper' && input.record && !sameRecord(input.record, record)) {
        throw errors.validation('The record is not the one this helper request produced.', {
          code: 'EVIDENCE_NOT_OF_THIS_REQUEST',
        });
      }
      const action = await this.complete(trx, organizationId, toCaseAction(current), {
        status: input.outcome,
        commandOperationId: input.operationId ?? null,
        auditRecordId: evidence?.auditRecordId ?? null,
        record,
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
      // The exception support raised is resolved because its underlying question is answered,
      // by the reviewer who answered it.
      await this.resolveUnknownOutcome(
        trx,
        principal,
        organizationId,
        current.id,
        `Outcome recorded by review: ${input.outcome}`,
        input.outcome,
        correlationId,
      );
      await this.afterRecord(trx, row, action, principal, correlationId, input.reason);
      return { case: await this.cases.detail(trx, organizationId, caseId), action };
    });
  }

  /**
   * support-migration-08 (SPK-SUPPORT-003): the evidence of a helper's succeeded outcome is the
   * command this request ran — recorded after the request, for a refund the same payment and
   * amount under the request's correlation id (finance's audit record of `finance.refund`), of a
   * refund finance did not record as failed or canceled — and is not already another case
   * action's evidence (one command settles one request).
   */
  private async assertEvidenceOfRequest(
    trx: Trx,
    current: CaseActionRow,
    audit: EvidenceAudit | null,
    isRefund: boolean,
  ): Promise<void> {
    const notOfThisRequest = () =>
      errors.validation('The evidence is not the command this helper request ran.', {
        code: 'EVIDENCE_NOT_OF_THIS_REQUEST',
      });
    if (!audit) throw notOfThisRequest();
    if (audit.occurredAt.getTime() < new Date(current.requested_at).getTime()) {
      throw notOfThisRequest();
    }
    if (isRefund) {
      const matches = await this.refundAuditsOf(await this.refundRequestOf(trx, current), trx);
      if (!matches.some((m) => m.id === audit.id)) throw notOfThisRequest();
      const refund = await this.refunds.load(trx, current.organization_id, audit.targetId);
      if (!refund || REFUND_NO_EFFECT.includes(refund.status)) {
        throw errors.resourceConflict(
          `Finance recorded this refund as ${refund?.status ?? 'missing'}: it is not a succeeded outcome.`,
          { code: 'REFUND_NOT_EFFECTIVE', refundId: audit.targetId, status: refund?.status },
        );
      }
    }
    const elsewhere = await trx
      .selectFrom('case_actions')
      .select(['id', 'case_id'])
      .where('organization_id', '=', current.organization_id)
      .where('id', '<>', current.id)
      .where((eb) =>
        eb.or([
          eb('audit_record_id', '=', audit.id),
          ...(audit.operationId ? [eb('command_operation_id', '=', audit.operationId)] : []),
        ]),
      )
      .executeTakeFirst();
    if (elsewhere) {
      throw errors.resourceConflict(
        'This command outcome is already linked to another case action.',
        {
          code: 'EVIDENCE_ALREADY_LINKED',
          caseActionId: elsewhere.id,
        },
      );
    }
  }

  /**
   * A refund that a refund helper request on some case ran (still `requested` or `unknown`) is
   * that request's outcome: it is recorded by settling the request, never linked as a separate
   * action, so the request can still be settled with it (support-migration-08: one command
   * settles one request).
   */
  private async assertNotAnOutstandingHelpersRefund(
    trx: Trx,
    organizationId: string,
    audit: EvidenceAudit,
  ): Promise<void> {
    const paymentAttemptId = audit.details['paymentAttemptId'];
    if (typeof paymentAttemptId !== 'string') return;
    const outstanding = await trx
      .selectFrom('case_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('via', '=', 'helper')
      .where('action_id', '=', FinanceActions.refund.id)
      .where('status', 'in', ['requested', 'unknown'])
      .where('requested_at', '<=', audit.occurredAt)
      .where(sql<SqlBool>`input->>'paymentAttemptId' = ${paymentAttemptId}`)
      .execute();
    for (const helper of outstanding) {
      const matches = await this.refundAuditsOf(await this.refundRequestOf(trx, helper), trx);
      if (matches.some((m) => m.id === audit.id)) {
        throw new DomainError(
          'RESOURCE_CONFLICT',
          'This refund is the outcome of a refund requested from a case; record it on that request.',
          {
            details: {
              code: 'HELPER_REQUEST_OUTSTANDING',
              caseId: helper.case_id,
              caseActionId: helper.id,
            },
            nextAction: 'settle_case_action',
          },
        );
      }
    }
  }

  /**
   * support-migration-04 (§4.7 invariant 5, SPK-SUPPORT-003): a refund helper may be settled
   * `failed` only when finance holds no refund for this request, or only refunds it recorded as
   * failed or canceled (read through finance's exported service). Returns that refund's reference.
   */
  private async assertNoRefundRecorded(
    trx: Trx,
    current: CaseActionRow,
  ): Promise<{ type: string; id: string } | null> {
    const matches = await this.refundAuditsOf(await this.refundRequestOf(trx, current), trx);
    let record: { type: string; id: string } | null = null;
    for (const match of matches) {
      const refund = await this.refunds.load(trx, current.organization_id, match.targetId);
      if (refund && !REFUND_NO_EFFECT.includes(refund.status)) {
        throw errors.resourceConflict(
          'Finance recorded a refund for this request: settle it with that refund, or wait for finance to reconcile it.',
          {
            code: 'REFUND_RECORDED_BY_FINANCE',
            auditRecordId: match.id,
            refundId: refund.id,
            operationId: refund.operation_id,
            status: refund.status,
          },
        );
      }
      record ??= { type: 'refund_attempt', id: match.targetId };
    }
    return record;
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

  /** The audit record of the `finance.refund` this helper call ran, while it is running. */
  private async refundAuditFor(
    principal: Principal,
    input: RequestRefundInput,
    pending: CaseAction,
    correlationId: string | null,
  ): Promise<string | null> {
    const matches = await this.refundAuditsOf({
      organizationId: organizationOf(principal),
      caseActionId: pending.id,
      accountId: principal.accountId,
      paymentAttemptId: input.paymentAttemptId,
      amountMinor: String(input.amountMinor),
      requestedAt: new Date(pending.requestedAt),
      correlationId,
    });
    return matches[0]?.id ?? null;
  }

  /**
   * A refund helper's request as recorded with its intent: the input on the case action and the
   * request's correlation id on support's own intent audit record (read through AuditReader,
   * SUP-02).
   */
  private async refundRequestOf(trx: Trx, current: CaseActionRow): Promise<RefundRequestOf> {
    const input = current.input as { paymentAttemptId?: unknown; amountMinor?: unknown };
    const actor = current.actor as { accountId?: string | null };
    const intents = await this.auditReader.forTarget(
      current.organization_id,
      'support_case',
      current.case_id,
      { actions: [SupportActions.linkAction.id], limit: 200 },
      trx,
    );
    const intent = intents.find(
      (r) => r.details['caseActionId'] === current.id && r.details['status'] === 'requested',
    );
    return {
      organizationId: current.organization_id,
      caseActionId: current.id,
      accountId: actor.accountId ?? null,
      paymentAttemptId: String(input.paymentAttemptId ?? ''),
      amountMinor: String(input.amountMinor ?? ''),
      requestedAt: new Date(current.requested_at),
      correlationId: intent?.correlationId ?? null,
    };
  }

  /**
   * The audit records of the `finance.refund` a refund helper request ran: the same operator,
   * payment and amount, recorded since the intent and carried by the request's correlation id (or,
   * without one, not linked to another case action). Finance writes this record and its
   * `finance.refund_requested` event in the transaction that reserves the refund, so the refunds
   * are found in the kernel's outbox history (OutboxHistory, IF-27) and their audit records
   * through AuditReader (IF-44) — never the kernel's tables (SUP-02).
   */
  private async refundAuditsOf(request: RefundRequestOf, trx?: Trx): Promise<AuditRecord[]> {
    if (!request.accountId) return [];
    const refundIds: string[] = [];
    let after: { occurredAt: string; id: string } | null = {
      occurredAt: new Date(request.requestedAt.getTime() - 1).toISOString(),
      id: MAX_UUID,
    };
    while (after) {
      const page: Awaited<ReturnType<OutboxHistory['page']>> = await this.outboxHistory.page(
        {
          organizationId: request.organizationId,
          eventTypes: [RefundRequested.type],
          after,
          limit: 500,
        },
        trx,
      );
      for (const event of page.items) {
        const payload = event.payload as { paymentAttemptId?: unknown; refundAttemptId?: unknown };
        if (
          payload.paymentAttemptId === request.paymentAttemptId &&
          typeof payload.refundAttemptId === 'string'
        ) {
          refundIds.push(payload.refundAttemptId);
        }
      }
      after = page.next;
    }
    const matches: AuditRecord[] = [];
    for (const refundId of [...new Set(refundIds)]) {
      const records = await this.auditReader.forTarget(
        request.organizationId,
        'refund_attempt',
        refundId,
        { actions: [FinanceActions.refund.id], limit: 200 },
        trx,
      );
      for (const r of records) {
        if (new Date(r.occurredAt).getTime() < request.requestedAt.getTime()) continue;
        if (r.actor.accountId !== request.accountId) continue;
        if (String(r.details['paymentAttemptId'] ?? '') !== request.paymentAttemptId) continue;
        if (String(r.details['amountMinor'] ?? '') !== request.amountMinor) continue;
        if (request.correlationId && r.correlationId !== request.correlationId) continue;
        matches.push(r);
      }
    }
    if (!request.correlationId && matches.length > 0) {
      // Without a correlation id, a refund already evidencing another case action is not this one.
      const linked = new Set(
        (
          await (trx ?? this.uow.reader())
            .selectFrom('case_actions')
            .select('audit_record_id')
            .where('organization_id', '=', request.organizationId)
            .where('id', '<>', request.caseActionId)
            .where(
              'audit_record_id',
              'in',
              matches.map((m) => m.id),
            )
            .execute()
        ).map((r) => r.audit_record_id),
      );
      return sortByOccurrence(matches.filter((m) => !linked.has(m.id)));
    }
    return sortByOccurrence(matches);
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

function evidenceAudit(record: AuditRecord): EvidenceAudit {
  return {
    id: record.id,
    targetType: record.targetType,
    targetId: record.targetId,
    operationId: record.operationId,
    occurredAt: new Date(record.occurredAt),
    details: record.details,
  };
}

function sortByOccurrence(records: AuditRecord[]): AuditRecord[] {
  return [...records].sort((a, b) =>
    a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt < b.occurredAt ? -1 : 1,
  );
}

/** Dedupe key of the exception raised when a helper request stays `requested` (SUP-04). */
function staleKey(caseActionId: string): string {
  return `support:case_action:${caseActionId}:stale`;
}

function sameRecord(
  a: { type: string; id: string } | null,
  b: { type: string; id: string } | null,
): boolean {
  return a?.type === b?.type && a?.id === b?.id;
}
