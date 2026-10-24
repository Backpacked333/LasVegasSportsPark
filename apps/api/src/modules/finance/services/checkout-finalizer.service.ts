import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CheckoutMachine,
  DomainError,
  PaymentAttemptMachine,
  errors,
  type CheckoutRecovery,
  type CompensateCheckoutInput,
  type Principal,
  type QuoteDiscountLine,
  type RecoverCheckoutInput,
  type AbortCheckoutInput,
} from '@sportspark/contracts';
import { json, type CheckoutsTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PRICING_PORT, type PricingPort } from '../../catalog';
import {
  BASKET_PORT,
  ENROLLMENT_PORT,
  type BasketPort,
  type EnrollmentPort,
} from '../../enrollment';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import type { CompensationMethod } from '../finance.policy';
import {
  financeSystem,
  minutesFrom,
  organizationOf,
  withSavepoint,
  type Reader,
} from '../finance.shared';
import { LedgerService } from '../ledger/ledger.service';
import { FinancePolicyResolver } from './finance-policy.resolver';
import { MoneyFacts } from './money-facts.service';
import { RefundsService } from './refunds.service';

export type CheckoutRow = Selectable<CheckoutsTable>;

/** Failures that will not go away by retrying: the place or the entitlement is gone (SPK-AT-006). */
const DEFINITIVE = new Set(['CAPACITY_UNAVAILABLE', 'DUPLICATE_ENTITLEMENT', 'INVALID_TRANSITION']);

/**
 * §4.11 steps 8–10 for registration checkouts. Finalization confirms every enrollment through
 * enrollment's EnrollmentPort (commit holds, or re-acquire a still-free place; never displace a
 * waitlist offer) together with the order and checkout state in ONE transaction. If finalization
 * fails after the money was received, the failure stays visible as received money plus
 * incomplete fulfillment: checkout and operation `recovery_required`, an owned exception, and a
 * compensation plan per policy (refund or credit, DEC-009). Every step is idempotent so a
 * redelivered follow-up never confirms twice or posts twice (SPK-AT-023).
 */
