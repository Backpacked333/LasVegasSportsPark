import { errors } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { ENROLLMENT_PORT, EnrollmentsService, type EnrollmentPort } from '../../enrollment';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { CheckoutFinalizer } from '../services/checkout-finalizer.service';
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

/** Makes the enrollment port fail the next N confirmations (a stopped worker or a domain refusal). */
const flaky = { failures: 0, kind: 'crash' as 'crash' | 'domain' };

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
});
