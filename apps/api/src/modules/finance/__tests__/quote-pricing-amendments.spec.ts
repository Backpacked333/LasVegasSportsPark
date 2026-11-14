import { newId, type QuoteLinePriceBasis } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCapability, type TestApp } from '../../../testing';
import {
  createDiscountFixture,
  createEntitlementDefinitionFixture,
  createOfferingSessionFixture,
  createPolicyVersionFixture,
  createPriceRuleFixture,
  type OfferingFixture,
} from '../../catalog';
import {
  createEnrollmentFixture,
  FINANCE_POLICY_IMPL,
  type FinancePolicyPort,
} from '../../enrollment';
import { createPersonFixture } from '../../identity';
import { unitPriceFromBasis } from '../pricing/quote-calculator';
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
  rejectsWith,
  type Actor,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-11-02T15:00:00Z');
const TERM_START = Date.parse('2026-10-13T00:00:00Z');
const CHECK = '23514';
const RESTRICT = '23001';

type Line = Record<string, unknown> & { priceBasis: QuoteLinePriceBasis | null };
type QuoteBody = Record<string, unknown> & { id: string; totalMinor: number };
const linesOf = (quote: Record<string, unknown>) => quote['lines'] as Line[];

/**
 * Proposed amendments PA-02 (SPK-PAY-013, per-session price) and PA-04 (SPK-PAY-015, member
 * price) in the registration quote: both are Proposed, their open values Pending decision
 * (DEC-096, DEC-098), and each is switched by its own capability. Prices, dates and the
 * membership are test data, not policy.
 */
