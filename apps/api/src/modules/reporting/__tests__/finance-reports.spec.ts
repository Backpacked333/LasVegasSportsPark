import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOutboxChecked, type TestApp } from '../../../testing';
import {
  createCreditFixture,
  FakePaymentProvider,
  FakePaymentTokens,
  FinanceModule,
} from '../../finance';
import { createPersonFixture } from '../../identity';
import { DAY, get, HOUR, post, reportingTestApp, staff, valueOf, type Actor } from './support';

type Row = Record<string, string | number | boolean | null>;
type Value = {
  metric: string;
  label: string;
  value: number | null;
  currency: string | null;
  dimensions: Record<string, string>;
};

/**
 * The financial reports' figures against their definitions (SPK-REPORT-002 R09 and R10,
 * SPK-PAY-009, SPK-PAY-011, §5.5): expired credits are no outstanding liability (MET-043),
 * settlement discrepancies are never netted (MET-049), and point-of-sale money, which creates no
 * receipt, is reported beside customer receipts (MET-050). Each test works in its own period.
 */
describe('financial reports (SPK-REPORT-002, SPK-PAY-009, SPK-PAY-011)', () => {
  let t: TestApp;
  let gm: Actor;
  let manager: Actor;
  let desk: Actor;
  let financeOperator: Actor;

  beforeAll(async () => {
    t = await reportingTestApp({ imports: [FinanceModule] });
    await t.enableCapability('point_of_sale');
    gm = await staff(t, ['general_manager']);
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    financeOperator = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-002 / SPK-PAY-009 (R3-REPORTING-03): an active credit past its expiry is not outstanding; it is reported separately as expired', async () => {
    const owner = await createPersonFixture(t, { kind: 'adult' });
    // Finance never writes an `expired` status: the lapsed credit stays `active` with its balance.
    await createCreditFixture(t, {
      ownerPersonId: owner,
      amountMinor: 2_000,
      expiresAt: new Date(t.clock.now().getTime() - DAY),
    });
    await createCreditFixture(t, {
      ownerPersonId: owner,
      amountMinor: 500,
      expiresAt: new Date(t.clock.now().getTime() + 30 * DAY),
    });
    await createCreditFixture(t, { ownerPersonId: owner, amountMinor: 300, expiresAt: null });
    const res = await get(t, '/v1/reports/outstanding-obligations', gm);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-043', 'Credits outstanding', 'USD')).toBe(800);
    expect(valueOf(res.body, 'MET-043', 'Credits outstanding (count)', 'USD')).toBe(2);
    expect(valueOf(res.body, 'MET-043', 'Expired credits (unredeemed balance)', 'USD')).toBe(2_000);
    expect(valueOf(res.body, 'MET-043', 'Expired credits (count)')).toBe(1);
    const definition = (
      res.body.metrics as Array<{ metricKey: string; exclusions: string[] }>
    ).find((m) => m.metricKey === 'MET-043')!;
    expect(definition.exclusions.join(' ')).toMatch(/expired credits/);
  });

  it('§5.5 / SPK-PAY-011 (R3-REPORTING-02): a shortage at one drawer and an overage at another are listed per reconciliation and never netted', async () => {
    const periodStart = new Date('2027-03-01T08:00:00.000Z');
    const periodEnd = new Date('2027-03-02T08:00:00.000Z');
    const otherFacility = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: otherFacility,
        organization_id: t.organizationId,
        slug: 'north',
        name: 'North complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    // Written as finance's reconciliation command leaves them (test helper only).
    const reconcile = async (
      facilityId: string | null,
      kind: 'cash_drawer' | 'processor_settlement',
      expected: number,
      reported: number,
      performedAt: Date,
    ) => {
      const id = newId();
      await t.db
        .insertInto('settlement_reconciliations')
        .values({
          id,
          organization_id: t.organizationId,
          kind,
          provider: kind === 'processor_settlement' ? 'fake-payments' : null,
          facility_id: facilityId,
          period_start: periodStart,
          period_end: periodEnd,
          currency: 'USD',
          expected_minor: expected,
          reported_minor: reported,
          difference_minor: reported - expected,
          breakdown: json({}),
          status: reported === expected ? 'balanced' : 'discrepancy',
          external_reference: null,
          notes: null,
          performed_by: json({ kind: 'system', actorLabel: 'reporting-tests' }),
          performed_by_person_id: null,
          performed_at: performedAt,
        })
        .execute();
      return id;
    };
    const performed = new Date('2027-03-02T10:00:00.000Z');
    const short = await reconcile(t.facilityId, 'cash_drawer', 10_000, 9_500, performed);
    const over = await reconcile(otherFacility, 'cash_drawer', 8_000, 8_500, performed);
    const monday = await reconcile(null, 'processor_settlement', 20_000, 20_300, performed);
    const friday = await reconcile(
      null,
      'processor_settlement',
      15_000,
      14_700,
      new Date(performed.getTime() + HOUR),
    );

    const res = await get(t, '/v1/reports/payment-reconciliation', gm, {
      periodStart: '2027-03-02T00:00:00.000Z',
      periodEnd: '2027-03-03T00:00:00.000Z',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const settlementRows = (res.body.rows as Row[]).filter((r) => r.section === 'settlements');
    // One row per reconciliation, each with its own signed difference.
    expect(
      settlementRows
        .map((r) => [r.recordId, r.detail, r.amountMinor, r.expectedMinor, r.reportedMinor])
        .sort(),
    ).toEqual(
      [
        [short, `cash_drawer:${t.facilityId}`, -500, 10_000, 9_500],
        [over, `cash_drawer:${otherFacility}`, 500, 8_000, 8_500],
        [monday, 'processor_settlement:fake-payments', 300, 20_000, 20_300],
        [friday, 'processor_settlement:fake-payments', -300, 15_000, 14_700],
      ].sort(),
    );
    expect(settlementRows.every((r) => r.count === 1)).toBe(true);

    const values = res.body.values as Value[];
    const of = (label: string, scope: string) =>
      values.find(
        (v) => v.metric === 'MET-049' && v.label === label && v.dimensions.scope === scope,
      )?.value;
    // No signed sum over reconciliations: the offsetting differences never read as balanced.
    expect(values.some((v) => v.label === 'Settlement variance')).toBe(false);
    expect(of('Settlement shortages', `cash_drawer:${t.facilityId}`)).toBe(500);
    expect(of('Settlement overages', `cash_drawer:${t.facilityId}`)).toBe(0);
    expect(of('Settlement overages', `cash_drawer:${otherFacility}`)).toBe(500);
    expect(of('Settlement absolute discrepancy', `cash_drawer:${otherFacility}`)).toBe(500);
    expect(of('Settlement shortages', 'processor_settlement:fake-payments')).toBe(300);
    expect(of('Settlement overages', 'processor_settlement:fake-payments')).toBe(300);
    expect(of('Settlement absolute discrepancy', 'processor_settlement:fake-payments')).toBe(600);
    expect(of('Reconciliations with a discrepancy', 'processor_settlement:fake-payments')).toBe(2);
    const disclosures = (res.body.disclosures as string[]).join(' ');
    expect(disclosures).toContain('one row per reconciliation');
    expect(disclosures).toContain('a shortage never cancels an overage');
  });

  it('SPK-PAY-011 / SPK-PAY-007 / MET-050 (R3-REPORTING-04): point-of-sale card captures, drawer tenders and returns are reported beside customer receipts, never added to them; a card return is paid only when its refund succeeds', async () => {
    t.clock.set(new Date('2027-04-01T16:00:00.000Z'));
    const periodStart = t.clock.now().toISOString();
    const customer = await createPersonFixture(t, { kind: 'adult' });
    const product = await post(t, '/v1/pos-products', manager, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Team water bottle',
      kind: 'merchandise',
      priceMinor: 3_000,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const register = await post(t, '/v1/pos-registers', manager, {
      facilityId: t.facilityId,
      code: 'RPT1',
      name: 'Reporting desk',
    });
    expect(register.status, JSON.stringify(register.body)).toBe(201);
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const sale = async () => {
      const opened = await post(t, '/v1/pos-sales', desk, {
        registerSessionId: session.body.id,
        customerPersonId: customer,
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const line = await post(t, `/v1/pos-sales/${opened.body.id}/lines`, desk, {
        productId: product.body.id,
        quantity: 1,
      });
      expect(line.status, JSON.stringify(line.body)).toBe(201);
      return { saleId: opened.body.id as string, lineId: line.body.lines[0].id as string };
    };
    const card = await sale();
    const paidByCard = await post(t, `/v1/pos-sales/${card.saleId}/tenders`, desk, {
      kind: 'card',
      amountMinor: 3_000,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paidByCard.body.status, JSON.stringify(paidByCard.body)).toBe('paid');
    const cash = await sale();
    const paidInCash = await post(t, `/v1/pos-sales/${cash.saleId}/tenders`, desk, {
      kind: 'cash',
      amountMinor: 3_000,
    });
    expect(paidInCash.body.status, JSON.stringify(paidInCash.body)).toBe('paid');
    const cardReturn = await post(t, `/v1/pos-sales/${card.saleId}/returns`, financeOperator, {
      lines: [{ saleLineId: card.lineId, quantity: 1 }],
      tenderKind: 'card',
      reason: 'Wrong size',
    });
    expect(cardReturn.status, JSON.stringify(cardReturn.body)).toBe(201);
    const cashReturn = await post(t, `/v1/pos-sales/${cash.saleId}/returns`, financeOperator, {
      lines: [{ saleLineId: cash.lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Damaged',
    });
    expect(cashReturn.status, JSON.stringify(cashReturn.body)).toBe(201);
    // Two more card returns whose refunds do not succeed: one is lost track of (unknown), one is
    // declined (failed). Each return row is recorded when its refund is reserved.
    const cardSale = async (refundOutcome: 'timeout' | 'fail') => {
      const s = await sale();
      const paid = await post(t, `/v1/pos-sales/${s.saleId}/tenders`, desk, {
        kind: 'card',
        amountMinor: 3_000,
        paymentMethodToken: FakePaymentTokens.succeed,
      });
      expect(paid.body.status, JSON.stringify(paid.body)).toBe('paid');
      t.app.get(FakePaymentProvider).scriptRefunds(refundOutcome);
      const returned = await post(t, `/v1/pos-sales/${s.saleId}/returns`, financeOperator, {
        lines: [{ saleLineId: s.lineId, quantity: 1 }],
        tenderKind: 'card',
        reason: 'Changed mind',
      });
      expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    };
    await cardSale('timeout');
    await cardSale('fail');
    await drainOutboxChecked(t, { rounds: 25, batchSize: 200 });
    t.clock.advance(HOUR);

    const res = await get(t, '/v1/reports/payment-reconciliation', gm, {
      periodStart,
      periodEnd: t.clock.now().toISOString(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The card tenders are payment attempts and the card returns refund attempts (MET-045/047)...
    expect(valueOf(res.body, 'MET-045', 'Succeeded payment attempts', 'USD')).toBe(9_000);
    expect(
      valueOf(
        res.body,
        'MET-045',
        'Succeeded point-of-sale payment attempts (included above)',
        'USD',
      ),
    ).toBe(9_000);
    expect(valueOf(res.body, 'MET-047', 'Refund attempts submitted', 'USD')).toBe(9_000);
    expect(
      valueOf(
        res.body,
        'MET-047',
        'Refund attempts on point-of-sale payments (included above)',
        'USD',
      ),
    ).toBe(9_000);
    // ...and the money is reported beside receipts: none of it is a receipt.
    const values = res.body.values as Value[];
    expect(values.some((v) => v.metric === 'MET-050' && v.label === 'Customer receipts')).toBe(
      false,
    );
    expect(valueOf(res.body, 'MET-050', 'Point-of-sale card captures', 'USD')).toBe(9_000);
    expect(
      valueOf(res.body, 'MET-050', 'Point-of-sale drawer tenders (cash and external)', 'USD'),
    ).toBe(3_000);
    // Returns are what was recorded, never labelled paid: the cash return was paid from the drawer;
    // the card returns are shown by the state of their refund attempts, and the refund whose
    // outcome is unknown stays unknown (SPK-PAY-007).
    expect(values.some((v) => v.metric === 'MET-050' && /returns paid$/.test(v.label))).toBe(false);
    expect(valueOf(res.body, 'MET-050', 'Point-of-sale returns recorded', 'USD')).toBe(12_000);
    expect(
      valueOf(
        res.body,
        'MET-050',
        'Point-of-sale cash and external returns, paid at the return (included above)',
        'USD',
      ),
    ).toBe(3_000);
    const byRefundState = Object.fromEntries(
      values
        .filter(
          (v) =>
            v.metric === 'MET-050' &&
            v.label === 'Point-of-sale card returns by refund state (included above)',
        )
        .map((v) => [v.dimensions.refundState, v.value]),
    );
    expect(byRefundState).toEqual({ succeeded: 3_000, unknown: 3_000, failed: 3_000 });
    expect(
      [
        ...new Set(values.filter((v) => v.metric === 'MET-050').map((v) => v.dimensions.series)),
      ].sort(),
    ).toEqual(['pos_card', 'pos_drawer', 'pos_returns']);
    const disclosures = (res.body.disclosures as string[]).join(' ');
    expect(disclosures).toContain('Point-of-sale money creates no receipt');
    expect(disclosures).toContain('an unknown refund stays unknown');
    const definition = (res.body.metrics as Array<{ metricKey: string; numerator: string }>).find(
      (m) => m.metricKey === 'MET-050',
    )!;
    expect(definition.numerator).toContain('returns recorded');
    expect(definition.numerator).not.toContain('returns paid by return instant');
  });
});
