import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import {
  adult,
  basketFor,
  child,
  drain,
  financeTestApp,
  key,
  ledgerTotals,
  offering,
  post,
  provider,
  quoteFor,
  staff,
  type Actor,
} from './support';

describe('registration quotes and checkout (§4.11, SPK-PAY-001/002/007)', () => {
  let t: TestApp;
  let parent: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-002: a quote shows each participant and item, base price, discounts, approved taxes and fees, credits, due now, expiry and policies', async () => {
    const setup = await offering(t, {
      basePriceMinor: 12_500,
      chargeLines: [
        { code: 'tax', label: 'Sales tax', kind: 'tax', basisPoints: 800, inclusive: false },
        { code: 'fee', label: 'Facility fee', kind: 'fee', amountMinor: 250, inclusive: false },
      ],
    });
    const { basketId, participants } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    expect(quote).toMatchObject({
      basketId,
      payerPersonId: parent.personId,
      status: 'active',
      currency: 'USD',
      subtotalMinor: 12_500,
      discountMinor: 0,
      taxMinor: 1_000,
      feeMinor: 250,
      totalMinor: 13_750,
      creditsAppliedMinor: 0,
      dueNowMinor: 13_750,
      paymentPlan: 'full',
      futureObligations: [],
    });
    const lines = quote['lines'] as Array<Record<string, unknown>>;
    expect(lines).toEqual([
      expect.objectContaining({
        participantPersonId: participants[0],
        offeringId: setup.offeringId,
        priceRuleId: setup.priceRuleId,
        unitPriceMinor: 12_500,
        taxMinor: 1_000,
        feeMinor: 250,
        totalMinor: 13_750,
        policies: expect.objectContaining({
          cancellationPolicyVersionId: setup.cancellationPolicyVersionId,
          eligibilityPolicyVersionId: setup.eligibilityPolicyVersionId,
        }),
      }),
    ]);
    // POL-013: the quote expires no later than the hold.
    expect(new Date(quote['expiresAt'] as string).getTime()).toBeLessThanOrEqual(
      t.clock.now().getTime() + 10 * 60_000,
    );
  });

  it('SPK-PAY-001: client-submitted prices are rejected and never become the basis', async () => {
    const setup = await offering(t, { basePriceMinor: 9_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const tampered = await post(t, '/v1/registration-quotes', parent.header, {
      basketId,
      totalMinor: 1,
    });
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('VALIDATION_FAILED');
    const quote = await quoteFor(t, parent, basketId);
    expect(quote.totalMinor).toBe(9_000);
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      amountMinor: 1,
    });
    expect(checkout.status).toBe(400);
    // Card details never reach the API (§4.14).
    const card = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: 'pm_4242424242424242' },
    });
    expect(card.status).toBe(400);
  });

  it('§4.11: checkout acquires holds, records the payment as facts and confirms the enrollments in one finalization', async () => {
    const setup = await offering(t, { basePriceMinor: 10_000 });
    const { basketId, participants } = await basketFor(t, parent, [setup], { hold: false });
    const quote = await quoteFor(t, parent, basketId);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'completed',
      paymentKind: 'provider',
      payment: { status: 'succeeded', amountMinor: 10_000, evidenceSource: 'sync_response' },
      receipt: { amountMinor: 10_000, allocatedMinor: 10_000, excessMinor: 0 },
      nextAction: null,
    });
    const enrollmentIds = res.body.enrollmentIds as string[];
    expect(enrollmentIds).toHaveLength(1);
    const enrollment = await t.http.get(`/v1/enrollments/${enrollmentIds[0]}`).set(parent.header);
    expect(enrollment.body).toMatchObject({
      status: 'confirmed',
      participantPersonId: participants[0],
      orderRef: res.body.orderId,
    });
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(parent.header);
    expect(order.body).toMatchObject({
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      totalMinor: 10_000,
    });
    const operation = await t.http
      .get(`/v1/operations/${res.body.operationId as string}`)
      .set(parent.header);
    expect(operation.body).toMatchObject({
      status: 'succeeded',
      kind: 'finance.registration_checkout',
    });
    const basket = await t.http.get(`/v1/baskets/${basketId}`).set(parent.header);
    expect(basket.body.status).toBe('fulfilled');
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', 'in', [res.body.orderId as string, res.body.id as string])
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining([
        'finance.order_paid',
        'finance.enrollment_fulfilled',
        'finance.checkout_started',
      ]),
    );
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
    await drain(t);
  });

  it('§4.9 / invariant 5: a replayed checkout returns the same outcome with one order and one charge', async () => {
    const setup = await offering(t, { basePriceMinor: 7_500 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    const body = {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    };
    const idempotencyKey = key();
    const charges = provider(t).chargeCount();
    const first = await post(t, '/v1/registration-checkouts', parent.header, body, idempotencyKey);
    const replay = await post(t, '/v1/registration-checkouts', parent.header, body, idempotencyKey);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    // A different key for the same quote still returns the one checkout (one checkout per quote).
    const again = await post(t, '/v1/registration-checkouts', parent.header, body);
    expect(again.body.id).toBe(first.body.id);
    expect(provider(t).chargeCount()).toBe(charges + 1);
    const orders = await t.db
      .selectFrom('orders')
      .select('id')
      .where('quote_id', '=', quote.id)
      .execute();
    expect(orders).toHaveLength(1);
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('order_id', '=', first.body.orderId as string)
      .execute();
    expect(receipts).toHaveLength(1);
  });

  it('QUOTE_EXPIRED: an expired quote needs a new one', async () => {
    const setup = await offering(t, { basePriceMinor: 5_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    t.clock.advance(11 * 60_000);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'QUOTE_EXPIRED', nextAction: 'request_new_quote' });
    await drain(t);
  });

  it('§4.7 invariant 1 / §4.10: another household and another organization learn nothing', async () => {
    const setup = await offering(t, { basePriceMinor: 5_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const stranger = await adult(t);
    const quoteAttempt = await post(t, '/v1/registration-quotes', stranger.header, { basketId });
    expect(quoteAttempt.status).toBe(404);
    const quote = await quoteFor(t, parent, basketId);
    expect(
      (await t.http.get(`/v1/registration-quotes/${quote.id}`).set(stranger.header)).status,
    ).toBe(404);
    const checkout = await post(t, '/v1/registration-checkouts', stranger.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status).toBe(404);
    const other = await seedOrganization(t.db);
    const foreignStaff = await staff(t, ['finance_operator'], other.organizationId);
    expect(
      (await t.http.get(`/v1/registration-quotes/${quote.id}`).set(foreignStaff.header)).status,
    ).toBe(404);
    // A second guardian with pay authority over the same child still cannot use the payer's quote.
    const coGuardian = await adult(t);
    const shared = await child(t, [parent, coGuardian]);
    const sharedBasket = await basketFor(t, parent, [setup], { participants: [shared] });
    const sharedQuote = await quoteFor(t, parent, sharedBasket.basketId);
    const hijack = await post(t, '/v1/registration-checkouts', coGuardian.header, {
      quoteId: sharedQuote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(hijack.status).toBe(404);
  });

  it('staff role matrix: desk staff check out for a family; schedulers and coaches cannot', async () => {
    const setup = await offering(t, { basePriceMinor: 4_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const scheduler = await staff(t, ['scheduler']);
    expect((await post(t, '/v1/registration-quotes', scheduler.header, { basketId })).status).toBe(
      404,
    );
    const coach = await staff(t, ['coach']);
    expect((await post(t, '/v1/registration-quotes', coach.header, { basketId })).status).toBe(404);
    const desk = await staff(t, ['front_desk']);
    const quote = await quoteFor(t, desk, basketId);
    expect(quote.payerPersonId).toBe(parent.personId);
    // A customer may never record a cash tender (SPK-PAY-012).
    const cashByCustomer = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: {
        method: 'cash',
        tenderKind: 'cash',
        facilityId: t.facilityId,
        evidence: { reference: 'R-1' },
      },
    });
    expect(cashByCustomer.status).toBe(403);
    const cash = await post(t, '/v1/registration-checkouts', desk.header, {
      quoteId: quote.id,
      payment: {
        method: 'cash',
        tenderKind: 'cash',
        facilityId: t.facilityId,
        evidence: { reference: 'R-1' },
      },
    });
    expect(cash.status).toBe(201);
    expect(cash.body).toMatchObject({
      status: 'completed',
      paymentKind: 'cash',
      receipt: { sourceKind: 'cash_tender', amountMinor: 4_000 },
    });
    const tender = await t.db
      .selectFrom('cash_tenders')
      .selectAll()
      .where('checkout_id', '=', cash.body.id as string)
      .executeTakeFirstOrThrow();
    expect(tender).toMatchObject({ recorded_by_person_id: desk.personId, status: 'recorded' });
  });
});
