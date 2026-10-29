import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errors,
  type CollectInstallmentInput,
  type ExtendInstallmentInput,
  type InstallmentPlan,
  type Principal,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  RecoveryMode,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  outcomeUnknownDetails,
  financeSystem,
  organizationOf,
  toInstallmentPlan,
  type InstallmentPlanRow,
  type InstallmentRow,
  type Reader,
} from '../finance.shared';
import { MoneyFacts } from './money-facts.service';
import { PaymentsService } from './payments.service';

/** The plan's notice lead time (POL-016), the default three days when it records none. */
function noticeDaysBefore(plan: InstallmentPlanRow): number {
  const days = (plan.notice_policy as { daysBefore?: unknown } | null)?.daysBefore;
  return typeof days === 'number' && Number.isFinite(days) && days >= 0 ? days : 3;
}

/**
 * Installment plans (SPK-PAY-006): amounts, due dates, authorization, retry policy, notices,
 * extensions and the outstanding obligations (one obligation per installment). Collection
 * charges the payment method the payer authorized at checkout, outside any transaction; a
 * failure is a financial state plus an owned action, never a silent retry loop.
 */
@Injectable()
export class InstallmentsService {
  private readonly logger = new Logger(InstallmentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facts: MoneyFacts,
    private readonly payments: PaymentsService,
    private readonly recovery: RecoveryMode,
  ) {}

  async planView(db: Reader, plan: InstallmentPlanRow): Promise<InstallmentPlan> {
    const installments = await db
      .selectFrom('installments')
      .selectAll()
      .where('organization_id', '=', plan.organization_id)
      .where('plan_id', '=', plan.id)
      .orderBy('sequence')
      .execute();
    let outstanding = 0;
    for (const installment of installments) {
      const obligation = await this.facts.loadObligation(
        db,
        plan.organization_id,
        installment.obligation_id,
      );
      if (obligation && obligation.status === 'open') {
        outstanding += obligation.amount_minor - obligation.allocated_minor;
      }
    }
    return toInstallmentPlan(plan, installments, outstanding);
  }

