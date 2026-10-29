import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RefundMachine,
  errors,
  newId,
  type CreateRefundInput,
  type Principal,
  type Refund,
  type RefundEvent,
  type RefundState,
} from '@sportspark/contracts';
import { json, type Db, type EvidenceSource, type RefundPurpose } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
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
  RECORD_AUTHORITY_PORT,
  type PaymentProviderPort,
  type ProviderRefundResult,
  type RecordAuthorityPort,
} from '../finance.ports';
import {
  financeSystem,
  minutesFrom,
  organizationOf,
  toRefund,
  type Reader,
  type RefundRow,
  type RefundableRow,
} from '../finance.shared';
import { LedgerService } from '../ledger/ledger.service';
import { FinancePolicyResolver } from './finance-policy.resolver';

export interface ReserveRefundInput {
  organizationId: string;
  paymentAttemptId: string;
  amountMinor: number;
  reason: string;
  purpose: RefundPurpose;
  checkoutId?: string | null;
  operationId?: string | null;
  actor: Principal;
  correlationId: string | null;
}

export interface RefundEvidence {
  status: 'succeeded' | 'failed' | 'processing';
  providerReference: string | null;
  failureReason?: string | null;
  source: EvidenceSource;
  inboxEventId?: string | null;
  sequence?: number | null;
}

