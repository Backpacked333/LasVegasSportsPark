import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CheckoutMachine,
  PaymentAttemptMachine,
  errors,
  newId,
  type PaymentAttempt,
  type PaymentDetail,
  type PaymentAttemptEvent,
  type PaymentAttemptState,
  type Principal,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type Db,
  type EvidenceSource,
  type PaymentAttemptPurpose,
} from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  PAYMENT_PROVIDER_PORT,
  type PaymentProviderPort,
  type ProviderPaymentResult,
  type ProviderPaymentStatus,
} from '../finance.ports';
import {
  LIVE_ATTEMPT_STATES,
  financeSystem,
  hoursFrom,
  iso,
  minutesFrom,
  organizationOf,
  outcomeUnknownDetails,
  toPaymentAttempt,
  type PaymentAttemptRow,
  type Reader,
  type ReceiptRow,
} from '../finance.shared';
import { FinancePolicyResolver } from './finance-policy.resolver';
import { MoneyFacts } from './money-facts.service';
import { PosSaleFinalizer } from './pos/pos-sale-finalizer.service';

export interface CreateAttemptInput {
  organizationId: string;
  purpose: PaymentAttemptPurpose;
  checkoutId?: string | null;
  orderId?: string | null;
  obligationId?: string | null;
  contributionRequestId?: string | null;
  installmentId?: string | null;
  /** FIN-06: the point-of-sale sale a card tender pays (purpose `pos_sale`). */
  posSaleId?: string | null;
  payerPersonId: string;
  amountMinor: number;
  currency: string;
  paymentMethodRef: string;
  actor: Principal;
}

export interface PaymentEvidence {
  status: ProviderPaymentStatus;
  providerReference: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  feeMinor?: number | null;
  failureReason?: string | null;
  actionPayload?: Record<string, unknown> | null;
  source: EvidenceSource;
  inboxEventId?: string | null;
  sequence?: number | null;
}

export interface EvidenceOutcome {
  attempt: PaymentAttemptRow;
  changed: boolean;
  /** The receipt of a capture; null otherwise and for point-of-sale card tenders (FIN-06). */
  receipt: ReceiptRow | null;
  overpaymentCreditId: string | null;
  conflict: boolean;
}

const EVENT_FOR: Record<ProviderPaymentStatus, PaymentAttemptEvent> = {
  succeeded: 'succeed',
  failed: 'fail',
  canceled: 'cancel',
  requires_action: 'require_action',
  processing: 'process',
};
const LIVE: PaymentAttemptState[] = [...LIVE_ATTEMPT_STATES];

