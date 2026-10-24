import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createCreditFixture, createObligationFixture } from '../testing/finance-fixtures';
import {
  MINUTE,
  adult,
  basketFor,
  deliver,
  drain,
  financeTestApp,
  offering,
  post,
  processInbox,
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

  it('SPK-IAM-007 / §4.2: a credit is never issued to a merged person record; the survivor is named', async () => {
    const survivor = await adult(t);
    const merged = await adult(t);
    // identity's merge leaves the merged record pointing at the survivor (SPK-IAM-007)
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor.personId })
      .where('id', '=', merged.personId)
      .execute();
    const refused = await post(t, '/v1/credits', finance.header, {
      ownerPersonId: merged.personId,
      amountMinor: 1_000,
      currency: 'USD',
      permittedUses: ['obligation'],
      sourceKind: 'goodwill',
      reason: 'Goodwill',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { code: 'person_merged', canonicalPersonId: survivor.personId },
    });
    const credits = await t.db
      .selectFrom('credits')
      .select('id')
      .where('owner_person_id', '=', merged.personId)
      .execute();
    expect(credits).toEqual([]);
    const issued = await post(t, '/v1/credits', finance.header, {
      ownerPersonId: survivor.personId,
      amountMinor: 1_000,
      currency: 'USD',
      permittedUses: ['obligation'],
      sourceKind: 'goodwill',
      reason: 'Goodwill',
    });
    expect(issued.status).toBe(201);
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

  it('SPK-PAY-009 / SPK-PAY-002: a quote listing the same credit twice is rejected; listed once it applies once', async () => {
    const setup = await offering(t, { basePriceMinor: 10_000 });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 3_000,
    });
    const { basketId } = await basketFor(t, owner, [setup]);
    const twice = await post(t, '/v1/registration-quotes', owner.header, {
      basketId,
      creditIds: [creditId, creditId],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.code).toBe('VALIDATION_FAILED');
    const stored = await t.db
      .selectFrom('quotes')
      .select('id')
      .where('basket_id', '=', basketId)
      .execute();
    expect(stored).toEqual([]);
    const once = await quoteFor(t, owner, basketId, { creditIds: [creditId] });
    expect(once).toMatchObject({
      totalMinor: 10_000,
      creditsAppliedMinor: 3_000,
      dueNowMinor: 7_000,
      appliedCredits: [{ creditId, amountMinor: 3_000 }],
    });
  });

  it('SPK-PAY-002 / SPK-PAY-009: a checkout refuses a stored quote whose applied credits repeat a credit, and records nothing', async () => {
    const setup = await offering(t, { basePriceMinor: 10_000 });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 3_000,
    });
    const { basketId } = await basketFor(t, owner, [setup]);
    const valid = await quoteFor(t, owner, basketId, { creditIds: [creditId] });
    // A quote stored before duplicates were refused: the same credit counted twice.
    const row = await t.db
      .selectFrom('quotes')
      .selectAll()
      .where('id', '=', valid.id)
      .executeTakeFirstOrThrow();
    const lines = await t.db
      .selectFrom('quote_lines')
      .selectAll()
      .where('quote_id', '=', valid.id)
      .execute();
    const forgedId = newId();
    const applied = [
      { creditId, amountMinor: 3_000 },
      { creditId, amountMinor: 3_000 },
    ];
    await t.db
      .insertInto('quotes')
      .values({
        ...row,
        id: forgedId,
        credits_applied_minor: 6_000,
        due_now_minor: 4_000,
        applied_credits: json(applied),
        future_obligations: json(row.future_obligations),
        discount_codes: json(row.discount_codes),
        discounts: json(row.discounts),
        policy_references: json(row.policy_references),
        requested_by: json(row.requested_by),
      })
      .execute();
    for (const line of lines) {
      await t.db
        .insertInto('quote_lines')
        .values({
          ...line,
          id: newId(),
          quote_id: forgedId,
          discount_lines: json(line.discount_lines),
          charge_lines: json(line.charge_lines),
          policy_references: json(line.policy_references),
        })
        .execute();
    }
    const res = await post(t, '/v1/registration-checkouts', owner.header, {
      quoteId: forgedId,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.status).toBe(500);
    const orders = await t.db
      .selectFrom('orders')
      .select('id')
      .where('quote_id', '=', forgedId)
      .execute();
    expect(orders).toEqual([]);
    const credit = await t.http.get(`/v1/credits/${creditId}`).set(owner.header);
    expect(credit.body).toMatchObject({ remainingMinor: 3_000, status: 'active', redemptions: [] });
  });

  it('SPK-PAY-009 / §4.9: a second application of the same credit to the same obligation is refused (409 CREDIT_ALREADY_APPLIED), never a silent no-op', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 5_000,
    });
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 4_000,
    });
    const first = await post(t, `/v1/credits/${creditId}/redeem`, owner.header, {
      obligationId,
      amountMinor: 1_000,
    });
    expect(first.status).toBe(201);
    expect(first.body.remainingMinor).toBe(4_000);
    const second = await post(t, `/v1/credits/${creditId}/redeem`, owner.header, {
      obligationId,
      amountMinor: 1_000,
    });
    expect(second.status).toBe(409);
    expect(second.body.details.code).toBe('CREDIT_ALREADY_APPLIED');
    const credit = await t.db
      .selectFrom('credits')
      .select(['remaining_minor', 'revision'])
      .where('id', '=', creditId)
      .executeTakeFirstOrThrow();
    expect(credit.remaining_minor).toBe(4_000);
    const obligation = await t.http.get(`/v1/obligations/${obligationId}`).set(owner.header);
    expect(obligation.body.totals).toMatchObject({ allocatedMinor: 1_000, remainingMinor: 3_000 });
    const redemptions = await t.db
      .selectFrom('credit_redemptions')
      .select('id')
      .where('credit_id', '=', creditId)
      .execute();
    expect(redemptions).toHaveLength(1);
    // The audit records the one redemption that happened, with the revision it produced.
    const audits = await t.db
      .selectFrom('audit_records')
      .select(['after_revision'])
      .where('action', '=', 'finance.redeem_credit')
      .where('target_id', '=', creditId)
      .execute();
    expect(audits).toEqual([{ after_revision: credit.revision }]);
  });

  it('SPK-PAY-009: concurrent applications of one credit to one obligation apply it once and refuse the other (never a 500)', async () => {
    const creditId = await createCreditFixture(t, {
      ownerPersonId: owner.personId,
      amountMinor: 5_000,
    });
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: owner.personId,
      amountMinor: 4_000,
    });
    const results = await Promise.all(
      [1_000, 1_500].map((amountMinor) =>
        post(t, `/v1/credits/${creditId}/redeem`, owner.header, { obligationId, amountMinor }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409);
    expect(refused?.body.details.code).toBe('CREDIT_ALREADY_APPLIED');
    const redemptions = await t.db
      .selectFrom('credit_redemptions')
      .select('amount_minor')
      .where('credit_id', '=', creditId)
      .execute();
    expect(redemptions).toHaveLength(1);
    const credit = await t.db
      .selectFrom('credits')
      .select('remaining_minor')
      .where('id', '=', creditId)
      .executeTakeFirstOrThrow();
    expect(credit.remaining_minor).toBe(5_000 - Number(redemptions[0]?.amount_minor));
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

  it('SPK-PAY-006 / POL-016: an extended installment gets a notice for its new due date; a timer for the old date sends nothing', async () => {
    t.clock.set('2027-03-01T15:00:00Z');
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
    const [, second, third] = plan.body.installments as Array<{ id: string; dueAt: string }>;
    expect(second?.dueAt).toBe('2027-03-31T15:00:00.000Z');
    expect(third?.dueAt).toBe('2027-04-30T15:00:00.000Z');
    const notices = async (installmentId: string) =>
      (
        await t.db
          .selectFrom('outbox_events')
          .select('payload')
          .where('event_type', '=', 'finance.installment_notice')
          .where('aggregate_id', '=', installmentId)
          .orderBy('occurred_at')
          .execute()
      ).map((e) => (e.payload as { dueAt: string }).dueAt);
    // The notice for the second installment goes out three days before it falls due...
    t.clock.set('2027-03-28T15:00:01Z');
    await drain(t);
    expect(await notices(second?.id as string)).toEqual(['2027-03-31T15:00:00.000Z']);
    // ...then the installment is extended: the new due date gets its own notice.
    const extended = await post(
      t,
      `/v1/installments/${second?.id as string}/extend`,
      finance.header,
      {
        dueAt: '2027-04-20T15:00:00Z',
        reason: 'Payer asked for three weeks',
      },
    );
    expect(extended.status).toBe(201);
    expect(extended.body.installments[1]).toMatchObject({
      status: 'scheduled',
      noticeSentAt: null,
    });
    t.clock.set('2027-04-17T15:00:01Z');
    await drain(t);
    expect(await notices(second?.id as string)).toEqual([
      '2027-03-31T15:00:00.000Z',
      '2027-04-20T15:00:00.000Z',
    ]);
    // Extended before its first notice: the timer for the old date announces nothing early.
    const moved = await post(t, `/v1/installments/${third?.id as string}/extend`, finance.header, {
      dueAt: '2027-05-30T15:00:00Z',
      reason: 'Aligned with the payday',
    });
    expect(moved.status).toBe(201);
    t.clock.set('2027-04-27T15:00:01Z');
    await drain(t);
    expect(await notices(third?.id as string)).toEqual([]);
    t.clock.set('2027-05-27T15:00:01Z');
    await drain(t);
    expect(await notices(third?.id as string)).toEqual(['2027-05-30T15:00:00.000Z']);
  });
});

