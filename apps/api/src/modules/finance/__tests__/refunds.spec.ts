import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createCapturedPaymentFixture } from '../testing/finance-fixtures';
import {
  adult,
  balanceOf,
  deliver,
  financeTestApp,
  ledgerTotals,
  post,
  processInbox,
  provider,
  staff,
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
});
