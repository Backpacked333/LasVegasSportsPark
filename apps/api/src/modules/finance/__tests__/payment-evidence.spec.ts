import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createAcknowledgmentFixture } from '../../catalog';
import { FakePaymentProvider, FakePaymentTokens } from '../providers/fake-payment.provider';
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

  it('§4.11: "succeeded" after "failed" for one attempt raises an exception and never flips the record', async () => {
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
    await processInbox(t);
    expect((await t.http.get(`/v1/payments/${paymentId}`).set(parent.header)).body.status).toBe(
      'failed',
    );
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('payment_attempt_id', '=', paymentId)
      .execute();
    expect(receipts).toHaveLength(0);
    const conflicts = await openExceptions(t, 'finance.payment_evidence_conflict');
    expect(conflicts.find((e) => e.affected_id === paymentId)).toMatchObject({
      severity: 'critical',
      owner_queue: 'finance_operator',
    });
    // The payer may retry with another method while the hold lasts.
    const retried = await post(
      t,
      `/v1/registration-checkouts/${started.id}/payments`,
      parent.header,
      {
        paymentMethodToken: FakePaymentTokens.succeed,
      },
    );
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ status: 'completed', payment: { status: 'succeeded' } });
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
});