@Injectable()
export class CheckoutFinalizer {
  private readonly logger = new Logger(CheckoutFinalizer.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENROLLMENT_PORT) private readonly enrollments: EnrollmentPort,
    @Inject(BASKET_PORT) private readonly baskets: BasketPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly ledger: LedgerService,
    private readonly facts: MoneyFacts,
    private readonly refunds: RefundsService,
    private readonly policy: FinancePolicyResolver,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<CheckoutRow | undefined> {
    let q = db
      .selectFrom('checkouts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // Finalization (step 8)
  // -------------------------------------------------------------------------------------------

  /**
   * Inline finalization right after the evidence committed. An unexpected (non-domain) error
   * leaves the checkout `finalizing`: the durable `finance.checkout_payment_received` follow-up
   * retries it (SPK-AT-023).
   */
  async finalize(
    organizationId: string,
    checkoutId: string,
    correlationId: string | null,
  ): Promise<void> {
    try {
      await this.uow.run(({ trx }) =>
        this.finalizeInTrx(trx, organizationId, checkoutId, correlationId),
      );
    } catch (error) {
      this.logger.warn(
        `checkout ${checkoutId} finalization deferred to the outbox: ${String(error)}`,
      );
    }
  }

  async finalizeInTrx(
    trx: Trx,
    organizationId: string,
    checkoutId: string,
    correlationId: string | null,
  ): Promise<CheckoutRow> {
    const checkout = await this.load(trx, organizationId, checkoutId, true);
    if (!checkout) throw errors.notFound('checkout', checkoutId);
    if (checkout.status !== 'finalizing') return checkout; // replay: already completed or in recovery
    const actor = financeSystem(organizationId, 'finance.checkout');
    try {
      await withSavepoint(trx, 'finalize_checkout', () =>
        this.fulfill(trx, checkout, 'finalized', actor, correlationId),
      );
    } catch (error) {
      if (!DomainError.is(error)) throw error;
      await this.markRecoveryRequired(trx, checkout, error, correlationId);
    }
    return (await this.load(trx, organizationId, checkoutId)) as CheckoutRow;
  }

  private async fulfill(
    trx: Trx,
    checkout: CheckoutRow,
    event: 'finalized' | 'recovered',
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = checkout.organization_id;
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const lines = await trx
      .selectFrom('order_lines')
      .select(['enrollment_id'])
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', order.id)
      .orderBy('sequence')
      .execute();
    const enrollmentIds = lines.map((l) => l.enrollment_id).filter((id): id is string => !!id);
    for (const enrollmentId of enrollmentIds) {
      // Replay-safe on the enrollment side: a confirmed enrollment returns as it is.
      await this.enrollments.confirmEnrollment(trx, organizationId, enrollmentId, {
        orderRef: order.id,
        actor,
        correlationId,
        operationId: checkout.operation_id,
      });
    }
    await this.baskets.finishCheckout(trx, organizationId, checkout.basket_id, 'fulfilled', actor);
    const now = this.clock.now();
    await trx
      .updateTable('orders')
      .set({ fulfillment_status: 'fulfilled', fulfilled_at: now, revision: order.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', order.id)
      .execute();
    await trx
      .updateTable('checkouts')
      .set({
        status: CheckoutMachine.next(checkout.status, event),
        completed_at: now,
        enrollment_ids: json(enrollmentIds),
        revision: checkout.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.id)
      .where('revision', '=', checkout.revision)
      .execute();
    await this.operations.transition(trx, checkout.operation_id, 'succeeded', {
      result: {
        checkoutId: checkout.id,
        orderId: order.id,
        enrollmentIds,
        recovered: event === 'recovered',
      },
    });
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: event === 'recovered' ? 'finance.checkout_recovered' : 'finance.checkout_completed',
      targetType: 'checkout',
      targetId: checkout.id,
      beforeRevision: checkout.revision,
      afterRevision: checkout.revision + 1,
      correlationId,
      operationId: checkout.operation_id,
      details: { orderId: order.id, enrollmentIds },
    });
    await this.outbox.enqueue(trx, FinanceEvents.enrollmentFulfilled, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkout.id,
      correlationId,
      operationId: checkout.operation_id,
      payload: {
        organizationId,
        checkoutId: checkout.id,
        orderId: order.id,
        enrollmentIds,
        recovered: event === 'recovered',
      },
    });
  }

  /**
   * §4.11: provider success followed by local finalization failure stays visible as received
   * money plus incomplete fulfillment, with an owned exception and a compensation plan.
   */
  private async markRecoveryRequired(
    trx: Trx,
    checkout: CheckoutRow,
    error: DomainError,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = checkout.organization_id;
    const now = this.clock.now();
    const resolved = await this.policy.resolve(organizationId, now, trx);
    let plan: CompensationMethod = DEFINITIVE.has(error.code)
      ? resolved.config.compensation
      : 'manual';
    if (plan === 'refund' && checkout.payment_kind !== 'provider') plan = 'manual';
    const exception = await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.fulfillment_incomplete',
      severity: 'critical',
      title: 'Payment received but the registration could not be fulfilled',
      affectedType: 'checkout',
      affectedId: checkout.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `checkout-recovery:${checkout.id}`,
      details: {
        orderId: checkout.order_id,
        reasonCode: error.code,
        reason: error.message,
        details: error.details ?? null,
        plan,
      },
    });
    const recovery: CheckoutRecovery = {
      reasonCode: error.code,
      message: error.message,
      plan,
      refundAttemptId: null,
      creditId: null,
      exceptionId: exception.id,
    };
    await trx
      .updateTable('checkouts')
      .set({
        status: CheckoutMachine.next(checkout.status, 'finalization_failed'),
        recovery_required_at: now,
        failure_code: error.code,
        failure_details: json({ message: error.message, details: error.details ?? null }),
        recovery: json(recovery),
        revision: checkout.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.id)
      .where('revision', '=', checkout.revision)
      .execute();
    await trx
      .updateTable('orders')
      .set((eb) => ({ fulfillment_status: 'recovery_required', revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.order_id)
      .where('fulfillment_status', '=', 'pending')
      .execute();
    await this.operations.transition(trx, checkout.operation_id, 'recovery_required', {
      error: { code: error.code, message: error.message, details: error.details },
    });
    const actor = financeSystem(organizationId, 'finance.checkout');
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.checkout_recovery_required',
      targetType: 'checkout',
      targetId: checkout.id,
      beforeRevision: checkout.revision,
      afterRevision: checkout.revision + 1,
      correlationId,
      operationId: checkout.operation_id,
      details: { reasonCode: error.code, plan },
    });
    await this.outbox.enqueue(trx, FinanceEvents.checkoutRecoveryRequired, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkout.id,
      correlationId,
      operationId: checkout.operation_id,
      payload: {
        organizationId,
        checkoutId: checkout.id,
        orderId: checkout.order_id,
        reasonCode: error.code,
        plan,
      },
    });
    const current = (await this.load(trx, organizationId, checkout.id)) as CheckoutRow;
    if (plan === 'refund') {
      await this.startRefundCompensation(
        trx,
        current,
        `Compensation: ${error.code}`,
        actor,
        correlationId,
      );
    } else if (plan === 'credit') {
      await this.compensateWithCredit(
        trx,
        current,
        `Compensation: ${error.code}`,
        actor,
        correlationId,
      );
    }
  }

