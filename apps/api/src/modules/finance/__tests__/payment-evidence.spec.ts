import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createAcknowledgmentFixture } from '../../catalog';
import { PaymentOutcomeUnknownError } from '../finance.ports';
import { financeSystem } from '../finance.shared';
import { FakePaymentProvider, FakePaymentTokens } from '../providers/fake-payment.provider';
import { CheckoutFinalizer } from '../services/checkout-finalizer.service';
import { MoneyFacts } from '../services/money-facts.service';
import { PaymentsService } from '../services/payments.service';
import { createCreditFixture } from '../testing/finance-fixtures';
import {
  MINUTE,
  adult,
  balanceOf,
  basketFor,
  child,
  deliver,
  drain,
  financeTestApp,
  ledgerTotals,
  offering,
  post,
  processInbox,
  provider,
  quoteFor,
  staff,
  worker,
  type Actor,
} from './support';

async function checkout(t: TestApp, parent: Actor, token: string, price = 10_000, capacity = 20) {
  const setup = await offering(t, {
    basePriceMinor: price,
    capacityUnits: [{ unit: 'seats', limit: capacity }],
  });
  const basket = await basketFor(t, parent, [setup]);
  const quote = await quoteFor(t, parent, basket.basketId);
  const res = await post(t, '/v1/registration-checkouts', parent.header, {
    quoteId: quote.id,
    payment: { method: 'provider', paymentMethodToken: token },
  });
  expect(res.status).toBe(201);
  return { setup, basket, quote, checkout: res.body as Record<string, unknown> & { id: string } };
}

async function openExceptions(t: TestApp, category: string) {
  return t.db
    .selectFrom('operational_exceptions')
    .selectAll()
    .where('organization_id', '=', t.organizationId)
    .where('category', '=', category)
    .execute();
}