/**
 * Refunds (RefundMachine, SPK-PAY-008, §4.7 invariant 6, SPK-AT-007). The refundable amount is
 * reserved BEFORE execution with a conditional UPDATE (`refunded + reserved + x <= captured`
 * under the row lock), so concurrent requests cannot reserve the same funds; the database check
 * is the final guarantee. The provider is called outside any transaction. An unknown result keeps
 * its reservation until authoritative evidence (webhook or reconciliation) settles or releases it;
 * the provider's "no record" counts as evidence only `reconcileAfterMinutes` after submission.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly ledger: LedgerService,
    private readonly policy: FinancePolicyResolver,
    @Inject(RECORD_AUTHORITY_PORT) private readonly recordAuthority: RecordAuthorityPort,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<RefundRow | undefined> {
    let q = db
      .selectFrom('refund_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async refundable(
    db: Reader,
    organizationId: string,
    paymentAttemptId: string,
  ): Promise<RefundableRow> {
    const row = await db
      .selectFrom('payment_refundables')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('refundable payment', paymentAttemptId);
    return row;
  }

  async view(db: Reader, row: RefundRow): Promise<Refund> {
    return toRefund(row, await this.refundable(db, row.organization_id, row.payment_attempt_id));
  }

  async get(principal: Principal, id: string): Promise<Refund> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('refund');
    const payment = await this.db
      .selectFrom('payment_attempts')
      .select('payer_person_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.payment_attempt_id)
      .executeTakeFirstOrThrow();
    await this.authorization.require(principal, FinanceActions.readCheckout, {
      type: 'refund',
      id,
      organizationId,
      subjectPersonIds: [payment.payer_person_id],
      protected: true,
    });
    return this.view(this.db, row);
  }

  // -------------------------------------------------------------------------------------------
  // POST /payments/{id}/refunds
  // -------------------------------------------------------------------------------------------

  async request(
    principal: Principal,
    paymentAttemptId: string,
    input: CreateRefundInput,
    correlationId: string | null,
  ): Promise<Refund> {
    const organizationId = organizationOf(principal);
    const refund = await this.uow.run(async ({ trx }) => {
      // §4.10: a finance-only command is authorized before the record is read, so a caller
      // without the role gets the same answer whether or not the payment exists.
      await this.authorization.require(principal, FinanceActions.refund, {
        type: 'payment_attempt',
        id: paymentAttemptId,
        organizationId,
      });
      const payment = await trx
        .selectFrom('payment_attempts')
        .select(['id', 'status', 'payer_person_id', 'currency'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', paymentAttemptId)
        .executeTakeFirst();
      if (!payment) throw errors.protectedNotFound('payment');
      // Refundable means captured money is recorded for the attempt (SPK-PAY-008): normally a
      // succeeded attempt, also a capture the provider reported after the attempt was recorded as
      // failed or canceled (§4.11, PaymentsService.recordCaptureAfterResolution).
      const captured = await trx
        .selectFrom('payment_refundables')
        .select('payment_attempt_id')
        .where('organization_id', '=', organizationId)
        .where('payment_attempt_id', '=', paymentAttemptId)
        .executeTakeFirst();
      if (!captured) {
        throw errors.invalidTransition('PaymentAttempt', payment.status, 'refund');
      }
      // §5.6 / §4.7 invariant 11 (authority matrix row 15): while the legacy system is the refund
      // writer, no caller — the HTTP route, support's helper or automation — reserves or executes
      // one here. Checked before anything is reserved or audited.
      await this.recordAuthority.assertNoLegacyAuthorityInEffect(organizationId, 'refund', trx);
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'finance.refund',
        requestedBy: principal,
        correlationId,
        input: { paymentAttemptId, amountMinor: input.amountMinor },
        status: 'running',
        // §4.14: a refund outcome is read by finance operators, not by every staff role.
        readScope: { action: FinanceActions.refund },
      });
      const row = await this.reserveInTrx(trx, {
        organizationId,
        paymentAttemptId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        purpose: 'customer_refund',
        operationId,
        actor: principal,
        correlationId,
      });
      return row;
    });
    const executed = await this.execute(organizationId, refund.id, correlationId);
    return this.view(this.db, executed);
  }

  /** Reserves first (invariant 6), then records the requested refund, in the caller's transaction. */
  async reserveInTrx(trx: Trx, input: ReserveRefundInput): Promise<RefundRow> {
    const reserved = await trx
      .updateTable('payment_refundables')
      .set((eb) => ({
        reserved_minor: eb('reserved_minor', '+', input.amountMinor),
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', input.organizationId)
      .where('payment_attempt_id', '=', input.paymentAttemptId)
      .where(sql<boolean>`refunded_minor + reserved_minor + ${input.amountMinor} <= captured_minor`)
      .returningAll()
      .executeTakeFirst();
    if (!reserved) {
      const current = await this.refundable(trx, input.organizationId, input.paymentAttemptId);
      const unreserved = current.captured_minor - current.refunded_minor;
      if (current.reserved_minor > 0 && input.amountMinor <= unreserved) {
        // The funds exist but a pending (possibly unknown) refund holds them (SPK-PAY-008).
        throw errors.refundPending({
          availableMinor: unreserved - current.reserved_minor,
          reservedMinor: current.reserved_minor,
        });
      }
      throw errors.resourceConflict('The refund exceeds the refundable amount.', {
        code: 'REFUND_EXCEEDS_REFUNDABLE',
        availableMinor: unreserved - current.reserved_minor,
        capturedMinor: current.captured_minor,
        refundedMinor: current.refunded_minor,
      });
    }
    const payment = await trx
      .selectFrom('payment_attempts')
      .select(['provider'])
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.paymentAttemptId)
      .executeTakeFirstOrThrow();
    const id = newId();
    await trx
      .insertInto('refund_attempts')
      .values({
        id,
        organization_id: input.organizationId,
        payment_attempt_id: input.paymentAttemptId,
        amount_minor: input.amountMinor,
        currency: reserved.currency,
        purpose: input.purpose,
        checkout_id: input.checkoutId ?? null,
        status: 'requested',
        reservation_status: 'reserved',
        reason: input.reason,
        provider: payment.provider,
        provider_reference: null,
        failure_reason: null,
        evidence_source: null,
        evidence_inbox_event_id: null,
        evidence_sequence: null,
        requested_by: json(snapshotActor(input.actor)),
        requested_by_person_id: input.actor.personId,
        operation_id: input.operationId ?? null,
        submitted_at: null,
        unknown_since: null,
        resolved_at: null,
      })
      .execute();
    await this.audit.record(trx, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: FinanceActions.refund.id,
      targetType: 'refund_attempt',
      targetId: id,
      afterRevision: 1,
      reason: input.reason,
      correlationId: input.correlationId,
      operationId: input.operationId ?? null,
      details: {
        paymentAttemptId: input.paymentAttemptId,
        amountMinor: input.amountMinor,
        purpose: input.purpose,
        reservedAfter: reserved.reserved_minor,
      },
    });
    await this.outbox.enqueue(trx, FinanceEvents.refundRequested, {
      organizationId: input.organizationId,
      aggregateType: 'refund_attempt',
      aggregateId: id,
      correlationId: input.correlationId,
      operationId: input.operationId ?? null,
      payload: {
        organizationId: input.organizationId,
        refundAttemptId: id,
        paymentAttemptId: input.paymentAttemptId,
        amountMinor: input.amountMinor,
        currency: reserved.currency,
        purpose: input.purpose,
      },
    });
    return (await this.load(trx, input.organizationId, id)) as RefundRow;
  }

  /** Cancels a refund that was never sent (`requested`), releasing its reservation. */
  async cancelRequestedInTrx(trx: Trx, row: RefundRow, actor: Principal): Promise<boolean> {
    if (row.status !== 'requested') return false;
    await this.releaseReservation(trx, row);
    await trx
      .updateTable('refund_attempts')
      .set({
        status: RefundMachine.next('requested', 'cancel'),
        reservation_status: 'released',
        resolved_at: this.clock.now(),
        revision: row.revision + 1,
      })
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor,
      action: 'finance.refund_canceled',
      targetType: 'refund_attempt',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
    });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Execution outside any transaction
  // -------------------------------------------------------------------------------------------

  async execute(
    organizationId: string,
    refundId: string,
    correlationId: string | null,
  ): Promise<RefundRow> {
    if (this.uow.current()) {
      throw errors.internal('a provider call must never run inside a database transaction (§4.11)');
    }
    const submitted = await this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, refundId, true);
      if (!row) throw errors.notFound('refund', refundId);
      if (row.status !== 'requested') return null;
      const payment = await trx
        .selectFrom('payment_attempts')
        .select(['provider_reference'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', row.payment_attempt_id)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('refund_attempts')
        .set({
          status: RefundMachine.next(row.status, 'process'),
          submitted_at: this.clock.now(),
          revision: row.revision + 1,
        })
        .where('id', '=', refundId)
        .where('revision', '=', row.revision)
        .execute();
      return { row, providerPaymentReference: payment.provider_reference as string };
    });
    if (!submitted) return (await this.load(this.db, organizationId, refundId)) as RefundRow;
    let result: ProviderRefundResult;
    try {
      result = await this.provider.createRefund({
        idempotencyKey: refundId,
        providerPaymentReference: submitted.providerPaymentReference,
        amountMinor: submitted.row.amount_minor,
        currency: submitted.row.currency,
        metadata: { organizationId, refundAttemptId: refundId },
      });
    } catch (error) {
      this.logger.warn(`refund ${refundId}: outcome unknown (${String(error)})`);
      return this.uow.run(({ trx }) =>
        this.markUnknown(trx, organizationId, refundId, correlationId),
      );
    }
    return this.uow.run(({ trx }) =>
      this.applyEvidence(
        trx,
        organizationId,
        refundId,
        {
          status: result.status,
          providerReference: result.providerReference,
          failureReason: result.failureReason,
          source: 'sync_response',
        },
        correlationId,
      ),
    );
  }

  private async markUnknown(
    trx: Trx,
    organizationId: string,
    refundId: string,
    correlationId: string | null,
  ): Promise<RefundRow> {
    const row = await this.load(trx, organizationId, refundId, true);
    if (!row) throw errors.notFound('refund', refundId);
    if (!RefundMachine.can(row.status, 'lose_track')) return row;
    await trx
      .updateTable('refund_attempts')
      .set({
        status: RefundMachine.next(row.status, 'lose_track'),
        unknown_since: this.clock.now(),
        revision: row.revision + 1,
      })
      .where('id', '=', refundId)
      .where('revision', '=', row.revision)
      .execute();
    // The reservation is kept: the funds may already have left (SPK-PAY-008).
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.unknown_refund_outcome',
      severity: 'critical',
      title: 'A refund outcome is unknown; its reservation is kept until reconciliation',
      affectedType: 'refund_attempt',
      affectedId: refundId,
      ownerQueue: 'finance_operator',
      dedupeKey: `refund-unknown:${refundId}`,
      details: {
        paymentAttemptId: row.payment_attempt_id,
        amountMinor: row.amount_minor,
        currency: row.currency,
        correlationId,
      },
    });
    return (await this.load(trx, organizationId, refundId)) as RefundRow;
  }

  async applyEvidence(
    trx: Trx,
    organizationId: string,
    refundId: string,
    evidence: RefundEvidence,
    correlationId: string | null,
  ): Promise<RefundRow> {
    const row = await this.load(trx, organizationId, refundId, true);
    if (!row) throw errors.notFound('refund', refundId);
    if (evidence.status === 'processing') return row; // still pending: nothing changes
    const event: RefundEvent = evidence.status === 'succeeded' ? 'succeed' : 'fail';
    const target: RefundState = evidence.status;
    if (row.status === target) return row; // duplicate delivery
    if (RefundMachine.isTerminal(row.status) || !RefundMachine.can(row.status, event)) {
      await this.exceptions.raise(trx, {
        organizationId,
        category: 'finance.refund_evidence_conflict',
        severity: 'critical',
        title: `Conflicting refund evidence (${target} after ${row.status}); nothing was changed`,
        affectedType: 'refund_attempt',
        affectedId: refundId,
        ownerQueue: 'finance_operator',
        dedupeKey: `refund-conflict:${refundId}:${target}`,
        details: { recordedStatus: row.status, reportedStatus: target, source: evidence.source },
      });
      return row;
    }
    const now = this.clock.now();
    const actor = financeSystem(organizationId, `finance.refund.${evidence.source}`);
    if (target === 'succeeded') {
      await trx
        .updateTable('payment_refundables')
        .set((eb) => ({
          reserved_minor: eb('reserved_minor', '-', row.amount_minor),
          refunded_minor: eb('refunded_minor', '+', row.amount_minor),
          revision: eb('revision', '+', 1),
        }))
        .where('organization_id', '=', organizationId)
        .where('payment_attempt_id', '=', row.payment_attempt_id)
        .execute();
      await this.ledger.post(trx, {
        organizationId,
        sourceType: 'refund',
        sourceId: refundId,
        purpose: 'refund_settled',
        description: row.purpose === 'compensation' ? 'Compensation refund' : 'Customer refund',
        currency: row.currency,
        actor,
        correlationId,
        lines: [
          { account: 'refunds', debitMinor: row.amount_minor },
          { account: 'cash_processor', creditMinor: row.amount_minor },
        ],
      });
    } else {
      await this.releaseReservation(trx, row);
    }
    await trx
      .updateTable('refund_attempts')
      .set({
        status: RefundMachine.next(row.status, event),
        reservation_status: target === 'succeeded' ? 'settled' : 'released',
        provider_reference: row.provider_reference ?? evidence.providerReference,
        failure_reason: target === 'failed' ? (evidence.failureReason ?? 'failed') : null,
        evidence_source: evidence.source,
        evidence_inbox_event_id: evidence.inboxEventId ?? null,
        evidence_sequence: evidence.sequence ?? row.evidence_sequence,
        resolved_at: now,
        revision: row.revision + 1,
      })
      .where('id', '=', refundId)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: `finance.refund_${target}`,
      targetType: 'refund_attempt',
      targetId: refundId,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      operationId: row.operation_id,
      details: { from: row.status, source: evidence.source },
    });
    if (row.operation_id) {
      await this.operations.transition(
        trx,
        row.operation_id,
        target === 'succeeded' ? 'succeeded' : 'failed',
        target === 'succeeded'
          ? { result: { refundAttemptId: refundId, amountMinor: row.amount_minor } }
          : {
              error: { code: 'REFUND_FAILED', message: evidence.failureReason ?? 'refund failed' },
            },
      );
    }
    await this.outbox.enqueue(trx, FinanceEvents.refundSettled, {
      organizationId,
      aggregateType: 'refund_attempt',
      aggregateId: refundId,
      correlationId,
      payload: {
        organizationId,
        refundAttemptId: refundId,
        paymentAttemptId: row.payment_attempt_id,
        status: target,
        purpose: row.purpose,
        checkoutId: row.checkout_id,
      },
    });
    return (await this.load(trx, organizationId, refundId)) as RefundRow;
  }

  private async releaseReservation(trx: Trx, row: RefundRow): Promise<void> {
    await trx
      .updateTable('payment_refundables')
      .set((eb) => ({
        reserved_minor: eb('reserved_minor', '-', row.amount_minor),
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', row.organization_id)
      .where('payment_attempt_id', '=', row.payment_attempt_id)
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------------------------

  async reconcileCommand(
    principal: Principal,
    id: string,
    correlationId: string | null,
  ): Promise<Refund> {
    const organizationId = organizationOf(principal);
    // §4.10: authorized before the record is read (no existence oracle for non-finance callers).
    await this.authorization.require(principal, FinanceActions.reconcilePayment, {
      type: 'refund_attempt',
      id,
      organizationId,
    });
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('refund');
    const updated = await this.reconcile(organizationId, id, correlationId);
    return this.view(this.db, updated);
  }

  /**
   * Reconciles one submitted refund from the provider's record (SPK-PAY-008, SPK-AT-007). A record
   * the provider has is applied at any time (forced by staff or swept). "No record" means the
   * provider never received the refund only once it was last handed to it (submitted, or gone
   * unknown) at least `reconcileAfterMinutes` ago: before that the call may still be in flight, or
   * the provider may not show a just-timed-out request yet, so the refund and its reservation stay
   * as they are (§4.7 invariant 6: releasing them early would let a second refund over-refund).
   */
  async reconcile(
    organizationId: string,
    id: string,
    correlationId: string | null,
  ): Promise<RefundRow> {
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.notFound('refund', id);
    if (RefundMachine.isTerminal(row.status) || row.status === 'requested') return row;
    const found = await this.provider.retrieveRefund(row.id);
    return this.uow.run(async ({ trx }) => {
      if (!found) {
        const current = await this.load(trx, organizationId, id, true);
        if (!current) throw errors.notFound('refund', id);
        if (RefundMachine.isTerminal(current.status) || !this.absenceIsAuthoritative(current)) {
          return current;
        }
        // The provider never received it: nothing left, so the reservation is released.
        return this.applyEvidence(
          trx,
          organizationId,
          id,
          {
            status: 'failed',
            providerReference: null,
            failureReason: 'provider_has_no_record',
            source: 'reconciliation',
          },
          correlationId,
        );
      }
      return this.applyEvidence(
        trx,
        organizationId,
        id,
        {
          status: found.status,
          providerReference: found.providerReference,
          failureReason: found.failureReason,
          source: 'reconciliation',
        },
        correlationId,
      );
    });
  }

  /** "No record" is conclusive only `reconcileAfterMinutes` after the refund was last handed over. */
  private absenceIsAuthoritative(row: RefundRow): boolean {
    const threshold = minutesFrom(
      this.clock.now(),
      -this.policy.configuration.reconcileAfterMinutes,
    );
    const instants = [row.submitted_at, row.unknown_since]
      .filter((v): v is Date => v !== null && v !== undefined)
      .map((v) => new Date(v).getTime());
    if (instants.length === 0) return false;
    return Math.max(...instants) <= threshold.getTime();
  }

  /** Worker sweep: execute requested refunds, reconcile stale processing/unknown ones. */
  async runPending(limit = 50): Promise<{ executed: number; reconciled: number }> {
    const requested = await this.db
      .selectFrom('refund_attempts')
      .select(['id', 'organization_id'])
      .where('status', '=', 'requested')
      .orderBy('created_at')
      .limit(limit)
      .execute();
    let executed = 0;
    for (const row of requested) {
      try {
        await this.execute(row.organization_id, row.id, null);
        executed += 1;
      } catch (error) {
        this.logger.warn(`refund ${row.id} execution failed: ${String(error)}`);
      }
    }
    const threshold = minutesFrom(
      this.clock.now(),
      -this.policy.configuration.reconcileAfterMinutes,
    );
    const stale = await this.db
      .selectFrom('refund_attempts')
      .select(['id', 'organization_id'])
      .where('status', 'in', ['processing', 'unknown'])
      .where((eb) =>
        eb.or([
          eb('unknown_since', '<=', threshold),
          eb.and([eb('unknown_since', 'is', null), eb('submitted_at', '<=', threshold)]),
        ]),
      )
      .limit(limit)
      .execute();
    let reconciled = 0;
    for (const row of stale) {
      try {
        const before = await this.load(this.db, row.organization_id, row.id);
        const after = await this.reconcile(row.organization_id, row.id, null);
        if (before?.status !== after.status) reconciled += 1;
      } catch (error) {
        this.logger.warn(`refund ${row.id} reconciliation failed: ${String(error)}`);
      }
    }
    return { executed, reconciled };
  }
}
