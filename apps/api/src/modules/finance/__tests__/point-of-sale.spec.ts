import { newId } from '@sportspark/contracts';
import { json, pgErrorCode } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseConstraintOf } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { FakePaymentTokens, fakeFeeFor } from '../providers/fake-payment.provider';
import { approveTaxFee } from './stage3-doubles';
import {
  adult,
  drain,
  financeTestApp,
  ledgerTotals,
  post,
  provider,
  staff,
  worker,
  type Actor,
} from './support';

type Json = Record<string, unknown>;

/** The database constraint that refused a statement. */
async function refusedBy(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    const c = databaseConstraintOf(error);
    return c ? `${c.code}:${c.constraint ?? ''}` : (pgErrorCode(error) ?? String(error));
  }
  throw new Error('expected the database to refuse the statement');
}

describe('point of sale (FIN-06; §3.16 POS, SPK-PAY-002/008/010/012, DEC-016, DEC-079)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let customer: Actor;
  let codeCounter = 0;

  beforeAll(async () => {
    t = await financeTestApp();
    manager = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
    finance = await staff(t, ['finance_operator']);
    customer = await adult(t);
    approveTaxFee('city-sales-tax', {
      code: 'CITY',
      label: 'City sales tax',
      kind: 'tax',
      rateBasisPoints: 825,
      rounding: 'half_up',
    });
    approveTaxFee('bag-fee', {
      code: 'BAG',
      label: 'Bag fee',
      kind: 'fee',
      amountMinor: 10,
      currency: 'USD',
      rounding: 'half_up',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function product(
    priceMinor: number,
    chargePolicyKeys: string[] = [],
    kind = 'merchandise',
  ): Promise<string> {
    const res = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Team water bottle',
      kind,
      priceMinor,
      currency: 'USD',
      chargePolicyKeys,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function openSession(
    floatMinor = 10_000,
  ): Promise<{ registerId: string; sessionId: string }> {
    codeCounter += 1;
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `FD${codeCounter}`,
      name: `Front desk ${codeCounter}`,
    });
    expect(register.status, JSON.stringify(register.body)).toBe(201);
    const session = await post(t, `/v1/pos-registers/${register.body.id}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: floatMinor,
    });
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    return { registerId: register.body.id as string, sessionId: session.body.id as string };
  }

  async function sale(
    sessionId: string,
    customerPersonId?: string,
  ): Promise<Json & { id: string }> {
    const res = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: sessionId,
      ...(customerPersonId ? { customerPersonId } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Json & { id: string };
  }

  async function line(saleId: string, productId: string, quantity: number) {
    return post(t, `/v1/pos-sales/${saleId}/lines`, desk.header, { productId, quantity });
  }

  async function journalOf(sourceType: string, sourceId: string) {
    return t.db
      .selectFrom('journal_entries')
      .innerJoin('journals', 'journals.id', 'journal_entries.journal_id')
      .select([
        'journals.id as journal_id',
        'journals.purpose as purpose',
        'journal_entries.account_code as account',
        'journal_entries.debit_minor as debit',
        'journal_entries.credit_minor as credit',
        'journal_entries.memo as memo',
      ])
      .where('journals.organization_id', '=', t.organizationId)
      .where('journals.source_type', '=', sourceType)
      .where('journals.source_id', '=', sourceId)
      .orderBy('journal_entries.line_number')
      .execute();
  }

  it('DEC-016, DEC-079: with point_of_sale disabled nothing new is sold; reads stay available', async () => {
    const refused = await post(t, '/v1/pos-products', manager.header, {
      sku: 'SKU-OFF',
      name: 'Cap',
      kind: 'merchandise',
      priceMinor: 1_500,
      currency: 'USD',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'point_of_sale',
      applicabilityReferences: ['DEC-016', 'DEC-079'],
    });
    expect((await t.http.get('/v1/pos-products').set(manager.header)).status).toBe(200);
    await t.enableCapability('point_of_sale');
  });

  it('SPK-PAY-002: a sale shows only charges of approved tax_fee versions; a product whose charge key has no approved version cannot be sold', async () => {
    const taxed = await product(1_999, ['city-sales-tax', 'bag-fee']);
    const unapproved = await product(500, ['county-levy']);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    expect(s).toMatchObject({ status: 'open', totalMinor: 0 });
    expect(s.saleNumber).toMatch(/^FD\d+-20261102-1$/);
    const added = await line(s.id, taxed, 3);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    // 3 × 19.99 = 59.97; 8.25% of it = 4.9475, rounded half up per the approved version = 4.95;
    // the fixed bag fee of 0.10 per unit = 0.30.
    expect(added.body).toMatchObject({
      subtotalMinor: 5_997,
      chargesMinor: 525,
      totalMinor: 6_522,
      remainingMinor: 6_522,
    });
    const charges = added.body.lines[0].charges as Array<Json>;
    expect(charges.map((c) => [c.code, c.kind, c.amountMinor])).toEqual([
      ['CITY', 'tax', 495],
      ['BAG', 'fee', 30],
    ]);
    expect(charges.every((c) => typeof c.policyVersionId === 'string')).toBe(true);

    const refused = await line(s.id, unapproved, 1);
    expect(refused.status).toBe(409);
    expect(refused.body.details).toMatchObject({
      code: 'CHARGE_POLICY_NOT_APPROVED',
      policyKey: 'county-levy',
    });
    const after = await t.http.get(`/v1/pos-sales/${s.id}`).set(desk.header);
    expect(after.body.lines).toHaveLength(1);
    expect(after.body.totalMinor).toBe(6_522);
    // A client price is never accepted (SPK-PAY-001).
    const priced = await post(t, `/v1/pos-sales/${s.id}/lines`, desk.header, {
      productId: taxed,
      quantity: 1,
      unitPriceMinor: 1,
    });
    expect(priced.status).toBe(400);
  });

  it('cash pays a sale in full: tenders settle at once and the journal books revenue, taxes and fees', async () => {
    const taxed = await product(1_000, ['city-sales-tax']);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    await line(s.id, taxed, 2); // 20.00 + 1.65 tax
    const over = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 5_000,
    });
    expect(over.status).toBe(400);
    expect(over.body.details).toMatchObject({
      code: 'TENDER_EXCEEDS_REMAINING',
      remainingMinor: 2_165,
    });
    const part = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_000,
    });
    expect(part.body).toMatchObject({ status: 'open', settledMinor: 1_000, remainingMinor: 1_165 });
    const rest = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_165,
    });
    expect(rest.body).toMatchObject({ status: 'paid', settledMinor: 2_165, remainingMinor: 0 });
    const journal = await journalOf('pos_sale', s.id);
    expect(journal.map((e) => [e.account, Number(e.debit), Number(e.credit), e.memo])).toEqual([
      ['cash_on_hand', 2_165, 0, 'cash and external tenders'],
      ['pos_revenue', 0, 2_000, 'product kind merchandise'],
      ['taxes_payable', 0, 165, 'charge CITY'],
    ]);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
    await drain(t);
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['payload'])
      .where('event_type', '=', 'finance.pos_sale_changed')
      .where('aggregate_id', '=', s.id)
      .execute();
    expect(events.map((e) => (e.payload as Json).status)).toEqual(['open', 'paid']);
  });

  it("SPK-PAY-010: a return posts reversing journals and never edits the sale's entries", async () => {
    const taxed = await product(1_999, ['city-sales-tax']);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    await line(s.id, taxed, 3); // 59.97 + 4.95
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 6_492,
    });
    expect(paid.body.status).toBe('paid');
    const saleJournalBefore = await journalOf('pos_sale', s.id);
    const lineId = paid.body.lines[0].id as string;
    // Only finance approves returns.
    const byDesk = await post(t, `/v1/pos-sales/${s.id}/returns`, desk.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Damaged',
    });
    expect(byDesk.status).toBe(403);
    const first = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Damaged bottle',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // The line's base and its tax are split over its units by largest remainder: 19.99 + 1.65.
    expect(first.body).toMatchObject({ status: 'partially_returned', returnedMinor: 2_164 });
    expect(first.body.returns[0]).toMatchObject({
      amountMinor: 2_164,
      tenderKind: 'cash',
      registerSessionId: sessionId,
      lines: [{ saleLineId: lineId, quantity: 1, baseMinor: 1_999, amountMinor: 2_164 }],
    });
    const returnId = first.body.returns[0].id as string;
    const reversing = await journalOf('pos_return', returnId);
    expect(reversing.map((e) => [e.account, Number(e.debit), Number(e.credit)])).toEqual([
      ['pos_revenue', 1_999, 0],
      ['taxes_payable', 165, 0],
      ['cash_on_hand', 0, 2_164],
    ]);
    expect(await journalOf('pos_sale', s.id)).toEqual(saleJournalBefore);
    // The sale's own entries are append-only.
    const entryId = (
      await t.db
        .selectFrom('journal_entries')
        .select('id')
        .where('journal_id', '=', saleJournalBefore[0]?.journal_id as string)
        .executeTakeFirstOrThrow()
    ).id;
    expect(
      await refusedBy(
        t.db
          .updateTable('journal_entries')
          .set({ memo: 'edited' })
          .where('id', '=', entryId)
          .execute(),
      ),
    ).toMatch(/^23001/);
    // More than what is left is refused; the rest returns the sale in full (every unit paid back).
    const tooMany = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 3 }],
      tenderKind: 'cash',
      reason: 'Everything',
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.details).toMatchObject({
      code: 'RETURN_EXCEEDS_QUANTITY',
      returnableQuantity: 2,
    });
    const rest = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 2 }],
      tenderKind: 'cash',
      reason: 'Rest of the order',
    });
    expect(rest.body).toMatchObject({ status: 'returned', returnedMinor: 6_492 });
    const again = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Again',
    });
    expect(again.status).toBe(409);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('SPK-PAY-012: an external tender without evidence is refused; POS cannot sell a registration', async () => {
    const plain = await product(2_500);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    await line(s.id, plain, 1);
    const bare = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'external',
      amountMinor: 2_500,
    });
    expect(bare.status).toBe(400);
    const evidenced = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'external',
      amountMinor: 2_500,
      evidence: { reference: 'TERM-42 auth 991' },
    });
    expect(evidenced.body).toMatchObject({ status: 'paid' });
    expect(evidenced.body.tenders[0]).toMatchObject({
      kind: 'external',
      status: 'settled',
      evidenceReference: 'TERM-42 auth 991',
    });
    // The database refuses an external tender without its evidence reference too.
    const another = await sale(sessionId);
    await line(another.id, plain, 1);
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_tenders')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            sale_id: another.id,
            currency: 'USD',
            kind: 'external',
            amount_minor: 1,
            payment_attempt_id: null,
            evidence: json({ notes: 'no reference' }),
            status: 'settled',
            failure_reason: null,
            recorded_by: json({}),
            recorded_by_person_id: desk.personId,
            recorded_at: new Date(),
            settled_at: new Date(),
            failed_at: null,
          })
          .execute(),
      ),
    ).toBe('23514:pos_tenders_external_evidence');

    // Registrations (and memberships, packages, bookings) are never POS products.
    const registration = await post(t, '/v1/pos-products', manager.header, {
      sku: 'SKU-REG',
      name: 'Spring soccer registration',
      kind: 'registration',
      priceMinor: 15_000,
      currency: 'USD',
    });
    expect(registration.status).toBe(400);
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_products')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            facility_id: null,
            sku: 'SKU-MEMBERSHIP',
            name: 'Membership',
            kind: 'membership' as never,
            price_minor: 1,
            currency: 'USD',
            retired_at: null,
            retire_reason: null,
            created_by: json({}),
          })
          .execute(),
      ),
    ).toBe('23514:pos_products_kind_check');
  });

  it('§4.11: a card tender is charged outside the transaction; an unknown outcome keeps the sale open and pays it exactly once when reconciled', async () => {
    const plain = await product(4_000);
    const { sessionId } = await openSession();
    const anonymous = await sale(sessionId);
    await line(anonymous.id, plain, 1);
    const noCustomer = await post(t, `/v1/pos-sales/${anonymous.id}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 4_000,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.details).toMatchObject({ code: 'CARD_TENDER_NEEDS_CUSTOMER' });
    await post(t, `/v1/pos-sales/${anonymous.id}/void`, desk.header, { reason: 'Walked away' });

    const s = await sale(sessionId, customer.personId);
    await line(s.id, plain, 1);
    const unknown = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 4_000,
      paymentMethodToken: FakePaymentTokens.timeout,
    });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(201);
    expect(unknown.body).toMatchObject({ status: 'open', pendingMinor: 4_000, remainingMinor: 0 });
    expect(unknown.body.tenders[0]).toMatchObject({
      kind: 'card',
      status: 'pending',
      paymentStatus: 'unknown',
    });
    const attemptId = unknown.body.tenders[0].paymentAttemptId as string;
    // SPK-PAY-007: no second card charge while the outcome is unknown; void is refused too.
    const second = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 1,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    expect(second.body.details).toMatchObject({ attemptId, purpose: 'pos_sale' });
    const voided = await post(t, `/v1/pos-sales/${s.id}/void`, desk.header, { reason: 'x' });
    expect(voided.status).toBe(409);
    expect(voided.body.details).toMatchObject({ code: 'SALE_HAS_CARD_TENDER' });

    // The reconciliation sweep finds the captured charge: the tender settles and the sale pays.
    t.clock.advance(20 * 60_000);
    await worker(t).runOnce();
    const paid = await t.http.get(`/v1/pos-sales/${s.id}`).set(desk.header);
    expect(paid.body).toMatchObject({ status: 'paid', settledMinor: 4_000, pendingMinor: 0 });
    expect(paid.body.tenders[0]).toMatchObject({ status: 'settled', paymentStatus: 'succeeded' });
    await worker(t).runOnce();
    const journals = await t.db
      .selectFrom('journals')
      .select('id')
      .where('source_type', '=', 'pos_sale')
      .where('source_id', '=', s.id)
      .execute();
    expect(journals).toHaveLength(1);
    const journal = await journalOf('pos_sale', s.id);
    const fee = fakeFeeFor(4_000);
    expect(journal.map((e) => [e.account, Number(e.debit), Number(e.credit)])).toEqual([
      ['cash_processor', 4_000, 0],
      ['pos_revenue', 0, 4_000],
      ['processor_fees', fee, 0],
      ['cash_processor', 0, fee],
    ]);
    const payment = await t.http.get(`/v1/payments/${attemptId}`).set(customer.header);
    expect(payment.body).toMatchObject({
      purpose: 'pos_sale',
      posSaleId: s.id,
      refundableMinor: 4_000,
    });
    expect(provider(t).paymentCalls.filter((c) => c.idempotencyKey === attemptId)).toHaveLength(1);
  });

  it('SPK-PAY-008: a card return reserves within the captured funds and refunds outside the transaction', async () => {
    const plain = await product(3_000);
    const { sessionId } = await openSession();
    const s = await sale(sessionId, customer.personId);
    await line(s.id, plain, 2);
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 6_000,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.body.status).toBe('paid');
    const lineId = paid.body.lines[0].id as string;
    const cashBack = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Paid by card, not cash',
    });
    expect(cashBack.status).toBe(409);
    expect(cashBack.body.details).toMatchObject({
      code: 'RETURN_EXCEEDS_TENDER',
      availableMinor: 0,
    });
    const returned = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: lineId, quantity: 1 }],
      tenderKind: 'card',
      reason: 'Wrong size',
    });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body.returns[0]).toMatchObject({
      amountMinor: 3_000,
      tenderKind: 'card',
      refundStatus: 'succeeded',
    });
    const attemptId = paid.body.tenders[0].paymentAttemptId as string;
    const payment = await t.http.get(`/v1/payments/${attemptId}`).set(finance.header);
    expect(payment.body.refundableMinor).toBe(3_000);
    expect(payment.body.refunds).toHaveLength(1);
    const returnJournal = await journalOf('pos_return', returned.body.returns[0].id as string);
    expect(returnJournal.map((e) => [e.account, Number(e.debit), Number(e.credit)])).toEqual([
      ['pos_revenue', 3_000, 0],
      ['refunds', 0, 3_000],
    ]);
    const totals = await ledgerTotals(t);
    expect(totals.debits).toBe(totals.credits);
  });

  it('POL-018: closing a register counts the drawer; a difference is raised for finance without tolerance or posting', async () => {
    const plain = await product(1_250);
    const { registerId, sessionId } = await openSession(5_000);
    const open = await sale(sessionId);
    await line(open.id, plain, 1);
    const blocked = await post(t, `/v1/pos-register-sessions/${sessionId}/close`, desk.header, {
      countedCashMinor: 5_000,
      expectedRevision: 1,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toMatchObject({ code: 'SESSION_HAS_OPEN_SALES' });
    await post(t, `/v1/pos-sales/${open.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_250,
    });
    const voided = await sale(sessionId);
    await line(voided.id, plain, 2);
    await post(t, `/v1/pos-sales/${voided.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_000,
    });
    const v = await post(t, `/v1/pos-sales/${voided.id}/void`, desk.header, {
      reason: 'Changed mind',
    });
    expect(v.body).toMatchObject({ status: 'voided', voidReason: 'Changed mind' });
    const before = await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header);
    // Float 50.00 + 12.50 sold (the voided sale's cash went back).
    expect(before.body).toMatchObject({ status: 'open', expectedCashMinor: 6_250 });
    const closed = await post(t, `/v1/pos-register-sessions/${sessionId}/close`, desk.header, {
      countedCashMinor: 6_200,
      expectedRevision: before.body.revision,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body).toMatchObject({
      status: 'closed',
      expectedCashMinor: 6_250,
      countedCashMinor: 6_200,
      varianceMinor: -50,
    });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('category', '=', 'finance.pos_register_variance')
      .where('affected_id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({ owner_queue: 'finance_operator' });
    const journals = await t.db
      .selectFrom('journals')
      .select('id')
      .where('source_id', '=', sessionId)
      .execute();
    expect(journals).toEqual([]);
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'finance.pos_register_session_closed')
      .where('aggregate_id', '=', sessionId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ registerId, varianceMinor: -50, currency: 'USD' });
    // The next session of the register continues the day's sale numbers.
    const next = await post(t, `/v1/pos-registers/${registerId}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    const third = await sale(next.body.id as string);
    expect(third.saleNumber).toMatch(/-20261102-3$/);
  });

  it('§4.10: the customer reads their own receipt and lists it; another customer learns nothing', async () => {
    const plain = await product(800, ['city-sales-tax']);
    const { sessionId } = await openSession();
    const s = await sale(sessionId, customer.personId);
    await line(s.id, plain, 1);
    const early = await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(customer.header);
    expect(early.status).toBe(409);
    await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, { kind: 'cash', amountMinor: 866 });
    const receipt = await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(customer.header);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      saleId: s.id,
      status: 'paid',
      subtotalMinor: 800,
      totalMinor: 866,
      charges: [{ code: 'CITY', label: 'City sales tax', kind: 'tax', amountMinor: 66 }],
      tenders: [{ kind: 'cash', amountMinor: 866 }],
    });
    const stranger = await adult(t);
    const hidden = await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(stranger.header);
    expect(hidden.status).toBe(404);
    expect((await t.http.get(`/v1/pos-sales/${s.id}`).set(customer.header)).status).toBe(403);
    const mine = await t.http.get('/v1/me/pos-receipts').set(customer.header);
    expect(mine.status).toBe(200);
    expect((mine.body.items as Array<{ saleId: string }>).map((r) => r.saleId)).toContain(s.id);
    expect((await t.http.get('/v1/me/pos-receipts').set(stranger.header)).body.items).toEqual([]);
  });

  it('DEC-016: once disabled, new sales stop but voids, returns and closing continue', async () => {
    const plain = await product(1_000);
    const { sessionId } = await openSession();
    const paidSale = await sale(sessionId);
    await line(paidSale.id, plain, 1);
    const paid = await post(t, `/v1/pos-sales/${paidSale.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_000,
    });
    const openSale = await sale(sessionId);
    await t.disableCapability('point_of_sale');
    try {
      expect(
        (await post(t, '/v1/pos-sales', desk.header, { registerSessionId: sessionId })).status,
      ).toBe(403);
      expect((await line(openSale.id, plain, 1)).status).toBe(403);
      const voided = await post(t, `/v1/pos-sales/${openSale.id}/void`, desk.header, {
        reason: 'Closing',
      });
      expect(voided.body.status).toBe('voided');
      const returned = await post(t, `/v1/pos-sales/${paidSale.id}/returns`, finance.header, {
        lines: [{ saleLineId: paid.body.lines[0].id as string, quantity: 1 }],
        tenderKind: 'cash',
        reason: 'Return while disabled',
      });
      expect(returned.status).toBe(201);
      const session = await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header);
      const closed = await post(t, `/v1/pos-register-sessions/${sessionId}/close`, desk.header, {
        countedCashMinor: session.body.expectedCashMinor as number,
        expectedRevision: session.body.revision,
      });
      expect(closed.body.varianceMinor).toBe(0);
    } finally {
      await t.enableCapability('point_of_sale');
    }
  });

  it('DEC-016 (CAPABILITIES-01): a sale partly paid by card is completed, returned and its register closed after the switch is turned off', async () => {
    const plain = await product(2_500);
    const { registerId, sessionId } = await openSession();
    const s = await sale(sessionId, customer.personId);
    const added = await line(s.id, plain, 2);
    const card = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'card',
      amountMinor: 2_500,
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(card.body).toMatchObject({ status: 'open', remainingMinor: 2_500 });
    await t.disableCapability('point_of_sale');
    try {
      // Settling the existing sale is not a new commitment: the remaining cash is taken.
      const cash = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
        kind: 'cash',
        amountMinor: 2_500,
      });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      expect(cash.body.status).toBe('paid');
      // Nothing new is sold: another line and a new sale stay refused.
      const more = await line(s.id, plain, 1);
      expect(more.status).toBe(403);
      expect(more.body.details).toMatchObject({ code: 'CAPABILITY_DISABLED' });
      expect(
        (await post(t, '/v1/pos-sales', desk.header, { registerSessionId: sessionId })).status,
      ).toBe(403);
      // The sale is unwound: one unit back to the card, one from the drawer.
      const lineId = added.body.lines[0].id as string;
      for (const tenderKind of ['card', 'cash']) {
        const back = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
          lines: [{ saleLineId: lineId, quantity: 1 }],
          tenderKind,
          reason: 'Unwinding after the switch was turned off',
        });
        expect(back.status, JSON.stringify(back.body)).toBe(201);
      }
      const session = await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header);
      expect(session.body.expectedCashMinor).toBe(10_000);
      const closed = await post(t, `/v1/pos-register-sessions/${sessionId}/close`, desk.header, {
        countedCashMinor: session.body.expectedCashMinor as number,
        expectedRevision: session.body.revision,
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(201);
      expect(closed.body).toMatchObject({ status: 'closed', varianceMinor: 0 });
      const retired = await post(t, `/v1/pos-registers/${registerId}/retire`, manager.header, {
        reason: 'Point of sale turned off',
      });
      expect(retired.status, JSON.stringify(retired.body)).toBe(201);
      expect(retired.body.status).toBe('retired');
    } finally {
      await t.enableCapability('point_of_sale');
    }
  });

  it('§4.9 (COMMANDS-04): a void or return decided on a stale view of the sale is refused and changes nothing', async () => {
    const plain = await product(4_000);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    const added = await line(s.id, plain, 1);
    const seenByA = added.body.revision as number;
    // Operator B takes 20.00 cash on the same sale; the drawer now holds it.
    const tendered = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_000,
    });
    expect(tendered.status).toBe(201);
    expect(tendered.body.revision).toBeGreaterThan(seenByA);
    const before = await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header);
    const stale = await post(t, `/v1/pos-sales/${s.id}/void`, desk.header, {
      reason: 'Customer left',
      expectedRevision: seenByA,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const after = await t.http.get(`/v1/pos-sales/${s.id}`).set(desk.header);
    expect(after.body).toMatchObject({ status: 'open', settledMinor: 2_000 });
    const drawer = await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header);
    expect(drawer.body.expectedCashMinor).toBe(before.body.expectedCashMinor);
    // A stale line or tender is refused the same way.
    const staleLine = await post(t, `/v1/pos-sales/${s.id}/lines`, desk.header, {
      productId: plain,
      quantity: 1,
      expectedRevision: seenByA,
    });
    expect(staleLine.body.code).toBe('STALE_REVISION');
    const staleTender = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_000,
      expectedRevision: seenByA,
    });
    expect(staleTender.body.code).toBe('STALE_REVISION');
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_000,
      expectedRevision: after.body.revision,
    });
    expect(paid.body.status).toBe('paid');
    const staleReturn = await post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, {
      lines: [{ saleLineId: added.body.lines[0].id as string, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Changed mind',
      expectedRevision: after.body.revision,
    });
    expect(staleReturn.status).toBe(409);
    expect(staleReturn.body.code).toBe('STALE_REVISION');
    expect(
      await t.db.selectFrom('pos_returns').select('id').where('sale_id', '=', s.id).execute(),
    ).toHaveLength(0);
  });

  it('§4.7 invariants 5 and 6: the database refuses over-tendering, lines on a paid sale, edits and over-returns', async () => {
    const plain = await product(2_000);
    const { registerId, sessionId } = await openSession();
    const s = await sale(sessionId);
    await line(s.id, plain, 1);
    const tender = (kind: string, amount: number) =>
      t.db
        .insertInto('pos_tenders')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          sale_id: s.id,
          currency: 'USD',
          kind: kind as 'cash',
          amount_minor: amount,
          payment_attempt_id: null,
          evidence: null,
          status: 'settled',
          failure_reason: null,
          recorded_by: json({}),
          recorded_by_person_id: desk.personId,
          recorded_at: new Date(),
          settled_at: new Date(),
          failed_at: null,
        })
        .execute();
    expect(await refusedBy(tender('cash', 2_001))).toBe('23514:pos_tenders_within_total');
    expect(await refusedBy(tender('card', 2_000))).toBe('23514:pos_tenders_card_attempt');
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 2_000,
    });
    expect(paid.body.status).toBe('paid');
    const lineRow = await t.db
      .selectFrom('pos_sale_lines')
      .selectAll()
      .where('sale_id', '=', s.id)
      .executeTakeFirstOrThrow();
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_sale_lines')
          .values({
            ...lineRow,
            id: newId(),
            line_number: 2,
            charges: json([]),
            created_at: new Date(),
          })
          .execute(),
      ),
    ).toBe('23514:pos_sale_lines_open_sale');
    expect(
      await refusedBy(
        t.db
          .updateTable('pos_sale_lines')
          .set({ quantity: 5 })
          .where('id', '=', lineRow.id)
          .execute(),
      ),
    ).toMatch(/^23001/);
    expect(
      await refusedBy(
        t.db
          .updateTable('pos_sales')
          .set({ total_minor: 1, subtotal_minor: 1 })
          .where('id', '=', s.id)
          .execute(),
      ),
    ).toBe('23514:pos_sales_amounts_final');
    const ret = (amount: number, quantity: number) =>
      t.db
        .insertInto('pos_returns')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          sale_id: s.id,
          currency: 'USD',
          lines: json([
            {
              saleLineId: lineRow.id,
              quantity,
              amountMinor: amount,
              baseMinor: amount,
              charges: [],
            },
          ]),
          amount_minor: amount,
          tender_kind: 'cash',
          refund_attempt_id: null,
          register_session_id: sessionId,
          evidence: null,
          reason: 'direct',
          approved_by: json({}),
          approved_by_person_id: finance.personId,
          returned_at: new Date(),
        })
        .execute();
    expect(await refusedBy(ret(2_001, 1))).toBe('23514:pos_returns_within_paid');
    expect(await refusedBy(ret(1_000, 2))).toBe('23514:pos_returns_within_quantity');
    // One open session per register.
    const second = await post(t, `/v1/pos-registers/${registerId}/sessions`, desk.header, {
      currency: 'USD',
      openingFloatMinor: 0,
    });
    expect(second.status).toBe(409);
    expect(
      await refusedBy(
        t.db
          .insertInto('pos_register_sessions')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            register_id: registerId,
            facility_id: t.facilityId,
            currency: 'USD',
            business_date: '20261102',
            opening_float_minor: 0,
            opened_by: json({}),
            opened_by_person_id: desk.personId,
            opened_at: new Date(),
            counted_cash_minor: null,
            expected_cash_minor: null,
            variance_minor: null,
            closed_by: null,
            closed_by_person_id: null,
            closed_at: null,
          })
          .execute(),
      ),
    ).toBe('23505:pos_register_sessions_one_open_idx');
    // A point-of-sale payment attempt always names its sale and nothing else.
    expect(
      await refusedBy(
        t.db
          .insertInto('payment_attempts')
          .values({
            id: newId(),
            organization_id: t.organizationId,
            purpose: 'pos_sale',
            payer_person_id: customer.personId,
            amount_minor: 100,
            currency: 'USD',
            provider: 'fake-payments',
            payment_method_ref: 'pm_fake_visa',
            requested_by: json({}),
          })
          .execute(),
      ),
    ).toBe('23514:payment_attempts_purpose_target');
  });

  it('SPK-UX-005, §4.14: the front desk reads sales and receipts by operating the register; a desk at another facility cannot', async () => {
    const plain = await product(1_200);
    const { sessionId } = await openSession();
    const s = await sale(sessionId, customer.personId);
    await line(s.id, plain, 1);
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_200,
    });
    expect(paid.body.status).toBe('paid');
    // The desk holds no finance read: reading is part of operating the register at the facility.
    const permissions = await t.http.get('/v1/me/permissions').set(desk.header);
    const ids = (permissions.body.actions as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain('finance.operate_register');
    expect(ids).not.toContain('finance.read_pos');
    expect(ids).not.toContain('finance.read_pos_receipt');
    expect((await t.http.get(`/v1/pos-sales/${s.id}`).set(desk.header)).status).toBe(200);
    expect((await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(desk.header)).status).toBe(200);
    expect(
      (await t.http.get(`/v1/pos-register-sessions/${sessionId}`).set(desk.header)).status,
    ).toBe(200);
    expect((await t.http.get('/v1/pos-products').set(desk.header)).status).toBe(200);

    const elsewhere = await createStaffMemberFixture(t, {
      roles: ['front_desk'],
      facilityIds: [newId()],
    });
    const away = await authHeaderForPerson(t, elsewhere.personId);
    expect((await t.http.get(`/v1/pos-sales/${s.id}`).set(away)).status).toBe(403);
    expect((await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(away)).status).toBe(404);
    // The customer the sale names reads their receipt; another customer learns nothing.
    expect((await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(customer.header)).status).toBe(
      200,
    );
    const stranger = await adult(t);
    expect((await t.http.get(`/v1/pos-sales/${s.id}/receipt`).set(stranger.header)).status).toBe(
      404,
    );
  });

  it('§4.3, §4.14 (AUTHZ-PRIVACY-05): register and product lists without a facility are narrowed to the facilities the caller reads', async () => {
    const annex = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: annex,
        organization_id: t.organizationId,
        slug: `annex-${annex.slice(0, 8)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    codeCounter += 1;
    const home = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: `HM${codeCounter}`,
      name: 'Home desk',
    });
    const away = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: annex,
      code: `AX${codeCounter}`,
      name: 'Annex desk',
    });
    expect([home.status, away.status]).toEqual([201, 201]);
    const annexProduct = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Annex towel',
      kind: 'merchandise',
      priceMinor: 900,
      currency: 'USD',
      chargePolicyKeys: [],
      facilityId: annex,
    });
    expect(annexProduct.status, JSON.stringify(annexProduct.body)).toBe(201);
    const everywhere = await product(700);

    async function listed(header: { Authorization: string }, path: string) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await t.http
          .get(path)
          .query({ limit: 100, ...(cursor ? { cursor } : {}) })
          .set(header);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        ids.push(...(res.body.items as Array<{ id: string }>).map((i) => i.id));
        cursor = res.body.nextCursor as string | null;
      } while (cursor);
      return ids;
    }

    const scopedDesk = await createStaffMemberFixture(t, {
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    const scopedFinance = await createStaffMemberFixture(t, {
      roles: ['finance_operator'],
      facilityIds: [t.facilityId],
    });
    for (const member of [scopedDesk, scopedFinance]) {
      const header = await authHeaderForPerson(t, member.personId);
      const registers = await listed(header, '/v1/pos-registers');
      expect(registers).toContain(home.body.id);
      expect(registers).not.toContain(away.body.id);
      const products = await listed(header, '/v1/pos-products');
      expect(products).toContain(everywhere);
      expect(products).not.toContain(annexProduct.body.id);
    }
    // An organization-wide reader still lists every facility.
    const all = await listed(manager.header, '/v1/pos-registers');
    expect(all).toEqual(expect.arrayContaining([home.body.id, away.body.id]));
    expect(await listed(manager.header, '/v1/pos-products')).toContain(annexProduct.body.id);
  });

  it('§4.7 invariant 6: two concurrent returns of the whole sale — exactly one is recorded', async () => {
    const plain = await product(1_500);
    const { sessionId } = await openSession();
    const s = await sale(sessionId);
    await line(s.id, plain, 1);
    const paid = await post(t, `/v1/pos-sales/${s.id}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_500,
    });
    const body = {
      lines: [{ saleLineId: paid.body.lines[0].id as string, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Duplicate request',
    };
    const results = await Promise.all([
      post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, body),
      post(t, `/v1/pos-sales/${s.id}/returns`, finance.header, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const returns = await t.db
      .selectFrom('pos_returns')
      .select('id')
      .where('sale_id', '=', s.id)
      .execute();
    expect(returns).toHaveLength(1);
  });
});
