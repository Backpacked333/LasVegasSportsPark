import { errors } from '@sportspark/contracts';
import { pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork, databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPolicyVersionFixture } from '../../catalog';
import { ENROLLMENT_PORT, EnrollmentsService, type EnrollmentPort } from '../../enrollment';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { CheckoutFinalizer } from '../services/checkout-finalizer.service';
import { FinancePolicyResolver } from '../services/finance-policy.resolver';
import { createCreditFixture } from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  drain,
  financeTestApp,
  offering,
  post,
  quoteFor,
  staff,
  type Actor,
} from './support';

/**
 * Makes the enrollment port fail the next N confirmations: a stopped worker, a domain refusal, or
 * the place being gone (a definitive failure compensated per policy, SPK-AT-006).
 */
const flaky = { failures: 0, kind: 'crash' as 'crash' | 'domain' | 'capacity' };

async function refusedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

function flakyEnrollmentPort(real: EnrollmentsService): EnrollmentPort {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'confirmEnrollment') {
        return async (...args: Parameters<EnrollmentPort['confirmEnrollment']>) => {
          if (flaky.failures > 0) {
            flaky.failures -= 1;
            if (flaky.kind === 'domain') {
              throw errors.resourceConflict('Enrollment refused the confirmation (simulated).');
            }
            if (flaky.kind === 'capacity') {
              throw errors.capacityUnavailable('The place was taken (simulated).');
            }
            throw new Error('worker stopped after the registration commit (simulated)');
          }
          return target.confirmEnrollment(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('durable finalization (SPK-AT-023, §4.11 step 8, §4.12)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(ENROLLMENT_PORT)
          .useFactory({ factory: flakyEnrollmentPort, inject: [EnrollmentsService] }),
    });
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function paidCheckout(price: number) {
    const setup = await offering(t, { basePriceMinor: price });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.status).toBe(201);
    return res.body as Record<string, unknown> & {
      id: string;
      orderId: string;
      enrollmentIds: string[];
    };
  }

  it('SPK-AT-023: the finalization handler fails, the follow-up resumes, and nothing is confirmed or posted twice', async () => {
    flaky.kind = 'crash';
    flaky.failures = 2; // the inline attempt and the first handler attempt
    const checkout = await paidCheckout(11_000);
    // Money facts are committed; fulfillment is pending durable follow-up.
    expect(checkout).toMatchObject({
      status: 'finalizing',
      payment: { status: 'succeeded' },
      nextAction: 'await_fulfillment',
    });
    const enrollmentId = checkout.enrollmentIds[0] as string;
    const entriesBefore = await t.db.selectFrom('journal_entries').select('id').execute();
    await drain(t); // handler attempt fails; the event is retried with backoff
    expect(
      (await t.http.get(`/v1/registration-checkouts/${checkout.id}`).set(parent.header)).body
        .status,
    ).toBe('finalizing');
    const failedAttempts = await t.db
      .selectFrom('job_attempts')
      .select('outcome')
      .where('handler', '=', 'finance.finalize_checkout')
      .where('outcome', '=', 'failed')
      .execute();
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    t.clock.advance(5_000);
    await drain(t);
    const done = await t.http.get(`/v1/registration-checkouts/${checkout.id}`).set(parent.header);
    expect(done.body.status).toBe('completed');
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['status', 'order_ref'])
      .where('id', '=', enrollmentId)
      .executeTakeFirstOrThrow();
    expect(enrollment).toEqual({ status: 'confirmed', order_ref: checkout.orderId });

    // Redelivery of the same follow-up (an interrupted worker's event claimed again).
    const event = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'finance.checkout_payment_received')
      .where('aggregate_id', '=', checkout.id)
      .executeTakeFirstOrThrow();
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', dispatched_at: null, available_at: t.clock.now() })
      .where('id', '=', event.id)
      .execute();
    await drain(t);
    // And a direct replay of the finalization itself.
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app.get(CheckoutFinalizer).finalizeInTrx(trx, t.organizationId, checkout.id, null),
      );

    const confirmations = await t.db
      .selectFrom('audit_records')
      .select('id')
      .where('action', '=', 'enrollment.confirm')
      .where('target_id', '=', enrollmentId)
      .execute();
    expect(confirmations).toHaveLength(1);
    const fulfilled = await t.db
      .selectFrom('outbox_events')
      .select('id')
      .where('event_type', '=', 'finance.enrollment_fulfilled')
      .where('aggregate_id', '=', checkout.id)
      .execute();
    expect(fulfilled).toHaveLength(1);
    const receipts = await t.db
      .selectFrom('receipts')
      .select('id')
      .where('order_id', '=', checkout.orderId)
      .execute();
    expect(receipts).toHaveLength(1);
    // Finalization posts no journal: every money fact was posted once, at evidence time.
    const entriesAfter = await t.db.selectFrom('journal_entries').select('id').execute();
    expect(entriesAfter.length).toBe(entriesBefore.length);
  });

  it('§4.11: a refused finalization after payment is received money plus incomplete fulfillment; staff recover it', async () => {
    flaky.kind = 'domain';
    flaky.failures = 1;
    const checkout = await paidCheckout(7_000);
    expect(checkout).toMatchObject({
      status: 'recovery_required',
      recovery: { plan: 'manual', reasonCode: 'RESOURCE_CONFLICT' },
    });
    const order = await t.http.get(`/v1/orders/${checkout.orderId}`).set(parent.header);
    expect(order.body).toMatchObject({
      paymentStatus: 'paid',
      fulfillmentStatus: 'recovery_required',
    });
    const byParent = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/recover`,
      parent.header,
      {
        reason: 'try again',
      },
    );
    expect(byParent.status).toBe(403);
    const recovered = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/recover`,
      finance.header,
      {
        reason: 'Enrollment issue resolved',
      },
    );
    expect(recovered.status).toBe(201);
    expect(recovered.body.status).toBe('completed');
    const operation = await t.http
      .get(`/v1/operations/${checkout['operationId'] as string}`)
      .set(parent.header);
    expect(operation.body).toMatchObject({ status: 'succeeded', result: { recovered: true } });
    await drain(t);
  });

  it('§4.11 step 10: staff may compensate an unfulfillable checkout with a credit instead', async () => {
    flaky.kind = 'domain';
    flaky.failures = 1;
    const checkout = await paidCheckout(4_500);
    expect(checkout.status).toBe('recovery_required');
    const compensated = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/compensate`,
      finance.header,
      {
        method: 'credit',
        reason: 'Family accepted a credit',
      },
    );
    expect(compensated.status).toBe(201);
    expect(compensated.body).toMatchObject({ status: 'compensated', recovery: { plan: 'credit' } });
    const creditId = compensated.body.recovery.creditId as string;
    const credit = await t.http.get(`/v1/credits/${creditId}`).set(parent.header);
    expect(credit.body).toMatchObject({
      sourceKind: 'compensation',
      originalMinor: 4_500,
      status: 'active',
    });
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', '=', checkout.enrollmentIds[0] as string)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('canceled');
    await drain(t);
  });

  it('SPK-PAY-009 / §4.11 step 10: staff credit compensation gives back the credit applied at checkout beside a credit for the card part', async () => {
    const setup = await offering(t, { basePriceMinor: 10_000 });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 4_000,
    });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId, { creditIds: [creditId] });
    flaky.kind = 'domain';
    flaky.failures = 1;
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.body).toMatchObject({
      status: 'recovery_required',
      payment: { amountMinor: 6_000 },
    });
    const compensated = await post(
      t,
      `/v1/registration-checkouts/${res.body.id as string}/compensate`,
      finance.header,
      { method: 'credit', reason: 'Family accepted a credit' },
    );
    expect(compensated.status).toBe(201);
    expect(compensated.body.status).toBe('compensated');
    const compensation = await t.http
      .get(`/v1/credits/${compensated.body.recovery.creditId as string}`)
      .set(parent.header);
    expect(compensation.body).toMatchObject({ sourceKind: 'compensation', originalMinor: 6_000 });
    const original = await t.http.get(`/v1/credits/${creditId}`).set(parent.header);
    expect(original.body).toMatchObject({ remainingMinor: 4_000, status: 'active' });
    expect(Number(compensation.body.remainingMinor) + Number(original.body.remainingMinor)).toBe(
      10_000,
    );
    await drain(t);
  });

  it('SPK-PAY-008, §4.7 invariant 6 (MONEY-02): a credit compensation gives back only what was not refunded, and consumes it, so nothing is returned twice', async () => {
    flaky.kind = 'domain';
    flaky.failures = 1;
    const checkout = await paidCheckout(10_000);
    expect(checkout.status).toBe('recovery_required');
    const attemptId = (checkout['payment'] as { id: string }).id;
    const partial = await post(t, `/v1/payments/${attemptId}/refunds`, finance.header, {
      amountMinor: 4_000,
      reason: 'Partial goodwill refund',
    });
    expect(partial.body.status).toBe('succeeded');
    const compensated = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/compensate`,
      finance.header,
      { method: 'credit', reason: 'Family accepted a credit for the rest' },
    );
    expect(compensated.status, JSON.stringify(compensated.body)).toBe(201);
    const credit = await t.http
      .get(`/v1/credits/${compensated.body.recovery.creditId as string}`)
      .set(parent.header);
    expect(credit.body).toMatchObject({ sourceKind: 'compensation', originalMinor: 6_000 });
    // The payment shows nothing left to refund, and a further refund is refused.
    const payment = await t.http.get(`/v1/payments/${attemptId}`).set(finance.header);
    expect(payment.body.refundableMinor).toBe(0);
    const again = await post(t, `/v1/payments/${attemptId}/refunds`, finance.header, {
      amountMinor: 6_000,
      reason: 'Refund the rest too',
    });
    expect(again.status).toBe(409);
    expect(again.body.details).toMatchObject({
      code: 'REFUND_EXCEEDS_REFUNDABLE',
      availableMinor: 0,
    });
    // The database refuses it whoever writes it, and never gives compensated funds back.
    const refundableRow = () =>
      t.db
        .selectFrom('payment_refundables')
        .selectAll()
        .where('payment_attempt_id', '=', attemptId)
        .executeTakeFirstOrThrow();
    expect(await refundableRow()).toMatchObject({
      captured_minor: 10_000,
      refunded_minor: 4_000,
      compensated_minor: 6_000,
    });
    expect(
      await refusedBy(
        t.db
          .updateTable('payment_refundables')
          .set({ reserved_minor: 1 })
          .where('payment_attempt_id', '=', attemptId)
          .execute(),
      ),
    ).toBe('23514:payment_refundables_within_captured');
    expect(
      await refusedBy(
        t.db
          .updateTable('payment_refundables')
          .set({ compensated_minor: 0 })
          .where('payment_attempt_id', '=', attemptId)
          .execute(),
      ),
    ).toBe('23514:payment_refundables_compensated_accumulate');
    await drain(t);
  });

  it('SPK-PAY-008 (MONEY-02): a credit compensation waits while a refund of the payment is still reserved', async () => {
    flaky.kind = 'domain';
    flaky.failures = 1;
    const checkout = await paidCheckout(8_000);
    const attemptId = (checkout['payment'] as { id: string }).id;
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        trx
          .updateTable('payment_refundables')
          .set({ reserved_minor: 3_000 })
          .where('payment_attempt_id', '=', attemptId)
          .execute(),
      );
    const refused = await post(
      t,
      `/v1/registration-checkouts/${checkout.id}/compensate`,
      finance.header,
      { method: 'credit', reason: 'Family accepted a credit' },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('REFUND_PENDING');
    const still = await t.http.get(`/v1/registration-checkouts/${checkout.id}`).set(finance.header);
    expect(still.body.status).toBe('recovery_required');
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        trx
          .updateTable('payment_refundables')
          .set({ reserved_minor: 0 })
          .where('payment_attempt_id', '=', attemptId)
          .execute(),
      );
  });

  it('SPK-PAY-009 / §4.11 step 10: compensating a checkout paid entirely with a credit gives the credit back', async () => {
    const setup = await offering(t, { basePriceMinor: 5_000 });
    const creditId = await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 5_000,
    });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId, { creditIds: [creditId] });
    expect(quote.dueNowMinor).toBe(0);
    flaky.kind = 'domain';
    flaky.failures = 1;
    const res = await post(t, '/v1/registration-checkouts', parent.header, { quoteId: quote.id });
    expect(res.body).toMatchObject({ status: 'recovery_required', paymentKind: 'none' });
    const compensated = await post(
      t,
      `/v1/registration-checkouts/${res.body.id as string}/compensate`,
      finance.header,
      { method: 'credit', reason: 'Place could not be confirmed' },
    );
    expect(compensated.body).toMatchObject({
      status: 'compensated',
      recovery: { plan: 'credit', creditId: null },
    });
    const restored = await t.http.get(`/v1/credits/${creditId}`).set(parent.header);
    expect(restored.body).toMatchObject({ remainingMinor: 5_000, status: 'active' });
    await drain(t);
  });
});