describe('quote pricing amendments (SPK-PAY-013, SPK-PAY-015; migration 0687)', () => {
  let t: TestApp;
  let parent: Actor;
  let membershipDefinitionId: string;
  let membershipOffering: OfferingFixture;

  /** A class of ten weekly sessions from TERM_START priced per session (three are over at NOW). */
  async function perSessionClass(
    options: { memberPriceMinor?: number; firstStart?: number; sessions?: number } = {},
  ): Promise<{ klass: OfferingFixture; sessionIds: string[]; priceRuleId: string }> {
    const klass = await offering(t, { basePriceMinor: null });
    const priceRuleId = await createPriceRuleFixture(t, {
      offeringId: klass.offeringId,
      basePriceMinor: 2_400,
      pricingBasis: 'per_session',
      memberPriceMinor: options.memberPriceMinor ?? null,
      memberEntitlementDefinitionId:
        options.memberPriceMinor === undefined ? null : membershipDefinitionId,
      effectiveFrom: new Date(NOW - 30 * DAY),
    });
    const sessionIds: string[] = [];
    const firstStart = options.firstStart ?? TERM_START;
    for (let week = 0; week < (options.sessions ?? 10); week += 1) {
      sessionIds.push(
        await createOfferingSessionFixture(t, {
          offeringId: klass.offeringId,
          scheduledStart: new Date(firstStart + week * WEEK),
          scheduledEnd: new Date(firstStart + week * WEEK + HOUR),
        }),
      );
    }
    return { klass, sessionIds, priceRuleId };
  }

  /** An offering with a standard price of 300.00 and a member price of 250.00. */
  async function memberPricedCamp(): Promise<OfferingFixture> {
    const camp = await offering(t, { basePriceMinor: null });
    await createPriceRuleFixture(t, {
      offeringId: camp.offeringId,
      basePriceMinor: 30_000,
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: membershipDefinitionId,
      effectiveFrom: new Date(NOW - 30 * DAY),
    });
    return camp;
  }

  /** A confirmed membership of `personId` granting the entitlement, with the given term. */
  async function membership(
    personId: string,
    term: { from: number; to: number } = { from: NOW - 30 * DAY, to: NOW + 335 * DAY },
  ): Promise<string> {
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId: membershipOffering.offeringId,
      participantPersonId: personId,
      intent: 'membership',
      entitlementDefinitionId: membershipDefinitionId,
    });
    await t.db
      .updateTable('enrollments')
      .set({ membership_starts_at: new Date(term.from), membership_ends_at: new Date(term.to) })
      .where('id', '=', enrollmentId)
      .execute();
    return enrollmentId;
  }

  const switches = async (perSession: boolean, member: boolean) => {
    await setCapability(t.db, t.organizationId, 'per_session_pricing', perSession);
    await setCapability(t.db, t.organizationId, 'member_pricing', member);
  };

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    membershipDefinitionId = await createEntitlementDefinitionFixture(t, {
      name: 'Annual membership',
      kind: 'membership_benefit',
    });
    membershipOffering = await offering(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-013: a child joining a ten-session class after three sessions is quoted the per-session price times the seven sessions still to attend, and the quote stays reproducible from its stored basis', async () => {
    await switches(true, false);
    const { klass, sessionIds, priceRuleId } = await perSessionClass();
    const { basketId, participants } = await basketFor(t, parent, [klass], { hold: false });
    const quote = await quoteFor(t, parent, basketId);
    const [line] = linesOf(quote);

    // The quote shows the per-session price, the count and the product: 24.00 x 7 = 168.00.
    expect(line).toMatchObject({
      participantPersonId: participants[0],
      priceRuleId,
      quantity: 1,
      unitPriceMinor: 16_800,
      baseAmountMinor: 16_800,
      totalMinor: 16_800,
    });
    expect(line?.priceBasis).toEqual({
      pricingBasis: 'per_session',
      standardPriceMinor: 2_400,
      appliedPrice: 'standard',
      appliedPriceMinor: 2_400,
      member: null,
      sessions: {
        count: 7,
        sessionIds: sessionIds.slice(3),
        countedAt: '2026-11-02T15:00:00.000Z',
      },
      unitPriceMinor: 16_800,
    });
    expect(quote.totalMinor).toBe(16_800);

    // SPK-PAY-002: a session canceled and a session added after the quote change nothing that
    // was quoted; the stored basis alone gives the same price.
    await t.db
      .updateTable('offering_sessions')
      .set({ status: 'canceled', canceled_at: new Date(NOW), cancel_reason: 'coach unavailable' })
      .where('id', '=', sessionIds[9] as string)
      .execute();
    await createOfferingSessionFixture(t, {
      offeringId: klass.offeringId,
      scheduledStart: new Date(TERM_START + 12 * WEEK),
      scheduledEnd: new Date(TERM_START + 12 * WEEK + HOUR),
    });
    const read = await t.http.get(`/v1/registration-quotes/${quote.id}`).set(parent.header);
    expect(read.status).toBe(200);
    const stored = linesOf(read.body as Record<string, unknown>)[0] as Line;
    expect(stored.priceBasis).toEqual(line?.priceBasis);
    expect(unitPriceFromBasis(stored.priceBasis as QuoteLinePriceBasis)).toBe(16_800);

    // The purchase keeps the basis: the paid price is the quoted one, and the order line says why.
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain(t);
    const orderLine = await t.db
      .selectFrom('order_lines')
      .select(['unit_price_minor', 'total_minor', 'price_basis'])
      .where('quote_line_id', '=', line?.['id'] as string)
      .executeTakeFirstOrThrow();
    expect(orderLine).toMatchObject({ unit_price_minor: 16_800, total_minor: 16_800 });
    expect((orderLine.price_basis as { pricing?: unknown }).pricing).toEqual(line?.priceBasis);

    // A quote made a week later counts one session fewer (and no longer the canceled one).
    t.clock.advance(WEEK);
    const later = await basketFor(t, parent, [klass], { hold: false });
    const laterLine = linesOf(await quoteFor(t, parent, later.basketId))[0];
    expect(laterLine?.priceBasis?.sessions?.sessionIds).toHaveLength(6);
    expect(laterLine?.unitPriceMinor).toBe(14_400);
    t.clock.set(new Date(NOW));
  });

  it('SPK-PAY-013: when no session can still be attended the line is refused with a clear reason; no minimum charge is invented', async () => {
    await switches(true, false);
    // Every session of this class has started.
    const { klass } = await perSessionClass({ firstStart: NOW - 5 * WEEK, sessions: 5 });
    const { basketId } = await basketFor(t, parent, [klass], { hold: false });
    const refused = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(refused.body.message).toBe(
      'No session of this offering can still be attended, so there is nothing to price.',
    );
    expect(refused.body.details).toMatchObject({
      code: 'NO_SESSIONS_REMAINING',
      offeringId: klass.offeringId,
    });
    expect(
      await t.db.selectFrom('quotes').select('id').where('basket_id', '=', basketId).execute(),
    ).toHaveLength(0);
    // The basket's estimate says "unpriced" for the same reason, never a made-up amount.
    const estimate = await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ basis: 'unpriced', totalMinor: null });
  });

  it('SPK-PAY-013 with per-session pricing off: a term price is quoted exactly as before, and a per-session rule cannot be quoted', async () => {
    await switches(false, false);
    // Today's behaviour: the term price in full, no basis stored.
    const term = await offering(t, { basePriceMinor: 20_000 });
    for (let week = 0; week < 10; week += 1) {
      await createOfferingSessionFixture(t, {
        offeringId: term.offeringId,
        scheduledStart: new Date(TERM_START + week * WEEK),
        scheduledEnd: new Date(TERM_START + week * WEEK + HOUR),
      });
    }
    const plain = await basketFor(t, parent, [term], { hold: false });
    const quote = await quoteFor(t, parent, plain.basketId);
    expect(linesOf(quote)[0]).toMatchObject({
      unitPriceMinor: 20_000,
      baseAmountMinor: 20_000,
      priceBasis: null,
    });
    const row = await t.db
      .selectFrom('quote_lines')
      .select('price_basis')
      .where('quote_id', '=', quote.id)
      .executeTakeFirstOrThrow();
    expect(row.price_basis).toBeNull();

    // A rule written per session while the capability was on is never charged as a term price
    // (its base price is the price of one session): the quote is refused as "turned off".
    const { klass } = await perSessionClass();
    const { basketId } = await basketFor(t, parent, [klass], { hold: false });
    const refused = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'per_session_pricing',
    });
  });

  it('SPK-PAY-015: the member price applies only to a participant who holds the named membership at the quote instant, and the quote states which price applied and why', async () => {
    await switches(false, true);
    const camp = await memberPricedCamp();
    const member = await child(t, [parent]);
    const nonMember = await child(t, [parent]);
    const suspended = await child(t, [parent]);
    const lapsed = await child(t, [parent]);
    const future = await child(t, [parent]);
    const membershipId = await membership(member);
    const suspendedMembershipId = await membership(suspended);
    await t.db
      .insertInto('membership_suspensions')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        enrollment_id: suspendedMembershipId,
        participant_person_id: suspended,
        suspended_from: new Date(NOW - DAY),
        suspended_until: null,
        reason: 'injury',
        created_by: json({ kind: 'system' }),
      })
      .execute();
    await membership(lapsed, { from: NOW - 400 * DAY, to: NOW - DAY });
    await membership(future, { from: NOW + DAY, to: NOW + 366 * DAY });
    // The paying adult's own membership never makes a child a member (it follows the participant).
    await membership(parent.personId);

    const { basketId } = await basketFor(t, parent, [camp, camp, camp, camp, camp], {
      hold: false,
      participants: [member, nonMember, suspended, lapsed, future],
    });
    const quote = await quoteFor(t, parent, basketId);
    const lines = linesOf(quote);
    expect(lines.map((l) => l['unitPriceMinor'])).toEqual([25_000, 30_000, 30_000, 30_000, 30_000]);
    expect(lines[0]?.priceBasis).toEqual({
      pricingBasis: 'term',
      standardPriceMinor: 30_000,
      appliedPrice: 'member',
      appliedPriceMinor: 25_000,
      member: {
        priceMinor: 25_000,
        entitlementDefinitionId: membershipDefinitionId,
        entitlementName: 'Annual membership',
        applied: true,
        reason: 'active_membership',
        membershipEnrollmentId: membershipId,
        checkedAt: '2026-11-02T15:00:00.000Z',
      },
      sessions: null,
      unitPriceMinor: 25_000,
    });
    expect(lines.slice(1).map((l) => [l.priceBasis?.appliedPrice, l.priceBasis?.member])).toEqual([
      ['standard', expect.objectContaining({ applied: false, reason: 'no_active_membership' })],
      ['standard', expect.objectContaining({ applied: false, reason: 'membership_suspended' })],
      ['standard', expect.objectContaining({ applied: false, reason: 'no_active_membership' })],
      ['standard', expect.objectContaining({ applied: false, reason: 'no_active_membership' })],
    ]);
    expect(quote.totalMinor).toBe(145_000);
    for (const line of lines) {
      expect(unitPriceFromBasis(line.priceBasis as QuoteLinePriceBasis)).toBe(
        line['unitPriceMinor'],
      );
    }

    // A membership that lapses (here: is canceled) after purchase never changes the price paid.
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    await drain(t);
    await t.db
      .updateTable('enrollments')
      .set({
        status: 'canceled',
        canceled_at: new Date(NOW),
        cancellation_reason: 'membership refunded',
      })
      .where('id', '=', membershipId)
      .execute();
    const paid = await t.db
      .selectFrom('order_lines')
      .select(['unit_price_minor', 'total_minor', 'price_basis'])
      .where('quote_line_id', '=', lines[0]?.['id'] as string)
      .executeTakeFirstOrThrow();
    expect(paid).toMatchObject({ unit_price_minor: 25_000, total_minor: 25_000 });
    expect((paid.price_basis as { pricing?: unknown }).pricing).toEqual(lines[0]?.priceBasis);
    const reread = await t.http.get(`/v1/registration-quotes/${quote.id}`).set(parent.header);
    expect(linesOf(reread.body as Record<string, unknown>)[0]?.priceBasis).toEqual(
      lines[0]?.priceBasis,
    );
    // The next quote for a sibling of that (former) member pays the standard price.
    const sibling = await child(t, [parent]);
    const next = await basketFor(t, parent, [camp], { hold: false, participants: [sibling] });
    expect(linesOf(await quoteFor(t, parent, next.basketId))[0]?.priceBasis?.appliedPrice).toBe(
      'standard',
    );
  });

  it("SPK-PAY-015, SPK-IAM-007: a membership bought under a record since merged into the participant is the participant's", async () => {
    await switches(false, true);
    const camp = await memberPricedCamp();
    const survivor = await child(t, [parent]);
    const duplicate = await createPersonFixture(t, { kind: 'child' });
    const membershipId = await membership(duplicate);
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', duplicate)
      .execute();
    const { basketId } = await basketFor(t, parent, [camp], {
      hold: false,
      participants: [survivor],
    });
    const [line] = linesOf(await quoteFor(t, parent, basketId));
    expect(line?.unitPriceMinor).toBe(25_000);
    expect(line?.priceBasis?.member).toMatchObject({
      applied: true,
      reason: 'active_membership',
      membershipEnrollmentId: membershipId,
    });
  });

  it('SPK-PAY-015 with member pricing off: a member price on the rule is not evaluated and the standard price applies, as before', async () => {
    await switches(false, false);
    const camp = await memberPricedCamp();
    const member = await child(t, [parent]);
    await membership(member);
    const { basketId } = await basketFor(t, parent, [camp], {
      hold: false,
      participants: [member],
    });
    const [line] = linesOf(await quoteFor(t, parent, basketId));
    expect(line).toMatchObject({
      unitPriceMinor: 30_000,
      baseAmountMinor: 30_000,
      priceBasis: null,
    });
  });

  it('SPK-PAY-013, SPK-PAY-015: member price first, then the per-session multiplication; a discount is worked out on the result', async () => {
    await switches(true, true);
    const { klass, sessionIds } = await perSessionClass({ memberPriceMinor: 2_000 });
    const member = await child(t, [parent]);
    const nonMember = await child(t, [parent]);
    await membership(member);
    const discountId = await createDiscountFixture(t, {
      code: null,
      name: 'Sibling discount',
      amountKind: 'percentage',
      amountValue: 1_000,
      eligibilityRules: { minLines: 2, offeringIds: [klass.offeringId] },
      status: 'active',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    const { basketId } = await basketFor(t, parent, [klass, klass], {
      hold: false,
      participants: [member, nonMember],
    });
    const quote = (await quoteFor(t, parent, basketId)) as QuoteBody;
    const lines = linesOf(quote);
    // 20.00 x 7 = 140.00 for the member, 24.00 x 7 = 168.00 for the other child.
    expect(lines.map((l) => l['unitPriceMinor'])).toEqual([14_000, 16_800]);
    expect(lines[0]?.priceBasis).toMatchObject({
      pricingBasis: 'per_session',
      appliedPrice: 'member',
      appliedPriceMinor: 2_000,
      sessions: { count: 7, sessionIds: sessionIds.slice(3) },
      unitPriceMinor: 14_000,
    });
    expect(lines[1]?.priceBasis).toMatchObject({
      appliedPrice: 'standard',
      appliedPriceMinor: 2_400,
      sessions: { count: 7 },
      unitPriceMinor: 16_800,
    });
    // 10% of 308.00, not of two per-session prices.
    expect(lines.map((l) => l['discountMinor'])).toEqual([1_400, 1_680]);
    expect(quote.totalMinor).toBe(27_720);
    // The estimate shown before the quote follows the same pricing (before discounts).
    const estimate = await t.http.get(`/v1/basket-prices/${basketId}`).set(parent.header);
    expect(estimate.body).toMatchObject({ basis: 'estimate', subtotalMinor: 30_800 });
    await t.db
      .updateTable('discount_definitions')
      .set({ status: 'retired' })
      .where('id', '=', discountId)
      .execute();
  });

  it('SPK-PAY-013, SPK-PAY-015: a cancellation is worked out on the price that was quoted, and a transfer involving such a place goes to finance review', async () => {
    await switches(true, true);
    const port = t.app.get<FinancePolicyPort>(FINANCE_POLICY_IMPL);
    const halfBack = await createPolicyVersionFixture(t, {
      kind: 'cancellation',
      content: { refundBasisPoints: 5_000 },
    });
    /** Buys one place and answers the enrollment the order line names. */
    const buy = async (setup: OfferingFixture, participant: string): Promise<string> => {
      const { basketId } = await basketFor(t, parent, [setup], {
        hold: false,
        participants: [participant],
      });
      const quote = await quoteFor(t, parent, basketId);
      const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
      await drain(t);
      const line = await t.db
        .selectFrom('order_lines')
        .select('enrollment_id')
        .where('quote_line_id', '=', linesOf(quote)[0]?.['id'] as string)
        .executeTakeFirstOrThrow();
      return line.enrollment_id as string;
    };
    const at = new Date(NOW);
    const { klass } = await perSessionClass({ memberPriceMinor: 2_000 });
    const member = await child(t, [parent]);
    await membership(member);
    const perSessionEnrollment = await buy(klass, member);
    const term = await offering(t, { basePriceMinor: 20_000 });
    const termEnrollment = await buy(term, await child(t, [parent]));

    // Enrollment passes the rule's base price (24.00, the price of one session). The place cost
    // 20.00 x 7 = 140.00 (member price, seven sessions), and half of that is refunded.
    const cancellation = (enrollmentId: string, offeringId: string, amountMinor: number) =>
      port.cancellationConsequence(t.organizationId, {
        enrollmentId,
        participantPersonId: member,
        offeringId,
        cancellationPolicyVersionId: halfBack,
        price: { amountMinor, currency: 'USD' },
        at,
      });
    expect(await cancellation(perSessionEnrollment, klass.offeringId, 2_400)).toMatchObject({
      kind: 'refund',
      amountMinor: 7_000,
      currency: 'USD',
    });
    // A plain term price is worked out on the price enrollment passes, as before.
    expect(await cancellation(termEnrollment, term.offeringId, 20_000)).toMatchObject({
      kind: 'refund',
      amountMinor: 10_000,
    });

    const transfer = (enrollmentId: string, fromOfferingId: string, toOfferingId: string) =>
      port.transferConsequence(t.organizationId, {
        enrollmentId,
        participantPersonId: member,
        fromOfferingId,
        toOfferingId,
        fromPrice: { amountMinor: 20_000, currency: 'USD' },
        toPrice: { amountMinor: 2_400, currency: 'USD' },
        at,
      });
    const review = {
      kind: 'review_required',
      amountMinor: null,
      explanation:
        'One of the places is priced per session or at a member price; finance reviews the transfer.',
    };
    // Out of a per-session place, and into a per-session offering: never a difference of base prices.
    expect(await transfer(perSessionEnrollment, klass.offeringId, term.offeringId)).toMatchObject(
      review,
    );
    expect(await transfer(termEnrollment, term.offeringId, klass.offeringId)).toMatchObject(review);
    // Between two plain term prices the difference is a credit, as before.
    const other = await offering(t, { basePriceMinor: 2_400 });
    expect(await transfer(termEnrollment, term.offeringId, other.offeringId)).toMatchObject({
      kind: 'credit',
      amountMinor: 17_600,
    });
    // A member price on the target matters only while member pricing is on.
    const camp = await memberPricedCamp();
    expect(await transfer(termEnrollment, term.offeringId, camp.offeringId)).toMatchObject(review);
    await switches(true, false);
    expect(await transfer(termEnrollment, term.offeringId, camp.offeringId)).toMatchObject({
      kind: 'credit',
    });
  });

  it('SPK-PAY-002: the database refuses a stored basis that disagrees with the unit price or explains an unpriced line, and never lets a basis change', async () => {
    await switches(true, false);
    const { klass } = await perSessionClass();
    const { basketId } = await basketFor(t, parent, [klass], { hold: false });
    const quote = await quoteFor(t, parent, basketId);
    const row = await t.db
      .selectFrom('quote_lines')
      .selectAll()
      .where('quote_id', '=', quote.id)
      .executeTakeFirstOrThrow();
    const copy = (overrides: Record<string, unknown>) =>
      t.db
        .insertInto('quote_lines')
        .values({
          ...row,
          id: newId(),
          sequence: 2,
          discount_lines: json(row.discount_lines),
          charge_lines: json(row.charge_lines),
          policy_references: json(row.policy_references),
          price_basis: json(row.price_basis),
          ...overrides,
        } as never)
        .execute();
    // A second line for the same basket line is still refused (uniqueness is untouched).
    expect(await rejectsWith(copy({}))).toBe('23505');
    const other = await basketFor(t, parent, [klass], { hold: false });
    const otherLine = (
      other.body['lines'] as Array<{ id: string; participantPersonId: string }>
    )[0] as {
      id: string;
      participantPersonId: string;
    };
    const onOtherLine = {
      basket_line_id: otherLine.id,
      participant_person_id: otherLine.participantPersonId,
    };
    expect(
      await rejectsWith(
        copy({
          ...onOtherLine,
          price_basis: json({ ...(row.price_basis as object), unitPriceMinor: 1 }),
        }),
      ),
    ).toBe(CHECK);
    expect(await rejectsWith(copy({ ...onOtherLine, price_basis: json([1, 2]) }))).toBe(CHECK);
    expect(
      await rejectsWith(copy({ ...onOtherLine, price_basis: json({ pricingBasis: 'term' }) })),
    ).toBe(CHECK);
    // A basis on a line without a price rule (an unpriced line) is refused.
    expect(
      await rejectsWith(
        copy({
          ...onOtherLine,
          price_rule_id: null,
          unit_price_minor: 0,
          base_amount_minor: 0,
          total_minor: 0,
          price_basis: json({ unitPriceMinor: 0 }),
        }),
      ),
    ).toBe(CHECK);
    // Quote lines are append-only: the basis written with the quote is the basis forever.
    expect(
      await rejectsWith(
        t.db
          .updateTable('quote_lines')
          .set({ description: 'edited' })
          .where('id', '=', row.id)
          .execute(),
      ),
    ).toBe(RESTRICT);
  });
});
