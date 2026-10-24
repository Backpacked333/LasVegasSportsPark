import { Inject, Injectable } from '@nestjs/common';
import {
  CheckoutMachine,
  DomainError,
  errors,
  newId,
  type AppliedCredit,
  type Basket,
  type Checkout,
  type CheckoutRecovery,
  type CreateCheckoutInput,
  type FutureObligation,
  type LinePolicyReferences,
  type Order,
  type Principal,
  type QuoteDiscountLine,
  type QuotePolicyReferences,
  type RetryCheckoutPaymentInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  UnitOfWork,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { POLICY_PORT, PRICING_PORT, type PolicyPort, type PricingPort } from '../../catalog';
import {
  BASKET_PORT,
  BasketsService,
  ENROLLMENT_PORT,
  type BasketPort,
  type EnrollmentPort,
} from '../../enrollment';
import { FinanceActions } from '../finance.actions';
import { FinanceEvents } from '../finance.events';
import {
  daysFrom,
  iso,
  isoOrNull,
  isStaffLike,
  minutesFrom,
  organizationOf,
  toOrder,
  toPaymentAttempt,
  toReceipt,
  type QuoteLineRow,
  type QuoteRow,
  type Reader,
} from '../finance.shared';
import { CheckoutFinalizer, type CheckoutRow } from './checkout-finalizer.service';
import { FinancePolicyResolver } from './finance-policy.resolver';
import { MoneyFacts } from './money-facts.service';
import { PaymentsService } from './payments.service';
import { QuotesService } from './quotes.service';

type CashPayment = Extract<NonNullable<CreateCheckoutInput['payment']>, { method: 'cash' }>;
type CheckoutPaymentChoice =
  { kind: 'provider'; token: string } | { kind: 'cash'; payment: CashPayment } | { kind: 'none' };

/**
 * The checkout coordinator (§4.11, §4.8 `POST /v1/registration-checkouts`, SPK-PAY-007/012,
 * SPK-AT-006/023). In order:
 *   1. validate the stored quote (unexpired, unconsumed; every policy it relies on still approved);
 *   2. prevent duplicate equivalent entitlement intent (enrollment's EnrollmentPort);
 *   3. acquire the required holds (enrollment's basket hold) and check they still match the quote;
 *   4. create order, obligations, credit and discount redemptions, the durable operation, the
 *      checkout and the payment attempt in ONE transaction, and commit;
 *   5. call the provider OUTSIDE any transaction (timeout → unknown, never failed);
 *   6–7. record authoritative evidence as financial facts (receipt, journal, allocation);
 *   8. finalize the enrollments (CheckoutFinalizer), inline and as durable follow-up;
 *   9. enqueue follow-up events; 10. reconcile or compensate failures (worker, recovery).
 * One checkout per quote: a repeated request returns the same checkout and never charges again.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BASKET_PORT) private readonly basketPort: BasketPort,
    @Inject(ENROLLMENT_PORT) private readonly enrollments: EnrollmentPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PRICING_PORT) private readonly pricing: PricingPort,
    private readonly basketCommands: BasketsService,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly quotes: QuotesService,
    private readonly facts: MoneyFacts,
    private readonly payments: PaymentsService,
    private readonly finalizer: CheckoutFinalizer,
    private readonly policy: FinancePolicyResolver,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  async view(db: Reader, row: CheckoutRow): Promise<Checkout> {
    const attempt = row.payment_attempt_id
      ? await this.payments.load(db, row.organization_id, row.payment_attempt_id)
      : undefined;
    const receipt = await db
      .selectFrom('receipts')
      .selectAll()
      .where('organization_id', '=', row.organization_id)
      .where('order_id', '=', row.order_id)
      .orderBy('received_at')
      .executeTakeFirst();
    let nextAction: string | null = null;
    if (row.status === 'awaiting_payment' || row.status === 'prepared') {
      switch (attempt?.status) {
        case 'unknown':
          nextAction = 'await_reconciliation';
          break;
        case 'action_required':
          nextAction = 'complete_payment_action';
          break;
        case 'processing':
        case 'created':
          nextAction = 'await_payment_confirmation';
          break;
        default:
          nextAction = 'retry_payment';
      }
    } else if (row.status === 'finalizing') nextAction = 'await_fulfillment';
    else if (row.status === 'recovery_required') nextAction = 'await_staff_recovery';
    return {
      id: row.id,
      quoteId: row.quote_id,
      orderId: row.order_id,
      basketId: row.basket_id,
      payerPersonId: row.payer_person_id,
      status: row.status,
      paymentKind: row.payment_kind,
      payment: attempt ? toPaymentAttempt(attempt) : null,
      receipt: receipt ? toReceipt(receipt) : null,
      holdIds: row.hold_ids as string[],
      enrollmentIds: row.enrollment_ids as string[],
      operationId: row.operation_id,
      failure: row.failure_code
        ? { code: row.failure_code, details: row.failure_details ?? null }
        : null,
      recovery: (row.recovery as CheckoutRecovery | null) ?? null,
      nextAction,
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      completedAt: isoOrNull(row.completed_at),
    };
  }

  private async requireRead(
    principal: Principal,
    row: { id: string; organization_id: string; payer_person_id: string },
    type: string,
  ): Promise<void> {
    await this.authorization.require(principal, FinanceActions.readCheckout, {
      type,
      id: row.id,
      organizationId: row.organization_id,
      subjectPersonIds: [row.payer_person_id],
      protected: true,
    });
  }

  async get(principal: Principal, id: string): Promise<Checkout> {
    const organizationId = organizationOf(principal);
    const row = await this.finalizer.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('checkout');
    await this.requireRead(principal, row, 'checkout');
    return this.view(this.db, row);
  }

  async getOrder(principal: Principal, id: string): Promise<Order> {
    const organizationId = organizationOf(principal);
    const order = await this.db
      .selectFrom('orders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!order) throw errors.protectedNotFound('order');
    await this.requireRead(principal, order, 'order');
    const lines = await this.db
      .selectFrom('order_lines')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', id)
      .orderBy('sequence')
      .execute();
    const obligations = await this.db
      .selectFrom('obligations')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', id)
      .orderBy('due_at')
      .execute();
    const plan = await this.db
      .selectFrom('installment_plans')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('order_id', '=', id)
      .executeTakeFirst();
    return toOrder(
      order,
      lines,
      obligations.map((o) => o.id),
      plan?.id ?? null,
    );
  }

  // -------------------------------------------------------------------------------------------
  // POST /registration-checkouts
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreateCheckoutInput,
    correlationId: string | null,
  ): Promise<Checkout> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const quote = await this.quotes.load(this.db, organizationId, input.quoteId);
    if (!quote) throw errors.protectedNotFound('quote');
    const quoteLines = await this.quotes.lines(this.db, organizationId, quote.id);
    const participants = [...new Set(quoteLines.map((l) => l.participant_person_id))];
    // The payer holds `pay` over every participant line or is the adult participant (SPK-IAM-003).
    await this.authorization.require(principal, FinanceActions.checkout, {
      type: 'quote',
      id: quote.id,
      organizationId,
      subjectPersonIds: participants,
      protected: true,
    });
    if (!isStaffLike(principal) && principal.personId !== quote.payer_person_id) {
      throw errors.protectedNotFound('quote');
    }
    // One checkout per quote: a repeat returns it and never charges again (invariant 5).
    const existing = await this.db
      .selectFrom('checkouts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('quote_id', '=', quote.id)
      .executeTakeFirst();
    if (existing) return this.view(this.db, existing);

    // 1. The stored quote and its policies.
    if (quote.status !== 'active' || new Date(quote.expires_at) <= now) {
      await this.uow.run(({ trx }) => this.quotes.expireIfLapsed(trx, quote));
      throw errors.quoteExpired();
    }
    await this.assertPoliciesStillApproved(organizationId, quote, quoteLines);
    const payment = this.paymentFor(principal, quote, input);

    // 3a. Holds (enrollment's command, its own transaction) when the basket is not held yet.
    let basket = await this.basketPort.getBasket(organizationId, quote.basket_id);
    if (!basket) throw errors.protectedNotFound('basket');
    // 2. Duplicate equivalent entitlement intent (another active registration for the same thing).
    await this.assertNoDuplicateIntent(organizationId, basket, quoteLines);
    if (basket.status === 'open') {
      basket = await this.basketCommands.hold(principal, basket.id, {}, correlationId);
    }
    this.assertBasketMatchesQuote(basket, quoteLines, now);

    // 4. One transaction: order, obligations, redemptions, operation, checkout, attempt.
    let checkoutId: string;
    let attemptId: string | null;
    try {
      ({ checkoutId, attemptId } = await this.uow.run(({ trx }) =>
        this.prepare(
          trx,
          principal,
          quote,
          quoteLines,
          basket as Basket,
          payment,
          input,
          correlationId,
        ),
      ));
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.db
          .selectFrom('checkouts')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('quote_id', '=', quote.id)
          .executeTakeFirst();
        if (raced) return this.view(this.db, raced);
        throw errors.resourceConflict('Another checkout is already running for this basket.', {
          code: 'CHECKOUT_IN_PROGRESS',
        });
      }
      throw error;
    }
    // 5–7. Provider call outside any transaction; evidence recorded as facts.
    if (attemptId) await this.payments.execute(organizationId, attemptId, correlationId);
    // 8. Finalize inline; the durable follow-up does it if this process stops (SPK-AT-023).
    await this.settle(organizationId, checkoutId, correlationId);
    const row = await this.finalizer.load(this.db, organizationId, checkoutId);
    return this.view(this.db, row as CheckoutRow);
  }

  /** After evidence: finalize, and start a requested compensation refund (outside any transaction). */
  private async settle(
    organizationId: string,
    checkoutId: string,
    correlationId: string | null,
  ): Promise<void> {
    let row = await this.finalizer.load(this.db, organizationId, checkoutId);
    if (row?.status === 'finalizing') {
      await this.finalizer.finalize(organizationId, checkoutId, correlationId);
      row = await this.finalizer.load(this.db, organizationId, checkoutId);
    }
    if (row?.status === 'recovery_required') await this.finalizer.executePendingCompensation(row);
  }

  private paymentFor(
    principal: Principal,
    quote: QuoteRow,
    input: CreateCheckoutInput,
  ): CheckoutPaymentChoice {
    if (quote.due_now_minor === 0) {
      if (input.payment) throw errors.validation('Nothing is due now; no payment is taken.');
      return { kind: 'none' };
    }
    if (!input.payment) throw errors.validation('A payment is required for this checkout.');
    if (quote.payment_plan === 'installments') {
      if (input.payment.method !== 'provider') {
        throw errors.validation(
          'An installment plan needs a provider payment method for future charges.',
        );
      }
      if (!input.authorizeFutureInstallments) {
        throw errors.validation('The future installment charges must be explicitly authorized.', {
          field: 'authorizeFutureInstallments',
        });
      }
    }
    if (input.payment.method === 'cash') {
      // SPK-PAY-012: only permitted staff record tenders, with evidence; the same checkout path
      // (quote, holds, capacity) applies — a tender never bypasses registration checks.
      if (
        principal.kind !== 'staff' ||
        !FinanceActions.recordTender.staffRoles.some((r) => principal.staffRoles.includes(r))
      ) {
        throw errors.accessDenied('Only permitted staff may record a cash or external tender.');
      }
      return { kind: 'cash', payment: input.payment };
    }
    return { kind: 'provider', token: input.payment.paymentMethodToken };
  }

  private async assertPoliciesStillApproved(
    organizationId: string,
    quote: QuoteRow,
    lines: QuoteLineRow[],
  ): Promise<void> {
    const ids = new Set<string>();
    for (const line of lines) {
      const p = line.policy_references as unknown as LinePolicyReferences;
      for (const id of [
        p.eligibilityPolicyVersionId,
        p.cancellationPolicyVersionId,
        p.approvalPolicyVersionId,
        ...(p.requiredFormPolicyVersionIds ?? []),
      ]) {
        if (id) ids.add(id);
      }
    }
    const finance = quote.policy_references as unknown as QuotePolicyReferences;
    for (const id of [
      finance.installmentPolicyVersionId,
      finance.overpaymentPolicyVersionId,
      finance.refundPolicyVersionId,
    ]) {
      if (id) ids.add(id);
    }
    const now = this.clock.now();
    for (const id of ids) {
      const version = await this.policies.getPolicyVersion(organizationId, id);
      const lapsed = version?.effectiveTo ? new Date(version.effectiveTo) <= now : false;
      if (!version || version.approvalStatus !== 'approved' || version.retiredAt || lapsed) {
        throw new DomainError(
          'QUOTE_EXPIRED',
          'A policy this quote relies on is no longer approved.',
          {
            details: { policyVersionId: id },
          },
        );
      }
    }
  }

  private async assertNoDuplicateIntent(
    organizationId: string,
    basket: Basket,
    lines: QuoteLineRow[],
  ): Promise<void> {
    const ownEnrollments = new Set(
      basket.lines.map((l) => l.enrollmentId).filter((id): id is string => !!id),
    );
    const participations = await this.enrollments.participationsOf(organizationId, [
      ...new Set(lines.map((l) => l.participant_person_id)),
    ]);
    for (const line of lines) {
      if (!line.equivalence_key) continue;
      const summary = participations.find(
        (p) => p.participantPersonId === line.participant_person_id,
      );
      const clash = summary?.enrollments.find(
        (e) => e.equivalenceKey === line.equivalence_key && !ownEnrollments.has(e.id),
      );
      if (clash) {
        // §4.10 / SPK-AT-004: say what is wrong without revealing who else registered or paid.
        throw errors.duplicateEntitlement(
          'This participant already holds an equivalent registration.',
          {
            basketLineId: line.basket_line_id,
          },
        );
      }
    }
  }

  /** The held lines must be exactly the quoted lines (otherwise a new quote is needed). */
  private assertBasketMatchesQuote(basket: Basket, lines: QuoteLineRow[], now: Date): void {
    if (basket.status !== 'held') {
      throw errors.resourceConflict(`The basket is ${basket.status}; it cannot be checked out.`, {
        code: 'BASKET_NOT_HELD',
        basketStatus: basket.status,
      });
    }
    const held = basket.lines.filter((l) => l.outcome === 'held');
    const quoted = new Set(lines.map((l) => l.basket_line_id));
    const mismatch =
      held.length !== lines.length ||
      held.some((l) => !quoted.has(l.id) || !l.enrollmentId) ||
      lines.some((q) => {
        const line = held.find((l) => l.id === q.basket_line_id);
        return !line || line.quantity !== q.quantity || line.offeringId !== q.offering_id;
      });
    if (mismatch) {
      throw errors.resourceConflict(
        'The basket changed since it was quoted; request a new quote.',
        {
          code: 'QUOTE_STALE',
        },
      );
    }
    if (basket.holdExpiresAt && new Date(basket.holdExpiresAt) <= now) {
      throw errors.resourceConflict('The hold on this basket has expired.', {
        code: 'HOLD_EXPIRED',
      });
    }
  }

  private async prepare(
    trx: Trx,
    principal: Principal,
    quoteSnapshot: QuoteRow,
    quoteLines: QuoteLineRow[],
    basket: Basket,
    payment: CheckoutPaymentChoice,
    input: CreateCheckoutInput,
    correlationId: string | null,
  ): Promise<{ checkoutId: string; attemptId: string | null }> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const quote = await this.quotes.load(trx, organizationId, quoteSnapshot.id, true);
    if (!quote) throw errors.protectedNotFound('quote');
    if (quote.status !== 'active' || new Date(quote.expires_at) <= now) throw errors.quoteExpired();
    const actor = principal;
    const orderId = newId();
    const checkoutId = newId();
    // SPK-REG-007 and the hold: enrollment refuses when approval is pending or the hold lapsed.
    await this.basketPort.assertPaymentPermitted(trx, organizationId, basket.id);
    const started = await this.basketPort.startCheckout(
      trx,
      organizationId,
      basket.id,
      orderId,
      actor,
    );
    const operationId = await this.operations.create(trx, {
      organizationId,
      kind: 'finance.registration_checkout',
      requestedBy: principal,
      correlationId,
      input: { quoteId: quote.id, basketId: basket.id },
      status: 'running',
      // §4.9, §4.11 step 4: the checkout key names this operation, not the basket hold's.
      primary: true,
    });
    const policyReferences = quote.policy_references;
    await trx
      .insertInto('orders')
      .values({
        id: orderId,
        organization_id: organizationId,
        quote_id: quote.id,
        basket_id: basket.id,
        payer_person_id: quote.payer_person_id,
        currency: quote.currency,
        total_minor: quote.total_minor,
        credits_applied_minor: quote.credits_applied_minor,
        due_now_minor: quote.due_now_minor,
        paid_at: null,
        fulfilled_at: null,
        canceled_at: null,
        cancel_reason: null,
        policy_references: json(policyReferences),
        created_by: json(snapshotActor(principal)),
        created_by_person_id: principal.personId,
      })
      .execute();
    const lineByBasketLine = new Map(started.lines.map((l) => [l.id, l]));
    await trx
      .insertInto('order_lines')
      .values(
        quoteLines.map((line) => ({
          id: newId(),
          organization_id: organizationId,
          order_id: orderId,
          quote_line_id: line.id,
          sequence: line.sequence,
          basket_line_id: line.basket_line_id,
          enrollment_id:
            lineByBasketLine.get(line.basket_line_id)?.enrollmentId ?? line.enrollment_id,
          participant_person_id: line.participant_person_id,
          offering_id: line.offering_id,
          description: line.description,
          quantity: line.quantity,
          price_rule_id: line.price_rule_id,
          unit_price_minor: line.unit_price_minor,
          base_amount_minor: line.base_amount_minor,
          discount_minor: line.discount_minor,
          tax_minor: line.tax_minor,
          fee_minor: line.fee_minor,
          total_minor: line.total_minor,
          currency: line.currency,
          // SPK-PAY-002: the historical purchase keeps its price and policy basis.
          price_basis: json({
            quoteId: quote.id,
            quoteLineId: line.id,
            priceRuleId: line.price_rule_id,
            unitPriceMinor: line.unit_price_minor,
            discounts: line.discount_lines,
            charges: line.charge_lines,
          }),
          policy_references: json(line.policy_references),
        })),
      )
      .execute();

    // Obligations: the due-now part (credits applied are allocations against it) and, for an
    // installment plan, one obligation per future installment (SPK-PAY-002 "future obligations").
    const payerPersonId = quote.payer_person_id;
    const firstAmount = quote.due_now_minor + quote.credits_applied_minor;
    let planId: string | null = null;
    const future = quote.future_obligations as unknown as FutureObligation[];
    let firstObligationId: string | null = null;
    if (quote.payment_plan === 'installments') {
      const resolved = await this.policy.resolve(organizationId, now, trx);
      planId = newId();
      const token = payment.kind === 'provider' ? payment.token : '';
      await trx
        .insertInto('installment_plans')
        .values({
          id: planId,
          organization_id: organizationId,
          order_id: orderId,
          payer_person_id: payerPersonId,
          currency: quote.currency,
          total_minor: quote.total_minor - quote.credits_applied_minor,
          installment_count: future.length + 1,
          payment_authorization: json({
            paymentMethodRef: token,
            authorizedAt: now.toISOString(),
            authorizedByPersonId: principal.personId,
          }),
          retry_policy: json(resolved.config.installments.retry),
          notice_policy: json({ daysBefore: resolved.config.installments.noticeDaysBefore }),
          policy_version_id: resolved.references.installmentPolicyVersionId,
          created_by: json(snapshotActor(principal)),
          completed_at: null,
          defaulted_at: null,
          canceled_at: null,
        })
        .execute();
      const schedule = [
        { sequence: 1, dueAt: now.toISOString(), amountMinor: quote.due_now_minor },
        ...future,
      ];
      for (const step of schedule) {
        const installmentId = newId();
        const amount = step.sequence === 1 ? firstAmount : step.amountMinor;
        const obligation = await this.facts.createObligation(trx, {
          organizationId,
          debtorKind: 'person',
          debtorPersonId: payerPersonId,
          debtorTeamEntryId: null,
          mode: 'individual',
          responsiblePayerPersonId: null,
          sourceKind: 'installment',
          sourceId: installmentId,
          orderId,
          installmentPlanId: planId,
          description: `Installment ${step.sequence} of ${schedule.length}`,
          amountMinor: amount,
          currency: quote.currency,
          dueAt: new Date(step.dueAt),
          actor,
          correlationId,
        });
        if (step.sequence === 1) firstObligationId = obligation.id;
        await trx
          .insertInto('installments')
          .values({
            id: installmentId,
            organization_id: organizationId,
            plan_id: planId,
            sequence: step.sequence,
            obligation_id: obligation.id,
            amount_minor: amount,
            currency: quote.currency,
            due_at: new Date(step.dueAt),
            original_due_at: new Date(step.dueAt),
            status: 'scheduled',
            attempt_count: step.sequence === 1 ? 1 : 0,
            last_attempt_at: step.sequence === 1 ? now : null,
            last_failure_reason: null,
            next_retry_at: null,
            paid_at: null,
            failed_at: null,
            extension_reason: null,
            notice_sent_at: null,
          })
          .execute();
        if (step.sequence > 1) {
          const days = resolved.config.installments.noticeDaysBefore;
          const dueAt = new Date(step.dueAt);
          await this.outbox.enqueue(trx, FinanceEvents.installmentNoticeDue, {
            organizationId,
            aggregateType: 'installment',
            aggregateId: installmentId,
            correlationId,
            availableAt: new Date(Math.max(now.getTime(), daysFrom(dueAt, -days).getTime())),
            payload: { organizationId, installmentId },
          });
        }
      }
    } else if (firstAmount > 0) {
      const obligation = await this.facts.createObligation(trx, {
        organizationId,
        debtorKind: 'person',
        debtorPersonId: payerPersonId,
        debtorTeamEntryId: null,
        mode: 'individual',
        responsiblePayerPersonId: null,
        sourceKind: 'order',
        sourceId: orderId,
        orderId,
        installmentPlanId: null,
        description: 'Registration order',
        amountMinor: firstAmount,
        currency: quote.currency,
        dueAt: now,
        actor,
        correlationId,
      });
      firstObligationId = obligation.id;
    }

    // Credits applied (SPK-PAY-009, invariant 7) and discount redemptions (catalog, invariant 7).
    for (const credit of quote.applied_credits as unknown as AppliedCredit[]) {
      await this.facts.redeemCredit(trx, {
        organizationId,
        creditId: credit.creditId,
        amountMinor: credit.amountMinor,
        currency: quote.currency,
        use: 'registration',
        ownerPersonId: payerPersonId,
        referenceType: 'order',
        referenceId: orderId,
        obligationId: firstObligationId as string,
        actor,
        correlationId,
      });
    }
    for (const discount of quote.discounts as unknown as QuoteDiscountLine[]) {
      await this.pricing.redeemDiscount(trx, organizationId, {
        discountDefinitionId: discount.discountDefinitionId,
        referenceType: 'order',
        referenceId: orderId,
        personId: payerPersonId,
        amountMinor: discount.amountMinor,
        currency: quote.currency,
        actor,
        correlationId,
      });
    }

    await trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        organization_id: organizationId,
        quote_id: quote.id,
        order_id: orderId,
        basket_id: basket.id,
        payer_person_id: payerPersonId,
        requested_by: json(snapshotActor(principal)),
        requested_by_person_id: principal.personId,
        status: 'prepared',
        payment_kind: payment.kind,
        hold_ids: json(started.holds.filter((h) => h.status === 'active').map((h) => h.id)),
        enrollment_ids: json(
          started.lines.map((l) => l.enrollmentId).filter((id): id is string => !!id),
        ),
        payment_attempt_id: null,
        cash_tender_id: null,
        operation_id: operationId,
        failure_code: null,
        failure_details: null,
        recovery: null,
        completed_at: null,
        aborted_at: null,
        compensated_at: null,
        recovery_required_at: null,
      })
      .execute();
    await trx
      .updateTable('quotes')
      .set({
        status: 'consumed',
        consumed_at: now,
        consumed_by_checkout_id: checkoutId,
        revision: quote.revision + 1,
      })
      .where('id', '=', quote.id)
      .where('revision', '=', quote.revision)
      .execute();

    let attemptId: string | null = null;
    if (payment.kind === 'provider') {
      const attempt = await this.payments.createAttemptInTrx(trx, {
        organizationId,
        purpose: 'checkout',
        checkoutId,
        orderId,
        installmentId: null,
        payerPersonId,
        amountMinor: quote.due_now_minor,
        currency: quote.currency,
        paymentMethodRef: payment.token,
        actor,
      });
      attemptId = attempt.id;
      await trx
        .updateTable('checkouts')
        .set({ payment_attempt_id: attempt.id })
        .where('id', '=', checkoutId)
        .execute();
    } else if (payment.kind === 'cash') {
      await this.recordCashForCheckout(
        trx,
        principal,
        checkoutId,
        orderId,
        firstObligationId,
        quote,
        payment.payment,
        operationId,
        correlationId,
      );
    } else {
      // Fully covered by credits: nothing to collect, finalize directly.
      await this.markOrderPaid(trx, organizationId, orderId, now);
      await this.markPaymentReceived(
        trx,
        organizationId,
        checkoutId,
        orderId,
        null,
        operationId,
        correlationId,
      );
    }

    // Durable follow-ups: started, and the abandonment timer after the hold expiry.
    const holdExpiry = started.holdExpiresAt ? new Date(started.holdExpiresAt) : now;
    await this.outbox.enqueue(trx, FinanceEvents.checkoutStarted, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkoutId,
      correlationId,
      operationId,
      payload: { organizationId, checkoutId, orderId, basketId: basket.id },
    });
    await this.outbox.enqueue(trx, FinanceEvents.checkoutExpiryDue, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkoutId,
      correlationId,
      operationId,
      availableAt: minutesFrom(holdExpiry, this.policy.configuration.checkoutAbandonGraceMinutes),
      payload: { organizationId, checkoutId },
    });
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: FinanceActions.checkout.id,
      targetType: 'checkout',
      targetId: checkoutId,
      afterRevision: 1,
      correlationId,
      operationId,
      details: {
        quoteId: quote.id,
        orderId,
        basketId: basket.id,
        dueNowMinor: quote.due_now_minor,
        currency: quote.currency,
        paymentKind: payment.kind,
        installmentPlanId: planId,
        authorizeFutureInstallments: input.authorizeFutureInstallments,
      },
    });
    return { checkoutId, attemptId };
  }

  private async recordCashForCheckout(
    trx: Trx,
    principal: Principal,
    checkoutId: string,
    orderId: string,
    obligationId: string | null,
    quote: QuoteRow,
    payment: CashPayment,
    operationId: string,
    correlationId: string | null,
  ): Promise<void> {
    const organizationId = quote.organization_id;
    await this.authorization.require(principal, FinanceActions.recordTender, {
      type: 'cash_tender',
      organizationId,
      facilityId: payment.facilityId,
    });
    const now = this.clock.now();
    const tenderId = newId();
    await trx
      .insertInto('cash_tenders')
      .values({
        id: tenderId,
        organization_id: organizationId,
        facility_id: payment.facilityId,
        tender_kind: payment.tenderKind,
        payer_person_id: quote.payer_person_id,
        amount_minor: quote.due_now_minor,
        currency: quote.currency,
        obligation_id: obligationId,
        checkout_id: checkoutId,
        evidence: json(payment.evidence),
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId as string,
        recorded_at: now,
        reconciliation_id: null,
      })
      .execute();
    const recorded = await this.facts.recordReceipt(trx, {
      organizationId,
      sourceKind: 'cash_tender',
      cashTenderId: tenderId,
      payerPersonId: quote.payer_person_id,
      amountMinor: quote.due_now_minor,
      currency: quote.currency,
      processorFeeMinor: 0,
      cashAccount: 'cash_on_hand',
      obligationId,
      orderId,
      receivedAt: now,
      actor: principal,
      correlationId,
      operationId,
    });
    await trx
      .updateTable('checkouts')
      .set({ cash_tender_id: tenderId })
      .where('id', '=', checkoutId)
      .execute();
    await this.markOrderPaid(trx, organizationId, orderId, now);
    await this.outbox.enqueue(trx, FinanceEvents.cashTenderRecorded, {
      organizationId,
      aggregateType: 'cash_tender',
      aggregateId: tenderId,
      correlationId,
      payload: {
        organizationId,
        cashTenderId: tenderId,
        facilityId: payment.facilityId,
        amountMinor: quote.due_now_minor,
        currency: quote.currency,
      },
    });
    await this.markPaymentReceived(
      trx,
      organizationId,
      checkoutId,
      orderId,
      recorded.receipt.id,
      operationId,
      correlationId,
    );
  }

  /** prepared → finalizing for evidence available inside the preparing transaction (cash, credits). */
  private async markPaymentReceived(
    trx: Trx,
    organizationId: string,
    checkoutId: string,
    orderId: string,
    receiptId: string | null,
    operationId: string,
    correlationId: string | null,
  ): Promise<void> {
    await trx
      .updateTable('checkouts')
      .set((eb) => ({
        status: CheckoutMachine.next('prepared', 'payment_succeeded'),
        revision: eb('revision', '+', 1),
      }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', checkoutId)
      .execute();
    await this.outbox.enqueue(trx, FinanceEvents.checkoutPaymentReceived, {
      organizationId,
      aggregateType: 'checkout',
      aggregateId: checkoutId,
      correlationId,
      operationId,
      payload: { organizationId, checkoutId, orderId, receiptId },
    });
  }

  // -------------------------------------------------------------------------------------------
  // POST /registration-checkouts/{id}/payments
  // -------------------------------------------------------------------------------------------

  async retryPayment(
    principal: Principal,
    id: string,
    input: RetryCheckoutPaymentInput,
    correlationId: string | null,
  ): Promise<Checkout> {
    const organizationId = organizationOf(principal);
    const attemptId = await this.uow.run(async ({ trx }) => {
      const checkout = await this.finalizer.load(trx, organizationId, id, true);
      if (!checkout) throw errors.protectedNotFound('checkout');
      await this.authorization.require(principal, FinanceActions.checkout, {
        type: 'checkout',
        id,
        organizationId,
        subjectPersonIds: [checkout.payer_person_id],
        protected: true,
      });
      if (!isStaffLike(principal) && principal.personId !== checkout.payer_person_id) {
        throw errors.protectedNotFound('checkout');
      }
      if (checkout.status !== 'awaiting_payment' && checkout.status !== 'prepared') {
        throw errors.invalidTransition('Checkout', checkout.status, 'retry_payment');
      }
      if (checkout.payment_kind !== 'provider') {
        throw errors.validation('Only provider payments are retried.');
      }
      const live = await this.payments.liveAttempt(trx, organizationId, { checkoutId: id });
      if (live) {
        // SPK-PAY-007: no second charge while an outcome is pending or unknown.
        throw errors.paymentOutcomeUnknown({ paymentAttemptId: live.id, status: live.status });
      }
      const basket = await this.basketPort.getBasket(organizationId, checkout.basket_id, trx);
      if (basket?.holdExpiresAt && new Date(basket.holdExpiresAt) <= this.clock.now()) {
        throw errors.resourceConflict('The hold on this basket has expired.', {
          code: 'HOLD_EXPIRED',
        });
      }
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', checkout.order_id)
        .executeTakeFirstOrThrow();
      const attempt = await this.payments.createAttemptInTrx(trx, {
        organizationId,
        purpose: 'checkout',
        checkoutId: id,
        orderId: order.id,
        payerPersonId: checkout.payer_person_id,
        amountMinor: order.due_now_minor,
        currency: order.currency,
        paymentMethodRef: input.paymentMethodToken,
        actor: principal,
      });
      await trx
        .updateTable('checkouts')
        .set({
          payment_attempt_id: attempt.id,
          failure_code: null,
          failure_details: null,
          revision: checkout.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', checkout.revision)
        .execute();
      if (order.due_now_minor > 0) {
        // Keep the authorization for future installments on the method that paid.
        await trx
          .updateTable('installment_plans')
          .set((eb) => ({
            payment_authorization: json({
              paymentMethodRef: input.paymentMethodToken,
              authorizedAt: this.clock.now().toISOString(),
              authorizedByPersonId: principal.personId,
            }),
            revision: eb('revision', '+', 1),
          }))
          .where('organization_id', '=', organizationId)
          .where('order_id', '=', order.id)
          .where('status', '=', 'active')
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'finance.retry_checkout_payment',
        targetType: 'checkout',
        targetId: id,
        beforeRevision: checkout.revision,
        afterRevision: checkout.revision + 1,
        correlationId,
        operationId: checkout.operation_id,
        details: { paymentAttemptId: attempt.id },
      });
      return attempt.id;
    });
    await this.payments.execute(organizationId, attemptId, correlationId);
    await this.settle(organizationId, id, correlationId);
    const row = await this.finalizer.load(this.db, organizationId, id);
    return this.view(this.db, row as CheckoutRow);
  }

  private async markOrderPaid(
    trx: Trx,
    organizationId: string,
    orderId: string,
    at: Date,
  ): Promise<void> {
    await trx
      .updateTable('orders')
      .set((eb) => ({ payment_status: 'paid', paid_at: at, revision: eb('revision', '+', 1) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', orderId)
      .where('payment_status', '=', 'awaiting_payment')
      .execute();
  }

  /** Re-reads a checkout after a command and settles any follow-up that can run now. */
  async afterCommand(organizationId: string, checkoutId: string): Promise<Checkout> {
    await this.settle(organizationId, checkoutId, null);
    const fresh = await this.finalizer.load(this.db, organizationId, checkoutId);
    return this.view(this.db, fresh as CheckoutRow);
  }
}
