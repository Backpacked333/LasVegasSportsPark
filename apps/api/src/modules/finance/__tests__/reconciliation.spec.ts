import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createDiscountFixture,
  createOfferingFixture,
  createPolicyVersionFixture,
  createProgramFixture,
} from '../../catalog';
import { FakePaymentTokens, fakeFeeFor } from '../providers/fake-payment.provider';
import { createObligationFixture } from '../testing/finance-fixtures';
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

describe('reconciliation, discounts and finance policy (SPK-PAY-003/010/011, POL-007)', () => {
  let t: TestApp;
  let parent: Actor;
  let finance: Actor;
  const from = '2026-11-01T00:00:00Z';
  const to = '2026-11-03T00:00:00Z';

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-011: the report keeps orders, obligations, receipts, refunds, credits, fees, disputes, settlements and cash apart', async () => {
    const setup = await offering(t, { basePriceMinor: 20_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    const paid = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(paid.body.status).toBe('completed');
    const paymentId = paid.body.payment.id as string;
    const refund = await post(t, `/v1/payments/${paymentId}/refunds`, finance.header, {
      amountMinor: 5_000,
      reason: 'Partial refund',
    });
    expect(refund.body.status).toBe('succeeded');
    const desk = await staff(t, ['front_desk']);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 3_000,
    });
    await post(t, '/v1/cash-tenders', desk.header, {
      obligationId,
      facilityId: t.facilityId,
      tenderKind: 'cash',
      amountMinor: 3_000,
      currency: 'USD',
      evidence: { reference: 'DRAWER-7' },
    });
    await post(t, '/v1/credits', finance.header, {
      ownerPersonId: parent.personId,
      amountMinor: 1_000,
      currency: 'USD',
      permittedUses: ['registration'],
      sourceKind: 'goodwill',
      reason: 'Rain-out',
    });
    expect(
      (await t.http.get(`/v1/finance/reconciliation-report?from=${from}&to=${to}`).set(desk.header))
        .status,
    ).toBe(403);
    const report = await t.http
      .get(`/v1/finance/reconciliation-report?from=${from}&to=${to}`)
      .set(finance.header);
    expect(report.status).toBe(200);
    const fee = fakeFeeFor(20_000);
    expect(report.body).toMatchObject({
      orders: { count: 1, totalMinor: 20_000, paidCount: 1 },
      receipts: { processorMinor: 20_000, cashMinor: 3_000, count: 2, excessMinor: 0 },
      refunds: { succeededMinor: 5_000, reservedMinor: 0, unknownCount: 0 },
      credits: { issuedMinor: 1_000, pendingApprovalMinor: 0 },
      processorFeesMinor: fee,
      disputes: { count: 0 },
      cash: { recordedMinor: 3_000, unreconciledMinor: 3_000 },
      exceptions: { unknownPayments: 0, recoveryRequiredCheckouts: 0 },
    });
    // Payment volume is not revenue: the receipts sit in cash accounts, revenue stays deferred.
    const ledger = report.body.ledger as Array<{
      accountCode: string;
      balanceMinor: number;
      debitMinor: number;
      creditMinor: number;
    }>;
    const balance = (code: string) => ledger.find((l) => l.accountCode === code)?.balanceMinor ?? 0;
    expect(balance('deferred_revenue')).toBe(-23_000);
    expect(balance('cash_processor')).toBe(20_000 - fee - 5_000);
    expect(balance('cash_on_hand')).toBe(3_000);
    expect(balance('customer_receivable')).toBe(0);
    expect(balance('refunds')).toBe(6_000);
    expect(balance('credits_payable')).toBe(-1_000);
    expect(ledger.reduce((acc, l) => acc + l.debitMinor - l.creditMinor, 0)).toBe(0);
    const balances = await t.http
      .get('/v1/finance/ledger-balances?currency=USD')
      .set(finance.header);
    expect(balances.body).toEqual(ledger);

    // A processor settlement that matches the ledger is balanced; the same settlement twice is refused.
    const settlement = {
      kind: 'processor_settlement',
      provider: 'fake-payments',
      periodStart: from,
      periodEnd: to,
      currency: 'USD',
      reportedMinor: 20_000 - fee - 5_000,
      externalReference: 'payout-001',
    };
    const balanced = await post(t, '/v1/settlement-reconciliations', finance.header, settlement);
    expect(balanced.status).toBe(201);
    expect(balanced.body).toMatchObject({
      status: 'balanced',
      differenceMinor: 0,
      breakdown: { receiptsMinor: 20_000, processorFeesMinor: fee, refundsMinor: 5_000 },
    });
    const duplicate = await post(t, '/v1/settlement-reconciliations', finance.header, settlement);
    expect(duplicate.status).toBe(409);
    await drain(t);
  });

  it('SPK-PAY-003 / invariant 7: a quoted discount is explained and redeemed once at checkout; an exhausted one stops the checkout', async () => {
    await createDiscountFixture(t, {
      code: 'EARLY10',
      amountKind: 'percentage',
      amountValue: 1_000,
      redemptionLimit: 1,
      status: 'active',
      effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    });
    const setup = await offering(t, { basePriceMinor: 10_000 });
    const first = await basketFor(t, parent, [setup]);
    const second = await basketFor(t, parent, [setup]);
    const quoteA = await quoteFor(t, parent, first.basketId, { discountCodes: ['EARLY10'] });
    const quoteB = await quoteFor(t, parent, second.basketId, { discountCodes: ['EARLY10'] });
    expect(quoteA).toMatchObject({ discountMinor: 1_000, totalMinor: 9_000 });
    const discounts = quoteA['discounts'] as Array<{ code: string; explanation: string[] }>;
    expect(discounts[0]?.code).toBe('EARLY10');
    expect(discounts[0]?.explanation.length).toBeGreaterThan(0);
    const unknown = await post(t, '/v1/registration-quotes', parent.header, {
      basketId: first.basketId,
      discountCodes: ['NOPE99'],
    });
    expect(unknown.status).toBe(400);
    const a = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quoteA.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(a.body).toMatchObject({ status: 'completed', payment: { amountMinor: 9_000 } });
    const b = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quoteB.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(b.status).toBe(409);
    expect(b.body.details.code).toBe('DISCOUNT_REDEMPTION_LIMIT');
    // Nothing was created or charged for the refused checkout; the basket keeps its hold.
    expect(
      await t.db.selectFrom('orders').select('id').where('quote_id', '=', quoteB.id).execute(),
    ).toHaveLength(0);
    const basket = await t.http.get(`/v1/baskets/${second.basketId}`).set(parent.header);
    expect(basket.body.status).toBe('held');
    await drain(t);
  });

  it("POL-007 / DEC-009: finance answers enrollment's cancellation consequence from the approved policy", async () => {
    const cancellationPolicyVersionId = await createPolicyVersionFixture(t, {
      kind: 'cancellation',
      content: { refundBasisPoints: 5_000 },
    });
    const manager = await staff(t, ['program_manager']);
    const setup = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
      programId: await createProgramFixture(t, { ageBand: { minAgeYears: 6, maxAgeYears: 12 } }),
      basePriceMinor: 8_000,
      cancellationPolicyVersionId,
    });
    const { basketId } = await basketFor(t, parent, [setup]);
    const quote = await quoteFor(t, parent, basketId);
    const paid = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    const enrollmentId = (paid.body.enrollmentIds as string[])[0] as string;
    const preview = await t.http
      .get(`/v1/enrollments/${enrollmentId}/cancellation-preview`)
      .set(parent.header);
    expect(preview.status).toBe(200);
    expect(preview.body.financialConsequence).toMatchObject({
      kind: 'refund',
      amountMinor: 4_000,
      currency: 'USD',
      policyVersionId: cancellationPolicyVersionId,
    });
  });
});
