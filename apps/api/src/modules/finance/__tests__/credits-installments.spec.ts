import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createCreditFixture, createObligationFixture } from '../testing/finance-fixtures';
import {
  MINUTE,
  adult,
  basketFor,
  drain,
  financeTestApp,
  offering,
  post,
  provider,
  quoteFor,
  staff,
  worker,
  type Actor,
} from './support';

const DAY = 86_400_000;

describe('credits (SPK-PAY-009, §4.7 invariant 7)', () => {
  let t: TestApp;
  let owner: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    owner = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-009: a credit has owner, currency, permitted uses, expiry, remaining balance, source and history', async () => {
    const desk = await staff(t, ['front_desk']);
    const body = {
      ownerPersonId: owner.personId,
      amountMinor: 5_000,
      currency: 'USD',
      permittedUses: ['obligation'],
      expiresAt: new Date(t.clock.now().getTime() + 30 * DAY).toISOString(),
      sourceKind: 'goodwill',
      reason: 'Field closed twice',
    };
    expect((await post(t, '/v1/credits', desk.header, body)).status).toBe(403);
    const issued = await post(t, '/v1/credits', finance.header, body);
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({
      ownerPersonId: owner.personId,
      currency: 'USD',
      originalMinor: 5_000,
      remainingMinor: 5_000,
      permittedUses: ['obligation'],
      sourceKind: 'goodwill',
      status: 'active',
      redemptions: [],
    });
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 3_000,
    });
    const redeemed = await post(t, `/v1/credits/${issued.body.id as string}/redeem`, owner.header, {
      obligationId,
      amountMinor: 3_000,
    });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body).toMatchObject({
      remainingMinor: 2_000,
      redemptions: [
        expect.objectContaining({ kind: 'redeem', amountMinor: 3_000, referenceId: obligationId }),
      ],
    });
    const obligation = await t.http.get(`/v1/obligations/${obligationId}`).set(owner.header);
    expect(obligation.body).toMatchObject({
      status: 'settled',
      totals: { allocatedMinor: 3_000, receivedMinor: 3_000 },
    });
    // Other people learn nothing about the credit.
    const stranger = await adult(t);
    expect(
      (await t.http.get(`/v1/credits/${issued.body.id as string}`).set(stranger.header)).status,
    ).toBe(404);
    const list = await t.http.get(`/v1/credits?ownerPersonId=${owner.personId}`).set(owner.header);
    expect(list.body.items).toHaveLength(1);
  });

  it('§4.7 invariant 7: concurrent redemption cannot consume the same credit twice', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 5_000,
    });
    const first = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 5_000,
    });
    const second = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 5_000,
    });
    const results = await Promise.all(
      [first, second].map((obligationId) =>
        post(t, `/v1/credits/${creditId}/redeem`, owner.header, {
          obligationId,
          amountMinor: 5_000,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const credit = await t.db
      .selectFrom('credits')
      .selectAll()
      .where('id', '=', creditId)
      .executeTakeFirstOrThrow();
    expect(credit).toMatchObject({ remaining_minor: 0, status: 'exhausted' });
    const redemptions = await t.db
      .selectFrom('credit_redemptions')
      .select('id')
      .where('credit_id', '=', creditId)
      .execute();
    expect(redemptions).toHaveLength(1);
  });

  it('SPK-PAY-009: an expired credit or a use it does not permit is refused', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 1_000,
      permittedUses: ['registration'],
      expiresAt: new Date(t.clock.now().getTime() + DAY),
    });
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 1_000,
    });
    const wrongUse = await post(t, `/v1/credits/${creditId}/redeem`, owner.header, {
      obligationId,
      amountMinor: 500,
    });
    expect(wrongUse.status).toBe(400);
    const anyUse = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 1_000,
      expiresAt: new Date(t.clock.now().getTime() + DAY),
    });
    t.clock.advance(2 * DAY);
    const expired = await post(t, `/v1/credits/${anyUse}/redeem`, owner.header, {
      obligationId,
      amountMinor: 500,
    });
    expect(expired.status).toBe(409);
    expect(expired.body.details.code).toBe('CREDIT_EXPIRED');
    expect((await t.http.get(`/v1/credits/${anyUse}`).set(owner.header)).body.status).toBe(
      'expired',
    );
  });

  it('SPK-PAY-002/009: a credit applied in a quote is redeemed at checkout and given back when the checkout aborts', async () => {
    const setup = await offering(t, { basePriceMinor: 6_000 });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 2_500,
    });
    const { basketId } = await basketFor(t, owner, [setup]);
    const quote = await quoteFor(t, owner, basketId, { creditIds: [creditId] });
    expect(quote).toMatchObject({
      totalMinor: 6_000,
      creditsAppliedMinor: 2_500,
      dueNowMinor: 3_500,
      appliedCredits: [{ creditId, amountMinor: 2_500 }],
    });
    const res = await post(t, '/v1/registration-checkouts', owner.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.decline },
    });
    expect(res.body.status).toBe('awaiting_payment');
    const afterRedeem = await t.http.get(`/v1/credits/${creditId}`).set(owner.header);
    expect(afterRedeem.body).toMatchObject({ remainingMinor: 0, status: 'exhausted' });
    const aborted = await post(
      t,
      `/v1/registration-checkouts/${res.body.id as string}/abort`,
      owner.header,
      {
        reason: 'Changed my mind',
      },
    );
    expect(aborted.status).toBe(201);
    expect(aborted.body.status).toBe('aborted');
    const restored = await t.http.get(`/v1/credits/${creditId}`).set(owner.header);
    expect(restored.body).toMatchObject({
      remainingMinor: 2_500,
      status: 'active',
      redemptions: [
        expect.objectContaining({ kind: 'redeem', amountMinor: 2_500 }),
        expect.objectContaining({ kind: 'reversal', amountMinor: 2_500 }),
      ],
    });
  });
});

