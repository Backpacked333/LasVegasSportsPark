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
  OperationalExceptions,
  Outbox,
  RecoveryMode,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../../enrollment';
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
    @Inject(ENROLLMENT_PORT) private readonly enrollments: EnrollmentPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facts: MoneyFacts,
    private readonly payments: PaymentsService,
    private readonly recovery: RecoveryMode,
    private readonly exceptions: OperationalExceptions,
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
    const outcome = await this.collectInternal(principal, organizationId, id, correlationId);
    if (outcome.held) {
      // MONEY-04 (SPK-PAY-006, §4.11 step 10): every registration of the order was canceled; the
      // remaining installments wait for the cancellation decision (DEC-009) instead of a charge.
      throw errors.resourceConflict(
        'Every registration this plan pays for was canceled; the installment is not collected.',
        { code: 'INSTALLMENT_REGISTRATION_CANCELED', planId: outcome.planId },
      );
    }
    const plan = await this.loadPlan(this.db, organizationId, outcome.planId);
    return this.planView(this.db, plan as InstallmentPlanRow);
  }

  /**
   * Starts one collection. Lock order everywhere (MONEY-07): the obligation, then its installment
   * (the capture path allocates to the obligation before it marks the installment paid, and
   * ObligationsService.pay locks the obligation), so a direct payment and a collection of the same
   * installment are serialized and the second one sees the first one's live charge.
   */
  private async collectInternal(
    actor: Principal,
    organizationId: string,
    id: string,
    correlationId: string | null,
  ): Promise<{ planId: string; held: boolean }> {
    const result = await this.uow.run(async ({ trx }) => {
      const known = await this.loadInstallment(trx, organizationId, id);
      if (!known) throw errors.notFound('installment', id);
      const obligation = await this.facts.loadObligation(
        trx,
        organizationId,
        known.obligation_id,
        true,
      );
      const installment = (await this.loadInstallment(
        trx,
        organizationId,
        id,
        true,
      )) as InstallmentRow;
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
        return { attempt: live, planId: plan.id, held: false };
      }
      // MONEY-04: a held plan is never charged (the database refuses the attempt as well, 0613).
      if (
        plan.held_at ||
        (await this.holdIfRegistrationsCanceled(
          trx,
          organizationId,
          plan,
          installment,
          actor,
          correlationId,
        ))
      ) {
        return { attempt: null, planId: plan.id, held: true };
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
      return { attempt: created, planId: plan.id, held: false };
    });
    if (result.attempt?.status === 'created') {
      await this.payments.execute(organizationId, result.attempt.id, correlationId);
    }
    return { planId: result.planId, held: result.held };
  }

  /**
   * MONEY-04 (SPK-PAY-006, SPK-AT-006, §4.11 step 10: never charge for a registration the family
   * did not receive): whether every enrollment the plan's order registered has been canceled
   * (ENROLLMENT_PORT). Then the plan is held: the hold is recorded on the plan once (0613), with
   * the one exception that gives the finance operator the decision the cancellation consequence
   * asks for (DEC-009 pending). A held plan is never collected and its payer is never told of a
   * coming charge; resolving the exception does not lift the hold, and nothing raises it again.
   * An order line without an enrollment, or one whose enrollment cannot be read, never holds it.
   */
  private async holdIfRegistrationsCanceled(
    trx: Trx,
    organizationId: string,
    plan: InstallmentPlanRow,
    installment: InstallmentRow,
    actor: Principal,
    correlationId: string | null,
  ): Promise<boolean> {
    const lines = await trx
      .selectFrom('order_lines')
      .select('enrollment_id')
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', plan.order_id)
      .execute();
    if (lines.length === 0 || lines.some((l) => !l.enrollment_id)) return false;
    const enrollmentIds = [...new Set(lines.map((l) => l.enrollment_id as string))];
    for (const enrollmentId of enrollmentIds) {
      const enrollment = await this.enrollments.getEnrollment(organizationId, enrollmentId, trx);
      if (!enrollment || enrollment.status !== 'canceled') return false;
    }
    const held = await trx
      .updateTable('installment_plans')
      .set((eb) => ({
        held_at: this.clock.now(),
        hold_reason: 'registrations_canceled',
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', plan.id)
      .where('held_at', 'is', null)
      .returning(['revision'])
      .executeTakeFirst();
    // Another collection or notice of the same plan recorded the hold first: it raised the one
    // exception, so this one only refuses.
    if (!held) return true;
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'finance.hold_installment_plan',
      targetType: 'installment_plan',
      targetId: plan.id,
      beforeRevision: held.revision - 1,
      afterRevision: held.revision,
      reason: 'Every registration the plan pays for was canceled',
      correlationId,
      details: {
        holdReason: 'registrations_canceled',
        orderId: plan.order_id,
        installmentId: installment.id,
        enrollmentIds,
      },
    });
    await this.exceptions.raise(trx, {
      organizationId,
      category: 'finance.installment_registration_canceled',
      severity: 'high',
      title:
        'Every registration an installment plan pays for was canceled; decide what is still owed before collecting',
      affectedType: 'installment_plan',
      affectedId: plan.id,
      ownerQueue: 'finance_operator',
      dedupeKey: `installment-registration-canceled:${plan.id}`,
      details: {
        orderId: plan.order_id,
        installmentId: installment.id,
        enrollmentIds,
        correlationId,
      },
    });
    return true;
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
      const known = await this.loadInstallment(trx, organizationId, id);
      if (!known) throw errors.protectedNotFound('installment');
      // Lock order everywhere: the obligation, then its installment (see collectInternal).
      await this.facts.loadObligation(trx, organizationId, known.obligation_id, true);
      const installment = (await this.loadInstallment(
        trx,
        organizationId,
        id,
        true,
      )) as InstallmentRow;
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
    // MONEY-04: a held plan is not collected, so its payer is not told a charge is coming; the
    // notice stays unsent (a decision that resumes the plan, DEC-009, would schedule it again).
    if (
      plan.held_at ||
      (plan.status === 'active' &&
        (await this.holdIfRegistrationsCanceled(
          trx,
          organizationId,
          plan,
          installment,
          financeSystem(organizationId, 'finance.installments'),
          correlationId,
        )))
    ) {
      return;
    }
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

  /**
   * Worker sweep: due installments and scheduled retries of plans that are not held, oldest due
   * first. An installment whose plan this sweep finds held (its registrations were canceled,
   * MONEY-04) does not use up the sweep: the sweep reads further pages until `limit` installments
   * were taken up or none is left, so a plan held on the way never starves later due dates.
   */
  async collectDue(limit = 50): Promise<number> {
    const now = this.clock.now();
    let collected = 0;
    let taken = 0;
    let after: { dueAt: Date; id: string } | null = null;
    const recovering = new Map<string, boolean>();
    while (taken < limit) {
      let q = this.db
        .selectFrom('installments')
        .innerJoin('installment_plans', 'installment_plans.id', 'installments.plan_id')
        .innerJoin('orders', (join) =>
          join
            .onRef('orders.organization_id', '=', 'installment_plans.organization_id')
            .onRef('orders.id', '=', 'installment_plans.order_id'),
        )
        .select([
          'installments.id as id',
          'installments.organization_id as organization_id',
          'installments.due_at as due_at',
        ])
        .where('installment_plans.status', '=', 'active')
        // MONEY-04: a held plan is never swept (its one exception was raised when it was held).
        .where('installment_plans.held_at', 'is', null)
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
        .orderBy('installments.id')
        .limit(limit);
      if (after) {
        const cursor: { dueAt: Date; id: string } = after;
        q = q.where((eb) =>
          eb.or([
            eb('installments.due_at', '>', cursor.dueAt),
            eb.and([
              eb('installments.due_at', '=', cursor.dueAt),
              eb('installments.id', '>', cursor.id),
            ]),
          ]),
        );
      }
      const rows = await q.execute();
      for (const row of rows) {
        after = { dueAt: new Date(row.due_at), id: row.id };
        // §5.8, SPK-AT-028: on restored state a due installment may already have been charged
        // after the backup; no new charge (a new idempotency key) starts until recovery resumes.
        let paused = recovering.get(row.organization_id);
        if (paused === undefined) {
          paused = await this.recovery.isActive(row.organization_id);
          recovering.set(row.organization_id, paused);
        }
        if (paused) continue;
        try {
          const outcome = await this.collectInternal(
            financeSystem(row.organization_id, 'finance.installments'),
            row.organization_id,
            row.id,
            null,
          );
          if (outcome.held) continue;
          collected += 1;
        } catch (error) {
          this.logger.warn(`installment ${row.id} collection skipped: ${String(error)}`);
        }
        taken += 1;
        if (taken >= limit) break;
      }
      if (rows.length < limit) break;
    }
    return collected;
  }
}