  private async startRefundCompensation(
    trx: Trx,
    checkout: CheckoutRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (!checkout.payment_attempt_id) throw errors.internal('a refund needs the captured payment');
    const refundable = await this.refunds.refundable(
      trx,
      checkout.organization_id,
      checkout.payment_attempt_id,
    );
    const available =
      refundable.captured_minor - refundable.refunded_minor - refundable.reserved_minor;
    if (available <= 0) throw errors.refundPending({ checkoutId: checkout.id });
    const refund = await this.refunds.reserveInTrx(trx, {
      organizationId: checkout.organization_id,
      paymentAttemptId: checkout.payment_attempt_id,
      amountMinor: available,
      reason,
      purpose: 'compensation',
      checkoutId: checkout.id,
      actor,
      correlationId,
    });
    await this.updateRecovery(trx, checkout, { plan: 'refund', refundAttemptId: refund.id });
  }

  private async compensateWithCredit(
    trx: Trx,
    checkout: CheckoutRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = checkout.organization_id;
    const receipts = await trx
      .selectFrom('receipts')
      .select(['amount_minor', 'currency'])
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', checkout.order_id)
      .execute();
    const amount = receipts.reduce((acc, r) => acc + r.amount_minor, 0);
    const currency = receipts[0]?.currency;
    let creditId: string | null = null;
    if (amount > 0 && currency) {
      creditId = await this.facts.insertCredit(trx, {
        organizationId,
        ownerPersonId: checkout.payer_person_id,
        currency,
        amountMinor: amount,
        permittedUses: ['registration', 'obligation'],
        sourceKind: 'compensation',
        sourceId: checkout.id,
        status: 'active',
        reason,
        actor,
      });
      await this.ledger.post(trx, {
        organizationId,
        sourceType: 'credit',
        sourceId: creditId,
        purpose: 'credit_issued',
        description: 'Compensation credit for an unfulfilled registration',
        currency,
        actor,
        correlationId,
        lines: [
          {
            account: 'refunds',
            debitMinor: amount,
            personId: checkout.payer_person_id,
            orderId: checkout.order_id,
          },
          { account: 'credits_payable', creditMinor: amount, personId: checkout.payer_person_id },
        ],
      });
    }
    await this.updateRecovery(trx, checkout, { plan: 'credit', creditId });
    const current = (await this.load(trx, organizationId, checkout.id, true)) as CheckoutRow;
    await this.completeCompensationInTrx(
      trx,
      current,
      { method: 'credit', refundAttemptId: null, creditId },
      actor,
      correlationId,
    );
  }

