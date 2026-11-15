import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { FinanceModule } from '../../finance';
import { expectPgError, get, post, reportingTestApp, staff, type Actor } from './support';

type Row = Record<string, string | number | boolean | null>;
type Value = { metric: string; value: number; dimensions: Record<string, string> };

/**
 * SPK-PAY-016 (proposed amendment PA-08, DEC-102 pending; SPK-REPORT-004, SPK-PAY-011): the sales
 * report lists open-amount register lines apart from product lines, one row each with its
 * description and categories, from the read-only views of migration 1310. The categories and
 * ceilings are the finance module's proposed defaults.
 */
describe('sales by product line: open-amount register lines apart (SPK-PAY-016, proposed)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await reportingTestApp({ imports: [FinanceModule] });
    await t.enableCapability('point_of_sale');
    await t.enableCapability('open_amount_lines');
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-016: the report lists each open-amount line of a paid sale separately, under its reason and revenue category, with its return beside it', async () => {
    const product = await post(t, '/v1/pos-products', manager, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Sports drink',
      kind: 'concession',
      priceMinor: 300,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    const register = await post(t, '/v1/pos-registers', manager, {
      facilityId: t.facilityId,
      code: 'OAR1',
      name: 'Report desk',
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk, { registerSessionId: session.body.id });
    await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
      productId: product.body.id,
      quantity: 2,
    });
    const within = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
      description: 'Lost locker key 14',
      amountMinor: 1_500,
      reasonCategory: 'lost_key',
    });
    expect(within.status, JSON.stringify(within.body)).toBe(201);
    const above = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
      description: 'Goal net torn on field 3',
      amountMinor: 12_000,
      reasonCategory: 'field_damage_fee',
    });
    const big = above.body.lines.find((l: Row) => l.unitPriceMinor === 12_000).id as string;
    // Entered and removed before payment: never sold, never reported.
    const mistaken = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
      description: 'Rung up twice',
      amountMinor: 700,
      reasonCategory: 'one_off_service',
    });
    const gone = mistaken.body.lines.find((l: Row) => l.unitPriceMinor === 700).id as string;
    const removed = await post(t, `/v1/pos-sales/${sale.body.id}/lines/${gone}/quantity`, desk, {
      quantity: 0,
      expectedRevision: mistaken.body.revision,
    });
    const approved = await post(t, `/v1/pos-sales/${sale.body.id}/lines/${big}/approval`, manager, {
      reason: 'Damage confirmed on site',
      expectedRevision: removed.body.revision,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const paid = await post(t, `/v1/pos-sales/${sale.body.id}/tenders`, desk, {
      kind: 'cash',
      amountMinor: 600 + 1_500 + 12_000,
    });
    expect(paid.body.status, JSON.stringify(paid.body)).toBe('paid');
    const key = paid.body.lines.find((l: Row) => l.unitPriceMinor === 1_500).id as string;
    const returned = await post(t, `/v1/pos-sales/${sale.body.id}/returns`, finance, {
      lines: [{ saleLineId: key, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Key found',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    // An open sale's line is not sales yet.
    const open = await post(t, '/v1/pos-sales', desk, { registerSessionId: session.body.id });
    await post(t, `/v1/pos-sales/${open.body.id}/lines`, desk, {
      description: 'Not paid yet',
      amountMinor: 900,
      reasonCategory: 'one_off_service',
    });

    const today = t.clock.now().toISOString().slice(0, 10);
    const res = await get(t, '/v1/reports/sales-by-product-line', finance, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.rows as Row[];
    // The product line is unchanged, and no row calls an open amount a product kind.
    expect(rows.filter((r) => r.source === 'point_of_sale')).toEqual([
      expect.objectContaining({
        productLine: 'concession',
        lines: 1,
        salesMinor: 600,
        returnsMinor: 0,
        revenueCategory: null,
        description: null,
        saleNumber: null,
        secondApproval: null,
      }),
    ]);
    expect(rows.some((r) => r.productLine === 'open_amount')).toBe(false);
    expect(rows.filter((r) => r.source === 'point_of_sale_open_amount')).toEqual([
      expect.objectContaining({
        productLine: 'lost_key',
        revenueCategory: 'facility_fees',
        description: 'Lost locker key 14',
        saleNumber: paid.body.saleNumber,
        secondApproval: 'not needed',
        currency: 'USD',
        lines: 1,
        salesMinor: 1_500,
        returnsMinor: 1_500,
      }),
      expect.objectContaining({
        productLine: 'field_damage_fee',
        revenueCategory: 'facility_fees',
        description: 'Goal net torn on field 3',
        secondApproval: 'approved',
        salesMinor: 12_000,
        returnsMinor: 0,
      }),
    ]);
    const values = res.body.values as Value[];
    const metric = (id: string, productLine: string) =>
      values.find((v) => v.metric === id && v.dimensions.productLine === productLine);
    expect(metric('MET-109', 'field_damage_fee')).toMatchObject({
      value: 12_000,
      dimensions: { source: 'point_of_sale_open_amount', revenueCategory: 'facility_fees' },
    });
    expect(metric('MET-109', 'lost_key')).toMatchObject({ value: 1_500 });
    expect(metric('MET-110', 'lost_key')).toMatchObject({
      value: 1_500,
      dimensions: { source: 'point_of_sale_open_amount' },
    });
    expect(metric('MET-109', 'one_off_service')).toBeUndefined();
    expect((res.body.disclosures as string[]).join(' ')).toContain('Open-amount register lines');
    const byDesk = await get(t, '/v1/reports/sales-by-product-line', desk, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: today,
    });
    expect(byDesk.status).toBe(403);
  });

  it('SPK-PAY-016: the open-amount views are read-only and scoped to the organization', async () => {
    const lines = await t.db
      .selectFrom('reporting_pos_open_amount_lines_v')
      .select(['organization_id', 'reason_category', 'approval_required', 'approved'])
      .orderBy('amount_minor')
      .execute();
    expect(lines).toEqual([
      {
        organization_id: t.organizationId,
        reason_category: 'lost_key',
        approval_required: false,
        approved: false,
      },
      {
        organization_id: t.organizationId,
        reason_category: 'field_damage_fee',
        approval_required: true,
        approved: true,
      },
    ]);
    const RESTRICT = '23001';
    await expectPgError(
      sql`update reporting_pos_open_amount_lines_v set description = 'edited'`.execute(t.db),
      RESTRICT,
    );
    await expectPgError(sql`delete from reporting_pos_open_amount_lines_v`.execute(t.db), RESTRICT);
    await expectPgError(
      sql`delete from reporting_pos_open_amount_return_lines_v`.execute(t.db),
      RESTRICT,
    );
  });

  it('SPK-PAY-016: the second approval of an open-amount line reads approved, awaiting approval or not needed; a line that stopped needing one once other lines were removed is not needed (migration 1311)', async () => {
    const register = await post(t, '/v1/pos-registers', manager, {
      facilityId: t.facilityId,
      code: 'OAR2',
      name: 'Ceiling desk',
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    // Two lines of the same person on one sale: each within the 50.00 ceiling of the front desk,
    // together above it, so the second needed an approval when it was entered.
    const twoLines = async (first: string, second: string) => {
      const sale = await post(t, '/v1/pos-sales', desk, { registerSessionId: session.body.id });
      const a = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
        description: first,
        amountMinor: 3_000,
        reasonCategory: 'one_off_service',
      });
      const b = await post(t, `/v1/pos-sales/${sale.body.id}/lines`, desk, {
        description: second,
        amountMinor: 3_000,
        reasonCategory: 'one_off_service',
      });
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      const lineOf = (description: string) =>
        (b.body.lines as Row[]).find(
          (l) => (l.openAmount as unknown as Row | null)?.description === description,
        )!;
      expect((lineOf(second).openAmount as unknown as Row).awaitingApproval).toBe(true);
      return { saleId: sale.body.id as string, revision: b.body.revision as number, a, lineOf };
    };

    // Not needed any more: the first line is removed, the total is within the ceiling again.
    const lifted = await twoLines('Ball pump loan', 'Court sweep');
    const firstId = (lifted.a.body.lines as Row[]).find(
      (l) => (l.openAmount as unknown as Row | null)?.description === 'Ball pump loan',
    )!.id as string;
    const removed = await post(
      t,
      `/v1/pos-sales/${lifted.saleId}/lines/${firstId}/quantity`,
      desk,
      { quantity: 0, expectedRevision: lifted.revision },
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const paid = await post(t, `/v1/pos-sales/${lifted.saleId}/tenders`, desk, {
      kind: 'cash',
      amountMinor: 3_000,
    });
    expect(paid.body.status, JSON.stringify(paid.body)).toBe('paid');

    // Awaiting approval: the database refuses to pay such a sale (finance 0697), so the state is
    // produced as data written before that guard would be, with the triggers off for one update.
    const stuck = await twoLines('Net repair', 'Line paint');
    await t.db.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx);
      await sql`update pos_sales set status = 'paid', paid_at = ${t.clock.now()} where id = ${stuck.saleId}`.execute(
        trx,
      );
    });

    const view = await t.db
      .selectFrom('reporting_pos_open_amount_lines_v')
      .select(['description', 'approval_required', 'approved', 'awaiting_approval'])
      .where('description', 'in', ['Court sweep', 'Net repair', 'Line paint'])
      .orderBy('description')
      .execute();
    expect(view).toEqual([
      {
        description: 'Court sweep',
        approval_required: true,
        approved: false,
        awaiting_approval: false,
      },
      {
        description: 'Line paint',
        approval_required: true,
        approved: false,
        awaiting_approval: true,
      },
      {
        description: 'Net repair',
        approval_required: false,
        approved: false,
        awaiting_approval: false,
      },
    ]);

    const today = t.clock.now().toISOString().slice(0, 10);
    const res = await get(t, '/v1/reports/sales-by-product-line', finance, {
      facilityId: t.facilityId,
      from: '2027-02-01',
      to: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const approvalOf = (description: string) =>
      (res.body.rows as Row[]).find((r) => r.description === description)?.secondApproval;
    expect(approvalOf('Court sweep')).toBe('not needed');
    expect(approvalOf('Line paint')).toBe('awaiting approval');
    expect(approvalOf('Net repair')).toBe('not needed');
    expect(approvalOf('Goal net torn on field 3')).toBe('approved');
    expect((res.body.rows as Row[]).some((r) => r.secondApproval === 'missing')).toBe(false);
  });
});
