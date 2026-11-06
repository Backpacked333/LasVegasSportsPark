import { newId } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { approveTaxFee } from './stage3-doubles';
import { adult, financeTestApp, post, staff, type Actor } from './support';

type Json = Record<string, unknown>;

async function refusedBy(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

/**
 * Park UI redesign POS gaps (§3.16 POS, SPK-PAY-001/002/010, migration 0686): a ticket line's
 * quantity is changed (or the line removed) by a superseding line priced again; the configured tax
 * and fee lines are on the sale; returns, totals and the paid journal use the lines in effect.
 */
describe('point of sale: line quantity and configured charges on the ticket', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let customer: Actor;
  let n = 0;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    customer = await adult(t);
    approveTaxFee('county-sales-tax', {
      code: 'SALES',
      label: 'Sales tax 8.375%',
      kind: 'tax',
      rateBasisPoints: 838,
      rounding: 'half_up',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function product(priceMinor: number, keys: string[] = ['county-sales-tax']) {
    const res = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Sports drink',
      kind: 'concession',
      priceMinor,
      currency: 'USD',
      chargePolicyKeys: keys,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function openSale(): Promise<Json & { id: string; revision: number }> {
    n += 1;
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `QT${n}`,
      name: `Quantity ${n}`,
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: session.body.id,
      customerPersonId: customer.personId,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    return sale.body;
  }

  const change = (sale: Json, lineId: string, quantity: number) =>
    post(t, `/v1/pos-sales/${String(sale.id)}/lines/${lineId}/quantity`, desk.header, {
      quantity,
      expectedRevision: sale.revision,
    });

  it('SPK-PAY-002: the ticket lists the configured tax line with its amount over every line', async () => {
    const drink = await product(300);
    const sale = await openSale();
    const added = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: drink,
      quantity: 2,
    });
    expect(added.status).toBe(201);
    // 600 * 8.38% = 50.28 → 50 (half up)
    expect(added.body.charges).toEqual([
      { code: 'SALES', label: 'Sales tax 8.375%', kind: 'tax', amountMinor: 50 },
    ]);
    expect(added.body).toMatchObject({ subtotalMinor: 600, chargesMinor: 50, totalMinor: 650 });
  });

  it('§3.16 POS, SPK-PAY-010: changing a quantity supersedes the line, prices it again and keeps the old one as history', async () => {
    const drink = await product(300);
    const sale = await openSale();
    const added = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: drink,
      quantity: 2,
    });
    const lineId = added.body.lines[0].id as string;
    const changed = await change(added.body, lineId, 3);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.lines).toHaveLength(1);
    expect(changed.body.lines[0]).toMatchObject({ quantity: 3, baseMinor: 900, chargesMinor: 75 });
    expect(changed.body.lines[0].id).not.toBe(lineId);
    expect(changed.body).toMatchObject({ subtotalMinor: 900, chargesMinor: 75, totalMinor: 975 });
    const rows = await t.db
      .selectFrom('pos_sale_lines')
      .select(['id', 'quantity', 'supersedes_line_id'])
      .where('sale_id', '=', sale.id)
      .orderBy('line_number')
      .execute();
    expect(rows).toEqual([
      { id: lineId, quantity: 2, supersedes_line_id: null },
      { id: changed.body.lines[0].id, quantity: 3, supersedes_line_id: lineId },
    ]);
    // The superseded line cannot be changed again; a stale revision is refused.
    const stale = await change(added.body, changed.body.lines[0].id, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const twice = await change(changed.body, lineId, 1);
    expect(twice.status).toBe(409);
    expect(twice.body.details.code).toBe('LINE_ALREADY_CHANGED');
    // Removing the line (quantity 0) empties the ticket.
    const removed = await change(changed.body, changed.body.lines[0].id, 0);
    expect(removed.status).toBe(200);
    expect(removed.body.lines).toEqual([]);
    expect(removed.body).toMatchObject({ subtotalMinor: 0, chargesMinor: 0, totalMinor: 0 });
    // Only the register's operators change lines; a customer learns nothing.
    const byCustomer = await post(
      t,
      `/v1/pos-sales/${sale.id}/lines/${lineId}/quantity`,
      customer.header,
      { quantity: 1, expectedRevision: removed.body.revision },
    );
    expect([403, 404]).toContain(byCustomer.status);
  });

  it('§3.16 POS: a change that would bring the total below the tenders taken is refused; returns name only lines in effect', async () => {
    const drink = await product(1_000, []);
    const sale = await openSale();
    const one = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: drink,
      quantity: 2,
    });
    const first = one.body.lines[0].id as string;
    const tender = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_500,
      expectedRevision: one.body.revision,
    });
    expect(tender.status, JSON.stringify(tender.body)).toBe(201);
    const below = await change(tender.body, first, 1);
    expect(below.status).toBe(409);
    expect(below.body.details.code).toBe('BELOW_TENDERED');
    const up = await change(tender.body, first, 3);
    expect(up.status).toBe(200);
    const pay = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_500,
      expectedRevision: up.body.revision,
    });
    expect(pay.body.status).toBe('paid');
    // The paid journal credits the line in effect (3 units), not the superseded one.
    const revenue = await t.db
      .selectFrom('journal_entries')
      .innerJoin('journals', 'journals.id', 'journal_entries.journal_id')
      .select((eb) => eb.fn.sum<number>('journal_entries.credit_minor').as('credit'))
      .where('journals.source_id', '=', sale.id)
      .where('journals.purpose', '=', 'pos_sale_paid')
      .executeTakeFirst();
    expect(Number(revenue?.credit)).toBe(3_000);
    const superseded = await post(t, `/v1/pos-sales/${sale.id}/returns`, finance.header, {
      lines: [{ saleLineId: first, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Wrong item',
      expectedRevision: pay.body.revision,
    });
    expect(superseded.status).toBe(400);
    expect(superseded.body.details.code).toBe('LINE_NOT_ON_SALE');
  });

  it('§4.7 invariant: the database supersedes a line once, within its sale and product, and refuses a return of a superseded line', async () => {
    const drink = await product(500, []);
    const water = await product(200, []);
    const sale = await openSale();
    const added = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: drink,
      quantity: 1,
    });
    const lineId = added.body.lines[0].id as string;
    const lineRow = (over: Json) => ({
      id: newId(),
      organization_id: t.organizationId,
      sale_id: sale.id,
      currency: 'USD',
      line_number: 50,
      product_id: drink,
      sku: 'X',
      name: 'X',
      kind: 'concession' as const,
      unit_price_minor: 500,
      quantity: 2,
      base_minor: 1_000,
      charges: json([]),
      charges_minor: 0,
      line_total_minor: 1_000,
      supersedes_line_id: lineId,
      ...over,
    });
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_sale_lines')
          .values(lineRow({ product_id: water }))
          .execute(),
      ),
    ).toBe('23514:pos_sale_lines_same_product');
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_sale_lines')
          .values(
            lineRow({ supersedes_line_id: null, quantity: 0, base_minor: 0, line_total_minor: 0 }),
          )
          .execute(),
      ),
    ).toBe('23514:pos_sale_lines_quantity');
    await t.db.insertInto('pos_sale_lines').values(lineRow({})).execute();
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_sale_lines')
          .values(lineRow({ line_number: 2000 }))
          .execute(),
      ),
    ).toBe('23505:pos_sale_lines_superseded_once');
    const view = await t.http.get(`/v1/pos-sales/${sale.id}`).set(desk.header);
    expect(view.body).toMatchObject({ subtotalMinor: 1_000, totalMinor: 1_000 });
    const paid = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_000,
      expectedRevision: view.body.revision,
    });
    expect(paid.body.status).toBe('paid');
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_returns')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            sale_id: sale.id,
            currency: 'USD',
            amount_minor: 500,
            tender_kind: 'cash',
            lines: json([
              { saleLineId: lineId, quantity: 1, amountMinor: 500, baseMinor: 500, charges: [] },
            ]),
            refund_attempt_id: null,
            register_session_id: null,
            reason: 'direct',
            approved_by: json({ kind: 'system' }),
            approved_by_person_id: finance.personId,
            evidence: null,
          } as never)
          .execute(),
      ),
    ).toBe('23514:pos_returns_live_lines');
  });
});