  private async updateRecovery(
    trx: Trx,
    checkout: CheckoutRow,
    patch: Partial<CheckoutRecovery>,
  ): Promise<void> {
    const current = (checkout.recovery ?? {}) as CheckoutRecovery;
    await trx
      .updateTable('checkouts')
      .set((eb) => ({ recovery: json({ ...current, ...patch }), revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', checkout.organization_id)
      .where('id', '=', checkout.id)
      .execute();
  }

  /** The compensation finished: pending participation released, checkout and operation compensated. */
  async completeCompensationInTrx(
    trx: Trx,
    checkout: CheckoutRow,
    outcome: {
      method: 'refund' | 'credit';
      refundAttemptId: string | null;
      creditId: string | null;
    },
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (checkout.status !== 'recovery_required') return;
    const organizationId = checkout.organization_id;
    const lines = await trx
      .selectFrom('order_lines')
      .select('enrollment_id')
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', checkout.order_id)
      .execute();
    for (const line of lines) {
      if (!line.enrollment_id) continue;
      const enrollment = await this.enrollments.getEnrollment(
        organizationId,
        line.enrollment_id,
        trx,
      );
      if (enrollment?.status === 'pending') {
        await this.enrollments.failConfirmation(
          trx,
          organizationId,
          line.enrollment_id,
          'checkout_compensated',
          actor,
          correlationId,
        );
      }
    }
    await this.baskets.finishCheckout(trx, organizationId, checkout.basket_id, 'abandoned', actor);
    const now = this.clock.now();
    await trx
      .updateTable('orders')
      .set((eb) => ({ fulfillment_status: 'compensated', revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.order_id)
      .where('fulfillment_status', '=', 'recovery_required')
      .execute();
    await trx
      .updateTable('checkouts')
      .set({
        status: CheckoutMachine.next(checkout.status, 'compensate'),
        compensated_at: now,
        recovery: json({
          ...((checkout.recovery ?? {}) as CheckoutRecovery),
          plan: outcome.method,
          refundAttemptId: outcome.refundAttemptId,
          creditId: outcome.creditId,
        }),
        revision: checkout.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.id)
      .where('revision', '=', checkout.revision)
      .execute();
    await this.operations.transition(trx, checkout.operation_id, 'compensated', {
      result: { checkoutId: checkout.id, ...outcome },
    });
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.checkout_compensated',
      targetType: 'checkout',
      targetId: checkout.id,
      beforeRevision: checkout.revision,
      afterRevision: checkout.revision + 1,
      correlationId,
      operationId: checkout.operation_id,
      details: outcome,
    });
    await this.outbox.enqueue(trx, FinanceEvents.checkoutCompensated, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkout.id,
      correlationId,
      operationId: checkout.operation_id,
      payload: { organizationId, checkoutId: checkout.id, orderId: checkout.order_id, ...outcome },
    });
  }

  /** Outbox handler on `finance.refund_settled` for compensation refunds. */
  async onRefundSettled(
    trx: Trx,
    organizationId: string,
    payload: {
      refundAttemptId: string;
      checkoutId: string | null;
      status: 'succeeded' | 'failed';
      purpose: string;
    },
    correlationId: string | null,
  ): Promise<void> {
    if (payload.purpose !== 'compensation' || !payload.checkoutId) return;
    const checkout = await this.load(trx, organizationId, payload.checkoutId, true);
    if (!checkout || checkout.status !== 'recovery_required') return;
    const actor = financeSystem(organizationId, 'finance.compensation');
    if (payload.status === 'succeeded') {
      await this.completeCompensationInTrx(
        trx,
        checkout,
        { method: 'refund', refundAttemptId: payload.refundAttemptId, creditId: null },
        actor,
        correlationId,
      );
      return;
    }
    await this.updateRecovery(trx, checkout, {
      plan: 'manual',
      refundAttemptId: payload.refundAttemptId,
    });
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.compensation_failed',
      severity: 'critical',
      title: 'A compensation refund failed; the checkout still needs recovery',
      affectedType: 'checkout',
      affectedId: checkout.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `compensation-failed:${payload.refundAttemptId}`,
      details: { refundAttemptId: payload.refundAttemptId },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Staff recovery commands
  // -------------------------------------------------------------------------------------------

  async recover(
    principal: Principal,
    id: string,
    input: RecoverCheckoutInput,
    correlationId: string | null,
  ): Promise<CheckoutRow> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const checkout = await this.load(trx, organizationId, id, true);
      if (!checkout) throw errors.protectedNotFound('checkout');
      await this.authorization.require(principal, FinanceActions.recoverCheckout, {
        type: 'checkout',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, checkout.revision);
      if (checkout.status !== 'recovery_required') {
        throw errors.invalidTransition('Checkout', checkout.status, 'recovered');
      }
      const recovery = (checkout.recovery ?? {}) as CheckoutRecovery;
      if (recovery.refundAttemptId) {
        const refund = await this.refunds.load(trx, organizationId, recovery.refundAttemptId, true);
        if (
          refund &&
          refund.status !== 'requested' &&
          refund.status !== 'failed' &&
          refund.status !== 'canceled'
        ) {
          // Money may already be on its way back: recovery would fulfil a refunded registration.
          throw errors.refundPending({ refundAttemptId: refund.id, status: refund.status });
        }
        if (refund) await this.refunds.cancelRequestedInTrx(trx, refund, principal);
      }
      await trx
        .updateTable('checkouts')
        .set((eb) => ({ recovery_attempts: eb('recovery_attempts', '+', 1) }))
        .where('id', '=', id)
        .execute();
      const fresh = (await this.load(trx, organizationId, id, true)) as CheckoutRow;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.recoverCheckout.id,
        targetType: 'checkout',
        targetId: id,
        beforeRevision: checkout.revision,
        afterRevision: fresh.revision,
        reason: input.reason,
        correlationId,
        operationId: checkout.operation_id,
      });
      // A domain failure (still no place) propagates to the caller; nothing changes then.
      await this.fulfill(trx, fresh, 'recovered', principal, correlationId);
      return (await this.load(trx, organizationId, id)) as CheckoutRow;
    });
  }

