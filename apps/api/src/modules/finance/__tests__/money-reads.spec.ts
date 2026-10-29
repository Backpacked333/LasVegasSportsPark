import { errors } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INTEGRATION_REGISTRY, type IntegrationRegistryPort } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { ENROLLMENT_PORT, EnrollmentsService, type EnrollmentPort } from '../../enrollment';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { CashTendersService } from '../services/cash-tenders.service';
import {
  createCapturedPaymentFixture,
  createCreditFixture,
  createObligationFixture,
} from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  child,
  financeTestApp,
  offering,
  post,
  provider,
  quoteFor,
  staff,
  worker,
  type Actor,
} from './support';

/** The next N confirmations are refused by enrollment (a definitive domain refusal). */
const refuse = { next: 0 };
function refusingEnrollmentPort(real: EnrollmentsService): EnrollmentPort {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'confirmEnrollment') {
        return async (...args: Parameters<EnrollmentPort['confirmEnrollment']>) => {
          if (refuse.next > 0) {
            refuse.next -= 1;
            throw errors.resourceConflict('Enrollment refused the confirmation (simulated).');
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

describe('money read models (FIN-01, FIN-02; SPK-PAY-004/005/007/008, §4.5)', () => {
  let t: TestApp;
  let parent: Actor;
  let otherParent: Actor;
  let finance: Actor;
  let desk: Actor;

  beforeAll(async () => {
    t = await financeTestApp({
      configure: (builder) =>
        builder
          .overrideProvider(ENROLLMENT_PORT)
          .useFactory({ factory: refusingEnrollmentPort, inject: [EnrollmentsService] }),
    });
    parent = await adult(t);
    otherParent = await adult(t);
    finance = await staff(t, ['finance_operator']);
    desk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  async function checkout(actor: Actor, token: string, price = 8_000) {
    const setup = await offering(t, { basePriceMinor: price });
    const { basketId } = await basketFor(t, actor, [setup]);
    const quote = await quoteFor(t, actor, basketId);
    const res = await post(t, '/v1/registration-checkouts', actor.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: token },
    });
    expect(res.status).toBe(201);
    return res.body as Record<string, unknown> & { id: string; orderId: string; status: string };
  }

  it('SPK-PAY-007: a payer lists their checkouts and finds one in recovery_required', async () => {
    refuse.next = 1;
    const stuck = await checkout(parent, FakePaymentTokens.succeed, 7_000);
    expect(stuck.status).toBe('recovery_required');
    const done = await checkout(parent, FakePaymentTokens.succeed, 5_000);
    expect(done.status).toBe('completed');

    const mine = await t.http.get('/v1/me/registration-checkouts').set(parent.header);
    expect(mine.status).toBe(200);
    const ids = (mine.body.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([done.id, stuck.id]); // newest first
    const recovery = await t.http
      .get('/v1/me/registration-checkouts?status=recovery_required')
      .set(parent.header);
    expect(recovery.body.items).toHaveLength(1);
    expect(recovery.body.items[0]).toMatchObject({
      id: stuck.id,
      status: 'recovery_required',
      nextAction: 'await_staff_recovery',
    });
    // Another household sees none of them.
    const other = await t.http.get('/v1/me/registration-checkouts').set(otherParent.header);
    expect(other.body).toEqual({ items: [], nextCursor: null });

    // The same payer's orders, payments and receipts, newest first.
    const orders = await t.http.get('/v1/me/orders').set(parent.header);
    expect((orders.body.items as Array<{ id: string }>).map((o) => o.id)).toEqual([
      done.orderId,
      stuck.orderId,
    ]);
    expect(orders.body.items[1]).toMatchObject({
      paymentStatus: 'paid',
      fulfillmentStatus: 'recovery_required',
    });
    const payments = await t.http.get('/v1/me/payments?status=succeeded').set(parent.header);
    expect(payments.body.items).toHaveLength(2);
    expect(payments.body.items[0]).toMatchObject({ purpose: 'checkout', posSaleId: null });
    const receipts = await t.http.get('/v1/me/receipts?limit=1').set(parent.header);
    expect(receipts.body.items).toHaveLength(1);
    expect(receipts.body.nextCursor).not.toBeNull();
    const next = await t.http
      .get(`/v1/me/receipts?limit=1&cursor=${receipts.body.nextCursor as string}`)
      .set(parent.header);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].id).not.toBe(receipts.body.items[0].id);
    expect(next.body.nextCursor).toBeNull();
  });

  it('SPK-PAY-007: an obligation read shows the unknown attempt so the payer is told not to pay again', async () => {
    const debtor = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor: 6_000,
    });
    const paid = await post(t, `/v1/obligations/${obligationId}/payments`, debtor.header, {
      paymentMethodToken: FakePaymentTokens.timeout,
    });
    expect(paid.status).toBe(201);
    expect(paid.body.payment.status).toBe('unknown');
    const attemptId = paid.body.payment.id as string;

    const read = await t.http.get(`/v1/obligations/${obligationId}`).set(debtor.header);
    expect(read.status).toBe(200);
    expect(read.body.liveAttempt).toMatchObject({
      id: attemptId,
      status: 'unknown',
      amountMinor: 6_000,
      currency: 'USD',
    });
    expect(read.body.liveAttempt.unknownSince).not.toBeNull();

    // A second payment is refused and the payer is told which attempt is in the way.
    const again = await post(t, `/v1/obligations/${obligationId}/payments`, debtor.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PAYMENT_OUTCOME_UNKNOWN');
    expect(again.body.nextAction).toBe('await_reconciliation');
    expect(again.body.details).toMatchObject({ attemptId, purpose: 'obligation' });

    // Reconciliation resolves it; the obligation then shows no live attempt.
    t.clock.advance(20 * 60_000);
    await worker(t).runOnce();
    const after = await t.http.get(`/v1/obligations/${obligationId}`).set(debtor.header);
    expect(after.body.liveAttempt).toBeNull();
    expect(after.body.status).toBe('settled');
  });

  it('PAYMENT_OUTCOME_UNKNOWN names the attempt only to its payer and staff', async () => {
    const captain = await adult(t);
    const competitionId = await createCompetitionFixture(t);
    const { seasonId } = await createSeasonFixture(t, { competitionId });
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain.personId });
    const player = await adult(t);
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    const obligationId = await createObligationFixture(t, {
      debtorTeamEntryId: entry.teamEntryId,
      amountMinor: 20_000,
    });
    const requested = await post(
      t,
      `/v1/obligations/${obligationId}/contribution-requests`,
      captain.header,
      { requestedPersonId: player.personId, amountMinor: 10_000 },
    );
    expect(requested.status).toBe(201);
    const pay = await post(t, `/v1/contribution-requests/${requested.body.id}/pay`, player.header, {
      paymentMethodToken: FakePaymentTokens.timeout,
    });
    expect(pay.body.payment.status).toBe('unknown');
    // The player sees their own unknown payment on the team obligation; the captain does not.
    const asPlayer = await t.http
      .get(`/v1/contribution-requests/${requested.body.id}`)
      .set(player.header);
    expect(asPlayer.status).toBe(200);
    const asCaptain = await t.http.get(`/v1/obligations/${obligationId}`).set(captain.header);
    expect(asCaptain.body.liveAttempt).toBeNull();
    const asStaff = await t.http.get(`/v1/obligations/${obligationId}`).set(finance.header);
    expect(asStaff.body.liveAttempt).toMatchObject({ id: pay.body.payment.id, status: 'unknown' });
  });

  it('SPK-PAY-004: a player lists the contribution requests addressed to them', async () => {
    const captain = await adult(t);
    const competitionId = await createCompetitionFixture(t);
    const { seasonId } = await createSeasonFixture(t, { competitionId });
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain.personId });
    const player = await adult(t);
    const bystander = await adult(t);
    await addRosterMemberFixture(t, { teamEntryId: entry.teamEntryId, personId: player.personId });
    await addRosterMemberFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: bystander.personId,
    });
    const obligationId = await createObligationFixture(t, {
      debtorTeamEntryId: entry.teamEntryId,
      amountMinor: 30_000,
      description: 'Spring team fee',
    });
    const requested = await post(
      t,
      `/v1/obligations/${obligationId}/contribution-requests`,
      captain.header,
      { requestedPersonId: player.personId, amountMinor: 15_000 },
    );
    expect(requested.status).toBe(201);
    const mine = await t.http.get('/v1/me/contribution-requests').set(player.header);
    expect(mine.status).toBe(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      id: requested.body.id,
      amountMinor: 15_000,
      status: 'requested',
      obligation: { description: 'Spring team fee' },
    });
    expect(
      (await t.http.get('/v1/me/contribution-requests').set(bystander.header)).body.items,
    ).toEqual([]);
    const paidFilter = await t.http
      .get('/v1/me/contribution-requests?status=paid')
      .set(player.header);
    expect(paidFilter.body.items).toEqual([]);
  });

  it('SPK-PAY-008: a payment shows its refundable amount and earlier refunds', async () => {
    const payer = await adult(t);
    const { paymentAttemptId } = await createCapturedPaymentFixture(t, {
      payerPersonId: payer.personId,
      amountMinor: 10_000,
    });
    const before = await t.http.get(`/v1/payments/${paymentAttemptId}`).set(finance.header);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ refundableMinor: 10_000, refunds: [] });
    const refund = await post(t, `/v1/payments/${paymentAttemptId}/refunds`, finance.header, {
      amountMinor: 4_000,
      reason: 'Partial refund',
    });
    expect(refund.status).toBe(201);
    const after = await t.http.get(`/v1/payments/${paymentAttemptId}`).set(payer.header);
    expect(after.status).toBe(200);
    expect(after.body.refundableMinor).toBe(6_000);
    expect(after.body.refunds).toEqual([
      {
        id: refund.body.id,
        status: 'succeeded',
        amountMinor: 4_000,
        currency: 'USD',
        requestedAt: expect.any(String),
      },
    ]);
    // Staff list refunds of the payment and payments by state; customers are refused.
    const list = await t.http
      .get(`/v1/refunds?paymentAttemptId=${paymentAttemptId}`)
      .set(finance.header);
    expect(list.status).toBe(200);
    expect((list.body.items as Array<{ id: string }>).map((r) => r.id)).toEqual([refund.body.id]);
    expect((await t.http.get('/v1/refunds').set(payer.header)).status).toBe(403);
    const payments = await t.http
      .get(`/v1/payments?payerPersonId=${payer.personId}&status=succeeded`)
      .set(desk.header);
    expect(payments.status).toBe(200);
    expect((payments.body.items as Array<{ id: string }>).map((p) => p.id)).toEqual([
      paymentAttemptId,
    ]);
    const customer = await t.http.get('/v1/payments').set(payer.header);
    expect(customer.status).toBe(403);
    expect(customer.body.code).toBe('ACCESS_DENIED');
  });

  it('FIN-02: finance readers list orders by payer and status; customers use their own list', async () => {
    const payer = await adult(t);
    const first = await checkout(payer, FakePaymentTokens.succeed, 3_000);
    const second = await checkout(payer, FakePaymentTokens.decline, 4_000);
    const all = await t.http.get(`/v1/orders?payerPersonId=${payer.personId}`).set(finance.header);
    expect(all.status).toBe(200);
    expect((all.body.items as Array<{ id: string }>).map((o) => o.id)).toEqual([
      second.orderId,
      first.orderId,
    ]);
    const awaiting = await t.http
      .get(`/v1/orders?payerPersonId=${payer.personId}&paymentStatus=awaiting_payment`)
      .set(finance.header);
    expect((awaiting.body.items as Array<{ id: string }>).map((o) => o.id)).toEqual([
      second.orderId,
    ]);
    const window = await t.http
      .get(
        `/v1/orders?payerPersonId=${payer.personId}&from=${encodeURIComponent(t.clock.now().toISOString())}`,
      )
      .set(finance.header);
    expect(window.status).toBe(200);
    expect((await t.http.get('/v1/orders').set(payer.header)).status).toBe(403);
    const failed = await t.http
      .get(`/v1/payments?payerPersonId=${payer.personId}&status=failed&purpose=checkout`)
      .set(finance.header);
    expect(failed.body.items).toHaveLength(1);
  });

  it('GET /obligations pages with a stable cursor across inserts', async () => {
    const debtor = await adult(t);
    const day = 86_400_000;
    const base = t.clock.now().getTime();
    for (let i = 1; i <= 5; i += 1) {
      await createObligationFixture(t, {
        debtorPersonId: debtor.personId,
        amountMinor: 1_000 * i,
        dueAt: new Date(base + i * day),
      });
    }
    const first = await t.http
      .get(`/v1/obligations?debtorPersonId=${debtor.personId}&limit=2`)
      .set(finance.header);
    expect(first.status).toBe(200);
    expect(
      (first.body.items as Array<{ totals: { amountMinor: number } }>).map(
        (o) => o.totals.amountMinor,
      ),
    ).toEqual([1_000, 2_000]);
    expect(first.body.nextCursor).not.toBeNull();
    // An obligation due before the cursor appears meanwhile: later pages do not shift or repeat.
    await createObligationFixture(t, {
      debtorPersonId: debtor.personId,
      amountMinor: 999,
      dueAt: new Date(base),
    });
    const second = await t.http
      .get(
        `/v1/obligations?debtorPersonId=${debtor.personId}&limit=2&cursor=${first.body.nextCursor as string}`,
      )
      .set(finance.header);
    expect(
      (second.body.items as Array<{ totals: { amountMinor: number } }>).map(
        (o) => o.totals.amountMinor,
      ),
    ).toEqual([3_000, 4_000]);
    const third = await t.http
      .get(
        `/v1/obligations?debtorPersonId=${debtor.personId}&limit=2&cursor=${second.body.nextCursor as string}`,
      )
      .set(finance.header);
    expect(
      (third.body.items as Array<{ totals: { amountMinor: number } }>).map(
        (o) => o.totals.amountMinor,
      ),
    ).toEqual([5_000]);
    expect(third.body.nextCursor).toBeNull();
  });

  it('FIN-02: GET /credits honours the cursor', async () => {
    const owner = await adult(t);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await createCreditFixture(t, { ownerPersonId: owner.personId, amountMinor: 500 }));
    }
    const first = await t.http
      .get(`/v1/credits?ownerPersonId=${owner.personId}&limit=2`)
      .set(owner.header);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    const rest = await t.http
      .get(
        `/v1/credits?ownerPersonId=${owner.personId}&limit=2&cursor=${first.body.nextCursor as string}`,
      )
      .set(owner.header);
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
    const seen = [...first.body.items, ...rest.body.items].map((c: { id: string }) => c.id);
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it('FIN-02: cash tenders are listed for people without their evidence (SUP-03)', async () => {
    const payer = await adult(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: payer.personId,
      amountMinor: 3_000,
    });
    const tender = await post(t, '/v1/cash-tenders', desk.header, {
      obligationId,
      facilityId: t.facilityId,
      tenderKind: 'cash',
      amountMinor: 3_000,
      currency: 'USD',
      evidence: { reference: 'DRAWER-1 slip 7', notes: 'paid at the desk' },
    });
    expect(tender.status).toBe(201);
    const listed = await t.app
      .get(CashTendersService)
      .listForPersons(t.organizationId, [payer.personId], { limit: 10 });
    expect(listed.nextCursor).toBeNull();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: tender.body.id,
      amountMinor: 3_000,
      tenderKind: 'cash',
      status: 'recorded',
    });
    expect(JSON.stringify(listed.items)).not.toContain('DRAWER-1');
  });

  it('§5.1, §5.2: the fake payment and accounting adapters are in the integration register', async () => {
    const registered = t.app.get<IntegrationRegistryPort>(INTEGRATION_REGISTRY).list();
    expect(registered.find((r) => r.id === 'finance.payment_provider')).toEqual({
      id: 'finance.payment_provider',
      gate: 'payments',
      port: 'PAYMENT_PROVIDER_PORT',
      adapter: { name: provider(t).name, kind: 'fake' },
      productionAllowed: false,
      scenarios: ['success', 'failure', 'timeout_unknown', 'duplicate'],
      reconciliationOwner: 'finance_operator',
    });
    expect(registered.find((r) => r.id === 'finance.accounting_export')).toMatchObject({
      gate: 'accounting',
      adapter: { name: 'fake-accounting', kind: 'fake' },
      productionAllowed: false,
    });
  });

  it('SPK-IAM-003: a guardian lists the payments they made for a child; the child is never a payer', async () => {
    const guardian = await adult(t);
    const kid = await child(t, [guardian]);
    const setup = await offering(t, { basePriceMinor: 2_500 });
    const { basketId } = await basketFor(t, guardian, [setup], { participants: [kid] });
    const quote = await quoteFor(t, guardian, basketId);
    const res = await post(t, '/v1/registration-checkouts', guardian.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(res.status).toBe(201);
    const payments = await t.http.get('/v1/me/payments').set(guardian.header);
    expect(payments.body.items[0]).toMatchObject({ payerPersonId: guardian.personId });
  });
});