describe('a purchase keeps its policy basis (SPK-PAY-002; POL-009, POL-016 with DEC-008 / DEC-009 pending)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(ENROLLMENT_PORT)
          .useFactory({ factory: flakyEnrollmentPort, inject: [EnrollmentsService] }),
    });
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    flaky.failures = 0;
    await t.close();
  });

  async function installmentQuote() {
    const setup = await offering(t, { basePriceMinor: 30_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    return quoteFor(t, parent, basketId, { paymentPlan: { kind: 'installments', count: 3 } });
  }

  async function planFor(quoteId: string) {
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      authorizeFutureInstallments: true,
    });
    expect(res.body.status).toBe('completed');
    const order = await t.http.get(`/v1/orders/${res.body.orderId as string}`).set(parent.header);
    const plan = await t.http
      .get(`/v1/installment-plans/${order.body.installmentPlanId as string}`)
      .set(finance.header);
    return plan.body as {
      retryPolicy: { maxAttempts: number };
      noticePolicy: { daysBefore: number };
      installments: Array<{ id: string; revision: number }>;
    };
  }

  it("SPK-PAY-002 / POL-016: installment terms come from the policy the quote recorded, not one approved since; extensions use the plan's notice lead time", async () => {
    const before = await installmentQuote();
    await createPolicyVersionFixture(t, {
      kind: 'installment',
      key: 'finance',
      content: { retryMaxAttempts: 5, noticeDaysBefore: 7 },
    });
    const basis = await planFor(before.id);
    expect(basis).toMatchObject({
      retryPolicy: { maxAttempts: 3 },
      noticePolicy: { daysBefore: 3 },
    });
    const after = await installmentQuote();
    const current = await planFor(after.id);
    expect(current).toMatchObject({
      retryPolicy: { maxAttempts: 5 },
      noticePolicy: { daysBefore: 7 },
    });
    // POL-016: an extended installment is announced the plan's lead time before its new date.
    const second = current.installments[1] as { id: string; revision: number };
    const extended = await post(t, `/v1/installments/${second.id}/extend`, finance.header, {
      dueAt: '2027-02-20T15:00:00Z',
      reason: 'Payer asked',
      expectedRevision: second.revision,
    });
    expect(extended.status).toBe(201);
    const timers = await t.db
      .selectFrom('outbox_events')
      .select('available_at')
      .where('event_type', '=', 'finance.installment_notice_due')
      .where('aggregate_id', '=', second.id)
      .orderBy('available_at', 'desc')
      .execute();
    expect(new Date(timers[0]?.available_at as Date).toISOString()).toBe(
      '2027-02-13T15:00:00.000Z',
    );
  });

  it('SPK-PAY-002 / SPK-AT-006: the compensation method comes from the refund policy the order recorded, not one approved after the quote', async () => {
    const setup = await offering(t, { basePriceMinor: 8_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    await createPolicyVersionFixture(t, {
      kind: 'refund',
      key: 'finance',
      content: { compensation: 'credit' },
    });
    flaky.kind = 'capacity';
    flaky.failures = 1;
    const res = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    // No refund policy when the family bought: the engineering default (refund) applies.
    expect(res.body).toMatchObject({
      status: 'recovery_required',
      recovery: { plan: 'refund', reasonCode: 'CAPACITY_UNAVAILABLE' },
    });
    await drain(t);
    // A purchase made under the new policy is compensated by it.
    const later = await offering(t, { basePriceMinor: 8_000 });
    const { basketId: laterBasket } = await basketFor(t, parent, [later]);
    const laterQuote = await quoteFor(t, parent, laterBasket);
    flaky.kind = 'capacity';
    flaky.failures = 1;
    const credited = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: laterQuote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(credited.body).toMatchObject({ status: 'compensated', recovery: { plan: 'credit' } });
    await drain(t);
  });
  it('SPK-PAY-002, SPK-PAY-006 (MONEY-08): a term an approved installment or deposit version leaves out is recorded as the engineering default it falls back to', async () => {
    const resolver = t.app.get(FinancePolicyResolver);
    const depositKey = `party-deposit-${Date.now()}`;
    await createPolicyVersionFixture(t, {
      kind: 'installment',
      key: depositKey,
      content: { installments: 2, intervalDays: 14 },
    });
    const deposit = await resolver.bookingDeposit(t.organizationId, depositKey, t.clock.now());
    expect(deposit).toMatchObject({ count: 2, intervalDays: 14 });
    expect(deposit.defaults).toEqual([
      'installment.retryMaxAttempts: engineering default 3 (POL-016, DEC-008)',
      'installment.retryIntervalHours: engineering default 72 (POL-016, DEC-008)',
      'installment.noticeDaysBefore: engineering default 3 (POL-016, DEC-008)',
    ]);
    // An organization installment policy that states only some terms: the quote says which
    // terms are defaults, not that the whole approved version applies.
    await createPolicyVersionFixture(t, {
      kind: 'installment',
      key: 'finance',
      version: 9,
      content: { retryMaxAttempts: 4, maxInstallments: 3 },
    });
    const quote = await installmentQuote();
    const policies = quote['policies'] as {
      installmentPolicyVersionId: string;
      defaults: string[];
    };
    expect(policies.installmentPolicyVersionId).toEqual(expect.any(String));
    expect(policies.defaults).toEqual(
      expect.arrayContaining([
        // The version does not say whether installments are offered: that is a default too.
        'installment.enabled: engineering default true (POL-016, DEC-008)',
        'installment.intervalDays: engineering default 30 (POL-016, DEC-008)',
        'installment.retryIntervalHours: engineering default 72 (POL-016, DEC-008)',
        'installment.noticeDaysBefore: engineering default 3 (POL-016, DEC-008)',
      ]),
    );
    expect(policies.defaults.some((d) => d.startsWith('installment.retryMaxAttempts'))).toBe(false);
    expect(policies.defaults.some((d) => d.startsWith('installment:'))).toBe(false);
    // A version that states `enabled` records no default for it.
    await createPolicyVersionFixture(t, {
      kind: 'installment',
      key: 'finance',
      version: 10,
      content: { enabled: true, retryMaxAttempts: 4, maxInstallments: 3 },
    });
    const stated = await installmentQuote();
    const statedDefaults = (stated['policies'] as { defaults: string[] }).defaults;
    expect(statedDefaults.some((d) => d.startsWith('installment.enabled'))).toBe(false);
    expect(statedDefaults).toContain(
      'installment.intervalDays: engineering default 30 (POL-016, DEC-008)',
    );
  });
});
