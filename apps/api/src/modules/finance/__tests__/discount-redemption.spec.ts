import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createDiscountFixture, type OfferingFixture } from '../../catalog';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import {
  adult,
  basketFor,
  child,
  drain,
  financeTestApp,
  offering,
  post,
  quoteFor,
  type Actor,
} from './support';

/**
 * R3-TIME-MONEY-01 (SPK-PAY-003 redemption limits, SPK-PAY-002 "a quote shows what will be
 * charged", §4.7): a per-person discount limit is counted for the participant at quote time and
 * at checkout alike. Checkout redeems each applied discount once per participant whose lines it
 * reduced, in that participant's name (the person catalog's evaluation and its 0207/0208 guard
 * count), never once per order in the payer's name.
 */
describe('discount redemptions follow the participant (R3-TIME-MONEY-01, SPK-PAY-003)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await financeTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const pay = (actor: Actor, quoteId: string, token: string = FakePaymentTokens.succeed) =>
    post(t, '/v1/registration-checkouts', actor.header, {
      quoteId,
      payment: { method: 'provider', paymentMethodToken: token },
    });

  async function ledger(discountDefinitionId: string) {
    return t.db
      .selectFrom('discount_redemption_entries')
      .select(['kind', 'person_id', 'reference_type', 'amount_minor'])
      .where('organization_id', '=', t.organizationId)
      .where('discount_definition_id', '=', discountDefinitionId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
  }

  async function offerings(count: number): Promise<OfferingFixture[]> {
    const list: OfferingFixture[] = [];
    for (let i = 0; i < count; i += 1) list.push(await offering(t, { basePriceMinor: 10_000 }));
    return list;
  }

  it('SPK-PAY-003: one payer, two children, a promo code limited to one use per participant', async () => {
    const guardian = await adult(t);
    const [first, second, third] = await offerings(3);
    const code = 'ONEPERKID';
    const discountId = await createDiscountFixture(t, {
      code,
      amountKind: 'percentage',
      amountValue: 1_000,
      perPersonLimit: 1,
      eligibilityRules: { offeringIds: [first!.offeringId, second!.offeringId, third!.offeringId] },
    });
    // Both children in one basket: each child's line gets the discount, each child uses it once.
    const both = await basketFor(t, guardian, [first!, first!]);
    const [childA, childB] = both.participants as [string, string];
    const quote = await quoteFor(t, guardian, both.basketId, { discountCodes: [code] });
    expect(quote).toMatchObject({ discountMinor: 2_000, totalMinor: 18_000 });
    const paid = await pay(guardian, quote.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('completed');
    const entries = await ledger(discountId);
    expect(
      entries.map((e) => [e.kind, e.person_id, e.reference_type, Number(e.amount_minor)]),
    ).toEqual([
      ['redeem', childA, 'order_line', 1_000],
      ['redeem', childB, 'order_line', 1_000],
    ]);
    expect(entries.some((e) => e.person_id === guardian.personId)).toBe(false);

    // Child A again (another offering): the quote no longer offers the discount, so nothing is
    // refused at checkout.
    const again = await basketFor(t, guardian, [second!], { participants: [childA] });
    const againQuote = await quoteFor(t, guardian, again.basketId, { discountCodes: [code] });
    expect(againQuote).toMatchObject({ discountMinor: 0, totalMinor: 10_000 });
    const againPaid = await pay(guardian, againQuote.id);
    expect(againPaid.status, JSON.stringify(againPaid.body)).toBe(201);
    expect(againPaid.body.status).toBe('completed');

    // A third child of the same payer still has the allowance: quoted and charged with it.
    const sibling = await basketFor(t, guardian, [second!]);
    const siblingQuote = await quoteFor(t, guardian, sibling.basketId, { discountCodes: [code] });
    expect(siblingQuote).toMatchObject({ discountMinor: 1_000, totalMinor: 9_000 });
    const siblingPaid = await pay(guardian, siblingQuote.id);
    expect(siblingPaid.status, JSON.stringify(siblingPaid.body)).toBe(201);
    expect(siblingPaid.body).toMatchObject({
      status: 'completed',
      payment: { amountMinor: 9_000 },
    });
    await drain(t);
  });

  it('SPK-PAY-003: an automatic per-participant discount never blocks a later child of the same payer', async () => {
    const guardian = await adult(t);
    const [first, second] = await offerings(2);
    const discountId = await createDiscountFixture(t, {
      code: null,
      amountKind: 'fixed',
      amountValue: 1_500,
      currency: 'USD',
      perPersonLimit: 1,
      eligibilityRules: { offeringIds: [first!.offeringId, second!.offeringId] },
    });
    const one = await basketFor(t, guardian, [first!]);
    const childA = one.participants[0] as string;
    const quoteA = await quoteFor(t, guardian, one.basketId);
    expect(quoteA).toMatchObject({ discountMinor: 1_500, totalMinor: 8_500 });
    expect((await pay(guardian, quoteA.id)).body.status).toBe('completed');

    // Before R3-TIME-MONEY-01 the payer's allowance was used, so this checkout answered 409
    // DISCOUNT_PER_PERSON_LIMIT although the automatic discount (which cannot be removed) was
    // quoted: the payer could never check out another eligible child.
    const two = await basketFor(t, guardian, [first!]);
    const childB = two.participants[0] as string;
    const quoteB = await quoteFor(t, guardian, two.basketId);
    expect(quoteB).toMatchObject({ discountMinor: 1_500, totalMinor: 8_500 });
    const paidB = await pay(guardian, quoteB.id);
    expect(paidB.status, JSON.stringify(paidB.body)).toBe(201);
    expect(paidB.body).toMatchObject({ status: 'completed', payment: { amountMinor: 8_500 } });

    // Child A's allowance is used: their next eligible purchase is quoted and charged in full.
    const three = await basketFor(t, guardian, [second!], { participants: [childA] });
    const quoteA2 = await quoteFor(t, guardian, three.basketId);
    expect(quoteA2).toMatchObject({ discountMinor: 0, totalMinor: 10_000 });
    expect((await pay(guardian, quoteA2.id)).body.status).toBe('completed');
    expect((await ledger(discountId)).map((e) => e.person_id)).toEqual([childA, childB]);
    await drain(t);
  });

  it("SPK-PAY-003: two guardians paying for the same child use that child's one allowance", async () => {
    const mother = await adult(t);
    const father = await adult(t);
    const shared = await child(t, [mother, father]);
    const [first, second] = await offerings(2);
    const code = 'ONCEPERCHILD';
    const discountId = await createDiscountFixture(t, {
      code,
      amountKind: 'percentage',
      amountValue: 2_000,
      perPersonLimit: 1,
      eligibilityRules: { offeringIds: [first!.offeringId, second!.offeringId] },
    });
    const byMother = await basketFor(t, mother, [first!], { participants: [shared] });
    const motherQuote = await quoteFor(t, mother, byMother.basketId, { discountCodes: [code] });
    expect(motherQuote).toMatchObject({ discountMinor: 2_000 });
    expect((await pay(mother, motherQuote.id)).body.status).toBe('completed');

    const byFather = await basketFor(t, father, [second!], { participants: [shared] });
    const fatherQuote = await quoteFor(t, father, byFather.basketId, { discountCodes: [code] });
    expect(fatherQuote).toMatchObject({ discountMinor: 0, totalMinor: 10_000 });
    expect((await pay(father, fatherQuote.id)).body.status).toBe('completed');
    const entries = await ledger(discountId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'redeem', person_id: shared });
    await drain(t);
  });

  it("SPK-PAY-003: an aborted checkout gives the participant's allowance back", async () => {
    const guardian = await adult(t);
    const [first, second] = await offerings(2);
    const code = 'GIVEBACK';
    const discountId = await createDiscountFixture(t, {
      code,
      amountKind: 'percentage',
      amountValue: 1_000,
      perPersonLimit: 1,
      eligibilityRules: { offeringIds: [first!.offeringId, second!.offeringId] },
    });
    const declined = await basketFor(t, guardian, [first!]);
    const participant = declined.participants[0] as string;
    const quote = await quoteFor(t, guardian, declined.basketId, { discountCodes: [code] });
    const attempt = await pay(guardian, quote.id, FakePaymentTokens.decline);
    expect(attempt.body.status).toBe('awaiting_payment');
    const aborted = await post(
      t,
      `/v1/registration-checkouts/${attempt.body.id as string}/abort`,
      guardian.header,
      { reason: 'Card declined' },
    );
    expect(aborted.status, JSON.stringify(aborted.body)).toBe(201);
    expect(aborted.body.status).toBe('aborted');
    expect((await ledger(discountId)).map((e) => [e.kind, e.person_id, e.reference_type])).toEqual([
      ['redeem', participant, 'order_line'],
      ['release', participant, 'order_line'],
    ]);

    const retry = await basketFor(t, guardian, [second!], { participants: [participant] });
    const retryQuote = await quoteFor(t, guardian, retry.basketId, { discountCodes: [code] });
    expect(retryQuote).toMatchObject({ discountMinor: 1_000, totalMinor: 9_000 });
    expect((await pay(guardian, retryQuote.id)).body.status).toBe('completed');
    await drain(t);
  });
});
