import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { localYearStart } from '../services/finance-desk.service';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { createCreditFixture, createObligationFixture } from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  child,
  CLOCK_START,
  drain,
  financeTestApp,
  key,
  offering,
  post,
  quoteFor,
  rejectsWith,
  staff,
  type Actor,
} from './support';

const DAY = 86_400_000;

/**
 * Finance desk (park UI redesign): payment reminders for past-due obligations (SPK-COMMS-002
 * payment attention, SPK-PAY-004), the protected person money summary (SPK-PAY-004/009/011,
 * §4.10) and basket prices are covered here and in point-of-sale.spec.ts for the POS gaps.
 */
describe('finance desk: payment reminders and the person money summary', () => {
  let t: TestApp;
  let finance: Actor;
  let desk: Actor;
  let coach: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    finance = await staff(t, ['finance_operator']);
    desk = await staff(t, ['front_desk']);
    coach = await staff(t, ['coach']);
  });
  afterAll(async () => {
    await t.close();
  });

  const now = () => t.clock.now().getTime();

  it('SPK-COMMS-002: finance reminds the debtor of a past-due obligation once; the essential notice states the balance', async () => {
    const parent = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 12_500,
      dueAt: new Date(now() - 3 * DAY),
      description: 'Autumn league fee',
    });
    const reminded = await post(t, `/v1/obligations/${obligationId}/reminders`, finance.header, {
      reason: 'Past due three days',
    });
    expect(reminded.status).toBe(201);
    expect(reminded.body).toMatchObject({
      obligationId,
      recipientPersonId: parent.personId,
      remainingMinor: 12_500,
      currency: 'USD',
      reason: 'Past due three days',
      requestedByPersonId: finance.personId,
    });
    await drain(t);
    const notices = await t.db
      .selectFrom('notifications')
      .select(['kind', 'category', 'title', 'body', 'protected'])
      .where('subject_type', '=', 'obligation')
      .where('subject_id', '=', obligationId)
      .execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: 'payment_attention',
      category: 'operational',
      title: 'A payment is past due',
      protected: true,
    });
    expect(notices[0]!.body).toContain('$125.00 toward Autumn league fee');
    const inbox = await t.http.get('/v1/me/inbox').set(parent.header);
    expect(inbox.body.items.map((i: { title: string }) => i.title)).toContain(
      'A payment is past due',
    );
    // The staff view of the obligation says when it was last reminded.
    const view = await t.http.get(`/v1/obligations/${obligationId}`).set(finance.header);
    expect(view.body.lastReminderAt).toBe(reminded.body.requestedAt);
    // Pressed again the same day: refused, nothing more is sent (engineering placeholder interval).
    const again = await post(t, `/v1/obligations/${obligationId}/reminders`, finance.header, {});
    expect(again.status).toBe(409);
    expect(again.body.details.code).toBe('REMINDED_RECENTLY');
    t.clock.advance(25 * 3_600_000);
    const later = await post(t, `/v1/obligations/${obligationId}/reminders`, finance.header, {});
    expect(later.status).toBe(201);
  });

  it('SPK-COMMS-002: an obligation not yet due, or with nothing left, is not reminded; desk staff and customers may not remind', async () => {
    const parent = await adult(t);
    const notDue = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 5_000,
      dueAt: new Date(now() + 2 * DAY),
    });
    const early = await post(t, `/v1/obligations/${notDue}/reminders`, finance.header, {});
    expect(early.status).toBe(409);
    expect(early.body.details.code).toBe('OBLIGATION_NOT_PAST_DUE');
    const pastDue = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 5_000,
      dueAt: new Date(now() - DAY),
    });
    const byDesk = await post(t, `/v1/obligations/${pastDue}/reminders`, desk.header, {});
    expect(byDesk.status).toBe(403);
    // §4.10: the customer learns nothing about whether the obligation exists.
    const byCustomer = await post(t, `/v1/obligations/${pastDue}/reminders`, parent.header, {});
    expect(byCustomer.status).toBe(404);
    const unknown = await post(t, `/v1/obligations/${newId()}/reminders`, finance.header, {});
    expect(unknown.status).toBe(404);
    // Paid in full: nothing is outstanding.
    const paid = await post(t, `/v1/obligations/${pastDue}/payments`, parent.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status).toBe(201);
    const settled = await post(t, `/v1/obligations/${pastDue}/reminders`, finance.header, {});
    expect(settled.status).toBe(409);
  });

  it('SPK-COMMS-002 invariant: the database refuses a reminder before the due date or for no balance, and never edits one', async () => {
    const parent = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 5_000,
      dueAt: new Date(now() - DAY),
    });
    const row = (over: Record<string, unknown>) => ({
      id: newId(),
      organization_id: t.organizationId,
      obligation_id: obligationId,
      currency: 'USD',
      remaining_minor: 5_000,
      due_at: new Date(now() - DAY),
      recipient_person_id: parent.personId,
      reason: null,
      requested_by: json({ kind: 'system' }),
      requested_by_person_id: null,
      requested_at: new Date(now()),
      ...over,
    });
    expect(
      await rejectsWith(
        t.db
          .insertInto('payment_reminders')
          .values(row({ requested_at: new Date(now() - 2 * DAY) }))
          .execute(),
      ),
    ).toBe('23514');
    expect(
      await rejectsWith(
        t.db
          .insertInto('payment_reminders')
          .values(row({ remaining_minor: 0 }))
          .execute(),
      ),
    ).toBe('23514');
    // Another currency than the obligation's is refused by the composite reference.
    expect(
      await rejectsWith(
        t.db
          .insertInto('payment_reminders')
          .values(row({ currency: 'EUR' }))
          .execute(),
      ),
    ).toBe('23503');
    const ok = row({});
    await t.db.insertInto('payment_reminders').values(ok).execute();
    expect(
      await rejectsWith(
        t.db
          .updateTable('payment_reminders')
          .set({ remaining_minor: 1 })
          .where('id', '=', ok.id)
          .execute(),
      ),
    ).toBe('23001');
  });

  it('SPK-PAY-004/009/011: the person money summary states the balance, credits and paid this year per currency; protected (§4.10)', async () => {
    const parent = await adult(t);
    const kid = await child(t, [parent]);
    await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 20_000,
      dueAt: new Date(now() - DAY),
    });
    await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 3_000,
      dueAt: new Date(now() + 10 * DAY),
    });
    await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 900,
      currency: 'CAD',
      dueAt: new Date(now() + 10 * DAY),
    });
    const toPay = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 4_500,
      dueAt: new Date(now() + DAY),
    });
    await createCreditFixture(t, { ownerPersonId: parent.personId, amountMinor: 1_500 });
    await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 700,
      status: 'pending_approval',
    });
    await createCreditFixture(t, {
      ownerPersonId: parent.personId,
      amountMinor: 999,
      expiresAt: new Date(now() - DAY),
    });
    const paid = await post(t, `/v1/obligations/${toPay}/payments`, parent.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status).toBe(201);
    await drain(t);

    const summary = await t.http
      .get(`/v1/people/${parent.personId}/money-summary`)
      .set(desk.header);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      personId: parent.personId,
      accountBalance: [
        { currency: 'CAD', amountMinor: 900 },
        { currency: 'USD', amountMinor: 23_000 },
      ],
      openObligations: 3,
      pastDueObligations: 1,
      creditsAvailable: [{ currency: 'USD', amountMinor: 1_500 }],
      creditsPendingApproval: [{ currency: 'USD', amountMinor: 700 }],
      paidThisYear: [{ currency: 'USD', amountMinor: 4_500 }],
      refundedThisYear: [],
    });
    expect(new Date(summary.body.paidSince).getTime()).toBeLessThanOrEqual(
      new Date(CLOCK_START).getTime(),
    );
    // The person reads their own; a guardian reads the child's (pay authority).
    const own = await t.http.get(`/v1/people/${parent.personId}/money-summary`).set(parent.header);
    expect(own.status).toBe(200);
    const childs = await t.http.get(`/v1/people/${kid}/money-summary`).set(parent.header);
    expect(childs.status).toBe(200);
    expect(childs.body.accountBalance).toEqual([]);
    // §4.10: another household and a coach learn nothing, not even that the person exists.
    const stranger = await adult(t);
    const other = await t.http
      .get(`/v1/people/${parent.personId}/money-summary`)
      .set(stranger.header);
    expect(other.status).toBe(404);
    const byCoach = await t.http
      .get(`/v1/people/${parent.personId}/money-summary`)
      .set(coach.header);
    expect(byCoach.status).toBe(404);
    const missing = await t.http.get(`/v1/people/${newId()}/money-summary`).set(desk.header);
    expect(missing.status).toBe(404);
  });

  it('localYearStart: local midnight of 1 January in the zone', () => {
    expect(
      localYearStart(new Date('2026-11-06T12:00:00Z'), 'America/Los_Angeles').toISOString(),
    ).toBe('2026-01-01T08:00:00.000Z');
    expect(
      localYearStart(new Date('2027-01-01T05:00:00Z'), 'America/Los_Angeles').toISOString(),
    ).toBe('2026-01-01T08:00:00.000Z');
    expect(localYearStart(new Date('2026-06-01T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('SPK-PAY-001/002: a basket price is an estimate from the price rule in effect until checked out, then the order', async () => {
    const parent = await adult(t);
    const setup = await offering(t, { basePriceMinor: 15_000 });
    const { basketId } = await basketFor(t, parent, [setup]);
    const estimate = await t.http.get(`/v1/basket-prices/${basketId}`).set(desk.header);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      basketId,
      basis: 'estimate',
      currency: 'USD',
      subtotalMinor: 15_000,
      totalMinor: 15_000,
      orderId: null,
    });
    const quote = await quoteFor(t, parent, basketId);
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    await drain(t);
    const ordered = await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header);
    expect(ordered.body).toMatchObject({
      basis: 'order',
      totalMinor: quote.totalMinor,
      paymentStatus: 'paid',
    });
    // §4.10: another household learns nothing about the basket.
    const stranger = await adult(t);
    const hidden = await t.http.get(`/v1/basket-prices/${basketId}`).set(stranger.header);
    expect(hidden.status).toBe(404);
  });

  it('idempotency: a repeated reminder request with the same key answers the same reminder', async () => {
    const parent = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: parent.personId,
      amountMinor: 2_000,
      dueAt: new Date(now() - DAY),
    });
    const k = key();
    const first = await post(t, `/v1/obligations/${obligationId}/reminders`, finance.header, {}, k);
    const second = await post(
      t,
      `/v1/obligations/${obligationId}/reminders`,
      finance.header,
      {},
      k,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });
});