  async compensate(
    principal: Principal,
    id: string,
    input: CompensateCheckoutInput,
    correlationId: string | null,
  ): Promise<CheckoutRow> {
    const organizationId = organizationOf(principal);
    const row = await this.uow.run(async ({ trx }) => {
      const checkout = await this.load(trx, organizationId, id, true);
      if (!checkout) throw errors.protectedNotFound('checkout');
      await this.authorization.require(principal, FinanceActions.recoverCheckout, {
        type: 'checkout',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, checkout.revision);
      if (checkout.status !== 'recovery_required') {
        throw errors.invalidTransition('Checkout', checkout.status, 'compensate');
      }
      const recovery = (checkout.recovery ?? {}) as CheckoutRecovery;
      if (recovery.refundAttemptId) {
        const refund = await this.refunds.load(trx, organizationId, recovery.refundAttemptId);
        if (refund && !['failed', 'canceled'].includes(refund.status)) {
          throw errors.refundPending({ refundAttemptId: refund.id, status: refund.status });
        }
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FinanceActions.recoverCheckout.id,
        targetType: 'checkout',
        targetId: id,
        beforeRevision: checkout.revision,
        reason: input.reason,
        correlationId,
        operationId: checkout.operation_id,
        details: { method: input.method },
      });
      if (input.method === 'refund') {
        if (checkout.payment_kind !== 'provider') {
          throw errors.validation('Only a provider payment can be refunded through the provider.');
        }
        await this.startRefundCompensation(trx, checkout, input.reason, principal, correlationId);
      } else {
        await this.compensateWithCredit(trx, checkout, input.reason, principal, correlationId);
      }
      return (await this.load(trx, organizationId, id)) as CheckoutRow;
    });
    await this.executePendingCompensation(row);
    return (await this.load(this.db, organizationId, id)) as CheckoutRow;
  }

