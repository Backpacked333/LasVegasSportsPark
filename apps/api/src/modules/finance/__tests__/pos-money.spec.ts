import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { FakePaymentTokens, fakeFeeFor } from '../providers/fake-payment.provider';
import {
  adult,
  balanceOf,
  deliver,
  drain,
  financeTestApp,
  ledgerTotals,
  post,
  processInbox,
  provider,
  staff,
  type Actor,
} from './support';

const DAY = 86_400_000;

/**
 * Point-of-sale money in the subledger and in reconciliation (MONEY-03, MONEY-05; SPK-PAY-010,
 * SPK-PAY-011, §4.11, §5.8 / SPK-AT-028 provider facts). Each test works in a day of its own so a
 * period holds only its own money.
 */
describe('point-of-sale money in reconciliation and the ledger (SPK-PAY-010/011)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let customer: Actor;
  let counter = 0;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    customer = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function openSale(priceMinor: number) {
    counter += 1;
    const product = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Team water bottle',
      kind: 'merchandise',
      priceMinor,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `PM${counter}`,
      name: `Money desk ${counter}`,
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: session.body.id,
      customerPersonId: customer.personId,
    });
    const line = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk.header, {
      productId: product.body.id,
      quantity: 1,
    });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    return { saleId: sale.body.id as string, lineId: line.body.lines[0].id as string };
  }

  function day() {
    t.clock.advance(DAY);
    const from = t.clock.now();
    return { from: from.toISOString(), to: new Date(from.getTime() + DAY / 2).toISOString() };
  }

  it('SPK-PAY-011 (MONEY-03): a processor settlement expects point-of-sale card captures, and the report shows point-of-sale money beside receipts and cash', async () => {
    const period = day();
    const card = await openSale(4_000);
    const paid = await post(t, `/v1/pos-sales/${card.saleId}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 4_000,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.body.status).toBe('paid');
    const cash = await openSale(1_500);
    expect(
      (
        await post(t, `/v1/pos-sales/${cash.saleId}/tenders`, desk.header, {
          kind: 'cash',
          amountMinor: 1_500,
        })
      ).body.status,
    ).toBe('paid');
    const back = await post(t, `/v1/pos-sales/${cash.saleId}/returns`, finance.header, {
      lines: [{ saleLineId: cash.lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Wrong size',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    await drain(t);
    const fee = fakeFeeFor(4_000);
    const settlement = await post(t, '/v1/settlement-reconciliations', finance.header, {
      kind: 'processor_settlement',
      provider: 'fake-payments',
      periodStart: period.from,
      periodEnd: period.to,
      currency: 'USD',
      reportedMinor: 4_000 - fee,
      externalReference: `payout-${newId()}`,
    });
    expect(settlement.status, JSON.stringify(settlement.body)).toBe(201);
    expect(settlement.body).toMatchObject({
      status: 'balanced',
      expectedMinor: 4_000 - fee,
      breakdown: { receiptsMinor: 0, posCardMinor: 4_000, processorFeesMinor: fee },
    });
    const report = await t.http
      .get('/v1/finance/reconciliation-report')
      .query({ from: period.from, to: period.to, currency: 'USD' })
      .set(finance.header);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.processorFeesMinor).toBe(fee);
    expect(report.body.pointOfSale).toEqual({
      cardMinor: 4_000,
      drawerMinor: 1_500,
      processorFeesMinor: fee,
      returnedMinor: 1_500,
    });
  });

  it('SPK-PAY-010 (MONEY-05): a card capture reported after its tender failed is booked once against overpayment liability, and its refund settles that liability', async () => {
    const period = day();
    const sale = await openSale(3_000);
    const pending = await post(t, `/v1/pos-sales/${sale.saleId}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 3_000,
      paymentMethodToken: FakePaymentTokens.processing,
    });
    const attemptId = pending.body.tenders[0].paymentAttemptId as string;
    provider(t).settlePayment(attemptId, 'failed');
    await deliver(t, provider(t).paymentWebhook(attemptId));
    await processInbox(t);
    const before = {
      processor: await balanceOf(t, 'cash_processor'),
      liability: await balanceOf(t, 'overpayment_liability'),
      fees: await balanceOf(t, 'processor_fees'),
      refunds: await balanceOf(t, 'refunds'),
    };
    // The provider then reports the capture (twice: a duplicate delivery changes nothing).
    provider(t).settlePayment(attemptId, 'succeeded');
    for (let i = 0; i < 2; i += 1) {
      await deliver(t, provider(t).paymentWebhook(attemptId, { type: 'payment.succeeded' }));
      await processInbox(t);
    }
    const fee = fakeFeeFor(3_000);
    const journals = await t.db
      .selectFrom('journals')
      .select('purpose')
      .where('organization_id', '=', t.organizationId)
      .where('source_id', '=', attemptId)
      .execute();
    expect(journals.map((j) => j.purpose)).toEqual(['pos_capture_after_failure']);
    expect((await balanceOf(t, 'cash_processor')) - before.processor).toBe(3_000 - fee);
    expect((await balanceOf(t, 'overpayment_liability')) - before.liability).toBe(-3_000);
    expect((await balanceOf(t, 'processor_fees')) - before.fees).toBe(fee);
    const attempt = await t.db
      .selectFrom('payment_attempts')
      .select(['status', 'processor_fee_minor'])
      .where('id', '=', attemptId)
      .executeTakeFirstOrThrow();
    expect(attempt).toEqual({ status: 'failed', processor_fee_minor: fee });
    // The processor settlement of the day expects the late capture's net.
    const settlement = await post(t, '/v1/settlement-reconciliations', finance.header, {
      kind: 'processor_settlement',
      provider: 'fake-payments',
      periodStart: period.from,
      periodEnd: period.to,
      currency: 'USD',
      reportedMinor: 3_000 - fee,
      externalReference: `payout-${newId()}`,
    });
    expect(settlement.body).toMatchObject({ status: 'balanced', expectedMinor: 3_000 - fee });
    // Finance refunds it, as the exception asks: the liability is settled, no refund expense.
    const refund = await post(t, `/v1/payments/${attemptId}/refunds`, finance.header, {
      amountMinor: 3_000,
      reason: 'Charged after the tender failed',
    });
    expect(refund.body.status).toBe('succeeded');
    await drain(t);
    expect((await balanceOf(t, 'overpayment_liability')) - before.liability).toBe(0);
    expect((await balanceOf(t, 'refunds')) - before.refunds).toBe(0);
    expect((await balanceOf(t, 'cash_processor')) - before.processor).toBe(-fee);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });
});