describe('installments (SPK-PAY-006)', () => {
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

  async function planCheckout(price: number) {
    const setup = await offering(t, { basePriceMinor: price });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    return quote;
  }

  it('SPK-PAY-006: a plan records amounts, due dates, explicit authorization, retry policy, notices and outstanding obligations', async () => {
    const quote = await planCheckout(30_000);
    expect(quote).toMatchObject({
      paymentPlan: 'installments',
      totalMinor: 30_000,
      dueNowMinor: 10_000,
      futureObligations: [
        { sequence: 2, amountMinor: 10_000, dueAt: '2026-12-02T15:00:00.000Z' },
        { sequence: 3, amountMinor: 10_000, dueAt: '2027-01-01T15:00:00.000Z' },
      ],
    });
    const unauthorized = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(unauthorized.status).toBe(400);
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.body).toMatchObject({ status: 'completed', payment: { amountMinor: 10_000 } });
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(payer.header);
    expect(order.body.obligationIds).toHaveLength(3);
    const planId = order.body.installmentPlanId as string;
    const plan = await t.http.get(`/v1/installment-plans/${planId}`).set(payer.header);
    expect(plan.body).toMatchObject({
      status: 'active',
      totalMinor: 30_000,
      outstandingMinor: 20_000,
      authorization: { authorizedByPersonId: payer.personId },
      retryPolicy: { maxAttempts: 3, retryIntervalHours: 72 },
      noticePolicy: { daysBefore: 3 },
    });
    expect(JSON.stringify(plan.body)).not.toContain('pm_fake');
    const installments = plan.body.installments as Array<Record<string, unknown>>;
    expect(installments.map((i) => i.status)).toEqual(['paid', 'scheduled', 'scheduled']);
    // The notice goes out three days before the second installment.
    t.clock.set('2026-11-29T15:00:01Z');
    await drain(t);
    const noticed = await t.http.get(`/v1/installment-plans/${planId}`).set(payer.header);
    expect(noticed.body.installments[1].noticeSentAt).not.toBeNull();
    const notices = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'finance.installment_notice')
      .where('aggregate_id', '=', installments[1]?.id as string)
      .execute();
    expect(notices).toHaveLength(1);
    // Due: the worker collects with the authorized method, outside any transaction.
    t.clock.set('2026-12-02T15:00:01Z');
    const summary = await worker(t).runOnce();
    expect(summary.installmentsCollected).toBe(1);
    const second = await t.http.get(`/v1/installment-plans/${planId}`).set(payer.header);
    expect(second.body).toMatchObject({ outstandingMinor: 10_000 });
    expect(second.body.installments.map((i: { status: string }) => i.status)).toEqual([
      'paid',
      'paid',
      'scheduled',
    ]);
    await drain(t);
  });

  it('SPK-PAY-006: a failed installment is a financial state plus an owned action; participation is evaluated separately', async () => {
    t.clock.set('2027-02-01T15:00:00Z');
    const quote = await planCheckout(9_000);
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.body.status).toBe('completed');
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(payer.header);
    const planId = order.body.installmentPlanId as string;
    const plan = await t.http.get(`/v1/installment-plans/${planId}`).set(finance.header);
    const second = plan.body.installments[1] as { id: string; obligationId: string };
    // The stored card is declined at collection.
    provider(t).scriptPayments(FakePaymentTokens.decline);
    const customer = await post(t, `/v1/installments/${second.id}/collect`, payer.header, {});
    expect(customer.status).toBe(403);
    const failed = await post(t, `/v1/installments/${second.id}/collect`, finance.header, {});
    expect(failed.status).toBe(201);
    expect(failed.body.installments[1]).toMatchObject({
      status: 'failed',
      attemptCount: 1,
      lastFailureReason: 'card_declined',
      nextRetryAt: '2027-02-04T15:00:00.000Z',
    });
    const obligation = await t.http.get(`/v1/obligations/${second.obligationId}`).set(payer.header);
    expect(obligation.body).toMatchObject({ status: 'open', totals: { remainingMinor: 3_000 } });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'finance.installment_failed')
      .where('affected_id', '=', second.id)
      .executeTakeFirstOrThrow();
    expect(exception).toEqual({ owner_queue: 'finance_operator', status: 'open' });
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'finance.installment_failed')
      .where('aggregate_id', '=', second.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      finalAttempt: false,
      attemptCount: 1,
      orderId: res.body.orderId,
    });
    // The enrollment stays confirmed: participation consequences are not decided here (POL-017).
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', '=', (res.body.enrollmentIds as string[])[0] as string)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('confirmed');
    // An extension moves the due date with a reason; the retry then succeeds.
    const extended = await post(t, `/v1/installments/${second.id}/extend`, finance.header, {
      dueAt: '2027-02-10T15:00:00Z',
      reason: 'Payer asked for a week',
    });
    expect(extended.body.installments[1]).toMatchObject({
      status: 'scheduled',
      extensionCount: 1,
      attemptCount: 0,
    });
    t.clock.set('2027-02-10T15:00:01Z');
    await worker(t).runOnce();
    const after = await t.http.get(`/v1/installment-plans/${planId}`).set(finance.header);
    expect(after.body.installments[1].status).toBe('paid');
    await drain(t);
    t.clock.advance(5 * MINUTE);
  });
});