describe('payment evidence: uncertainty, webhooks, reordering and recovery (SPK-PAY-007, §4.11)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-007: a timeout is unknown, never failed; no second charge until a webhook resolves it', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.timeout);
    expect(started).toMatchObject({
      status: 'awaiting_payment',
      payment: { status: 'unknown' },
      nextAction: 'await_reconciliation',
    });
    const paymentId = (started['payment'] as { id: string }).id;
    const exceptions = await openExceptions(t, 'finance.unknown_payment_outcome');
    expect(exceptions.find((e) => e.affected_id === paymentId)).toMatchObject({
      severity: 'critical',
      owner_queue: 'finance_operator',
      status: 'open',
    });
    // No second charge while the outcome is unknown.
    const retry = await post(
      t,
      `/v1/registration-checkouts/${started.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    const operation = await t.http
      .get(`/v1/operations/${started['operationId'] as string}`)
      .set(parent.header);
    expect(operation.body.status).toBe('running');
    // The provider's authoritative webhook resolves it; the inbox applies it; finalization follows.
    const event = provider(t).paymentWebhook(paymentId);
    const recorded = await deliver(t, event);
    expect(recorded.status).toBe(202);
    expect(recorded.body.duplicate).toBe(false);
    await processInbox(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body).toMatchObject({
      status: 'completed',
      payment: { status: 'succeeded', evidenceSource: 'webhook' },
    });
    // Duplicate delivery: acknowledged, one receipt, one journal posting.
    const again = await deliver(t, event);
    expect(again.body.duplicate).toBe(true);
    await processInbox(t);
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(receipts).toHaveLength(1);
    expect(provider(t).chargeCount()).toBeGreaterThan(0);
  });

  it('§4.11: webhooks are authenticated; a tampered event is refused and records nothing', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.processing);
    const paymentId = (started['payment'] as { id: string }).id;
    provider(t).settlePayment(paymentId, 'succeeded');
    const event = provider(t).paymentWebhook(paymentId);
    const forged = await deliver(t, {
      body: { ...event.body, sequence: 99 },
      signature: event.signature,
    });
    expect(forged.status).toBe(401);
    const unsigned = await t.http.post('/v1/webhooks/payments/fake-payments').send(event.body);
    expect(unsigned.status).toBe(401);
    expect(
      await t.db
        .selectFrom('inbox_events')
        .select('id')
        .where('provider_event_id', '=', event.body.id)
        .execute(),
    ).toHaveLength(0);
    await deliver(t, event);
    await processInbox(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body.status).toBe('completed');
  });

  it('§4.11 reordering: an older event delivered late never moves a resolved payment back', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.requireAction);
    expect(started).toMatchObject({
      status: 'awaiting_payment',
      payment: { status: 'action_required', actionRequired: { type: 'challenge' } },
      nextAction: 'complete_payment_action',
    });
    const paymentId = (started['payment'] as { id: string }).id;
    const stale = provider(t).paymentWebhook(paymentId, {
      type: 'payment.processing',
      sequence: 1,
    });
    provider(t).settlePayment(paymentId, 'succeeded');
    const fresh = provider(t).paymentWebhook(paymentId);
    // The newer success arrives first, the older "processing" afterwards.
    await deliver(t, fresh);
    await deliver(t, stale);
    await processInbox(t);
    const done = await t.http.get(`/v1/payments/${paymentId}`).set(parent.header);
    expect(done.body.status).toBe('succeeded');
    const checkoutNow = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(checkoutNow.body.status).toBe('completed');
  });

  it('§4.11 / SPK-PAY-007: "succeeded" after "failed" never flips the record, but the captured money is recorded and no second charge is taken', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.requireAction);
    const paymentId = (started['payment'] as { id: string }).id;
    provider(t).settlePayment(paymentId, 'failed');
    await deliver(t, provider(t).paymentWebhook(paymentId));
    await processInbox(t);
    expect((await t.http.get(`/v1/payments/${paymentId}`).set(parent.header)).body.status).toBe(
      'failed',
    );
    const failedCheckout = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(failedCheckout.body).toMatchObject({
      status: 'awaiting_payment',
      failure: { code: 'PAYMENT_FAILED' },
      nextAction: 'retry_payment',
    });
    const contradicting = provider(t).paymentWebhook(paymentId, {
      type: 'payment.succeeded',
      sequence: 9,
    });
    await deliver(t, contradicting);
    await deliver(t, contradicting);
    await processInbox(t);
    expect((await t.http.get(`/v1/payments/${paymentId}`).set(parent.header)).body.status).toBe(
      'failed',
    );
    const conflicts = await openExceptions(t, 'finance.payment_evidence_conflict');
    expect(conflicts.find((e) => e.affected_id === paymentId)).toMatchObject({
      severity: 'critical',
      owner_queue: 'finance_operator',
    });
    // The provider holds the money: it is received money (receipt, journal, refundable funds),
    // recorded once however often the provider reports it.
    const receipts = await t.db
      .selectFrom('receipts')
      .select(['amount_minor', 'allocated_minor'])
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(receipts).toEqual([{ amount_minor: 10_000, allocated_minor: 10_000 }]);
    const refundable = await t.db
      .selectFrom('payment_refundables')
      .select('captured_minor')
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(refundable).toEqual([{ captured_minor: 10_000 }]);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body.status).toBe('completed');
    // So the payer is not charged a second time.
    const retried = await post(
      t,
      `/v1/registration-checkouts/${started.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retried.status).toBe(409);
    expect(retried.body.code).toBe('INVALID_TRANSITION');
    const attempts = await t.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('checkout_id', '=', started.id)
      .execute();
    expect(attempts).toHaveLength(1);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('§4.11 / SPK-PAY-008: a capture reported after a retry already succeeded is held as visible excess and can be refunded', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.requireAction, 5_000);
    const firstId = (started['payment'] as { id: string }).id;
    provider(t).settlePayment(firstId, 'failed');
    await deliver(t, provider(t).paymentWebhook(firstId));
    await processInbox(t);
    const retried = await post(
      t,
      `/v1/registration-checkouts/${started.id}/payments`,
      parent.header,
      { paymentMethodToken: FakePaymentTokens.succeed },
    );
    expect(retried.body).toMatchObject({ status: 'completed', payment: { status: 'succeeded' } });
    await deliver(
      t,
      provider(t).paymentWebhook(firstId, { type: 'payment.succeeded', sequence: 9 }),
    );
    await processInbox(t);
    const receipt = await t.db
      .selectFrom('receipts')
      .selectAll()
      .where('payment_attempt_id', '=', firstId)
      .executeTakeFirstOrThrow();
    expect(receipt).toMatchObject({ amount_minor: 5_000, allocated_minor: 0, excess_minor: 5_000 });
    const held = await t.db
      .selectFrom('credits')
      .select(['status', 'original_minor'])
      .where('source_kind', '=', 'overpayment')
      .where('source_id', '=', receipt.id)
      .executeTakeFirstOrThrow();
    expect(held).toEqual({ status: 'pending_approval', original_minor: 5_000 });
    const late = await openExceptions(t, 'finance.fulfillment_incomplete');
    expect(late.find((e) => e.affected_id === started.id)).toBeDefined();
    const refund = await post(t, `/v1/payments/${firstId}/refunds`, finance.header, {
      amountMinor: 5_000,
      reason: 'Charged twice by the processor',
    });
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({
      status: 'succeeded',
      refundable: { refundedMinor: 5_000 },
    });
    await drain(t);
  });

  it('SPK-PAY-006 / §4.11: a capture reported after a failed installment collection settles the installment; it is not collected again', async () => {
    const setup = await offering(t, { basePriceMinor: 9_000 });
    const basket = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basket.basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.body.status).toBe('completed');
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(parent.header);
    const planId = order.body.installmentPlanId as string;
    const plan = await t.http.get(`/v1/installment-plans/${planId}`).set(finance.header);
    const second = plan.body.installments[1] as { id: string };
    provider(t).scriptPayments(FakePaymentTokens.decline);
    const failed = await post(t, `/v1/installments/${second.id}/collect`, finance.header, {});
    expect(failed.body.installments[1]).toMatchObject({ status: 'failed', attemptCount: 1 });
    const attempt = await t.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('installment_id', '=', second.id)
      .executeTakeFirstOrThrow();
    await deliver(
      t,
      provider(t).paymentWebhook(attempt.id, { type: 'payment.succeeded', sequence: 9 }),
    );
    await processInbox(t);
    const after = await t.http.get(`/v1/installment-plans/${planId}`).set(finance.header);
    expect(after.body.installments[1]).toMatchObject({ status: 'paid', nextRetryAt: null });
    expect(after.body.outstandingMinor).toBe(3_000);
    // Past the retry time, the worker does not collect the settled installment again.
    t.clock.advance(4 * 24 * 60 * MINUTE);
    await worker(t).runOnce();
    const attempts = await t.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('installment_id', '=', second.id)
      .execute();
    expect(attempts).toHaveLength(1);
    await drain(t);
  });

  it('SPK-PAY-007: staff reconcile an unknown outcome from the provider record; absence means nothing was charged', async () => {
    const { checkout: charged } = await checkout(t, parent, FakePaymentTokens.timeout);
    const chargedId = (charged['payment'] as { id: string }).id;
    const customer = await post(t, `/v1/payments/${chargedId}/reconcile`, parent.header);
    expect(customer.status).toBe(403);
    const reconciled = await post(t, `/v1/payments/${chargedId}/reconcile`, finance.header);
    expect(reconciled.status).toBe(201);
    expect(reconciled.body).toMatchObject({
      status: 'succeeded',
      evidenceSource: 'reconciliation',
    });
    await drain(t);
    expect(
      (await t.http.get(`/v1/registration-checkouts/${charged.id}`).set(parent.header)).body.status,
    ).toBe('completed');

    const { checkout: lost } = await checkout(t, parent, FakePaymentTokens.unreachable);
    const lostId = (lost['payment'] as { id: string }).id;
    expect(lost['payment']).toMatchObject({ status: 'unknown' });
    // The worker sweeps unknown attempts once they are older than the reconciliation threshold.
    t.clock.advance(16 * MINUTE);
    const summary = await worker(t).runOnce();
    expect(summary.paymentsReconciled).toBeGreaterThanOrEqual(1);
    const resolved = await t.http.get(`/v1/payments/${lostId}`).set(parent.header);
    expect(resolved.body).toMatchObject({
      status: 'canceled',
      failureReason: 'provider_has_no_record',
    });
    await drain(t);
  });

  it('abandoned checkout: after the hold expires with no live payment, it aborts and every financial effect is reversed', async () => {
    const before = await balanceOf(t, 'customer_receivable');
    const { checkout: started, basket } = await checkout(
      t,
      parent,
      FakePaymentTokens.decline,
      6_000,
    );
    expect(started).toMatchObject({ status: 'awaiting_payment', payment: { status: 'failed' } });
    t.clock.advance(16 * MINUTE);
    await drain(t);
    const aborted = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(aborted.body.status).toBe('aborted');
    const order = await t.http.get(`/v1/orders/${started['orderId'] as string}`).set(parent.header);
    expect(order.body).toMatchObject({ paymentStatus: 'canceled', fulfillmentStatus: 'canceled' });
    const basketNow = await t.http.get(`/v1/baskets/${basket.basketId}`).set(parent.header);
    expect(['abandoned', 'expired']).toContain(basketNow.body.status);
    // The receivable posted for the order was reversed (SPK-PAY-010), never overwritten.
    expect(await balanceOf(t, 'customer_receivable')).toBe(before);
    const reversals = await t.db
      .selectFrom('journals')
      .select('reversal_of_journal_id')
      .where('purpose', '=', 'obligation_canceled')
      .execute();
    expect(reversals.length).toBeGreaterThanOrEqual(1);
    const operation = await t.http
      .get(`/v1/operations/${started['operationId'] as string}`)
      .set(parent.header);
    expect(operation.body.status).toBe('failed');
  });

  it('SPK-AT-006: with no one waiting, a payment after hold expiry re-acquires the place (tracked valid fulfillment)', async () => {
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.timeout, 8_000, 1);
    const paymentId = (started['payment'] as { id: string }).id;
    t.clock.advance(11 * MINUTE);
    await drain(t); // the hold expires; the checkout keeps its pending enrollment (unknown payment)
    await deliver(t, provider(t).paymentWebhook(paymentId));
    await processInbox(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body.status).toBe('completed');
  });

  it('SPK-AT-006: a payment after hold expiry never displaces a waitlist offer; it is compensated per policy with an exception', async () => {
    const { checkout: started, setup } = await checkout(
      t,
      parent,
      FakePaymentTokens.timeout,
      9_000,
      1,
    );
    const paymentId = (started['payment'] as { id: string }).id;
    const waiting = await adult(t);
    const kid = await child(t, [waiting]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: waiting.personId,
    });
    const joined = await post(t, '/v1/waitlist-entries', waiting.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(joined.status).toBe(201);
    t.clock.advance(11 * MINUTE);
    await drain(t); // hold expires → the freed place is offered to the waitlist with its own hold
    const entry = await t.http
      .get(`/v1/waitlist-entries/${joined.body.id as string}`)
      .set(waiting.header);
    expect(entry.body.status).toBe('offered');
    // The provider captured the money all along.
    await deliver(t, provider(t).paymentWebhook(paymentId));
    await processInbox(t);
    const recovery = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(recovery.body).toMatchObject({
      status: 'recovery_required',
      failure: { code: 'CAPACITY_UNAVAILABLE' },
      recovery: { plan: 'refund', reasonCode: 'CAPACITY_UNAVAILABLE' },
      nextAction: 'await_staff_recovery',
    });
    const operation = await t.http
      .get(`/v1/operations/${started['operationId'] as string}`)
      .set(parent.header);
    expect(operation.body.status).toBe('recovery_required');
    const exceptions = await openExceptions(t, 'finance.fulfillment_incomplete');
    expect(exceptions.find((e) => e.affected_id === started.id)).toMatchObject({
      severity: 'critical',
      owner_queue: 'finance_operator',
    });
    // The offer still holds the place (not displaced).
    const offered = await t.http
      .get(`/v1/waitlist-entries/${joined.body.id as string}`)
      .set(waiting.header);
    expect(offered.body.status).toBe('offered');
    // The compensation refund runs outside any transaction (worker), then completes the recovery.
    await worker(t).runOnce();
    await drain(t);
    const compensated = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(compensated.body.status).toBe('compensated');
    const order = await t.http.get(`/v1/orders/${started['orderId'] as string}`).set(parent.header);
    expect(order.body).toMatchObject({ paymentStatus: 'paid', fulfillmentStatus: 'compensated' });
    const refund = await t.db
      .selectFrom('refund_attempts')
      .selectAll()
      .where('checkout_id', '=', started.id)
      .executeTakeFirstOrThrow();
    expect(refund).toMatchObject({
      purpose: 'compensation',
      status: 'succeeded',
      amount_minor: 9_000,
    });
    const enrollmentId = (started['enrollmentIds'] as string[])[0] as string;
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('canceled');
    const finalOperation = await t.http
      .get(`/v1/operations/${started['operationId'] as string}`)
      .set(parent.header);
    expect(finalOperation.body.status).toBe('compensated');
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });
  it('§4.11: provider evidence that matches no attempt is recorded and raised for review, never dropped', async () => {
    const body = {
      id: 'evt_orphan_1',
      type: 'payment.succeeded' as const,
      sequence: 1,
      data: {
        organizationId: t.organizationId,
        providerReference: 'fp_does_not_exist',
        amountMinor: 1_234,
        currency: 'USD',
      },
    };
    const recorded = await deliver(t, { body, signature: FakePaymentProvider.sign(body) });
    expect(recorded.status).toBe(202);
    await processInbox(t);
    const raised = await openExceptions(t, 'finance.unmatched_provider_event');
    expect(raised.find((e) => e.affected_id === recorded.body.inboxEventId)).toMatchObject({
      owner_queue: 'finance_operator',
      severity: 'high',
    });
  });

  it('SPK-PAY-007: a forced reconciliation right after a timeout does not take "no record yet" as absence; the late capture settles it with one charge', async () => {
    const p = provider(t);
    const original = p.createPayment.bind(p);
    let late: (() => Promise<unknown>) | null = null;
    // Our call times out; the provider finishes the capture a little later.
    const spy = vi.spyOn(p, 'createPayment').mockImplementationOnce(async (request) => {
      late = () => original(request);
      throw new PaymentOutcomeUnknownError('client timeout (simulated)');
    });
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.succeed, 8_000);
    spy.mockRestore();
    const paymentId = (started['payment'] as { id: string }).id;
    expect(started['payment']).toMatchObject({ status: 'unknown' });
    // Finance reacts to the critical exception at once: the provider shows nothing yet.
    const early = await post(t, `/v1/payments/${paymentId}/reconcile`, finance.header);
    expect(early.status).toBe(201);
    expect(early.body).toMatchObject({ status: 'unknown', failureReason: null });
    expect(early.body.unknownSince).not.toBeNull();
    // ...so no second charge is possible.
    const retry = await post(
      t,
      `/v1/registration-checkouts/${started.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    await (late as unknown as () => Promise<unknown>)();
    await deliver(t, p.paymentWebhook(paymentId));
    await processInbox(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body).toMatchObject({ status: 'completed', payment: { status: 'succeeded' } });
    const attempts = await t.db
      .selectFrom('payment_attempts')
      .select('id')
      .where('checkout_id', '=', started.id)
      .execute();
    expect(attempts).toHaveLength(1);
    const conflicts = await openExceptions(t, 'finance.payment_evidence_conflict');
    expect(conflicts.find((e) => e.affected_id === paymentId)).toBeUndefined();

    // Once the attempt went unknown long enough ago, the provider's "no record" is conclusive.
    const { checkout: lost } = await checkout(t, parent, FakePaymentTokens.unreachable, 8_000);
    const lostId = (lost['payment'] as { id: string }).id;
    const tooEarly = await post(t, `/v1/payments/${lostId}/reconcile`, finance.header);
    expect(tooEarly.body.status).toBe('unknown');
    t.clock.advance(16 * MINUTE);
    const conclusive = await post(t, `/v1/payments/${lostId}/reconcile`, finance.header);
    expect(conclusive.body).toMatchObject({
      status: 'canceled',
      failureReason: 'provider_has_no_record',
    });
    await drain(t);
  });

  it('SPK-PAY-007 / SPK-AT-028: an unsubmitted created attempt is never canceled by assumption; abort and the expiry timer wait for the provider lookup', async () => {
    const payments = t.app.get(PaymentsService);
    const p = provider(t);
    // A restore lost the submission commit while the provider kept the capture it received.
    const spy = vi
      .spyOn(payments, 'execute')
      .mockImplementationOnce(async (organizationId, attemptId) => {
        const row = await payments.load(t.db, organizationId, attemptId);
        if (!row) throw new Error('attempt missing');
        await p.createPayment({
          idempotencyKey: attemptId,
          amountMinor: row.amount_minor,
          currency: row.currency,
          paymentMethodRef: row.payment_method_ref,
          metadata: { organizationId, paymentAttemptId: attemptId },
        });
        return {
          attempt: row,
          changed: false,
          receipt: null,
          overpaymentCreditId: null,
          conflict: false,
        };
      });
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.succeed, 7_000);
    spy.mockRestore();
    const paymentId = (started['payment'] as { id: string }).id;
    expect(started).toMatchObject({ status: 'prepared', payment: { status: 'created' } });
    const abort = await post(t, `/v1/registration-checkouts/${started.id}/abort`, parent.header, {
      reason: 'Changed my mind',
    });
    expect(abort.status).toBe(409);
    expect(abort.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    // The hold expires and the abandonment timer fires: it waits for the lookup too.
    t.clock.advance(16 * MINUTE);
    await drain(t);
    const waiting = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(waiting.body).toMatchObject({ status: 'prepared', payment: { status: 'created' } });
    // The stranded-attempt sweep (database age) asks the provider, which holds the capture.
    await t.db
      .updateTable('payment_attempts')
      .set({ created_at: sql<Date>`now() - interval '30 minutes'` })
      .where('id', '=', paymentId)
      .execute();
    await worker(t).runOnce();
    await drain(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body).toMatchObject({
      status: 'completed',
      payment: { status: 'succeeded', evidenceSource: 'reconciliation' },
    });
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(receipts).toHaveLength(1);
  });

  it('SPK-PAY-007: an attempt that never reached the provider is canceled by the lookup, then the checkout can be aborted', async () => {
    const payments = t.app.get(PaymentsService);
    const spy = vi
      .spyOn(payments, 'execute')
      .mockImplementationOnce(async (organizationId, attemptId) => {
        const row = await payments.load(t.db, organizationId, attemptId);
        if (!row) throw new Error('attempt missing');
        return {
          attempt: row,
          changed: false,
          receipt: null,
          overpaymentCreditId: null,
          conflict: false,
        };
      });
    const { checkout: started } = await checkout(t, parent, FakePaymentTokens.succeed, 7_000);
    spy.mockRestore();
    const paymentId = (started['payment'] as { id: string }).id;
    const refused = await post(t, `/v1/registration-checkouts/${started.id}/abort`, parent.header, {
      reason: 'Changed my mind',
    });
    expect(refused.status).toBe(409);
    await t.db
      .updateTable('payment_attempts')
      .set({ created_at: sql<Date>`now() - interval '30 minutes'` })
      .where('id', '=', paymentId)
      .execute();
    await worker(t).runOnce();
    const resolved = await t.http.get(`/v1/payments/${paymentId}`).set(parent.header);
    expect(resolved.body).toMatchObject({
      status: 'canceled',
      failureReason: 'provider_has_no_record',
      evidenceSource: 'reconciliation',
    });
    const aborted = await post(t, `/v1/registration-checkouts/${started.id}/abort`, parent.header, {
      reason: 'Changed my mind',
    });
    expect(aborted.status).toBe(201);
    expect(aborted.body.status).toBe('aborted');
    await drain(t);
  });
});

describe('compensation ends what the order still asks and gives back applied credits (SPK-AT-006, SPK-PAY-006, SPK-PAY-009, §4.11 step 10)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;
  const DAY = 24 * 60 * MINUTE;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  /** SPK-AT-006: the payment lands after the hold expired and the place went to the waitlist. */
  async function lateCaptureAfterWaitlistOffer(
    price: number,
    quoteExtra: Record<string, unknown> = {},
    checkoutExtra: Record<string, unknown> = {},
  ) {
    const setup = await offering(t, {
      basePriceMinor: price,
      capacityUnits: [{ unit: 'seats', limit: 1 }],
    });
    const basket = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basket.basketId, quoteExtra);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.timeout },
      ...checkoutExtra,
    });
    expect(res.status).toBe(201);
    const started = res.body as Record<string, unknown> & { id: string; orderId: string };
    const paymentId = (started['payment'] as { id: string }).id;
    const waiting = await adult(t);
    const kid = await child(t, [waiting]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: waiting.personId,
    });
    const joined = await post(t, '/v1/waitlist-entries', waiting.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(joined.status).toBe(201);
    t.clock.advance(11 * MINUTE);
    await drain(t);
    await deliver(t, provider(t).paymentWebhook(paymentId));
    await processInbox(t);
    const recovery = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(recovery.body).toMatchObject({
      status: 'recovery_required',
      recovery: { plan: 'refund', reasonCode: 'CAPACITY_UNAVAILABLE' },
    });
    return { started, paymentId };
  }

  async function planOf(orderId: string) {
    const order = await t.http.get(`/v1/orders/${orderId}`).set(parent.header);
    const plan = await t.http
      .get(`/v1/installment-plans/${order.body.installmentPlanId as string}`)
      .set(finance.header);
    return plan.body as {
      status: string;
      outstandingMinor: number;
      installments: Array<{ id: string; status: string; obligationId: string }>;
    };
  }

  async function obligationsOf(orderId: string) {
    return t.db
      .selectFrom('obligations')
      .select(['id', 'status'])
      .where('order_id', '=', orderId)
      .orderBy('due_at')
      .execute();
  }

  it('SPK-AT-006 / SPK-PAY-006: a refund-compensated installment checkout cancels its plan, future installments and obligations; nothing is collected later', async () => {
    const { started } = await lateCaptureAfterWaitlistOffer(
      30_000,
      { paymentPlan: { kind: 'installments', count: 3 } },
      { authorizeFutureInstallments: true },
    );
    await worker(t).runOnce(); // the compensation refund runs outside any transaction
    await drain(t);
    const compensated = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(compensated.body.status).toBe('compensated');
    const plan = await planOf(started.orderId);
    expect(plan).toMatchObject({ status: 'canceled', outstandingMinor: 0 });
    expect(plan.installments.map((i) => i.status)).toEqual(['paid', 'canceled', 'canceled']);
    const obligations = await obligationsOf(started.orderId);
    expect(obligations.map((o) => o.status)).toEqual(['settled', 'canceled', 'canceled']);
    // Each canceled receivable is reversed in the ledger, never overwritten (SPK-PAY-010).
    const reversals = await t.db
      .selectFrom('journals')
      .select('source_id')
      .where('purpose', '=', 'obligation_canceled')
      .where(
        'source_id',
        'in',
        obligations.filter((o) => o.status === 'canceled').map((o) => o.id),
      )
      .execute();
    expect(reversals).toHaveLength(2);
    // Past every due date, the stored payment method is never charged for this registration.
    const calls = provider(t).paymentCalls.length;
    t.clock.advance(31 * DAY);
    await worker(t).runOnce();
    await drain(t);
    t.clock.advance(31 * DAY);
    await worker(t).runOnce();
    await drain(t);
    expect(provider(t).paymentCalls.length).toBe(calls);
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('order_id', '=', started.orderId)
      .execute();
    expect(receipts).toHaveLength(1);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('SPK-AT-006 / SPK-PAY-009: compensating a late payment returns the card part and restores the credit applied at checkout', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 4_000,
    });
    const { started } = await lateCaptureAfterWaitlistOffer(10_000, { creditIds: [creditId] });
    expect(started).toMatchObject({ payment: { amountMinor: 6_000 } });
    await worker(t).runOnce();
    await drain(t);
    const compensated = await t.http
      .get(`/v1/registration-checkouts/${started.id}`)
      .set(parent.header);
    expect(compensated.body.status).toBe('compensated');
    const refund = await t.db
      .selectFrom('refund_attempts')
      .select(['amount_minor', 'status'])
      .where('checkout_id', '=', started.id)
      .executeTakeFirstOrThrow();
    expect(refund).toEqual({ amount_minor: 6_000, status: 'succeeded' });
    const credit = await t.http.get(`/v1/credits/${creditId}`).set(parent.header);
    expect(credit.body).toMatchObject({
      remainingMinor: 4_000,
      status: 'active',
      redemptions: [
        expect.objectContaining({ kind: 'redeem', amountMinor: 4_000 }),
        expect.objectContaining({ kind: 'reversal', amountMinor: 4_000 }),
      ],
    });
    // The family is made whole: refund + restored credit = what the order cost.
    expect(refund.amount_minor + Number(credit.body.remainingMinor)).toBe(10_000);
    const operation = await t.http
      .get(`/v1/operations/${started['operationId'] as string}`)
      .set(parent.header);
    expect(operation.body).toMatchObject({
      status: 'compensated',
      result: { restoredCreditMinor: 4_000 },
    });
    // The receivable is not reopened: the order's obligation stays settled at zero.
    const obligations = await obligationsOf(started.orderId);
    expect(obligations.map((o) => o.status)).toEqual(['settled']);
    const receivable = await t.db
      .selectFrom('journal_entries')
      .select(['debit_minor', 'credit_minor'])
      .where('account_code', '=', 'customer_receivable')
      .where('obligation_id', '=', obligations[0]?.id as string)
      .execute();
    expect(receivable.reduce((a, r) => a + r.debit_minor - r.credit_minor, 0)).toBe(0);
    // A replayed completion restores nothing twice.
    const finalizer = t.app.get(CheckoutFinalizer);
    const facts = t.app.get(MoneyFacts);
    const row = await finalizer.load(t.db, t.organizationId, started.id);
    const redemption = await t.db
      .selectFrom('credit_redemptions')
      .select('id')
      .where('credit_id', '=', creditId)
      .where('kind', '=', 'redeem')
      .executeTakeFirstOrThrow();
    const again = await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await finalizer.completeCompensationInTrx(
        trx,
        row as NonNullable<typeof row>,
        { method: 'refund', refundAttemptId: null, creditId: null },
        financeSystem(t.organizationId, 'finance.test_replay'),
        null,
      );
      return facts.reverseCreditRedemption(
        trx,
        t.organizationId,
        redemption.id,
        financeSystem(t.organizationId, 'finance.test_replay'),
        null,
        { compensation: { personId: parent.personId, orderId: started.orderId } },
      );
    });
    expect(again).toBe(0);
    const reversalRows = await t.db
      .selectFrom('credit_redemptions')
      .select('id')
      .where('credit_id', '=', creditId)
      .where('kind', '=', 'reversal')
      .execute();
    expect(reversalRows).toHaveLength(1);
    const restorations = await t.db
      .selectFrom('journals')
      .select('id')
      .where('purpose', '=', 'credit_restored_compensation')
      .where('source_id', '=', redemption.id)
      .execute();
    expect(restorations).toHaveLength(1);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('SPK-PAY-006 / §4.11 step 10: while a failed compensation refund waits for staff, no installment is collected; staff credit compensation then ends the plan', async () => {
    const { started } = await lateCaptureAfterWaitlistOffer(
      30_000,
      { paymentPlan: { kind: 'installments', count: 3 } },
      { authorizeFutureInstallments: true },
    );
    provider(t).scriptRefunds('fail');
    await worker(t).runOnce();
    await drain(t);
    const waiting = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(waiting.body).toMatchObject({
      status: 'recovery_required',
      recovery: { plan: 'manual' },
    });
    const calls = provider(t).paymentCalls.length;
    t.clock.advance(31 * DAY);
    await worker(t).runOnce();
    expect(provider(t).paymentCalls.length).toBe(calls);
    expect((await planOf(started.orderId)).installments.map((i) => i.status)).toEqual([
      'paid',
      'scheduled',
      'scheduled',
    ]);
    const compensated = await post(
      t,
      `/v1/registration-checkouts/${started.id}/compensate`,
      finance.header,
      { method: 'credit', reason: 'Family accepted a credit' },
    );
    expect(compensated.status).toBe(201);
    expect(compensated.body.status).toBe('compensated');
    const plan = await planOf(started.orderId);
    expect(plan.status).toBe('canceled');
    expect(plan.installments.map((i) => i.status)).toEqual(['paid', 'canceled', 'canceled']);
    t.clock.advance(31 * DAY);
    await worker(t).runOnce();
    await drain(t);
    expect(provider(t).paymentCalls.length).toBe(calls);
  });
});

describe('abandoned payment challenges are canceled at the provider (SPK-PAY-007, §4.11 step 10; DEC-019 pending)', () => {
  let t: TestApp;
  let parent: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function challenge(price = 5_000) {
    const {
      setup,
      basket,
      checkout: started,
    } = await checkout(t, parent, FakePaymentTokens.requireAction, price);
    expect(started).toMatchObject({
      status: 'awaiting_payment',
      payment: { status: 'action_required' },
    });
    return { setup, basket, started, paymentId: (started['payment'] as { id: string }).id };
  }

  it('SPK-PAY-007 / §4.11 step 10: an abandoned challenge is canceled after the threshold; the checkout then aborts and the child can register again', async () => {
    const { setup, basket, started, paymentId } = await challenge();
    t.clock.advance(20 * MINUTE); // the hold expired; the timer waits for the challenge
    await drain(t);
    t.clock.advance(20 * MINUTE);
    await drain(t);
    t.clock.advance(21 * MINUTE); // 61 minutes after submission
    const summary = await worker(t).runOnce();
    expect(summary.paymentsCanceled).toBe(1);
    expect(provider(t).cancelCalls).toContain(paymentId);
    const canceled = await t.http.get(`/v1/payments/${paymentId}`).set(parent.header);
    expect(canceled.body).toMatchObject({
      status: 'canceled',
      failureReason: 'action_abandoned',
      evidenceSource: 'reconciliation',
    });
    t.clock.advance(5 * MINUTE);
    await drain(t);
    const aborted = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(aborted.body.status).toBe('aborted');
    const order = await t.http.get(`/v1/orders/${started['orderId'] as string}`).set(parent.header);
    expect(order.body).toMatchObject({ paymentStatus: 'canceled', fulfillmentStatus: 'canceled' });
    const obligation = await t.db
      .selectFrom('obligations')
      .select('status')
      .where('order_id', '=', started['orderId'] as string)
      .executeTakeFirstOrThrow();
    expect(obligation.status).toBe('canceled');
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', '=', (started['enrollmentIds'] as string[])[0] as string)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('canceled');
    // The timer looked again only once the cancel could have happened (bounded outbox growth).
    const timers = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'finance.checkout_expiry_due')
      .where('aggregate_id', '=', started.id)
      .execute();
    expect(timers).toHaveLength(2);
    const again = await post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId });
    const line = await post(t, `/v1/baskets/${again.body.id as string}/lines`, parent.header, {
      participantPersonId: basket.participants[0],
      offeringId: setup.offeringId,
      intent: 'youth',
    });
    expect(line.status).toBe(201);
  });

  it('SPK-PAY-007: a challenge completed just before the cancel is recorded as the capture it is', async () => {
    const { started, paymentId } = await challenge();
    provider(t).scriptCancels('succeed');
    t.clock.advance(61 * MINUTE);
    await worker(t).runOnce();
    await drain(t);
    const done = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(done.body).toMatchObject({ status: 'completed', payment: { status: 'succeeded' } });
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(receipts).toHaveLength(1);
  });

  it('SPK-PAY-007 / §4.12: a cancel without an answer keeps the attempt live with one owned exception; the next pass resolves it', async () => {
    const { started, paymentId } = await challenge();
    provider(t).scriptCancels('timeout', 'timeout');
    t.clock.advance(61 * MINUTE);
    await worker(t).runOnce();
    await worker(t).runOnce();
    const live = await t.http.get(`/v1/payments/${paymentId}`).set(parent.header);
    expect(live.body.status).toBe('action_required');
    const raised = await openExceptions(t, 'finance.payment_action_abandoned');
    expect(raised.filter((e) => e.affected_id === paymentId)).toEqual([
      expect.objectContaining({ owner_queue: 'finance_operator', status: 'open' }),
    ]);
    const abort = await post(t, `/v1/registration-checkouts/${started.id}/abort`, parent.header, {
      reason: 'never mind',
    });
    expect(abort.status).toBe(409);
    await worker(t).runOnce();
    const canceled = await t.http.get(`/v1/payments/${paymentId}`).set(parent.header);
    expect(canceled.body.status).toBe('canceled');
    t.clock.advance(5 * MINUTE);
    await drain(t);
    const aborted = await t.http.get(`/v1/registration-checkouts/${started.id}`).set(parent.header);
    expect(aborted.body.status).toBe('aborted');
  });

  it('SPK-PAY-007: abandoned challenges never starve the reconciliation of a later unknown outcome', async () => {
    const { paymentId: abandonedId } = await challenge();
    const { checkout: timedOut } = await checkout(t, parent, FakePaymentTokens.timeout, 6_000);
    const unknownId = (timedOut['payment'] as { id: string }).id;
    t.clock.advance(61 * MINUTE);
    // One page of one attempt: the abandoned challenge (older) must not take the place.
    await t.app.get(PaymentsService).reconcileStale(1);
    const resolved = await t.http.get(`/v1/payments/${unknownId}`).set(parent.header);
    expect(resolved.body).toMatchObject({ status: 'succeeded', evidenceSource: 'reconciliation' });
    const stillOpen = await t.http.get(`/v1/payments/${abandonedId}`).set(parent.header);
    expect(stillOpen.body.status).toBe('action_required');
    await worker(t).runOnce();
    await drain(t);
  });
});