describe('installments: no charge beside the checkout payment of the same debt (SPK-PAY-007, §4.7 invariant 5)', () => {
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

  async function pendingPlanCheckout(token: string) {
    const setup = await offering(t, { basePriceMinor: 30_000 });
    const { basketId } = await basketFor(t, payer, [setup]);
    const quote = await quoteFor(t, payer, basketId, {
      paymentPlan: { kind: 'installments', count: 3 },
    });
    const res = await post(t, '/v1/registration-checkouts', payer.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: token },
      authorizeFutureInstallments: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('awaiting_payment');
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(payer.header);
    const plan = await t.http
      .get(`/v1/installment-plans/${order.body.installmentPlanId as string}`)
      .set(finance.header);
    const first = plan.body.installments[0] as { id: string; obligationId: string };
    return { checkout: res.body as Record<string, unknown> & { id: string }, first };
  }

  async function installmentRow(id: string) {
    return t.db
      .selectFrom('installments')
      .select(['status', 'attempt_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  const scenarios = [
    { name: 'processing', token: FakePaymentTokens.processing, settle: true },
    { name: 'action_required', token: FakePaymentTokens.requireAction, settle: true },
    { name: 'unknown', token: FakePaymentTokens.timeout, settle: false },
  ] as const;

  for (const scenario of scenarios) {
    it(`SPK-PAY-007: the worker never collects the due-now installment while the checkout payment is ${scenario.name}`, async () => {
      const { checkout, first } = await pendingPlanCheckout(scenario.token);
      const payment = checkout['payment'] as { id: string; status: string };
      expect(payment.status).toBe(scenario.name);
      // The checkout charge names the debt it pays (payment_attempts_live_obligation_idx).
      const attempt = await t.db
        .selectFrom('payment_attempts')
        .select('obligation_id')
        .where('id', '=', payment.id)
        .executeTakeFirstOrThrow();
      expect(attempt.obligation_id).toBe(first.obligationId);
      const calls = provider(t).paymentCalls.length;
      const succeededBefore = provider(t).chargeCount('succeeded');
      const summary = await worker(t).runOnce();
      expect(summary.installmentsCollected).toBe(0);
      expect(provider(t).paymentCalls.length).toBe(calls);
      expect(await installmentRow(first.id)).toEqual({ status: 'scheduled', attempt_count: 1 });
      // Staff cannot collect it either while the checkout's own payment is pending.
      const manual = await post(t, `/v1/installments/${first.id}/collect`, finance.header, {});
      expect(manual.status).toBe(409);
      expect(manual.body.details.code).toBe('CHECKOUT_PAYMENT_PENDING');
      expect(provider(t).paymentCalls.length).toBe(calls);
      // The checkout payment completes: the first installment is paid by it, exactly once.
      if (scenario.settle) provider(t).settlePayment(payment.id, 'succeeded');
      await deliver(t, provider(t).paymentWebhook(payment.id));
      await processInbox(t);
      const done = await t.http.get(`/v1/registration-checkouts/${checkout.id}`).set(payer.header);
      expect(done.body.status).toBe('completed');
      expect((await installmentRow(first.id)).status).toBe('paid');
      expect(provider(t).chargeCount('succeeded')).toBe(
        succeededBefore + (scenario.settle ? 1 : 0),
      );
      const attempts = await t.db
        .selectFrom('payment_attempts')
        .select('id')
        .where('order_id', '=', checkout['orderId'] as string)
        .execute();
      expect(attempts).toHaveLength(1);
      const overpayments = await t.db
        .selectFrom('credits')
        .select('id')
        .where('owner_person_id', '=', payer.personId)
        .where('source_kind', '=', 'overpayment')
        .execute();
      expect(overpayments).toEqual([]);
    });
  }

  it('SPK-PAY-006 / SPK-PAY-007: a declined checkout payment never turns into an installment charge or an installment failure', async () => {
    const { checkout, first } = await pendingPlanCheckout(FakePaymentTokens.decline);
    expect(checkout['payment']).toMatchObject({ status: 'failed' });
    const calls = provider(t).paymentCalls.length;
    const summary = await worker(t).runOnce();
    expect(summary.installmentsCollected).toBe(0);
    expect(provider(t).paymentCalls.length).toBe(calls);
    expect(await installmentRow(first.id)).toEqual({ status: 'scheduled', attempt_count: 1 });
    const failures = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'finance.installment_failed')
      .where('affected_id', '=', first.id)
      .execute();
    expect(failures).toEqual([]);
  });
});