/**
 * Payment attempts (PaymentAttemptMachine, SPK-PAY-007, §4.11 steps 5–7). The attempt is created
 * in the business transaction; the provider is called OUTSIDE any transaction with the attempt
 * id as idempotency key; the outcome is recorded as a fact in a new transaction. A timeout is
 * `unknown` — never `failed` — with an owned exception, and no second charge is possible until
 * authoritative evidence (synchronous result, webhook through the kernel inbox, or reconciliation
 * lookup) resolves it. Evidence that contradicts a terminal state raises an exception and changes
 * nothing; an older non-terminal event never moves the state back.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly facts: MoneyFacts,
    private readonly policy: FinancePolicyResolver,
    private readonly posSales: PosSaleFinalizer,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<PaymentAttemptRow | undefined> {
    let q = db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /**
   * GET /payments/{id}: the payer or finance readers; anyone else learns nothing (§4.10). FIN-02
   * (SPK-PAY-008, SCR-S-37): with what can still be refunded and the payment's earlier refunds.
   */
  async get(principal: Principal, id: string): Promise<PaymentDetail> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('payment');
    await this.authorization.require(principal, FinanceActions.readCheckout, {
      type: 'payment_attempt',
      id,
      organizationId,
      subjectPersonIds: [row.payer_person_id],
      protected: true,
    });
    return this.detail(this.db, row);
  }

  async detail(db: Reader, row: PaymentAttemptRow): Promise<PaymentDetail> {
    const refundable = await db
      .selectFrom('payment_refundables')
      .select(['captured_minor', 'refunded_minor', 'reserved_minor'])
      .where('organization_id', '=', row.organization_id)
      .where('payment_attempt_id', '=', row.id)
      .executeTakeFirst();
    const refunds = await db
      .selectFrom('refund_attempts')
      .select(['id', 'status', 'amount_minor', 'currency', 'created_at'])
      .where('organization_id', '=', row.organization_id)
      .where('payment_attempt_id', '=', row.id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return {
      ...toPaymentAttempt(row),
      refundableMinor: refundable
        ? Number(refundable.captured_minor) -
          Number(refundable.refunded_minor) -
          Number(refundable.reserved_minor)
        : 0,
      refunds: refunds.map((r) => ({
        id: r.id,
        status: r.status,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        requestedAt: iso(r.created_at),
      })),
    };
  }

  /** The view of an attempt as listed (FIN-01/02 lists reuse the GET mapping). */
  view(row: PaymentAttemptRow): PaymentAttempt {
    return toPaymentAttempt(row);
  }

  async createAttemptInTrx(trx: Trx, input: CreateAttemptInput): Promise<PaymentAttemptRow> {
    // SPK-PAY-007, FIN-01: the attempt already on its way for the same target is named (to its
    // payer and staff) instead of only refusing; the partial unique indexes stay the guarantee.
    const live = await this.liveAttempt(trx, input.organizationId, {
      checkoutId: input.purpose === 'checkout' ? (input.checkoutId ?? undefined) : undefined,
      installmentId:
        input.purpose === 'installment' ? (input.installmentId ?? undefined) : undefined,
      posSaleId: input.purpose === 'pos_sale' ? (input.posSaleId ?? undefined) : undefined,
      obligationId:
        input.purpose === 'obligation' || input.purpose === 'contribution'
          ? (input.obligationId ?? undefined)
          : undefined,
      payerPersonId:
        input.purpose === 'obligation' || input.purpose === 'contribution'
          ? input.payerPersonId
          : undefined,
      purposes:
        input.purpose === 'obligation' || input.purpose === 'contribution'
          ? ['obligation', 'contribution']
          : undefined,
    });
    if (live) {
      throw errors.paymentOutcomeUnknown({
        code: 'PAYMENT_IN_PROGRESS',
        message: 'A payment for this is already in progress or awaiting reconciliation.',
        ...outcomeUnknownDetails(input.actor, live),
      });
    }
    const id = newId();
    try {
      await trx
        .insertInto('payment_attempts')
        .values({
          id,
          organization_id: input.organizationId,
          purpose: input.purpose,
          checkout_id: input.checkoutId ?? null,
          order_id: input.orderId ?? null,
          obligation_id: input.obligationId ?? null,
          contribution_request_id: input.contributionRequestId ?? null,
          installment_id: input.installmentId ?? null,
          pos_sale_id: input.posSaleId ?? null,
          payer_person_id: input.payerPersonId,
          amount_minor: input.amountMinor,
          currency: input.currency,
          provider: this.provider.name,
          payment_method_ref: input.paymentMethodRef,
          provider_reference: null,
          status: 'created',
          action_required_payload: null,
          failure_reason: null,
          processor_fee_minor: null,
          evidence_source: null,
          evidence_inbox_event_id: null,
          evidence_sequence: null,
          requested_by: json(snapshotActor(input.actor)),
          requested_by_person_id: input.actor.personId,
          submitted_at: null,
          unknown_since: null,
          resolved_at: null,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        // SPK-PAY-007: another attempt is still live (or unknown) for the same target.
        throw errors.paymentOutcomeUnknown({
          code: 'PAYMENT_IN_PROGRESS',
          message: 'A payment for this is already in progress or awaiting reconciliation.',
        });
      }
      throw error;
    }
    const row = await this.load(trx, input.organizationId, id);
    if (!row) throw errors.internal('payment attempt vanished');
    return row;
  }

  /** The live (or unknown) attempt for a target, if any. */
  async liveAttempt(
    db: Reader,
    organizationId: string,
    target: {
      checkoutId?: string;
      installmentId?: string;
      obligationId?: string;
      payerPersonId?: string;
      posSaleId?: string;
      purposes?: PaymentAttemptPurpose[];
    },
  ): Promise<PaymentAttemptRow | undefined> {
    if (
      !target.checkoutId &&
      !target.installmentId &&
      !target.obligationId &&
      !target.payerPersonId &&
      !target.posSaleId
    ) {
      return undefined;
    }
    let q = db
      .selectFrom('payment_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', 'in', LIVE);
    if (target.checkoutId) q = q.where('checkout_id', '=', target.checkoutId);
    if (target.installmentId) q = q.where('installment_id', '=', target.installmentId);
    if (target.obligationId) q = q.where('obligation_id', '=', target.obligationId);
    if (target.payerPersonId) q = q.where('payer_person_id', '=', target.payerPersonId);
    if (target.posSaleId) q = q.where('pos_sale_id', '=', target.posSaleId);
    if (target.purposes) q = q.where('purpose', 'in', target.purposes);
    return q.orderBy('created_at', 'desc').executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // §4.11 step 5: provider execution, never inside a transaction
  // -------------------------------------------------------------------------------------------

  async execute(
    organizationId: string,
    attemptId: string,
    correlationId: string | null,
  ): Promise<EvidenceOutcome> {
    if (this.uow.current()) {
      throw errors.internal('a provider call must never run inside a database transaction (§4.11)');
    }
    const submitted = await this.uow.run(async ({ trx }) => {
      const attempt = await this.load(trx, organizationId, attemptId, true);
      if (!attempt) throw errors.notFound('payment attempt', attemptId);
      // Submission is a fact (`submitted_at`), not a state: `processing` means the provider said
      // so, and the machine only reaches `action_required` from `created`.
      if (attempt.status !== 'created' || attempt.submitted_at) return null;
      const now = this.clock.now();
      await trx
        .updateTable('payment_attempts')
        .set({ submitted_at: now, revision: attempt.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', attemptId)
        .where('revision', '=', attempt.revision)
        .execute();
      if (attempt.checkout_id) {
        const checkout = await trx
          .selectFrom('checkouts')
          .select(['status', 'revision'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', attempt.checkout_id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (checkout.status === 'prepared') {
          await trx
            .updateTable('checkouts')
            .set({
              status: CheckoutMachine.next('prepared', 'initiate_payment'),
              revision: checkout.revision + 1,
            })
            .where('organization_id', '=', organizationId)
            .where('id', '=', attempt.checkout_id)
            .execute();
        }
      }
      return (await this.load(trx, organizationId, attemptId)) ?? null;
    });
    if (!submitted) {
      const current = await this.load(this.db, organizationId, attemptId);
      if (!current) throw errors.notFound('payment attempt', attemptId);
      return {
        attempt: current,
        changed: false,
        receipt: null,
        overpaymentCreditId: null,
        conflict: false,
      };
    }
    let result: ProviderPaymentResult;
    try {
      result = await this.provider.createPayment({
        idempotencyKey: submitted.id,
        amountMinor: submitted.amount_minor,
        currency: submitted.currency,
        paymentMethodRef: submitted.payment_method_ref,
        metadata: { organizationId, paymentAttemptId: submitted.id },
      });
    } catch (error) {
      this.logger.warn(`payment ${submitted.id}: outcome unknown (${String(error)})`);
      return this.uow.run(({ trx }) =>
        this.markUnknown(trx, organizationId, submitted.id, correlationId),
      );
    }
    return this.uow.run(({ trx }) =>
      this.applyEvidence(
        trx,
        organizationId,
        submitted.id,
        {
          status: result.status,
          providerReference: result.providerReference,
          amountMinor: result.amountMinor,
          currency: result.currency,
          feeMinor: result.feeMinor,
          failureReason: result.failureReason,
          actionPayload: result.actionPayload,
          source: 'sync_response',
        },
        correlationId,
      ),
    );
  }

  /** SPK-PAY-007: a timeout is not a failure. The attempt is `unknown` with an owned exception. */
  private async markUnknown(
    trx: Trx,
    organizationId: string,
    attemptId: string,
    correlationId: string | null,
  ): Promise<EvidenceOutcome> {
    const attempt = await this.load(trx, organizationId, attemptId, true);
    if (!attempt) throw errors.notFound('payment attempt', attemptId);
    if (!PaymentAttemptMachine.can(attempt.status, 'lose_track')) {
      // Evidence arrived (webhook) while the call was outstanding: it stands.
      return { attempt, changed: false, receipt: null, overpaymentCreditId: null, conflict: false };
    }
    const now = this.clock.now();
    await trx
      .updateTable('payment_attempts')
      .set({
        status: PaymentAttemptMachine.next(attempt.status, 'lose_track'),
        unknown_since: now,
        revision: attempt.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', attemptId)
      .where('revision', '=', attempt.revision)
      .execute();
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.unknown_payment_outcome',
      severity: 'critical',
      title: 'A payment outcome is unknown; reconcile before charging the customer again',
      affectedType: 'payment_attempt',
      affectedId: attemptId,
      ownerQueue: 'finance_operator',
      dedupeKey: `payment-unknown:${attemptId}`,
      details: {
        purpose: attempt.purpose,
        checkoutId: attempt.checkout_id,
        obligationId: attempt.obligation_id,
        amountMinor: attempt.amount_minor,
        currency: attempt.currency,
      },
    });
    await this.audit.record(trx, {
      organizationId,
      actor: financeSystem(organizationId, 'finance.payments'),
      action: 'finance.payment_outcome_unknown',
      targetType: 'payment_attempt',
      targetId: attemptId,
      beforeRevision: attempt.revision,
      afterRevision: attempt.revision + 1,
      correlationId,
    });
    await this.outbox.enqueue(trx, FinanceEvents.paymentOutcomeUnknown, {
      organizationId,
      aggregateType: 'payment_attempt',
      aggregateId: attemptId,
      correlationId,
      payload: { organizationId, paymentAttemptId: attemptId, purpose: attempt.purpose },
    });
    const updated = await this.load(trx, organizationId, attemptId);
    return {
      attempt: updated as PaymentAttemptRow,
      changed: true,
      receipt: null,
      overpaymentCreditId: null,
      conflict: false,
    };
  }

  // -------------------------------------------------------------------------------------------
  // §4.11 steps 6–7: authoritative evidence → financial facts
  // -------------------------------------------------------------------------------------------

  async applyEvidence(
    trx: Trx,
    organizationId: string,
    attemptId: string,
    evidence: PaymentEvidence,
    correlationId: string | null,
  ): Promise<EvidenceOutcome> {
    const attempt = await this.load(trx, organizationId, attemptId, true);
    if (!attempt) throw errors.notFound('payment attempt', attemptId);
    const unchanged = (conflict = false): EvidenceOutcome => ({
      attempt,
      changed: false,
      receipt: null,
      overpaymentCreditId: null,
      conflict,
    });
    if (
      evidence.providerReference &&
      attempt.provider_reference &&
      evidence.providerReference !== attempt.provider_reference
    ) {
      await this.conflict(trx, attempt, evidence, 'provider reference mismatch', correlationId);
      return unchanged(true);
    }
    if (
      (evidence.amountMinor !== undefined &&
        evidence.amountMinor !== null &&
        evidence.amountMinor !== attempt.amount_minor) ||
      (evidence.currency && evidence.currency !== attempt.currency)
    ) {
      await this.conflict(trx, attempt, evidence, 'amount or currency mismatch', correlationId);
      return unchanged(true);
    }
    const event = EVENT_FOR[evidence.status];
    const target = PaymentAttemptMachine.transitions.created[event] as PaymentAttemptState;
    const terminalEvidence = ['succeeded', 'failed', 'canceled'].includes(target);
    if (terminalEvidence) {
      if (attempt.status === target) return unchanged(); // duplicate delivery: one effect
      if (PaymentAttemptMachine.isTerminal(attempt.status)) {
        // e.g. `succeeded` after `failed`: never a silent flip (§4.11, SPK-PAY-007).
        await this.conflict(
          trx,
          attempt,
          evidence,
          `${target} reported after ${attempt.status}`,
          correlationId,
        );
        if (target === 'succeeded') {
          // ...but the money the provider captured is received money all the same.
          return this.recordCaptureAfterResolution(trx, attempt, evidence, correlationId);
        }
        return unchanged(true);
      }
    } else {
      // Non-terminal evidence never moves a resolved or unknown attempt, nor goes backwards.
      if (PaymentAttemptMachine.isTerminal(attempt.status) || attempt.status === 'unknown') {
        return unchanged();
      }
      if (
        evidence.sequence !== undefined &&
        evidence.sequence !== null &&
        attempt.evidence_sequence !== null &&
        evidence.sequence <= attempt.evidence_sequence
      ) {
        return unchanged();
      }
      if (attempt.status === target || !PaymentAttemptMachine.can(attempt.status, event)) {
        return unchanged();
      }
    }
    const next = PaymentAttemptMachine.next(attempt.status, event);
    const now = this.clock.now();
    await trx
      .updateTable('payment_attempts')
      .set({
        status: next,
        provider_reference: attempt.provider_reference ?? evidence.providerReference,
        failure_reason:
          next === 'failed' || next === 'canceled' ? (evidence.failureReason ?? next) : null,
        action_required_payload:
          next === 'action_required' && evidence.actionPayload
            ? json(evidence.actionPayload)
            : null,
        processor_fee_minor: next === 'succeeded' ? (evidence.feeMinor ?? 0) : null,
        evidence_source: evidence.source,
        evidence_inbox_event_id: evidence.inboxEventId ?? null,
        evidence_sequence: evidence.sequence ?? attempt.evidence_sequence,
        resolved_at: terminalEvidence ? now : null,
        revision: attempt.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', attemptId)
      .where('revision', '=', attempt.revision)
      .execute();
    const updated = (await this.load(trx, organizationId, attemptId)) as PaymentAttemptRow;
    await this.audit.record(trx, {
      organizationId,
      actor: financeSystem(organizationId, `finance.evidence.${evidence.source}`),
      action: `finance.payment_${next}`,
      targetType: 'payment_attempt',
      targetId: attemptId,
      beforeRevision: attempt.revision,
      afterRevision: attempt.revision + 1,
      correlationId,
      details: {
        from: attempt.status,
        to: next,
        source: evidence.source,
        inboxEventId: evidence.inboxEventId ?? null,
      },
    });
    let receipt: ReceiptRow | null = null;
    let overpaymentCreditId: string | null = null;
    if (next === 'succeeded') {
      const captured = await this.onCaptured(trx, updated, correlationId);
      receipt = captured.receipt;
      overpaymentCreditId = captured.overpaymentCreditId;
    } else if (next === 'failed' || next === 'canceled') {
      await this.onFailed(trx, updated, correlationId);
    }
    return { attempt: updated, changed: true, receipt, overpaymentCreditId, conflict: false };
  }

  /**
   * §4.11 ("provider success ... must remain visible as received money"), SPK-PAY-007, SPK-PAY-011:
   * the provider reports a capture for an attempt recorded as failed or canceled. The recorded
   * state is not flipped (the machine, its database guard and payment_attempts_one_success_idx
   * forbid it) and the conflict exception stays open for review, but the money is recorded through
   * the normal capture path: receipt, journal, refundable funds and the purpose follow-up. A
   * checkout still awaiting payment finalizes on it (so no second charge is taken); money for a
   * checkout that was already paid or aborted is held as visible excess with an exception; an
   * installment's obligation settles. One receipt per attempt makes a repeated report a no-op.
   */
  private async recordCaptureAfterResolution(
    trx: Trx,
    attempt: PaymentAttemptRow,
    evidence: PaymentEvidence,
    correlationId: string | null,
  ): Promise<EvidenceOutcome> {
    const organizationId = attempt.organization_id;
    const recorded = await trx
      .selectFrom('receipts')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('payment_attempt_id', '=', attempt.id)
      .executeTakeFirst();
    if (recorded) {
      return { attempt, changed: false, receipt: null, overpaymentCreditId: null, conflict: true };
    }
    let row = attempt;
    if (!attempt.provider_reference && evidence.providerReference) {
      // A refund names the provider's payment; an attempt canceled for "no record" never had one.
      await trx
        .updateTable('payment_attempts')
        .set({ provider_reference: evidence.providerReference, revision: attempt.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .execute();
      row = (await this.load(trx, organizationId, attempt.id)) as PaymentAttemptRow;
    }
    const captured = await this.onCaptured(
      trx,
      { ...row, processor_fee_minor: evidence.feeMinor ?? 0 },
      correlationId,
    );
    await this.audit.record(trx, {
      organizationId,
      actor: financeSystem(organizationId, `finance.evidence.${evidence.source}`),
      action: `finance.payment_captured_after_${attempt.status}`,
      targetType: 'payment_attempt',
      targetId: attempt.id,
      beforeRevision: attempt.revision,
      afterRevision: row.revision,
      correlationId,
      details: {
        recordedStatus: attempt.status,
        receiptId: captured.receipt?.id ?? null,
        source: evidence.source,
        inboxEventId: evidence.inboxEventId ?? null,
      },
    });
    return {
      attempt: row,
      changed: true,
      receipt: captured.receipt,
      overpaymentCreditId: captured.overpaymentCreditId,
      conflict: true,
    };
  }

  private async conflict(
    trx: Trx,
    attempt: PaymentAttemptRow,
    evidence: PaymentEvidence,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    await this.exceptions.raise(trx, {
      organizationId: attempt.organization_id,
      category: 'finance.payment_evidence_conflict',
      severity: 'critical',
      title: `Conflicting payment evidence (${reason}); the recorded state was not changed`,
      affectedType: 'payment_attempt',
      affectedId: attempt.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `payment-conflict:${attempt.id}:${evidence.status}`,
      details: {
        reason,
        recordedStatus: attempt.status,
        reportedStatus: evidence.status,
        source: evidence.source,
        inboxEventId: evidence.inboxEventId ?? null,
        providerReference: evidence.providerReference,
        correlationId,
      },
    });
  }

  /** Money was captured: receipt, journal, allocation, refundable funds, purpose follow-up. */
  private async onCaptured(
    trx: Trx,
    attempt: PaymentAttemptRow,
    correlationId: string | null,
  ): Promise<{ receipt: ReceiptRow | null; overpaymentCreditId: string | null }> {
    if (attempt.purpose === 'pos_sale') {
      // FIN-06: a sale's card tender pays no obligation (no receipt); its finalizer settles the
      // tender, records the refundable funds and pays the sale once its tenders cover it.
      await this.posSales.onCardCaptured(trx, attempt, correlationId);
      return { receipt: null, overpaymentCreditId: null };
    }
    const organizationId = attempt.organization_id;
    const actor = financeSystem(organizationId, 'finance.payments');
    let obligationId = attempt.obligation_id;
    if (attempt.purpose === 'checkout' && attempt.order_id) {
      const due = await trx
        .selectFrom('obligations')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('order_id', '=', attempt.order_id)
        .where('status', '=', 'open')
        .orderBy('due_at')
        .orderBy('created_at')
        .executeTakeFirst();
      obligationId = due?.id ?? null;
    }
    const recorded = await this.facts.recordReceipt(trx, {
      organizationId,
      sourceKind: 'payment_attempt',
      paymentAttemptId: attempt.id,
      payerPersonId: attempt.payer_person_id,
      amountMinor: attempt.amount_minor,
      currency: attempt.currency,
      processorFeeMinor: attempt.processor_fee_minor ?? 0,
      cashAccount: 'cash_processor',
      obligationId,
      orderId: attempt.order_id,
      receivedAt: this.clock.now(),
      actor,
      correlationId,
    });
    // SPK-PAY-008: the captured amount is the refundable ceiling (reservations move it).
    await trx
      .insertInto('payment_refundables')
      .values({
        payment_attempt_id: attempt.id,
        organization_id: organizationId,
        receipt_id: recorded.receipt.id,
        currency: attempt.currency,
        captured_minor: attempt.amount_minor,
      })
      .execute();
    const now = this.clock.now();
    switch (attempt.purpose) {
      case 'checkout':
        await this.onCheckoutCaptured(trx, attempt, recorded.receipt, correlationId);
        break;
      case 'contribution':
        if (attempt.contribution_request_id) {
          await trx
            .updateTable('contribution_requests')
            .set((eb) => ({
              status: 'paid',
              paid_at: now,
              receipt_id: recorded.receipt.id,
              revision: eb('revision', '+', 1),
            }))
            .where('organization_id', '=', organizationId)
            .where('id', '=', attempt.contribution_request_id)
            .where('status', '=', 'requested')
            .execute();
        }
        break;
      case 'installment':
        // The installment is marked paid when its obligation settles (MoneyFacts).
        break;
      default:
        break;
    }
    return recorded;
  }

  private async onCheckoutCaptured(
    trx: Trx,
    attempt: PaymentAttemptRow,
    receipt: ReceiptRow,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = attempt.organization_id;
    const checkout = await trx
      .selectFrom('checkouts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', attempt.checkout_id as string)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = this.clock.now();
    if (order.payment_status === 'awaiting_payment') {
      await trx
        .updateTable('orders')
        .set({ payment_status: 'paid', paid_at: now, revision: order.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', order.id)
        .execute();
    }
    if (CheckoutMachine.can(checkout.status, 'payment_succeeded')) {
      await trx
        .updateTable('checkouts')
        .set({
          status: CheckoutMachine.next(checkout.status, 'payment_succeeded'),
          // The attempt that actually captured (a compensation refund targets it).
          payment_attempt_id: attempt.id,
          failure_code: null,
          failure_details: null,
          revision: checkout.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', checkout.id)
        .execute();
      // §4.11 step 8 runs as durable follow-up: a worker that stops here resumes it (SPK-AT-023).
      await this.outbox.enqueue(trx, FinanceEvents.checkoutPaymentReceived, {
        organizationId,
        aggregateType: 'checkout',
        aggregateId: checkout.id,
        correlationId,
        operationId: checkout.operation_id,
        payload: {
          organizationId,
          checkoutId: checkout.id,
          orderId: order.id,
          receiptId: receipt.id,
        },
      });
    } else {
      // Money arrived for a checkout that can no longer be fulfilled this way: visible, owned.
      await this.exceptions.raise(trx, {
        organizationId,
        category: 'finance.fulfillment_incomplete',
        severity: 'critical',
        title: 'Payment received for a checkout that is no longer awaiting payment',
        affectedType: 'checkout',
        affectedId: checkout.id,
        ownerQueue: 'finance_operator',
        dedupeKey: `checkout-late-money:${checkout.id}`,
        details: {
          checkoutStatus: checkout.status,
          receiptId: receipt.id,
          paymentAttemptId: attempt.id,
        },
      });
    }
    await this.outbox.enqueue(trx, FinanceEvents.orderPaid, {
      organizationId,
      aggregateType: 'order',
      aggregateId: order.id,
      correlationId,
      operationId: checkout.operation_id,
      payload: {
        organizationId,
        orderId: order.id,
        checkoutId: checkout.id,
        payerPersonId: order.payer_person_id,
        totalMinor: order.total_minor,
        currency: order.currency,
      },
    });
  }

  private async onFailed(
    trx: Trx,
    attempt: PaymentAttemptRow,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = attempt.organization_id;
    if (attempt.purpose === 'pos_sale') {
      // FIN-06: the tender fails; the sale stays open for another tender.
      await this.posSales.onCardFailed(trx, attempt, correlationId);
    }
    if (attempt.purpose === 'checkout' && attempt.checkout_id) {
      // The checkout stays awaiting payment so the payer may retry while the hold lasts.
      await trx
        .updateTable('checkouts')
        .set((eb) => ({
          failure_code: 'PAYMENT_FAILED',
          failure_details: json({ paymentAttemptId: attempt.id, reason: attempt.failure_reason }),
          revision: eb('revision', '+', 1),
        }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', attempt.checkout_id)
        .where('status', 'in', ['prepared', 'awaiting_payment'])
        .execute();
    }
    if (attempt.purpose === 'installment' && attempt.installment_id) {
      await this.onInstallmentFailed(trx, attempt, correlationId);
    }
    await this.outbox.enqueue(trx, FinanceEvents.paymentFailed, {
      organizationId,
      aggregateType: 'payment_attempt',
      aggregateId: attempt.id,
      correlationId,
      payload: {
        organizationId,
        paymentAttemptId: attempt.id,
        purpose: attempt.purpose,
        status: attempt.status === 'canceled' ? 'canceled' : 'failed',
        failureReason: attempt.failure_reason,
      },
    });
  }

  /**
   * SPK-PAY-006: a failed installment is a financial state (the obligation stays open, the
   * installment `failed` with its retry time) plus an owned action (exception for the finance
   * operator). Participation consequences are decided separately by `finance.installment_failed`
   * subscribers (POL-017).
   */
  private async onInstallmentFailed(
    trx: Trx,
    attempt: PaymentAttemptRow,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = attempt.organization_id;
    const installment = await trx
      .selectFrom('installments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', attempt.installment_id as string)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const plan = await trx
      .selectFrom('installment_plans')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', installment.plan_id)
      .executeTakeFirstOrThrow();
    const retry = plan.retry_policy as { maxAttempts: number; retryIntervalHours: number };
    const now = this.clock.now();
    const finalAttempt = installment.attempt_count >= retry.maxAttempts;
    await trx
      .updateTable('installments')
      .set({
        status: 'failed',
        failed_at: now,
        last_failure_reason: attempt.failure_reason,
        next_retry_at: finalAttempt ? null : hoursFrom(now, retry.retryIntervalHours),
        revision: installment.revision + 1,
      })
      .where('id', '=', installment.id)
      .execute();
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.installment_failed',
      severity: finalAttempt ? 'high' : 'warning',
      title: finalAttempt
        ? 'An installment failed its final collection attempt'
        : 'An installment collection failed; a retry is scheduled',
      affectedType: 'installment',
      affectedId: installment.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `installment-failed:${installment.id}`,
      details: {
        planId: plan.id,
        obligationId: installment.obligation_id,
        attemptCount: installment.attempt_count,
        maxAttempts: retry.maxAttempts,
        failureReason: attempt.failure_reason,
      },
    });
    await this.outbox.enqueue(trx, FinanceEvents.installmentFailed, {
      organizationId,
      aggregateType: 'installment',
      aggregateId: installment.id,
      correlationId,
      payload: {
        organizationId,
        installmentId: installment.id,
        planId: plan.id,
        obligationId: installment.obligation_id,
        orderId: plan.order_id,
        payerPersonId: plan.payer_person_id,
        attemptCount: installment.attempt_count,
        finalAttempt,
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reconciliation (SPK-PAY-007, §4.11 step 10)
  // -------------------------------------------------------------------------------------------

  /** POST /payments/{id}/reconcile: ask the provider for the authoritative outcome. */
  async reconcileCommand(
    principal: Principal,
    id: string,
    correlationId: string | null,
  ): Promise<PaymentAttempt> {
    const organizationId = organizationOf(principal);
    // §4.10: a finance-only command is authorized before the record is read, so a caller without
    // the role gets the same answer whether or not the payment exists.
    await this.authorization.require(principal, FinanceActions.reconcilePayment, {
      type: 'payment_attempt',
      id,
      organizationId,
    });
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('payment');
    const outcome = await this.reconcile(organizationId, id, correlationId, { force: true });
    return toPaymentAttempt(outcome.attempt);
  }

  /**
   * Reconciles one unresolved attempt from the provider's record. A record the provider has is
   * applied at once (forced or not). "No record" is authoritative absence (nothing was charged:
   * canceled) only for an attempt never handed to the provider, decided under the row lock, or
   * one last handed to it (submitted, or gone unknown) at least `reconcileAfterMinutes` ago;
   * before that the attempt stays as it is and new charges stay refused (SPK-PAY-007: a timeout
   * is not proof of failure, and a provider may not show a just-submitted request yet).
   */
  async reconcile(
    organizationId: string,
    id: string,
    correlationId: string | null,
    options: { force?: boolean } = {},
  ): Promise<EvidenceOutcome> {
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.notFound('payment attempt', id);
    const unchanged: EvidenceOutcome = {
      attempt: row,
      changed: false,
      receipt: null,
      overpaymentCreditId: null,
      conflict: false,
    };
    if (PaymentAttemptMachine.isTerminal(row.status)) return unchanged;
    const threshold = minutesFrom(
      this.clock.now(),
      -this.policy.configuration.reconcileAfterMinutes,
    );
    // A call that is still in flight (submitted, no answer yet) is never second-guessed, even by
    // a forced reconciliation: its own answer is on the way. `unknown` means the call returned.
    if (row.status !== 'unknown' && row.submitted_at && new Date(row.submitted_at) > threshold) {
      return unchanged;
    }
    if (!options.force) {
      // Unsent `created` rows are swept by database age (forced); others by their
      // application-clock instants.
      if (row.status === 'created' && !row.submitted_at) return unchanged;
      const since = new Date(row.unknown_since ?? row.submitted_at ?? this.clock.now());
      if (since > threshold) return unchanged;
    }
    const found = await this.provider.retrievePayment(row.id);
    return this.uow.run(async ({ trx }) => {
      if (!found) {
        const current = await this.load(trx, organizationId, id, true);
        if (!current) throw errors.notFound('payment attempt', id);
        const unchangedNow: EvidenceOutcome = { ...unchanged, attempt: current };
        // Evidence arrived meanwhile: a stale empty lookup must not contradict it.
        if (PaymentAttemptMachine.isTerminal(current.status)) return unchangedNow;
        // Too early to call it absence: stays as it is (unknown keeps refusing new charges).
        if (!this.absenceIsAuthoritative(current, threshold)) return unchangedNow;
      }
      return this.applyEvidence(
        trx,
        organizationId,
        id,
        found
          ? {
              status: found.status,
              providerReference: found.providerReference,
              amountMinor: found.amountMinor,
              currency: found.currency,
              feeMinor: found.feeMinor,
              failureReason: found.failureReason,
              actionPayload: found.actionPayload,
              source: 'reconciliation',
            }
          : {
              status: 'canceled',
              providerReference: null,
              failureReason: 'provider_has_no_record',
              source: 'reconciliation',
            },
        correlationId,
      );
    });
  }

  /**
   * SPK-PAY-007: "no record" proves nothing was charged only for an attempt never handed to the
   * provider (checked under the row lock, so `execute()` can no longer submit it) or last handed
   * to it (submitted, or gone unknown) at least `reconcileAfterMinutes` ago.
   */
  private absenceIsAuthoritative(row: PaymentAttemptRow, threshold: Date): boolean {
    const instants = [row.submitted_at, row.unknown_since]
      .filter((v): v is Date => v !== null && v !== undefined)
      .map((v) => new Date(v).getTime());
    if (instants.length === 0) return true;
    return Math.max(...instants) <= threshold.getTime();
  }

  /**
   * Worker sweep (SPK-PAY-007, §4.11 step 10; DEC-019 pending: the challenge validity window and
   * the cancel semantics depend on the processor): a payment challenge (`action_required`) still
   * open `actionRequiredCancelAfterMinutes` after submission is abandoned. The provider is asked to
   * cancel it, outside any transaction, and its answer is recorded as evidence: `canceled` lets the
   * checkout's expiry timer abort it and reverse its effects; a capture that won the race is
   * recorded as any capture (finalization or compensation follows). Without an answer the attempt
   * stays live, an owned exception says so, and the next pass asks again (cancel is idempotent).
   * `processing` is never canceled: the processor resolves it and reconciliation records it.
   */
  async cancelAbandoned(limit = 50): Promise<number> {
    if (this.uow.current()) {
      throw errors.internal('a provider call must never run inside a database transaction (§4.11)');
    }
    const threshold = minutesFrom(
      this.clock.now(),
      -this.policy.configuration.actionRequiredCancelAfterMinutes,
    );
    const rows = await this.db
      .selectFrom('payment_attempts')
      .select(['id', 'organization_id'])
      .where('status', '=', 'action_required')
      .where('submitted_at', '<=', threshold)
      .orderBy('submitted_at')
      .limit(limit)
      .execute();
    let changed = 0;
    for (const row of rows) {
      try {
        let result: ProviderPaymentResult | null;
        try {
          result = await this.provider.cancelPayment(row.id);
        } catch (error) {
          // A thrown error is an unknown outcome (the port's contract): nothing is assumed.
          this.logger.warn(`payment ${row.id}: cancel outcome unknown (${String(error)})`);
          await this.uow.run(({ trx }) =>
            this.raiseCancelUnanswered(trx, row.organization_id, row.id),
          );
          continue;
        }
        const outcome = await this.uow.run(({ trx }) =>
          this.applyEvidence(
            trx,
            row.organization_id,
            row.id,
            result
              ? {
                  status: result.status,
                  providerReference: result.providerReference,
                  amountMinor: result.amountMinor,
                  currency: result.currency,
                  feeMinor: result.feeMinor,
                  failureReason: result.failureReason,
                  actionPayload: result.actionPayload,
                  source: 'reconciliation',
                }
              : {
                  status: 'canceled',
                  providerReference: null,
                  failureReason: 'provider_has_no_record',
                  source: 'reconciliation',
                },
            null,
          ),
        );
        if (outcome.changed) changed += 1;
      } catch (error) {
        this.logger.warn(`cancel of abandoned payment ${row.id} failed: ${String(error)}`);
      }
    }
    return changed;
  }

  private async raiseCancelUnanswered(
    trx: Trx,
    organizationId: string,
    attemptId: string,
  ): Promise<void> {
    const attempt = await this.load(trx, organizationId, attemptId);
    if (!attempt || attempt.status !== 'action_required') return;
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.payment_action_abandoned',
      severity: 'high',
      title:
        'An abandoned payment challenge could not be canceled at the provider; it is retried and the checkout stays open',
      affectedType: 'payment_attempt',
      affectedId: attemptId,
      ownerQueue: 'finance_operator',
      dedupeKey: `payment-action-abandoned:${attemptId}`,
      details: {
        purpose: attempt.purpose,
        checkoutId: attempt.checkout_id,
        obligationId: attempt.obligation_id,
        amountMinor: attempt.amount_minor,
        currency: attempt.currency,
      },
    });
  }

  /** Worker sweep: unresolved attempts older than the reconciliation threshold. */
  async reconcileStale(limit = 50): Promise<number> {
    const minutes = this.policy.configuration.reconcileAfterMinutes;
    const threshold = minutesFrom(this.clock.now(), -minutes);
    const abandonedBefore = minutesFrom(
      this.clock.now(),
      -this.policy.configuration.actionRequiredCancelAfterMinutes,
    );
    const submitted = await this.db
      .selectFrom('payment_attempts')
      .select(['id', 'organization_id', 'status'])
      .where('status', 'in', ['created', 'action_required', 'processing', 'unknown'])
      .where((eb) =>
        eb.or([
          eb('unknown_since', '<=', threshold),
          eb.and([eb('unknown_since', 'is', null), eb('submitted_at', '<=', threshold)]),
        ]),
      )
      // Abandoned challenges belong to cancelAbandoned: they never leave this set otherwise and
      // would fill the page, starving the reconciliation of unknown outcomes (SPK-PAY-007).
      .where((eb) =>
        eb.not(
          eb.and([eb('status', '=', 'action_required'), eb('submitted_at', '<=', abandonedBefore)]),
        ),
      )
      .orderBy('created_at')
      .limit(limit)
      .execute();
    // A `created` attempt older than the threshold (database time) was never handed to the
    // provider by a process that stopped; the lookup decides whether anything was charged.
    const stranded = await this.db
      .selectFrom('payment_attempts')
      .select(['id', 'organization_id', 'status'])
      .where('status', '=', 'created')
      .where('submitted_at', 'is', null)
      .where(sql<boolean>`created_at < now() - make_interval(mins => ${minutes})`)
      .orderBy('created_at')
      .limit(limit)
      .execute();
    const rows = [...submitted, ...stranded];
    let changed = 0;
    for (const row of rows) {
      try {
        const outcome = await this.reconcile(row.organization_id, row.id, null, { force: true });
        if (outcome.changed) changed += 1;
      } catch (error) {
        this.logger.warn(`reconcile ${row.id} failed: ${String(error)}`);
      }
    }
    return changed;
  }
}
