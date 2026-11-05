import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions, UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { MERGED_PERSON_MONEY, PersonMergeMoneyFollowUp } from '../services/person-merge-follow-up';
import {
  createCapturedPaymentFixture,
  createCreditFixture,
  createObligationFixture,
} from '../testing/finance-fixtures';
import {
  adult,
  basketFor,
  child,
  drain,
  financeTestApp,
  offering,
  post,
  quoteFor,
  staff,
  type Actor,
} from './support';

type Json = Record<string, unknown>;

/**
 * SPK-IAM-007 (R2-LIFECYCLES-02): a merge of duplicate person records rewrites no financial row.
 * The merged record's credits and debts are the survivor's: listed, read, used and paid by the
 * people who hold authority over the survivor, and reported once to the finance operator.
 */
describe('finance after a person merge (SPK-IAM-007, SPK-PAY-004/009)', () => {
  let t: TestApp;
  let admin: Actor;
  let support: Actor;
  let finance: Actor;

  beforeAll(async () => {
    t = await financeTestApp();
    admin = await staff(t, ['system_administrator']);
    support = await staff(t, ['support_operator']);
    finance = await staff(t, ['finance_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  /** Support flags the pair, a system administrator merges `merged` into `survivor`. */
  async function merge(survivorPersonId: string, mergedPersonId: string): Promise<string> {
    const flagged = await post(t, '/v1/duplicate-candidates', support.header, {
      personAId: survivorPersonId,
      personBId: mergedPersonId,
      reasons: ['same name and date of birth'],
      score: 90,
    });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    const merged = await post(
      t,
      `/v1/duplicate-candidates/${flagged.body.id as string}/merge`,
      admin.header,
      { survivorPersonId, reason: 'Confirmed with the family at the desk' },
    );
    expect(merged.status, JSON.stringify(merged.body)).toBe(201);
    expect(merged.body.mergedPersonId).toBe(mergedPersonId);
    await drain(t);
    return merged.body.id as string;
  }

  const moneyExceptions = (survivorPersonId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'owner_queue', 'status', 'details'])
      .where('category', '=', MERGED_PERSON_MONEY)
      .where('affected_id', '=', survivorPersonId)
      .execute();

  const ids = (body: Json) => (body['items'] as Json[]).map((i) => i['id']);

  it("SPK-IAM-007 (R2-LIFECYCLES-02): the credit and the debt of the merged record are the survivor's to list, quote, redeem and pay; one exception goes to the finance operator", async () => {
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const creditId = await createCreditFixture(t, {
      ownerPersonId: duplicate.personId,
      amountMinor: 2_500,
    });
    const lockerId = await createObligationFixture(t, {
      debtorPersonId: duplicate.personId,
      amountMinor: 700,
      description: 'Locker rental',
    });
    const earlier = await createCapturedPaymentFixture(t, {
      payerPersonId: duplicate.personId,
      amountMinor: 1_200,
    });
    const mergeId = await merge(survivor.personId, duplicate.personId);

    // The merged record's payment, as its own payment list shows it, opens under the survivor.
    const payment = await t.http
      .get(`/v1/payments/${earlier.paymentAttemptId}`)
      .set(survivor.header);
    expect(payment.status, JSON.stringify(payment.body)).toBe(200);
    expect(payment.body).toMatchObject({ payerPersonId: duplicate.personId });
    // The finance operator's payment list by the survivor includes it too.
    const byPayer = await t.http
      .get(`/v1/payments?payerPersonId=${survivor.personId}`)
      .set(finance.header);
    expect(byPayer.status, JSON.stringify(byPayer.body)).toBe(200);
    expect(ids(byPayer.body)).toContain(earlier.paymentAttemptId);

    // The credit is listed and readable under the survivor; nothing was rewritten.
    const listed = await t.http
      .get(`/v1/credits?ownerPersonId=${survivor.personId}`)
      .set(survivor.header);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(ids(listed.body)).toEqual([creditId]);
    const read = await t.http.get(`/v1/credits/${creditId}`).set(survivor.header);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ownerPersonId: duplicate.personId, remainingMinor: 2_500 });

    // The survivor quotes and checks out with it: the credit is redeemed for the order.
    const setup = await offering(t, { basePriceMinor: 6_000 });
    const { basketId } = await basketFor(t, survivor, [setup]);
    const quote = await quoteFor(t, survivor, basketId, { creditIds: [creditId] });
    expect(quote).toMatchObject({
      creditsAppliedMinor: 2_500,
      dueNowMinor: 3_500,
      appliedCredits: [{ creditId, amountMinor: 2_500 }],
    });
    const checkout = await post(t, '/v1/registration-checkouts', survivor.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    const used = await t.http.get(`/v1/credits/${creditId}`).set(survivor.header);
    expect(used.body).toMatchObject({ remainingMinor: 0, status: 'exhausted' });

    // The merged record's debt: listed, read and paid by the survivor.
    const debts = await t.http
      .get(`/v1/obligations?debtorPersonId=${survivor.personId}`)
      .set(survivor.header);
    expect(debts.status, JSON.stringify(debts.body)).toBe(200);
    expect(ids(debts.body)).toContain(lockerId);
    expect((await t.http.get(`/v1/obligations/${lockerId}`).set(survivor.header)).status).toBe(200);
    const paid = await post(t, `/v1/obligations/${lockerId}/payments`, survivor.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.obligation).toMatchObject({ id: lockerId, status: 'settled' });
    const rows = await t.db
      .selectFrom('obligations')
      .select('debtor_person_id')
      .where('id', '=', lockerId)
      .executeTakeFirstOrThrow();
    expect(rows.debtor_person_id).toBe(duplicate.personId);

    // One exception names what the merged record held, and a replay raises nothing new.
    const raised = await moneyExceptions(survivor.personId);
    expect(raised).toEqual([
      expect.objectContaining({
        owner_queue: 'finance_operator',
        status: 'open',
        details: expect.objectContaining({
          mergeId,
          mergedPersonId: duplicate.personId,
          credits: [
            expect.objectContaining({
              creditId,
              ownerPersonId: duplicate.personId,
              remainingMinor: 2_500,
            }),
          ],
          obligations: [
            expect.objectContaining({
              obligationId: lockerId,
              debtorPersonId: duplicate.personId,
              outstandingMinor: 700,
            }),
          ],
        }),
      }),
    ]);
    const delivered = await t.db
      .selectFrom('outbox_events')
      .select(['id', 'organization_id', 'payload'])
      .where('event_type', '=', 'identity.persons_merged')
      .where('aggregate_id', '=', survivor.personId)
      .executeTakeFirstOrThrow();
    const replay = {
      id: delivered.id,
      type: 'identity.persons_merged',
      organizationId: delivered.organization_id,
      payload: delivered.payload,
    } as unknown as Parameters<PersonMergeMoneyFollowUp['onPersonsMerged']>[0];
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get(PersonMergeMoneyFollowUp)
          .onPersonsMerged(replay, { trx, attempt: 2, afterCommit: () => undefined }),
      );
    expect(await moneyExceptions(survivor.personId)).toHaveLength(1);
  });

  it('SPK-IAM-007 (R2-LIFECYCLES-02): a guardian pays the debt and uses the credit of a merged child record through the survivor', async () => {
    const guardian = await adult(t);
    const outsider = await adult(t);
    const kept = await child(t, [guardian]);
    const duplicateChild = await child(t, [guardian]);
    const creditId = await createCreditFixture(t, {
      ownerPersonId: duplicateChild,
      amountMinor: 400,
      permittedUses: ['obligation'],
    });
    const feeId = await createObligationFixture(t, {
      debtorPersonId: duplicateChild,
      amountMinor: 900,
      description: 'Uniform',
    });
    await merge(kept, duplicateChild);

    const credits = await t.http.get(`/v1/credits?ownerPersonId=${kept}`).set(guardian.header);
    expect(ids(credits.body)).toEqual([creditId]);
    const credit = await t.http.get(`/v1/credits/${creditId}`).set(guardian.header);
    expect(credit.status).toBe(200);
    const redeemed = await post(t, `/v1/credits/${creditId}/redeem`, guardian.header, {
      obligationId: feeId,
      amountMinor: 400,
      expectedRevision: credit.body.revision,
    });
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    const paid = await post(t, `/v1/obligations/${feeId}/payments`, guardian.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.obligation).toMatchObject({ id: feeId, status: 'settled' });
    expect(paid.body.payment).toMatchObject({ amountMinor: 500 });
    // Someone with no authority over the survivor still learns nothing (§4.10).
    expect((await t.http.get(`/v1/credits/${creditId}`).set(outsider.header)).status).toBe(404);
    expect((await t.http.get(`/v1/obligations/${feeId}`).set(outsider.header)).status).toBe(404);
  });

  it('SPK-IAM-007 (R2-LIFECYCLES-02): a merge of a record that holds no money raises nothing for finance', async () => {
    const survivor = await adult(t);
    const duplicate = await adult(t);
    await createCreditFixture(t, { ownerPersonId: survivor.personId, amountMinor: 1_000 });
    await merge(survivor.personId, duplicate.personId);
    expect(await moneyExceptions(survivor.personId)).toEqual([]);
    // The finance operator still reads the survivor's own credit as before.
    const listed = await t.http
      .get(`/v1/credits?ownerPersonId=${survivor.personId}`)
      .set(finance.header);
    expect((listed.body.items as Json[]).length).toBe(1);
  });

  it("SPK-IAM-007 (R2-LIFECYCLES-02): a team contribution asked of the merged record is the survivor's to read and pay", async () => {
    const leagueManager = await staff(t, ['league_manager']);
    const competitionId = await createCompetitionFixture(t);
    const { seasonId } = await createSeasonFixture(t, { competitionId });
    const captain = await adult(t);
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const outsider = await adult(t);
    const entry = await createTeamEntryFixture(t, { seasonId, captainPersonId: captain.personId });
    await addRosterMemberFixture(t, {
      teamEntryId: entry.teamEntryId,
      personId: duplicate.personId,
    });
    const obligation = await post(t, '/v1/obligations', leagueManager.header, {
      debtor: { kind: 'team_entry', teamEntryId: entry.teamEntryId },
      mode: 'team_with_contributions',
      amountMinor: 60_000,
      currency: 'USD',
      dueAt: '2026-12-01T00:00:00Z',
      description: 'Team fee, autumn season',
      source: { kind: 'team_fee', id: seasonId },
    });
    expect(obligation.status, JSON.stringify(obligation.body)).toBe(201);
    const requested = await post(
      t,
      `/v1/obligations/${obligation.body.id as string}/contribution-requests`,
      captain.header,
      { requestedPersonId: duplicate.personId, amountMinor: 20_000 },
    );
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const requestId = requested.body.id as string;
    await merge(survivor.personId, duplicate.personId);

    // Listed under the survivor, and now also readable and payable by them.
    const mine = await t.http.get('/v1/me/contribution-requests').set(survivor.header);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(ids(mine.body)).toEqual([requestId]);
    const read = await t.http.get(`/v1/contribution-requests/${requestId}`).set(survivor.header);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const paid = await post(t, `/v1/contribution-requests/${requestId}/pay`, survivor.header, {
      paymentMethodToken: FakePaymentTokens.succeed,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body).toMatchObject({
      payment: { status: 'succeeded', payerPersonId: survivor.personId, amountMinor: 20_000 },
    });
    const request = await t.db
      .selectFrom('contribution_requests')
      .select(['requested_person_id', 'status'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(request).toEqual({ requested_person_id: duplicate.personId, status: 'paid' });
    // Someone with no authority over the survivor still learns nothing (§4.10).
    expect(
      (await t.http.get(`/v1/contribution-requests/${requestId}`).set(outsider.header)).status,
    ).toBe(404);
  });

  it("SPK-IAM-007 (R2-LIFECYCLES-02): the point-of-sale receipt of the merged record is the survivor's to read", async () => {
    await t.enableCapability('point_of_sale');
    const manager = await staff(t, ['general_manager']);
    const desk = await staff(t, ['front_desk']);
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const outsider = await adult(t);
    const product = await post(t, '/v1/pos-products', manager.header, {
      sku: `SKU-${newId().slice(-8).toUpperCase()}`,
      name: 'Team water bottle',
      kind: 'merchandise',
      priceMinor: 1_200,
      currency: 'USD',
      chargePolicyKeys: [],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const register = await post(t, '/v1/pos-registers', manager.header, {
      facilityId: t.facilityId,
      code: 'MERGE1',
      name: 'Merge desk',
    });
    expect(register.status, JSON.stringify(register.body)).toBe(201);
    const session = await post(
      t,
      `/v1/pos-registers/${register.body.id as string}/sessions`,
      desk.header,
      { currency: 'USD', openingFloatMinor: 5_000 },
    );
    expect(session.status, JSON.stringify(session.body)).toBe(201);
    const sale = await post(t, '/v1/pos-sales', desk.header, {
      registerSessionId: session.body.id,
      customerPersonId: duplicate.personId,
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    const saleId = sale.body.id as string;
    const line = await post(t, `/v1/pos-sales/${saleId}/lines`, desk.header, {
      productId: product.body.id,
      quantity: 1,
    });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    const tendered = await post(t, `/v1/pos-sales/${saleId}/tenders`, desk.header, {
      kind: 'cash',
      amountMinor: 1_200,
    });
    expect(tendered.body.status).toBe('paid');
    await merge(survivor.personId, duplicate.personId);

    const mine = await t.http.get('/v1/me/pos-receipts').set(survivor.header);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect((mine.body.items as Json[]).map((r) => r['saleId'])).toEqual([saleId]);
    const receipt = await t.http.get(`/v1/pos-sales/${saleId}/receipt`).set(survivor.header);
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body).toMatchObject({ saleId, status: 'paid' });
    expect((await t.http.get(`/v1/pos-sales/${saleId}/receipt`).set(outsider.header)).status).toBe(
      404,
    );
  });

  it("SPK-IAM-007 (R2-LIFECYCLES-02): the finance operator's order list by payer includes the merged record's orders", async () => {
    const survivor = await adult(t);
    const duplicate = await adult(t);
    const setup = await offering(t, { basePriceMinor: 4_000 });
    const { basketId } = await basketFor(t, duplicate, [setup]);
    const quote = await quoteFor(t, duplicate, basketId);
    const checkout = await post(t, '/v1/registration-checkouts', duplicate.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    const orderId = checkout.body.orderId as string;
    expect(orderId).toBeTruthy();
    await merge(survivor.personId, duplicate.personId);

    const orders = await t.http
      .get(`/v1/orders?payerPersonId=${survivor.personId}`)
      .set(finance.header);
    expect(orders.status, JSON.stringify(orders.body)).toBe(200);
    expect(ids(orders.body)).toEqual([orderId]);
    const payments = await t.http
      .get(`/v1/payments?payerPersonId=${survivor.personId}`)
      .set(finance.header);
    expect(payments.status, JSON.stringify(payments.body)).toBe(200);
    expect((payments.body.items as Json[]).map((p) => p['orderId'])).toEqual([orderId]);
  });

  it('SPK-IAM-007 (R2-LIFECYCLES-02): on a chained merge the money of records merged earlier is named again for the new survivor, and money it already reviewed is not', async () => {
    const first = await adult(t); // A, merged into B
    const middle = await adult(t); // B, holds nothing of its own, later merged into C
    const last = await adult(t); // C
    const earlierDuplicate = await adult(t); // D, merged into C before B is
    const firstCredit = await createCreditFixture(t, {
      ownerPersonId: first.personId,
      amountMinor: 1_500,
    });
    const earlierCredit = await createCreditFixture(t, {
      ownerPersonId: earlierDuplicate.personId,
      amountMinor: 800,
    });

    // A into B: one exception for B names A's credit; the finance operator resolves it.
    await merge(middle.personId, first.personId);
    const [forMiddle] = await moneyExceptions(middle.personId);
    expect(forMiddle?.details).toMatchObject({
      credits: [{ creditId: firstCredit, ownerPersonId: first.personId }],
    });
    const operator = staffPrincipal(t.organizationId, ['finance_operator'], {
      personId: finance.personId,
      accountId: finance.accountId,
    });
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app
        .get(OperationalExceptions)
        .transition(trx, operator, forMiddle?.id as string, 'resolved', {
          reason: 'Reviewed with the family',
        }),
    );

    // D into C: one exception for C names D's credit.
    await merge(last.personId, earlierDuplicate.personId);
    expect(await moneyExceptions(last.personId)).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({
          credits: [expect.objectContaining({ creditId: earlierCredit })],
        }),
      }),
    ]);

    // B into C: B holds nothing itself, but A's credit now counts for C; D's was already named.
    const chainedMergeId = await merge(last.personId, middle.personId);
    const forLast = await moneyExceptions(last.personId);
    expect(forLast).toHaveLength(2);
    const chained = forLast.find(
      (e) => (e.details as Json)['mergeId'] === chainedMergeId,
    ) as (typeof forLast)[number];
    expect(chained).toMatchObject({ owner_queue: 'finance_operator', status: 'open' });
    expect(chained.details).toMatchObject({
      survivorPersonId: last.personId,
      mergedPersonId: middle.personId,
      credits: [{ creditId: firstCredit, ownerPersonId: first.personId, remainingMinor: 1_500 }],
      obligations: [],
    });
  });
});