  /** Runs a requested compensation refund outside any transaction (the worker does so too). */
  async executePendingCompensation(checkout: CheckoutRow): Promise<void> {
    const recovery = (checkout.recovery ?? null) as CheckoutRecovery | null;
    if (!recovery?.refundAttemptId) return;
    const refund = await this.refunds.load(
      this.db,
      checkout.organization_id,
      recovery.refundAttemptId,
    );
    if (refund?.status === 'requested') {
      await this.refunds.execute(checkout.organization_id, refund.id, null);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Abort (payer, staff, or the expiry timer)
  // -------------------------------------------------------------------------------------------

  async abort(
    principal: Principal,
    id: string,
    input: AbortCheckoutInput,
    correlationId: string | null,
  ): Promise<CheckoutRow> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const checkout = await this.load(trx, organizationId, id, true);
      if (!checkout) throw errors.protectedNotFound('checkout');
      await this.authorization.require(principal, FinanceActions.checkout, {
        type: 'checkout',
        id,
        organizationId,
        subjectPersonIds: [checkout.payer_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, checkout.revision);
      await this.abortInTrx(trx, checkout, input.reason, principal, correlationId);
      return (await this.load(trx, organizationId, id)) as CheckoutRow;
    });
  }

  async abortInTrx(
    trx: Trx,
    checkout: CheckoutRow,
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (!CheckoutMachine.can(checkout.status, 'abort')) {
      throw errors.invalidTransition('Checkout', checkout.status, 'abort');
    }
    const organizationId = checkout.organization_id;
    const now = this.clock.now();
    const live = await trx
      .selectFrom('payment_attempts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('checkout_id', '=', checkout.id)
      .where('status', 'in', ['created', 'action_required', 'processing', 'unknown'])
      .forUpdate()
      .execute();
    for (const attempt of live) {
      if (attempt.status !== 'created' || attempt.submitted_at) {
        // SPK-PAY-007: money may be moving; reconcile before giving the place up.
        throw errors.paymentOutcomeUnknown({
          paymentAttemptId: attempt.id,
          status: attempt.status,
        });
      }
      await trx
        .updateTable('payment_attempts')
        .set({
          status: PaymentAttemptMachine.next('created', 'cancel'),
          failure_reason: 'checkout_aborted',
          resolved_at: now,
          revision: attempt.revision + 1,
        })
        .where('id', '=', attempt.id)
        .where('revision', '=', attempt.revision)
        .execute();
    }
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.order_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('orders')
      .set({
        payment_status: 'canceled',
        fulfillment_status: 'canceled',
        canceled_at: now,
        cancel_reason: reason,
        revision: order.revision + 1,
      })
      .where('id', '=', order.id)
      .execute();
    const obligations = await trx
      .selectFrom('obligations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', order.id)
      .forUpdate()
      .execute();
    for (const obligation of obligations) {
      await this.facts.cancelObligation(trx, obligation, reason, actor, correlationId);
    }
    const redemptions = await trx
      .selectFrom('credit_redemptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('kind', '=', 'redeem')
      .where('reference_type', '=', 'order')
      .where('reference_id', '=', order.id)
      .execute();
    for (const redemption of redemptions) {
      await this.facts.reverseCreditRedemption(
        trx,
        organizationId,
        redemption.id,
        actor,
        correlationId,
      );
    }
    const quote = await trx
      .selectFrom('quotes')
      .select(['discounts'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.quote_id)
      .executeTakeFirstOrThrow();
    for (const discount of quote.discounts as unknown as QuoteDiscountLine[]) {
      await this.pricing.releaseDiscount(trx, organizationId, {
        discountDefinitionId: discount.discountDefinitionId,
        referenceType: 'order',
        referenceId: order.id,
        personId: checkout.payer_person_id,
        actor,
        correlationId,
      });
    }
    await trx
      .updateTable('installment_plans')
      .set((eb) => ({ status: 'canceled', canceled_at: now, revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', order.id)
      .where('status', '=', 'active')
      .execute();
    await trx
      .updateTable('installments')
      .set((eb) => ({ status: 'canceled', revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('plan_id', 'in', (eb) =>
        eb.selectFrom('installment_plans').select('id').where('order_id', '=', order.id),
      )
      .where('status', 'in', ['scheduled', 'failed'])
      .execute();
    await this.baskets.finishCheckout(trx, organizationId, checkout.basket_id, 'abandoned', actor);
    await trx
      .updateTable('checkouts')
      .set({
        status: CheckoutMachine.next(checkout.status, 'abort'),
        aborted_at: now,
        failure_code: checkout.failure_code ?? 'ABORTED',
        revision: checkout.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkout.id)
      .where('revision', '=', checkout.revision)
      .execute();
    await this.operations.transition(trx, checkout.operation_id, 'failed', {
      error: { code: 'CHECKOUT_ABORTED', message: reason },
    });
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.checkout_aborted',
      targetType: 'checkout',
      targetId: checkout.id,
      beforeRevision: checkout.revision,
      afterRevision: checkout.revision + 1,
      reason,
      correlationId,
      operationId: checkout.operation_id,
    });
    await this.outbox.enqueue(trx, FinanceEvents.checkoutAborted, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkout.id,
      correlationId,
      operationId: checkout.operation_id,
      payload: { organizationId, checkoutId: checkout.id, orderId: order.id, reason },
    });
  }

  /** Timer handler: an awaiting checkout without live payment is aborted after its hold expired. */
  async onExpiryDue(
    trx: Trx,
    organizationId: string,
    checkoutId: string,
    correlationId: string | null,
  ): Promise<void> {
    const checkout = await this.load(trx, organizationId, checkoutId, true);
    if (!checkout || !CheckoutMachine.can(checkout.status, 'abort')) return;
    const live = await trx
      .selectFrom('payment_attempts')
      .select(['id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('checkout_id', '=', checkoutId)
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['action_required', 'processing', 'unknown']),
          eb.and([eb('status', '=', 'created'), eb('submitted_at', 'is not', null)]),
        ]),
      )
      .executeTakeFirst();
    if (live) {
      // Reconciliation decides first; check again later (SPK-PAY-007).
      await this.outbox.enqueue(trx, FinanceEvents.checkoutExpiryDue, {
        organizationId,
        aggregateType: 'checkout',
        aggregateId: checkoutId,
        correlationId,
        availableAt: minutesFrom(
          this.clock.now(),
          this.policy.configuration.checkoutAbandonGraceMinutes,
        ),
        payload: { organizationId, checkoutId },
      });
      return;
    }
    await this.abortInTrx(
      trx,
      checkout,
      'hold_expired',
      financeSystem(organizationId, 'finance.checkout_expiry'),
      correlationId,
    );
  }
}
