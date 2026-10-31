import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
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
          credits: [expect.objectContaining({ creditId, remainingMinor: 2_500 })],
          obligations: [expect.objectContaining({ obligationId: lockerId, outstandingMinor: 700 })],
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
});
