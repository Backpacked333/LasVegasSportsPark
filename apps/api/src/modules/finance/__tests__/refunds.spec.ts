import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import { PaymentOutcomeUnknownError, type CreateRefundRequest } from '../finance.ports';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createCapturedPaymentFixture, createCreditFixture } from '../testing/finance-fixtures';
import {
  MINUTE,
  adult,
  balanceOf,
  basketFor,
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

async function refundable(t: TestApp, paymentAttemptId: string) {
  return t.db
    .selectFrom('payment_refundables')
    .selectAll()
    .where('payment_attempt_id', '=', paymentAttemptId)
    .executeTakeFirstOrThrow();
}

describe('refunds: reserve before execution (SPK-PAY-008, §4.7 invariant 6, SPK-AT-007)', () => {
  let t: TestApp;
  let payer: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    payer = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-008: a refund reserves, executes outside the transaction and settles with a journal entry', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const before = await balanceOf(t, 'refunds');
    const res = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 4_000,
      reason: 'Partial refund after injury',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'succeeded',
      reservationStatus: 'settled',
      amountMinor: 4_000,
      refundable: {
        capturedMinor: 10_000,
        refundedMinor: 4_000,
        reservedMinor: 0,
        availableMinor: 6_000,
      },
    });
    expect(await balanceOf(t, 'refunds')).toBe(before + 4_000);
    const operation = await t.http
      .get(`/v1/operations/${res.body.operationId as string}`)
      .set(finance.header);
    expect(operation.body.status).toBe('succeeded');
    // Beyond the refundable amount is refused.
    const over = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_001,
      reason: 'Too much',
    });
    expect(over.status).toBe(409);
    expect(over.body.details.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('SPK-AT-007: two concurrent 60% refunds — exactly one reserves; nothing is over-refunded', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const [a, b] = await Promise.all([
      post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
        amountMinor: 6_000,
        reason: 'A',
      }),
      post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
        amountMinor: 6_000,
        reason: 'B',
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['REFUND_PENDING', 'RESOURCE_CONFLICT']).toContain(loser.body.code);
    const funds = await refundable(t, paymentAttemptId);
    expect(funds.refunded_minor + funds.reserved_minor).toBeLessThanOrEqual(funds.captured_minor);
    expect(funds.refunded_minor).toBe(6_000);
    const attempts = await t.db
      .selectFrom('refund_attempts')
      .select('id')
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute();
    expect(attempts).toHaveLength(1);
  });

  it('SPK-AT-007 / SPK-PAY-008: an unknown refund result keeps its reservation until authoritative evidence', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    provider(t).scriptRefunds('timeout');
    const uncertain = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'Uncertain refund',
    });
    expect(uncertain.status).toBe(201);
    expect(uncertain.body).toMatchObject({
      status: 'unknown',
      reservationStatus: 'reserved',
      refundable: { reservedMinor: 6_000, availableMinor: 4_000 },
    });
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['severity', 'owner_queue'])
      .where('category', '=', 'finance.unknown_refund_outcome')
      .where('affected_id', '=', uncertain.body.id as string)
      .execute();
    expect(exceptions).toEqual([{ severity: 'critical', owner_queue: 'finance_operator' }]);
    // The reserved funds cannot be refunded again while the outcome is unknown.
    const blocked = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 5_000,
      reason: 'Second attempt',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('REFUND_PENDING');
    // The provider's webhook settles it; a duplicate delivery changes nothing.
    const event = provider(t).refundWebhook(uncertain.body.id as string);
    await deliver(t, event);
    await deliver(t, event);
    await processInbox(t);
    const settled = await t.http
      .get(`/v1/refunds/${uncertain.body.id as string}`)
      .set(finance.header);
    expect(settled.body).toMatchObject({
      status: 'succeeded',
      reservationStatus: 'settled',
      refundable: { refundedMinor: 6_000, reservedMinor: 0, availableMinor: 4_000 },
    });
    const postings = await t.db
      .selectFrom('journals')
      .select('id')
      .where('source_id', '=', uncertain.body.id as string)
      .where('purpose', '=', 'refund_settled')
      .execute();
    expect(postings).toHaveLength(1);
  });

  it('SPK-PAY-008: a failed refund releases its reservation; a refund without a provider record is reconciled as failed', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 5_000,
    });
    provider(t).scriptRefunds('fail');
    const failed = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 5_000,
      reason: 'Rejected by the processor',
    });
    expect(failed.body).toMatchObject({ status: 'failed', reservationStatus: 'released' });
    expect((await refundable(t, paymentAttemptId)).reserved_minor).toBe(0);
    provider(t).scriptRefunds('processing');
    const pending = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 2_000,
      reason: 'Processing',
    });
    expect(pending.body).toMatchObject({ status: 'processing', reservationStatus: 'reserved' });
    provider(t).settleRefund(pending.body.id as string, 'succeeded');
    const reconciled = await post(
      t,
      `/v1/refunds/${pending.body.id as string}/reconcile`,
      finance.header,
    );
    expect(reconciled.body).toMatchObject({
      status: 'succeeded',
      refundable: { refundedMinor: 2_000 },
    });
  });

  it('staff role matrix: only finance roles refund; customers and desk staff cannot', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 3_000,
    });
    const desk = await staff(t, ['front_desk']);
    const byDesk = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, desk.header, {
      amountMinor: 100,
      reason: 'x',
    });
    expect(byDesk.status).toBe(403);
    const byPayer = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, payer.header, {
      amountMinor: 100,
      reason: 'x',
    });
    expect(byPayer.status).toBe(403);
    const manager = await staff(t, ['general_manager']);
    const byManager = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, manager.header, {
      amountMinor: 100,
      reason: 'Goodwill',
    });
    expect(byManager.status).toBe(201);
    // Payer privacy: another adult learns nothing about the payment (§4.10).
    const stranger = await adult(t);
    expect((await t.http.get(`/v1/payments/${paymentAttemptId}`).set(stranger.header)).status).toBe(
      404,
    );
    expect((await t.http.get(`/v1/payments/${paymentAttemptId}`).set(payer.header)).status).toBe(
      200,
    );
  });

  it('§4.10 / §4.14: finance-only money commands answer a customer the same way whether or not the record exists', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 30_000,
    });
    const refund = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 100,
      reason: 'Goodwill',
    });
    expect(refund.status).toBe(201);
    const creditId = await createCreditFixture(t, {
      ownerPersonId: payer.personId,
      amountMinor: 500,
      status: 'pending_approval',
    });
    const setup = await offering(t, { basePriceMinor: 30_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    const checkout = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    const order = await t.http
      .get(`/v1/orders/${checkout.body.orderId as string}`)
      .set(payer.header);
    const plan = await t.http
      .get(`/v1/installment-plans/${order.body.installmentPlanId as string}`)
      .set(payer.header);
    const installmentId = plan.body.installments[1].id as string;
    const stranger = await adult(t);
    const commands: Array<[(id: string) => string, string, Record<string, unknown>]> = [
      [(id) => `/v1/payments/${id}/reconcile`, paymentAttemptId, {}],
      [(id) => `/v1/payments/${id}/refunds`, paymentAttemptId, { amountMinor: 1, reason: 'x' }],
      [(id) => `/v1/refunds/${id}/reconcile`, refund.body.id as string, {}],
      [(id) => `/v1/credits/${id}/approve`, creditId, {}],
      [(id) => `/v1/installments/${id}/collect`, installmentId, {}],
      [
        (id) => `/v1/installments/${id}/extend`,
        installmentId,
        { dueAt: '2027-06-01T15:00:00Z', reason: 'x' },
      ],
      [
        (id) => `/v1/registration-checkouts/${id}/recover`,
        checkout.body.id as string,
        { reason: 'x' },
      ],
      [
        (id) => `/v1/registration-checkouts/${id}/compensate`,
        checkout.body.id as string,
        { method: 'credit', reason: 'x' },
      ],
    ];
    for (const [path, existingId, body] of commands) {
      const existing = await post(t, path(existingId), stranger.header, body);
      const missing = await post(t, path(newId()), stranger.header, body);
      expect({ path: path(':id'), status: existing.status, code: existing.body.code }).toEqual({
        path: path(':id'),
        status: missing.status,
        code: missing.body.code,
      });
      expect(existing.status).toBe(403);
    }
  });

  it('SPK-PAY-008 / SPK-AT-007: reconciling a refund whose provider call is still in flight keeps its reservation; no second refund over-refunds', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const p = provider(t);
    const original = p.createRefund.bind(p);
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(p, 'createRefund').mockImplementationOnce(async (request) => {
      entered();
      await gate;
      return original(request);
    });
    const firstCall = post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'A',
    }).then((r) => r);
    await inFlight; // the refund is `processing`; the provider call has not returned yet
    const pending = await t.db
      .selectFrom('refund_attempts')
      .select('id')
      .where('payment_attempt_id', '=', paymentAttemptId)
      .executeTakeFirstOrThrow();
    const reconciled = await post(t, `/v1/refunds/${pending.id}/reconcile`, finance.header);
    expect(reconciled.status).toBe(201);
    expect(reconciled.body).toMatchObject({
      status: 'processing',
      reservationStatus: 'reserved',
      refundable: { reservedMinor: 6_000, availableMinor: 4_000 },
    });
    const second = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'B',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REFUND_PENDING');
    release();
    const first = await firstCall;
    spy.mockRestore();
    expect(first.body).toMatchObject({
      status: 'succeeded',
      refundable: { refundedMinor: 6_000, reservedMinor: 0 },
    });
    const sent = p.refundCalls.filter((c) => c.metadata.refundAttemptId === pending.id);
    expect(sent.map((c) => c.amountMinor)).toEqual([6_000]);
    const attempts = await t.db
      .selectFrom('refund_attempts')
      .select('id')
      .where('payment_attempt_id', '=', paymentAttemptId)
      .execute();
    expect(attempts).toHaveLength(1);
  });

  it('SPK-PAY-008 / SPK-AT-007: right after a timeout the provider\'s "no record yet" keeps the reservation; the refund settles once the provider shows it', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const p = provider(t);
    let unsent: CreateRefundRequest | null = null;
    const spy = vi.spyOn(p, 'createRefund').mockImplementationOnce(async (request) => {
      unsent = request; // the request timed out before the provider recorded it
      throw new PaymentOutcomeUnknownError('timeout (simulated)');
    });
    const uncertain = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'Timed out',
    });
    spy.mockRestore();
    expect(uncertain.body).toMatchObject({ status: 'unknown', reservationStatus: 'reserved' });
    const early = await post(
      t,
      `/v1/refunds/${uncertain.body.id as string}/reconcile`,
      finance.header,
    );
    expect(early.body).toMatchObject({
      status: 'unknown',
      reservationStatus: 'reserved',
      refundable: { reservedMinor: 6_000 },
    });
    const second = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'Second',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REFUND_PENDING');
    // The provider then records the refund; the sweep finds it after the threshold.
    await p.createRefund(unsent as unknown as CreateRefundRequest);
    t.clock.advance(16 * MINUTE);
    await worker(t).runOnce();
    const settled = await t.http
      .get(`/v1/refunds/${uncertain.body.id as string}`)
      .set(finance.header);
    expect(settled.body).toMatchObject({
      status: 'succeeded',
      reservationStatus: 'settled',
      refundable: { refundedMinor: 6_000, reservedMinor: 0 },
    });
    await drain(t);
  });

  it('SPK-PAY-008: a refund the provider still has no record of after the threshold is failed and released, forced or swept', async () => {
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const p = provider(t);
    const spy = vi.spyOn(p, 'createRefund').mockImplementation(async () => {
      throw new PaymentOutcomeUnknownError('never reached the provider (simulated)');
    });
    const forced = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 3_000,
      reason: 'Forced',
    });
    const swept = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 3_000,
      reason: 'Swept',
    });
    spy.mockRestore();
    expect([forced.body.status, swept.body.status]).toEqual(['unknown', 'unknown']);
    t.clock.advance(16 * MINUTE);
    const reconciled = await post(
      t,
      `/v1/refunds/${forced.body.id as string}/reconcile`,
      finance.header,
    );
    expect(reconciled.body).toMatchObject({
      status: 'failed',
      reservationStatus: 'released',
      failureReason: 'provider_has_no_record',
    });
    await worker(t).runOnce();
    const sweptNow = await t.http.get(`/v1/refunds/${swept.body.id as string}`).set(finance.header);
    expect(sweptNow.body).toMatchObject({
      status: 'failed',
      reservationStatus: 'released',
      refundable: { reservedMinor: 0, refundedMinor: 0, availableMinor: 10_000 },
    });
    await drain(t);
  });
});