  private async loadPlan(
    db: Reader,
    organizationId: string,
    id: string,
  ): Promise<InstallmentPlanRow | undefined> {
    return db
      .selectFrom('installment_plans')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async get(principal: Principal, id: string): Promise<InstallmentPlan> {
    const organizationId = organizationOf(principal);
    const plan = await this.loadPlan(this.db, organizationId, id);
    if (!plan) throw errors.protectedNotFound('installment plan');
    await this.authorization.require(principal, FinanceActions.readCheckout, {
      type: 'installment_plan',
      id,
      organizationId,
      subjectPersonIds: [plan.payer_person_id],
      protected: true,
    });
    return this.planView(this.db, plan);
  }

  private async loadInstallment(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<InstallmentRow | undefined> {
    let q = db
      .selectFrom('installments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** POST /installments/{id}/collect (finance staff) and the worker's due sweep. */
  async collect(
    principal: Principal,
    id: string,
    input: CollectInstallmentInput,
    correlationId: string | null,
  ): Promise<InstallmentPlan> {
    const organizationId = organizationOf(principal);
    // §4.10: a finance-only command is authorized before the record is read, so a caller without
    // the role gets the same answer whether or not the installment exists.
    await this.authorization.require(principal, FinanceActions.manageInstallments, {
      type: 'installment',
      id,
      organizationId,
    });
    const existing = await this.loadInstallment(this.db, organizationId, id);
    if (!existing) throw errors.protectedNotFound('installment');
    assertExpectedRevision(input.expectedRevision, existing.revision);
    const planId = await this.collectInternal(principal, organizationId, id, correlationId);
    const plan = await this.loadPlan(this.db, organizationId, planId);
    return this.planView(this.db, plan as InstallmentPlanRow);
  }

  private async collectInternal(
    actor: Principal,
    organizationId: string,
    id: string,
    correlationId: string | null,
  ): Promise<string> {
    const attempt = await this.uow.run(async ({ trx }) => {
      const installment = await this.loadInstallment(trx, organizationId, id, true);
      if (!installment) throw errors.notFound('installment', id);
      if (installment.status !== 'scheduled' && installment.status !== 'failed') {
        throw errors.invalidTransition('Installment', installment.status, 'collect');
      }
      const plan = (await this.loadPlan(
        trx,
        organizationId,
        installment.plan_id,
      )) as InstallmentPlanRow;
      if (plan.status !== 'active')
        throw errors.invalidTransition('InstallmentPlan', plan.status, 'collect');
      await this.assertOrderCollectable(trx, organizationId, plan.order_id);
      // SPK-PAY-007, §4.7 invariant 5: one live charge per obligation, whatever its purpose (the
      // checkout attempt names the due-now installment's obligation; a payer may pay it directly).
      const live = await this.payments.liveAttempt(trx, organizationId, {
        obligationId: installment.obligation_id,
      });
      if (live) {
        if (live.purpose !== 'installment' || live.status === 'unknown') {
          throw errors.paymentOutcomeUnknown(outcomeUnknownDetails(actor, live));
        }
        return live;
      }
      const retry = plan.retry_policy as { maxAttempts: number };
      if (installment.attempt_count >= retry.maxAttempts) {
        throw errors.resourceConflict(
          'The installment used every collection attempt; extend it first.',
          {
            code: 'INSTALLMENT_ATTEMPTS_EXHAUSTED',
            attemptCount: installment.attempt_count,
          },
        );
      }
      const obligation = await this.facts.loadObligation(
        trx,
        organizationId,
        installment.obligation_id,
      );
      if (!obligation || obligation.status !== 'open') {
        throw errors.invalidTransition('Obligation', obligation?.status ?? 'missing', 'collect');
      }
      const authorization = plan.payment_authorization as { paymentMethodRef: string };
      await trx
        .updateTable('installments')
        .set({
          attempt_count: installment.attempt_count + 1,
          last_attempt_at: this.clock.now(),
          revision: installment.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', installment.revision)
        .execute();
      const created = await this.payments.createAttemptInTrx(trx, {
        organizationId,
        purpose: 'installment',
        installmentId: id,
        obligationId: obligation.id,
        orderId: plan.order_id,
        payerPersonId: plan.payer_person_id,
        amountMinor: obligation.amount_minor - obligation.allocated_minor,
        currency: obligation.currency,
        paymentMethodRef: authorization.paymentMethodRef,
        actor,
      });
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'finance.collect_installment',
        targetType: 'installment',
        targetId: id,
        beforeRevision: installment.revision,
        afterRevision: installment.revision + 1,
        correlationId,
        details: { paymentAttemptId: created.id, attempt: installment.attempt_count + 1 },
      });
      return created;
    });
    if (attempt.status === 'created') {
      await this.payments.execute(organizationId, attempt.id, correlationId);
    }
    const installment = (await this.loadInstallment(this.db, organizationId, id)) as InstallmentRow;
    return installment.plan_id;
  }

  /**
   * An installment of a plan is collected only once the checkout that created the plan has been
   * paid (SPK-PAY-007: its own charge of the due-now installment may still be in flight, processing
   * or unknown) and its registration fulfilled (SPK-AT-006, §4.11 step 10: a checkout in recovery,
   * compensated or canceled never charges for a registration the family did not receive). Staff
   * `recover` fulfils the order, and collection resumes.
   */
  private async assertOrderCollectable(
    trx: Trx,
    organizationId: string,
    orderId: string,
  ): Promise<void> {
    const order = await trx
      .selectFrom('orders')
      .select(['payment_status', 'fulfillment_status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', orderId)
      .executeTakeFirstOrThrow();
    if (order.payment_status !== 'paid') {
      throw errors.resourceConflict('The checkout payment for this plan has not settled.', {
        code: 'CHECKOUT_PAYMENT_PENDING',
        paymentStatus: order.payment_status,
      });
    }
    if (order.fulfillment_status !== 'fulfilled') {
      throw errors.invalidTransition('Order', order.fulfillment_status, 'collect_installment');
    }
  }

  /** POST /installments/{id}/extend: a new due date with a reason; retries start over. */
  async extend(
    principal: Principal,
    id: string,
    input: ExtendInstallmentInput,
    correlationId: string | null,
  ): Promise<InstallmentPlan> {
    const organizationId = organizationOf(principal);
    const planId = await this.uow.run(async ({ trx }) => {
      await this.authorization.require(principal, FinanceActions.manageInstallments, {
        type: 'installment',
        id,
        organizationId,
      });
      const installment = await this.loadInstallment(trx, organizationId, id, true);
      if (!installment) throw errors.protectedNotFound('installment');
      assertExpectedRevision(input.expectedRevision, installment.revision);
      if (installment.status !== 'scheduled' && installment.status !== 'failed') {
        throw errors.invalidTransition('Installment', installment.status, 'extend');
      }
      const dueAt = new Date(input.dueAt);
      if (dueAt <= this.clock.now())
        throw errors.validation('The new due date must be in the future.');
      const plan = (await this.loadPlan(
        trx,
        organizationId,
        installment.plan_id,
      )) as InstallmentPlanRow;
      await trx
        .updateTable('installments')
        .set({
          status: 'scheduled',
          due_at: dueAt,
          attempt_count: 0,
          next_retry_at: null,
          extension_count: installment.extension_count + 1,
          extension_reason: input.reason,
          // SPK-PAY-006 (POL-016): the new due date gets its own notice.
          notice_sent_at: null,
          revision: installment.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', installment.revision)
        .execute();
      await trx
        .updateTable('obligations')
        .set((eb) => ({ due_at: dueAt, revision: eb('revision', '+', 1) }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', installment.obligation_id)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'finance.extend_installment',
        targetType: 'installment',
        targetId: id,
        beforeRevision: installment.revision,
        afterRevision: installment.revision + 1,
        reason: input.reason,
        correlationId,
        details: { from: installment.due_at, to: dueAt.toISOString() },
      });
      await this.scheduleNotice(
        trx,
        organizationId,
        id,
        dueAt,
        correlationId,
        noticeDaysBefore(plan),
      );
      return installment.plan_id;
    });
    const plan = await this.loadPlan(this.db, organizationId, planId);
    return this.planView(this.db, plan as InstallmentPlanRow);
  }

  /** Enqueues the notice before an installment falls due (SPK-PAY-006 "Notices"). */
  async scheduleNotice(
    trx: Trx,
    organizationId: string,
    installmentId: string,
    dueAt: Date,
    correlationId: string | null,
    noticeDaysBefore?: number,
  ): Promise<void> {
    const days = noticeDaysBefore ?? 3;
    const at = new Date(Math.max(this.clock.now().getTime(), dueAt.getTime() - days * 86_400_000));
    await this.outbox.enqueue(trx, FinanceEvents.installmentNoticeDue, {
      organizationId,
      aggregateType: 'installment',
      aggregateId: installmentId,
      correlationId,
      availableAt: at,
      payload: { organizationId, installmentId },
    });
  }

  /**
   * Timer handler: records that the notice went out (once per due date) and emits it for
   * communications. A timer scheduled for an earlier due date that an extension has moved fires
   * before the new notice time and does nothing; the extension enqueued the timer for the new date.
   */
  async onNoticeDue(
    trx: Trx,
    organizationId: string,
    installmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const installment = await this.loadInstallment(trx, organizationId, installmentId, true);
    if (!installment || installment.status !== 'scheduled' || installment.notice_sent_at) return;
    const plan = (await this.loadPlan(
      trx,
      organizationId,
      installment.plan_id,
    )) as InstallmentPlanRow;
    const noticeAt = new Date(installment.due_at).getTime() - noticeDaysBefore(plan) * 86_400_000;
    if (this.clock.now().getTime() < noticeAt) return; // a timer for a due date since moved
    await trx
      .updateTable('installments')
      .set({ notice_sent_at: this.clock.now(), revision: installment.revision + 1 })
      .where('id', '=', installmentId)
      .execute();
    await this.outbox.enqueue(trx, FinanceEvents.installmentNotice, {
      organizationId,
      aggregateType: 'installment',
      aggregateId: installmentId,
      correlationId,
      payload: {
        organizationId,
        installmentId,
        payerPersonId: plan.payer_person_id,
        amountMinor: installment.amount_minor,
        currency: installment.currency,
        dueAt: new Date(installment.due_at).toISOString(),
      },
    });
  }

  /** Worker sweep: due installments and scheduled retries. */
  async collectDue(limit = 50): Promise<number> {
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('installments')
      .innerJoin('installment_plans', 'installment_plans.id', 'installments.plan_id')
      .innerJoin('orders', (join) =>
        join
          .onRef('orders.organization_id', '=', 'installment_plans.organization_id')
          .onRef('orders.id', '=', 'installment_plans.order_id'),
      )
      .select(['installments.id as id', 'installments.organization_id as organization_id'])
      .where('installment_plans.status', '=', 'active')
      // Only plans whose checkout was paid and fulfilled (see assertOrderCollectable).
      .where('orders.payment_status', '=', 'paid')
      .where('orders.fulfillment_status', '=', 'fulfilled')
      .where((eb) =>
        eb.or([
          eb.and([
            eb('installments.status', '=', 'scheduled'),
            eb('installments.due_at', '<=', now),
          ]),
          eb.and([
            eb('installments.status', '=', 'failed'),
            eb('installments.next_retry_at', '<=', now),
          ]),
        ]),
      )
      .orderBy('installments.due_at')
      .limit(limit)
      .execute();
    let collected = 0;
    const recovering = new Map<string, boolean>();
    for (const row of rows) {
      // §5.8, SPK-AT-028: on restored state a due installment may already have been charged after
      // the backup; no new charge (a new idempotency key) starts until recovery is resumed.
      let paused = recovering.get(row.organization_id);
      if (paused === undefined) {
        paused = await this.recovery.isActive(row.organization_id);
        recovering.set(row.organization_id, paused);
      }
      if (paused) continue;
      try {
        await this.collectInternal(
          financeSystem(row.organization_id, 'finance.installments'),
          row.organization_id,
          row.id,
          null,
        );
        collected += 1;
      } catch (error) {
        this.logger.warn(`installment ${row.id} collection skipped: ${String(error)}`);
      }
    }
    return collected;
  }
}
