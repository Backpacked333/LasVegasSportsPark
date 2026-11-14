import { newId } from '@sportspark/contracts';
import { json, pgErrorCode, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPolicyVersionFixture } from '../../catalog';
import { createPersonFixture } from '../../identity';
import { OPEN_AMOUNT_POLICY } from '../finance.policy';
import { approveTaxFee } from './stage3-doubles';
import { adult, financeTestApp, post, staff, type Actor } from './support';

type Json = Record<string, unknown>;
type SaleBody = Json & {
  id: string;
  revision: number;
  lines: Array<Json & { id: string; openAmount: Json | null }>;
};

async function refusedBy(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

/** The journal of a source as [account, debit, credit, memo] rows with an amount. */
async function journalOf(t: TestApp, sourceId: string, purpose: string) {
  const rows = await t.db
    .selectFrom('journal_entries')
    .innerJoin('journals', 'journals.id', 'journal_entries.journal_id')
    .select([
      'journal_entries.account_code as account',
      'journal_entries.debit_minor as debit',
      'journal_entries.credit_minor as credit',
      'journal_entries.memo as memo',
    ])
    .where('journals.source_id', '=', sourceId)
    .where('journals.purpose', '=', purpose)
    .orderBy('journal_entries.line_number')
    .execute();
  return rows
    .map((e) => [e.account, Number(e.debit), Number(e.credit), e.memo] as const)
    .filter((e) => e[1] !== 0 || e[2] !== 0);
}

/**
 * SPK-PAY-016 (proposed amendment PA-08; capability `open_amount_lines`, DEC-102 pending): an
 * open-amount register line. The categories and ceilings used here are the proposed defaults of
 * the finance configuration (front desk 50.00, finance operator 250.00) unless a test approves a
 * policy version of its own.
 */
describe('point of sale: open-amount lines (SPK-PAY-016, proposed)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let otherDesk: Actor;
  let finance: Actor;
  let customer: Actor;
  let n = 0;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale', 'open_amount_lines'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    otherDesk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    customer = await adult(t);
  });
  afterAll(async () => {
    await t.close();
  });

  async function openSale(): Promise<SaleBody & { registerSessionId: string }> {
    n += 1;
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `OA${n}`,
      name: `Open amount ${n}`,
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

  const openLine = (sale: Json, who: Actor, body: Json = {}) =>
    post(t, `/v1/pos-sales/${String(sale.id)}/lines`, who.header, {
      description: 'Goal net torn on field 3',
      amountMinor: 4_250,
      reasonCategory: 'field_damage_fee',
      ...body,
    });

  const approve = (sale: Json, lineId: string, who: Actor, reason = 'Checked with the renter') =>
    post(t, `/v1/pos-sales/${String(sale.id)}/lines/${lineId}/approval`, who.header, {
      reason,
      expectedRevision: sale.revision,
    });

  const cash = (sale: Json, amountMinor: number) =>
    post(t, `/v1/pos-sales/${String(sale.id)}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor,
      expectedRevision: sale.revision,
    });

  it('SPK-PAY-016: a permitted staff member adds a line with a description, an amount and a reason category; below the ceiling the sale is paid and revenue is booked to the line’s revenue category', async () => {
    const sale = await openSale();
    const added = await openLine(sale, desk);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ subtotalMinor: 4_250, chargesMinor: 0, totalMinor: 4_250 });
    expect(added.body.lines).toHaveLength(1);
    expect(added.body.lines[0]).toMatchObject({
      kind: 'open_amount',
      productId: null,
      sku: null,
      name: 'Field damage fee',
      unitPriceMinor: 4_250,
      quantity: 1,
      baseMinor: 4_250,
      lineTotalMinor: 4_250,
      openAmount: {
        description: 'Goal net torn on field 3',
        reasonCategory: 'field_damage_fee',
        revenueCategory: 'facility_fees',
        enteredByPersonId: desk.personId,
        ceilingMinor: 5_000,
        approvalRequired: false,
        approval: null,
        // No approved policy version: the proposed default applied, and the line says so.
        policyVersionId: null,
      },
    });
    const paid = await cash(added.body, 4_250);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('paid');
    expect(await journalOf(t, sale.id, 'pos_sale_paid')).toEqual([
      ['cash_on_hand', 4_250, 0, 'cash and external tenders'],
      ['pos_revenue', 0, 4_250, 'open amount, revenue category facility_fees'],
    ]);
    // The receipt shows the line with its description and category; nothing about staff.
    const receipt = await t.http.get(`/v1/pos-sales/${sale.id}/receipt`).set(customer.header);
    expect(receipt.status).toBe(200);
    expect(receipt.body.lines).toEqual([
      {
        name: 'Field damage fee',
        kind: 'open_amount',
        description: 'Goal net torn on field 3',
        quantity: 1,
        unitPriceMinor: 4_250,
        baseMinor: 4_250,
        charges: [],
        lineTotalMinor: 4_250,
      },
    ]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('target_id', '=', sale.id)
      .where('action', '=', 'finance.enter_open_amount_line')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      amountMinor: 4_250,
      reasonCategory: 'field_damage_fee',
      ceilingMinor: 5_000,
      approvalRequired: false,
      policyBasis: 'proposed_default',
    });
  });

  it('SPK-PAY-016: a product line and an open-amount line share a sale, and revenue is booked per product kind and per revenue category', async () => {
    const product = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Sports drink',
      kind: 'concession',
      priceMinor: 300,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    const sale = await openSale();
    const first = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: product.body.id,
      quantity: 2,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // A product line is exactly what it was: no open-amount facts.
    expect(first.body.lines[0]).toMatchObject({
      kind: 'concession',
      productId: product.body.id,
      openAmount: null,
    });
    const second = await openLine(first.body, desk, {
      description: 'Lost locker key 14',
      amountMinor: 1_500,
      reasonCategory: 'lost_key',
    });
    const third = await openLine(second.body, desk, {
      description: 'Line marking for a private event',
      amountMinor: 2_000,
      reasonCategory: 'one_off_service',
    });
    expect(third.body.totalMinor).toBe(600 + 1_500 + 2_000);
    const paid = await cash(third.body, 4_100);
    expect(paid.body.status).toBe('paid');
    expect(await journalOf(t, sale.id, 'pos_sale_paid')).toEqual([
      ['cash_on_hand', 4_100, 0, 'cash and external tenders'],
      ['pos_revenue', 0, 600, 'product kind concession'],
      ['pos_revenue', 0, 1_500, 'open amount, revenue category facility_fees'],
      ['pos_revenue', 0, 2_000, 'open amount, revenue category services'],
    ]);
  });

  it('SPK-PAY-016: above the ceiling the sale takes no tender until a second person approves; the approval is recorded with who, when and why', async () => {
    const sale = await openSale();
    const added = await openLine(sale, desk, { amountMinor: 12_000 });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const lineId = added.body.lines[0].id as string;
    expect(added.body.lines[0].openAmount).toMatchObject({
      ceilingMinor: 5_000,
      approvalRequired: true,
      approval: null,
    });
    // Without the approval: refused with a clear error naming the line.
    const early = await cash(added.body, 12_000);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('RESOURCE_CONFLICT');
    expect(early.body.details).toMatchObject({
      code: 'OPEN_AMOUNT_APPROVAL_REQUIRED',
      lines: [
        {
          saleLineId: lineId,
          amountMinor: 12_000,
          ceilingMinor: 5_000,
          enteredByPersonId: desk.personId,
        },
      ],
    });
    // Desk staff do not approve; a stale view of the sale is refused; a reason is required.
    const byDesk = await approve(added.body, lineId, otherDesk);
    expect(byDesk.status).toBe(403);
    expect(byDesk.body.details).toMatchObject({ action: 'finance.approve_open_amount_line' });
    const stale = await approve({ ...added.body, revision: 1 }, lineId, manager);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const noReason = await post(
      t,
      `/v1/pos-sales/${sale.id}/lines/${lineId}/approval`,
      manager.header,
      { expectedRevision: added.body.revision },
    );
    expect(noReason.status).toBe(400);
    const approved = await approve(added.body, lineId, manager, 'Damage confirmed on site');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.revision).toBe(added.body.revision + 1);
    expect(approved.body.lines[0].openAmount.approval).toMatchObject({
      approvedByPersonId: manager.personId,
      approvedAt: t.clock.now().toISOString(),
      reason: 'Damage confirmed on site',
    });
    const record = await t.db
      .selectFrom('pos_line_approvals')
      .selectAll()
      .where('sale_line_id', '=', lineId)
      .executeTakeFirstOrThrow();
    expect(record).toMatchObject({
      sale_id: sale.id,
      approved_by_person_id: manager.personId,
      amount_minor: 12_000,
      ceiling_minor: 5_000,
      currency: 'USD',
      reason: 'Damage confirmed on site',
    });
    // Once is enough.
    const again = await approve(approved.body, lineId, finance);
    expect(again.status).toBe(409);
    expect(again.body.details.code).toBe('LINE_ALREADY_APPROVED');
    const paid = await cash(approved.body, 12_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('paid');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['actor', 'reason', 'details'])
      .where('target_id', '=', sale.id)
      .where('action', '=', 'finance.approve_open_amount_line')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor: { personId: manager.personId },
      reason: 'Damage confirmed on site',
    });
    expect(audit.details).toMatchObject({ lineId, enteredByPersonId: desk.personId });
  });

  it('SPK-PAY-016: the person who entered a line never approves it, even holding the approving role', async () => {
    const sale = await openSale();
    // A finance operator may enter and may approve, and has the higher ceiling of that role.
    const within = await openLine(sale, finance, { amountMinor: 20_000 });
    expect(within.body.lines[0].openAmount).toMatchObject({
      ceilingMinor: 25_000,
      approvalRequired: false,
    });
    const above = await openLine(within.body, finance, {
      description: 'Scoreboard panel replaced',
      amountMinor: 40_000,
    });
    const line = above.body.lines.find(
      (l: Json) => (l.openAmount as Json).approvalRequired === true,
    );
    const own = await approve(above.body, line.id, finance);
    expect(own.status).toBe(403);
    expect(own.body.details).toMatchObject({ code: 'SECOND_PERSON_REQUIRED' });
    // A line within the ceiling needs none.
    const notNeeded = await approve(above.body, within.body.lines[0].id, manager);
    expect(notNeeded.status).toBe(409);
    expect(notNeeded.body.details.code).toBe('APPROVAL_NOT_REQUIRED');
    const approved = await approve(above.body, line.id, manager);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  });

  it('SPK-PAY-016: who may enter is a permission, the category comes from the list, and a discount is never a negative line', async () => {
    const sale = await openSale();
    // A general manager approves but does not ring lines up (proposed role assignment).
    const byManager = await openLine(sale, manager);
    expect(byManager.status).toBe(403);
    expect(byManager.body.details).toMatchObject({ action: 'finance.enter_open_amount_line' });
    const byCustomer = await openLine(sale, customer);
    expect(byCustomer.status).toBe(403);
    const unknown = await openLine(sale, desk, { reasonCategory: 'coach_tip' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.details).toMatchObject({
      code: 'OPEN_AMOUNT_CATEGORY_UNKNOWN',
      categories: ['field_damage_fee', 'lost_key', 'one_off_service'],
    });
    for (const body of [
      { amountMinor: -500 },
      { amountMinor: 0 },
      { description: '   ' },
      { reasonCategory: 'Not A Code' },
      { priceMinor: 100 },
      // Never both shapes at once.
      { productId: newId(), quantity: 1 },
    ]) {
      const refused = await openLine(sale, desk, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    }
    const stale = await openLine(sale, desk, { expectedRevision: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
  });

  it('SPK-PAY-016: a return or a void of an open-amount line follows the rules of any line', async () => {
    // Return: finance approves it, the revenue goes back under the line's revenue category.
    const sale = await openSale();
    const added = await openLine(sale, desk);
    const paid = await cash(added.body, 4_250);
    const lineId = paid.body.lines[0].id as string;
    const byDesk = await post(t, `/v1/pos-sales/${sale.id}/returns`, desk.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Charged in error',
      expectedRevision: paid.body.revision,
    });
    expect(byDesk.status).toBe(403);
    const returned = await post(t, `/v1/pos-sales/${sale.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Charged in error',
      expectedRevision: paid.body.revision,
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body).toMatchObject({ status: 'returned', returnedMinor: 4_250 });
    expect(returned.body.lines[0].returnedQuantity).toBe(1);
    const returnId = returned.body.returns[0].id as string;
    expect(await journalOf(t, returnId, 'pos_return')).toEqual([
      ['pos_revenue', 4_250, 0, 'open amount, revenue category facility_fees'],
      ['cash_on_hand', 0, 4_250, 'cash return'],
    ]);
    const twice = await post(t, `/v1/pos-sales/${sale.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Again',
    });
    expect(twice.status).toBe(409);

    // Void: an open sale is voided as today, whether or not a line waits for its approval.
    const open = await openSale();
    const waiting = await openLine(open, desk, { amountMinor: 9_000 });
    const voided = await post(t, `/v1/pos-sales/${open.id}/void`, desk.header, {
      reason: 'Customer left',
      expectedRevision: waiting.body.revision,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(201);
    expect(voided.body.status).toBe('voided');
    // A voided sale takes no approval and no line.
    const late = await approve(voided.body, waiting.body.lines[0].id, manager);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_TRANSITION');
  });

  it('SPK-PAY-016: an open-amount line is corrected only by removing it, and removing it lifts the block', async () => {
    const sale = await openSale();
    const added = await openLine(sale, desk, { amountMinor: 9_000 });
    const lineId = added.body.lines[0].id as string;
    const quantity = (body: Json, q: number) =>
      post(t, `/v1/pos-sales/${sale.id}/lines/${lineId}/quantity`, desk.header, {
        quantity: q,
        expectedRevision: body.revision,
      });
    const two = await quantity(added.body, 2);
    expect(two.status).toBe(400);
    expect(two.body.details).toMatchObject({ code: 'OPEN_AMOUNT_LINE_QUANTITY' });
    const within = await openLine(added.body, desk, {
      description: 'Lost locker key 9',
      amountMinor: 1_500,
      reasonCategory: 'lost_key',
    });
    const blocked = await cash(within.body, 1_500);
    expect(blocked.body.details).toMatchObject({ code: 'OPEN_AMOUNT_APPROVAL_REQUIRED' });
    const removed = await quantity(within.body, 0);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.lines).toHaveLength(1);
    expect(removed.body.totalMinor).toBe(1_500);
    // The removed line is kept as history; the removal repeats it at quantity 0.
    const rows = await t.db
      .selectFrom('pos_sale_lines')
      .select(['quantity', 'unit_price_minor', 'description', 'supersedes_line_id'])
      .where('sale_id', '=', sale.id)
      .where('reason_category', '=', 'field_damage_fee')
      .orderBy('line_number')
      .execute();
    expect(rows).toEqual([
      {
        quantity: 1,
        unit_price_minor: 9_000,
        description: 'Goal net torn on field 3',
        supersedes_line_id: null,
      },
      {
        quantity: 0,
        unit_price_minor: 9_000,
        description: 'Goal net torn on field 3',
        supersedes_line_id: lineId,
      },
    ]);
    const gone = await approve(removed.body, lineId, manager);
    expect(gone.status).toBe(409);
    expect(gone.body.details.code).toBe('LINE_ALREADY_CHANGED');
    const paid = await cash(removed.body, 1_500);
    expect(paid.body.status).toBe('paid');
  });

  it('SPK-PAY-016: the register session lists its open-amount lines apart, with description, category, who entered and who approved', async () => {
    const sale = await openSale();
    const first = await openLine(sale, desk);
    const second = await openLine(first.body, desk, {
      description: 'Scoreboard panel replaced',
      amountMinor: 30_000,
    });
    const big = second.body.lines.find((l: Json) => l.unitPriceMinor === 30_000).id as string;
    await approve(second.body, big, manager, 'Invoice 4471 seen');
    const removedLine = await openLine(
      (await t.http.get(`/v1/pos-sales/${sale.id}`).set(desk.header)).body,
      desk,
      { description: 'Rung up twice', amountMinor: 100 },
    );
    const gone = removedLine.body.lines.find((l: Json) => l.unitPriceMinor === 100).id as string;
    await post(t, `/v1/pos-sales/${sale.id}/lines/${gone}/quantity`, desk.header, {
      quantity: 0,
      expectedRevision: removedLine.body.revision,
    });
    const list = await t.http
      .get(`/v1/pos-register-sessions/${sale.registerSessionId}/open-amount-lines`)
      .set(finance.header);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.nextCursor).toBeNull();
    // Newest first; the removed line is not in effect and is not listed.
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0]).toMatchObject({
      saleId: sale.id,
      saleStatus: 'open',
      lineId: big,
      description: 'Scoreboard panel replaced',
      reasonCategory: 'field_damage_fee',
      reasonLabel: 'Field damage fee',
      revenueCategory: 'facility_fees',
      currency: 'USD',
      amountMinor: 30_000,
      lineTotalMinor: 30_000,
      enteredByPersonId: desk.personId,
      ceilingMinor: 5_000,
      approvalRequired: true,
      approval: { approvedByPersonId: manager.personId, reason: 'Invoice 4471 seen' },
      returnedQuantity: 0,
    });
    expect(list.body.items[1]).toMatchObject({
      description: 'Goal net torn on field 3',
      amountMinor: 4_250,
      approvalRequired: false,
      approval: null,
    });
    // One line per page, with a cursor to the next.
    const page = await t.http
      .get(`/v1/pos-register-sessions/${sale.registerSessionId}/open-amount-lines`)
      .query({ limit: 1 })
      .set(desk.header);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    const next = await t.http
      .get(`/v1/pos-register-sessions/${sale.registerSessionId}/open-amount-lines`)
      .query({ limit: 1, cursor: page.body.nextCursor })
      .set(desk.header);
    expect(next.body.items.map((i: Json) => i.amountMinor)).toEqual([4_250]);
    // Not a customer's read.
    const byCustomer = await t.http
      .get(`/v1/pos-register-sessions/${sale.registerSessionId}/open-amount-lines`)
      .set(customer.header);
    expect(byCustomer.status).toBe(403);
  });

  it('SPK-PAY-016: the rules read gives the categories and the caller’s own ceiling, and says the default is proposed', async () => {
    const rules = (who: Actor) =>
      t.http.get('/v1/pos-open-amount-rules').query({ facilityId: t.facilityId }).set(who.header);
    const forDesk = await rules(desk);
    expect(forDesk.status, JSON.stringify(forDesk.body)).toBe(200);
    expect(forDesk.body).toMatchObject({
      basis: 'proposed_default',
      policyVersionId: null,
      currency: null,
      ceilingMinor: 5_000,
      approverRoles: ['finance_operator', 'general_manager'],
    });
    expect(forDesk.body.categories.map((c: Json) => [c.code, c.label, c.revenueCategory])).toEqual([
      ['field_damage_fee', 'Field damage fee', 'facility_fees'],
      ['lost_key', 'Lost key', 'facility_fees'],
      ['one_off_service', 'One-off service', 'services'],
    ]);
    expect((await rules(finance)).body.ceilingMinor).toBe(25_000);
    // A general manager approves but does not enter a line: no ceiling of their own.
    expect((await rules(manager)).body.ceilingMinor).toBeNull();
    expect((await rules(customer)).status).toBe(403);
  });

  it('SPK-PAY-016, §4.7: two approvals at once leave one record, and a tender racing a line above the ceiling never pays the sale with that line unapproved', async () => {
    // Runs serialized under PGlite and truly concurrently under PostgreSQL (TEST_DATABASE_URL);
    // every writer locks the sale row first, so both modes give one of the two orders.
    const sale = await openSale();
    const added = await openLine(sale, desk, { amountMinor: 9_000 });
    const lineId = added.body.lines[0].id as string;
    const [byManager, byFinance] = await Promise.all([
      approve(added.body, lineId, manager),
      approve(added.body, lineId, finance),
    ]);
    expect([byManager.status, byFinance.status].sort()).toEqual([200, 409]);
    const records = await t.db
      .selectFrom('pos_line_approvals')
      .select('approved_by_person_id')
      .where('sale_line_id', '=', lineId)
      .execute();
    expect(records).toHaveLength(1);
    expect(records[0]!.approved_by_person_id).toBe(
      byManager.status === 200 ? manager.personId : finance.personId,
    );

    const racing = await openSale();
    const first = await openLine(racing, desk, { amountMinor: 1_000 });
    const [tender, line] = await Promise.all([
      cash(first.body, 1_000),
      openLine(first.body, desk, { amountMinor: 9_000, expectedRevision: first.body.revision }),
    ]);
    const after = await t.http.get(`/v1/pos-sales/${racing.id}`).set(desk.header);
    const unapproved = (after.body.lines as SaleBody['lines']).filter(
      (l) => l.openAmount?.approvalRequired === true && !l.openAmount.approval,
    );
    if (tender.status === 201) {
      // The tender came first: the sale was paid for what it held, and took no further line.
      expect(after.body).toMatchObject({ status: 'paid', totalMinor: 1_000 });
      expect(line.status).toBe(409);
      expect(unapproved).toEqual([]);
    } else {
      // The line came first: the tender was decided on an earlier view of the sale.
      expect(tender.status).toBe(409);
      expect(line.status).toBe(201);
      expect(after.body).toMatchObject({ status: 'open', totalMinor: 10_000, settledMinor: 0 });
      expect(unapproved).toHaveLength(1);
    }
  });

  describe('integrity the database enforces (migrations 0695, 0696)', () => {
    let sale: SaleBody;
    let productId: string;

    const lineRow = (over: Json = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      sale_id: sale.id,
      currency: 'USD',
      line_number: 100 + Math.floor(Math.random() * 1_000_000),
      product_id: null,
      sku: null,
      name: 'Field damage fee',
      kind: 'open_amount' as const,
      unit_price_minor: 1_000,
      quantity: 1,
      base_minor: 1_000,
      charges: json([]),
      charges_minor: 0,
      line_total_minor: 1_000,
      description: 'Net torn',
      reason_category: 'field_damage_fee',
      revenue_category: 'facility_fees',
      entered_by: json({ kind: 'staff' }),
      entered_by_person_id: desk.personId,
      approval_ceiling_minor: 5_000,
      approval_required: false,
      policy_version_id: null,
      ...over,
    });
    const insertLine = (over: Json = {}) =>
      t.db
        .insertInto('pos_sale_lines')
        .values(lineRow(over) as never)
        .execute();
    const approvalRow = (lineId: string, over: Json = {}) => ({
      id: newId(),
      organization_id: t.organizationId,
      sale_id: sale.id,
      sale_line_id: lineId,
      currency: 'USD',
      amount_minor: 9_000,
      ceiling_minor: 5_000,
      reason: 'direct',
      approved_by: json({ kind: 'staff' }),
      approved_by_person_id: manager.personId,
      approved_at: t.clock.now(),
      ...over,
    });
    const insertApproval = (lineId: string, over: Json = {}) =>
      t.db
        .insertInto('pos_line_approvals')
        .values(approvalRow(lineId, over) as never)
        .execute();

    beforeAll(async () => {
      const product = await post(t, '/v1/pos-products', manager.header, {
        sku: `SKU-${newId().slice(-8).toUpperCase()}`,
        name: 'Whistle',
        kind: 'merchandise',
        priceMinor: 700,
        currency: 'USD',
        chargePolicyKeys: [],
      });
      productId = product.body.id as string;
      sale = await openSale();
    });

    it('SPK-PAY-016: a line is a product line or an open-amount line, never both and never neither', async () => {
      // Both a product and a description.
      expect(await refusedBy(insertLine({ product_id: productId, sku: 'X' }))).toBe(
        '23514:pos_sale_lines_shape',
      );
      expect(
        await refusedBy(
          insertLine({ kind: 'merchandise', product_id: productId, sku: 'X', quantity: 1 }),
        ),
      ).toBe('23514:pos_sale_lines_shape');
      // Neither: a product kind without a product and without the open-amount facts.
      expect(
        await refusedBy(
          insertLine({
            kind: 'merchandise',
            description: null,
            reason_category: null,
            revenue_category: null,
            entered_by: null,
            entered_by_person_id: null,
            approval_ceiling_minor: null,
            approval_required: null,
          }),
        ),
      ).toBe('23514:pos_sale_lines_shape');
      // An open amount without one of its facts.
      for (const missing of [
        'description',
        'reason_category',
        'revenue_category',
        'entered_by_person_id',
        'approval_ceiling_minor',
        'approval_required',
      ]) {
        expect(await refusedBy(insertLine({ [missing]: null })), missing).toBe(
          '23514:pos_sale_lines_shape',
        );
      }
      // The kind is one of the four.
      expect(await refusedBy(insertLine({ kind: 'tip' }))).toBe('23514:pos_sale_lines_kind_check');
    });

    it('SPK-PAY-016: an open amount is positive, one unit, with a category code and a description', async () => {
      expect(
        await refusedBy(insertLine({ unit_price_minor: 0, base_minor: 0, line_total_minor: 0 })),
      ).toBe('23514:pos_sale_lines_open_amount_positive');
      expect(
        await refusedBy(
          insertLine({ unit_price_minor: -500, base_minor: -500, line_total_minor: -500 }),
        ),
        // A negative amount never reaches the new checks: the amount checks of 0607 answer first.
      ).toBe('23514:pos_sale_lines_base_minor_check');
      expect(
        await refusedBy(insertLine({ quantity: 2, base_minor: 2_000, line_total_minor: 2_000 })),
      ).toBe('23514:pos_sale_lines_open_amount_positive');
      for (const over of [
        { reason_category: 'Field Damage' },
        { reason_category: '' },
        { revenue_category: 'Facility fees!' },
        { description: '   ' },
        { description: 'x'.repeat(201) },
      ]) {
        expect(await refusedBy(insertLine(over)), JSON.stringify(over)).toBe(
          '23514:pos_sale_lines_open_amount_text',
        );
      }
    });

    it('SPK-PAY-016: whether a second approval is needed follows from the amount and the ceiling, never from the writer', async () => {
      // Above the ceiling but written as needing none.
      expect(
        await refusedBy(
          insertLine({ unit_price_minor: 9_000, base_minor: 9_000, line_total_minor: 9_000 }),
        ),
      ).toBe('23514:pos_sale_lines_open_amount_ceiling');
      // Within the ceiling but written as needing one.
      expect(await refusedBy(insertLine({ approval_required: true }))).toBe(
        '23514:pos_sale_lines_open_amount_ceiling',
      );
      expect(await refusedBy(insertLine({ approval_ceiling_minor: -1 }))).toBe(
        '23514:pos_sale_lines_open_amount_ceiling',
      );
    });

    it('SPK-PAY-016: lines stay append-only and an open-amount line is superseded only by its removal', async () => {
      const id = newId();
      await insertLine({ id });
      expect(
        await refusedBy(
          t.db
            .updateTable('pos_sale_lines')
            .set({ description: 'x' })
            .where('id', '=', id)
            .execute(),
        ),
      ).toBe('23001');
      expect(
        await refusedBy(t.db.deleteFrom('pos_sale_lines').where('id', '=', id).execute()),
      ).toBe('23001');
      const removal = { supersedes_line_id: id, quantity: 0, base_minor: 0, line_total_minor: 0 };
      // Another amount, another description or a quantity is not a removal.
      expect(await refusedBy(insertLine({ ...removal, unit_price_minor: 500 }))).toBe(
        '23514:pos_sale_lines_open_amount_supersede',
      );
      expect(await refusedBy(insertLine({ ...removal, description: 'Other' }))).toBe(
        '23514:pos_sale_lines_open_amount_supersede',
      );
      expect(await refusedBy(insertLine({ supersedes_line_id: id }))).toBe(
        '23514:pos_sale_lines_open_amount_supersede',
      );
      // A product line never supersedes an open amount (0686's rule answers first).
      expect(
        await refusedBy(
          t.db
            .insertInto('pos_sale_lines')
            .values({
              id: newId(),
              organization_id: t.organizationId,
              sale_id: sale.id,
              currency: 'USD',
              line_number: 7_000_001,
              product_id: productId,
              sku: 'W',
              name: 'Whistle',
              kind: 'merchandise',
              unit_price_minor: 700,
              quantity: 1,
              base_minor: 700,
              charges: json([]),
              charges_minor: 0,
              line_total_minor: 700,
              supersedes_line_id: id,
            })
            .execute(),
        ),
      ).toBe('23514:pos_sale_lines_same_product');
      await insertLine(removal);
      const after = await t.http.get(`/v1/pos-sales/${sale.id}`).set(desk.header);
      expect(after.body.lines.map((l: Json) => l.id)).not.toContain(id);
    });

    it('SPK-PAY-016: an approval is for a line that needs one, by a second person, once, and is never rewritten or deleted', async () => {
      const within = newId();
      await insertLine({ id: within });
      const above = newId();
      const amounts = { unit_price_minor: 9_000, base_minor: 9_000, line_total_minor: 9_000 };
      await insertLine({ id: above, ...amounts, approval_required: true });
      // The person who entered the line.
      expect(await refusedBy(insertApproval(above, { approved_by_person_id: desk.personId }))).toBe(
        '23514:pos_line_approvals_second_person',
      );
      // A line that needs none, and a product line.
      expect(await refusedBy(insertApproval(within, { amount_minor: 6_000 }))).toBe(
        '23514:pos_line_approvals_line',
      );
      const product = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
        productId,
        quantity: 1,
      });
      const productLine = product.body.lines.find((l: Json) => l.productId === productId)
        .id as string;
      expect(await refusedBy(insertApproval(productLine))).toBe('23514:pos_line_approvals_line');
      // Not the line's amount, ceiling or currency.
      expect(await refusedBy(insertApproval(above, { amount_minor: 8_000 }))).toBe(
        '23514:pos_line_approvals_facts',
      );
      expect(await refusedBy(insertApproval(above, { ceiling_minor: 100 }))).toBe(
        '23514:pos_line_approvals_facts',
      );
      expect(await refusedBy(insertApproval(above, { currency: 'EUR' }))).toBe(
        '23514:pos_line_approvals_facts',
      );
      expect(await refusedBy(insertApproval(above, { reason: '  ' }))).toBe(
        '23514:pos_line_approvals_reason_check',
      );
      const approvalId = newId();
      await insertApproval(above, { id: approvalId });
      expect(
        await refusedBy(insertApproval(above, { approved_by_person_id: finance.personId })),
      ).toBe('23505:pos_line_approvals_organization_id_sale_line_id_key');
      expect(
        await refusedBy(
          t.db
            .updateTable('pos_line_approvals')
            .set({ approved_by_person_id: finance.personId })
            .where('id', '=', approvalId)
            .execute(),
        ),
      ).toBe('23001');
      expect(
        await refusedBy(
          t.db.deleteFrom('pos_line_approvals').where('id', '=', approvalId).execute(),
        ),
      ).toBe('23001');
      // A removed line takes no approval.
      const removed = newId();
      await insertLine({ id: removed, ...amounts, approval_required: true });
      await insertLine({
        ...amounts,
        approval_required: true,
        supersedes_line_id: removed,
        quantity: 0,
        base_minor: 0,
        line_total_minor: 0,
      });
      expect(await refusedBy(insertApproval(removed))).toBe('23514:pos_line_approvals_line');
    });

    it('SPK-PAY-016: the database takes no tender and pays no sale while a line waits for its approval', async () => {
      const waiting = await openSale();
      const added = await openLine(waiting, desk, { amountMinor: 9_000 });
      const lineId = added.body.lines[0].id as string;
      const tender = () =>
        t.db
          .insertInto('pos_tenders')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            sale_id: waiting.id,
            currency: 'USD',
            kind: 'cash',
            amount_minor: 9_000,
            payment_attempt_id: null,
            evidence: null,
            status: 'settled',
            failure_reason: null,
            recorded_by: json({ kind: 'staff' }),
            recorded_by_person_id: desk.personId,
            recorded_at: t.clock.now(),
            settled_at: t.clock.now(),
            failed_at: null,
          })
          .execute();
      expect(await refusedBy(tender())).toBe('23514:pos_tenders_open_amount_approved');
      const pay = () =>
        t.db
          .updateTable('pos_sales')
          .set({ status: 'paid', paid_at: t.clock.now() })
          .where('id', '=', waiting.id)
          .execute();
      expect(await refusedBy(pay())).toBe('23514:pos_sales_open_amount_approved');
      await t.db
        .insertInto('pos_line_approvals')
        .values({
          ...approvalRow(lineId),
          sale_id: waiting.id,
        } as never)
        .execute();
      await tender();
      await pay();
      // A paid sale's lines take no approval.
      const late = await openSale();
      const lateLine = await openLine(late, desk);
      await cash(lateLine.body, 4_250);
      expect(
        await refusedBy(
          t.db
            .insertInto('pos_line_approvals')
            .values({ ...approvalRow(lateLine.body.lines[0].id), sale_id: late.id } as never)
            .execute(),
        ),
      ).toBe('23514:pos_line_approvals_open_sale');
    });

    it('§4.3: an open-amount line and its approval never reference another organization’s records', async () => {
      const other = await seedOrganization(t.db);
      const foreigner = await createPersonFixture(t, {
        kind: 'adult',
        organizationId: other.organizationId,
      });
      // Entered by a person of another organization.
      expect(await refusedBy(insertLine({ entered_by_person_id: foreigner }))).toBe(
        '23503:pos_sale_lines_entered_by_fk',
      );
      // A policy version of another organization.
      const foreignPolicy = await createPolicyVersionFixture(t, {
        kind: OPEN_AMOUNT_POLICY.kind,
        key: OPEN_AMOUNT_POLICY.key,
        organizationId: other.organizationId,
        content: {},
      });
      expect(await refusedBy(insertLine({ policy_version_id: foreignPolicy }))).toBe(
        '23503:pos_sale_lines_policy_version_fk',
      );
      const above = newId();
      await insertLine({
        id: above,
        unit_price_minor: 9_000,
        base_minor: 9_000,
        line_total_minor: 9_000,
        approval_required: true,
      });
      // Approved by a person of another organization.
      expect(await refusedBy(insertApproval(above, { approved_by_person_id: foreigner }))).toBe(
        '23503:pos_line_approvals_organization_id_approved_by_person_id_fkey',
      );
      // An approval filed under another organization for this organization's line: that
      // organization has no such sale.
      expect(
        await refusedBy(insertApproval(above, { organization_id: other.organizationId })),
      ).toBe('23514:pos_line_approvals_open_sale');
      // A line of another sale than the one the approval names.
      const elsewhere = await openSale();
      expect(
        await refusedBy(
          t.db
            .insertInto('pos_line_approvals')
            .values({ ...approvalRow(above), sale_id: elsewhere.id } as never)
            .execute(),
        ),
      ).toBe('23514:pos_line_approvals_line');
    });
  });
});

describe('point of sale: open-amount lines under an approved policy version (SPK-PAY-016, proposed)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let n = 0;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale', 'open_amount_lines'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    approveTaxFee('open-amount-service-tax', {
      code: 'SVC',
      label: 'Service tax 10%',
      kind: 'tax',
      rateBasisPoints: 1_000,
      rounding: 'half_up',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function openSale(currency = 'USD'): Promise<SaleBody> {
    n += 1;
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `OP${n}`,
      name: `Policy ${n}`,
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk.header, {
      currency,
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: session.body.id,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    return sale.body;
  }

  const policy = (version: number, content: Json, approved = true) =>
    createPolicyVersionFixture(t, {
      kind: OPEN_AMOUNT_POLICY.kind,
      key: OPEN_AMOUNT_POLICY.key,
      version,
      content,
      approved,
    });

  it('SPK-PAY-016: the approved policy version gives the categories, the revenue category, the tax treatment and the ceiling per role, and the line records the version', async () => {
    // A draft changes nothing: the proposed default still applies.
    await policy(1, { categories: [], ceilings: { defaultMinor: 0 } }, false);
    const before = await t.http
      .get('/v1/pos-open-amount-rules')
      .query({ facilityId: t.facilityId })
      .set(desk.header);
    expect(before.body.basis).toBe('proposed_default');
    const versionId = await policy(2, {
      currency: 'USD',
      categories: [
        { code: 'special_rental', label: 'Special rental', revenueCategory: 'rentals' },
        {
          code: 'one_off_service',
          label: 'One-off service',
          revenueCategory: 'services',
          chargePolicyKeys: ['open-amount-service-tax'],
        },
      ],
      ceilings: { defaultMinor: 1_000, byRole: { front_desk: 2_000 } },
    });
    const rules = await t.http
      .get('/v1/pos-open-amount-rules')
      .query({ facilityId: t.facilityId })
      .set(desk.header);
    expect(rules.body).toMatchObject({
      basis: 'approved_policy',
      policyVersionId: versionId,
      currency: 'USD',
      ceilingMinor: 2_000,
    });
    expect(rules.body.categories.map((c: Json) => c.code)).toEqual([
      'special_rental',
      'one_off_service',
    ]);
    // A finance operator is not named by the version: its default applies to that role.
    const forFinance = await t.http
      .get('/v1/pos-open-amount-rules')
      .query({ facilityId: t.facilityId })
      .set(finance.header);
    expect(forFinance.body.ceilingMinor).toBe(1_000);

    const sale = await openSale();
    // A category of the default list that the approved version does not carry is refused.
    const dropped = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Net torn',
      amountMinor: 500,
      reasonCategory: 'field_damage_fee',
    });
    expect(dropped.status).toBe(400);
    expect(dropped.body.details).toMatchObject({
      code: 'OPEN_AMOUNT_CATEGORY_UNKNOWN',
      categories: ['special_rental', 'one_off_service'],
    });
    const taxed = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Referee for a private match',
      amountMinor: 1_850,
      reasonCategory: 'one_off_service',
    });
    expect(taxed.status, JSON.stringify(taxed.body)).toBe(201);
    expect(taxed.body).toMatchObject({
      subtotalMinor: 1_850,
      chargesMinor: 185,
      totalMinor: 2_035,
    });
    expect(taxed.body.lines[0]).toMatchObject({
      name: 'One-off service',
      chargesMinor: 185,
      openAmount: {
        revenueCategory: 'services',
        ceilingMinor: 2_000,
        // The ceiling is on the amount entered, before taxes.
        approvalRequired: false,
        policyVersionId: versionId,
      },
    });
    expect(taxed.body.charges).toEqual([
      { code: 'SVC', label: 'Service tax 10%', kind: 'tax', amountMinor: 185 },
    ]);
    const above = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Field 2 for a film crew',
      amountMinor: 2_001,
      reasonCategory: 'special_rental',
      expectedRevision: taxed.body.revision,
    });
    expect(above.body.lines[1].openAmount).toMatchObject({
      ceilingMinor: 2_000,
      approvalRequired: true,
    });
    const approved = await post(
      t,
      `/v1/pos-sales/${sale.id}/lines/${above.body.lines[1].id}/approval`,
      finance.header,
      { reason: 'Agreed with the events manager', expectedRevision: above.body.revision },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const paid = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_035 + 2_001,
      expectedRevision: approved.body.revision,
    });
    expect(paid.body.status).toBe('paid');
    expect(await journalOf(t, sale.id, 'pos_sale_paid')).toEqual([
      ['cash_on_hand', 4_036, 0, 'cash and external tenders'],
      ['pos_revenue', 0, 1_850, 'open amount, revenue category services'],
      ['pos_revenue', 0, 2_001, 'open amount, revenue category rentals'],
      ['taxes_payable', 0, 185, 'charge SVC'],
    ]);
  });

  it('SPK-PAY-016: ceilings stated in one currency take no open-amount line on a sale in another', async () => {
    const sale = await openSale('EUR');
    const refused = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Field 2 for a film crew',
      amountMinor: 500,
      reasonCategory: 'special_rental',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      code: 'OPEN_AMOUNT_POLICY_CURRENCY_MISMATCH',
      policyCurrency: 'USD',
      saleCurrency: 'EUR',
    });
  });

  it('SPK-PAY-016, DEC-057: a category whose tax policy is not approved refuses the line, and an approved version with unusable content refuses every line', async () => {
    await policy(3, {
      categories: [
        {
          code: 'special_rental',
          label: 'Special rental',
          revenueCategory: 'rentals',
          chargePolicyKeys: ['never-approved-levy'],
        },
      ],
      ceilings: { defaultMinor: 1_000 },
    });
    const sale = await openSale();
    const noTax = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Field 2 for a film crew',
      amountMinor: 500,
      reasonCategory: 'special_rental',
    });
    expect(noTax.status).toBe(409);
    expect(noTax.body.details).toMatchObject({
      code: 'CHARGE_POLICY_NOT_APPROVED',
      policyKey: 'never-approved-levy',
      reasonCategory: 'special_rental',
    });
    const invalid = await policy(4, { categories: [], ceilings: {} });
    const refused = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      description: 'Field 2 for a film crew',
      amountMinor: 500,
      reasonCategory: 'special_rental',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      code: 'OPEN_AMOUNT_POLICY_INVALID',
      policyVersionId: invalid,
    });
    const rules = await t.http
      .get('/v1/pos-open-amount-rules')
      .query({ facilityId: t.facilityId })
      .set(desk.header);
    expect(rules.status).toBe(409);
  });
});

describe('point of sale: open-amount lines with the capability off (SPK-PAY-016, DEC-016)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let n = 0;

  beforeAll(async () => {
    t = await financeTestApp({ capabilities: ['point_of_sale'] });
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function openSale(): Promise<SaleBody> {
    n += 1;
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `OF${n}`,
      name: `Off ${n}`,
    });
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const sale = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: session.body.id,
    });
    return sale.body;
  }
  const openLine = (sale: Json, amountMinor = 4_250) =>
    post(t, `/v1/pos-sales/${String(sale.id)}/lines`, desk.header, {
      description: 'Goal net torn on field 3',
      amountMinor,
      reasonCategory: 'field_damage_fee',
    });

  it('SPK-PAY-016: with open_amount_lines off the open-amount body is refused with the capability error and product lines are exactly as before', async () => {
    const sale = await openSale();
    const refused = await openLine(sale);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'open_amount_lines',
      applicabilityReferences: ['DEC-016', 'DEC-102'],
    });
    expect(await t.db.selectFrom('pos_sale_lines').select('id').execute()).toEqual([]);
    const product = await post(t, '/v1/pos-products', manager.header, {
      sku: 'SOCKS',
      name: 'Game socks',
      kind: 'merchandise',
      priceMinor: 800,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    const lined = await post(t, `/v1/pos-sales/${sale.id}/lines`, desk.header, {
      productId: product.body.id,
      quantity: 3,
    });
    expect(lined.status, JSON.stringify(lined.body)).toBe(201);
    expect(lined.body).toMatchObject({ status: 'open', totalMinor: 2_400, remainingMinor: 2_400 });
    expect(lined.body.lines[0]).toMatchObject({
      kind: 'merchandise',
      sku: 'SOCKS',
      productId: product.body.id,
      openAmount: null,
    });
    const paid = await post(t, `/v1/pos-sales/${sale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_400,
    });
    expect(paid.body.status).toBe('paid');
    expect(await journalOf(t, sale.id, 'pos_sale_paid')).toEqual([
      ['cash_on_hand', 2_400, 0, 'cash and external tenders'],
      ['pos_revenue', 0, 2_400, 'product kind merchandise'],
    ]);
    const receipt = await t.http.get(`/v1/pos-sales/${sale.id}/receipt`).set(desk.header);
    expect(receipt.body.lines[0]).toMatchObject({ name: 'Game socks', description: null });
    const list = await t.http
      .get(`/v1/pos-register-sessions/${paid.body.registerSessionId}/open-amount-lines`)
      .set(desk.header);
    expect(list.body).toEqual({ items: [], nextCursor: null });
  });

  it('SPK-PAY-016, DEC-016: turning the switch off strands no sale: the approval is refused, but the line can be removed or the sale voided, and an approved sale is still paid and returned', async () => {
    await t.enableCapability('open_amount_lines');
    const finance = await staff(t, ['finance_operator']);
    const waiting = await openSale();
    const above = await openLine(waiting, 9_000);
    expect(above.status, JSON.stringify(above.body)).toBe(201);
    const approvedSale = await openSale();
    const line = await openLine(approvedSale, 9_000);
    const approved = await post(
      t,
      `/v1/pos-sales/${approvedSale.id}/lines/${line.body.lines[0].id}/approval`,
      manager.header,
      { reason: 'Seen', expectedRevision: line.body.revision },
    );
    expect(approved.status).toBe(200);
    await t.disableCapability('open_amount_lines');
    await t.disableCapability('point_of_sale');

    const lineId = above.body.lines[0].id as string;
    const refused = await post(
      t,
      `/v1/pos-sales/${waiting.id}/lines/${lineId}/approval`,
      manager.header,
      { reason: 'Seen', expectedRevision: above.body.revision },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'open_amount_lines',
    });
    // Removing the line needs no switch (it unwinds); the sale is then empty and can be voided.
    const removed = await post(
      t,
      `/v1/pos-sales/${waiting.id}/lines/${lineId}/quantity`,
      desk.header,
      { quantity: 0, expectedRevision: above.body.revision },
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.lines).toEqual([]);
    const voided = await post(t, `/v1/pos-sales/${waiting.id}/void`, desk.header, {
      reason: 'Nothing left to sell',
      expectedRevision: removed.body.revision,
    });
    expect(voided.body.status).toBe('voided');
    // The sale approved before the switch went off is paid and returned as any sale.
    const paid = await post(t, `/v1/pos-sales/${approvedSale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 9_000,
      expectedRevision: approved.body.revision,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('paid');
    const returned = await post(t, `/v1/pos-sales/${approvedSale.id}/returns`, finance.header, {
      lines: [{ saleLineId: paid.body.lines[0].id, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Charged in error',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    // Reads stay available: the line is still shown with its facts.
    const read = await t.http.get(`/v1/pos-sales/${approvedSale.id}`).set(desk.header);
    expect(read.body.lines[0].openAmount).toMatchObject({ approvalRequired: true });
    await t.enableCapability('point_of_sale');
    // With point of sale back on and open amounts still off, the capability named is the right one.
    const sale = await openSale();
    const still = await openLine(sale);
    expect(still.body.details).toMatchObject({ capability: 'open_amount_lines' });
  });
});
