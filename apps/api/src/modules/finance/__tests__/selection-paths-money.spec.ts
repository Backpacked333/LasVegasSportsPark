import type { QuoteLinePriceBasis } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCapability, type TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingAddonFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createOfferingUniformFixture,
  createPolicyVersionFixture,
  createPriceRuleFixture,
  createPriceRuleTierFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../catalog';
import { createStaffMemberFixture } from '../../identity';
import { FakePaymentTokens } from '../providers/fake-payment.provider';
import { adult, child, drain, financeTestApp, post, type Actor } from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');

type Body = Record<string, unknown>;
type Line = Body & { lineKind: string; priceBasis: QuoteLinePriceBasis | null };

/**
 * Quality review of 2026-11-14, findings M-2 and M-8, where money is decided: the quote of a
 * place that was accepted from the waiting list, and the cancellation of a place that was created
 * by a transfer. Proposed amendments PA-02 (SPK-PAY-013), PA-03 (SPK-PAY-014) and PA-07
 * (SPK-REG-012). Prices, tiers and the refund share are test data, not policy.
 */
describe('the price of a place that did not come from a basket line (SPK-PAY-013, SPK-PAY-014)', () => {
  let t: TestApp;
  let parent: Actor;
  let halfBack: string;

  /** An offering whose cancellation policy refunds half; the price rule is added by each test. */
  async function offeringOf(seats = 20): Promise<OfferingFixture> {
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    const programId = await createProgramFixture(t, {
      ageBand: { minAgeYears: 6, maxAgeYears: 12 },
    });
    return createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
      programId,
      capacityUnits: [{ unit: 'seats', limit: seats }],
      basePriceMinor: null,
      cancellationPolicyVersionId: halfBack,
    });
  }

  async function sessionsOf(setup: OfferingFixture, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let day = 0; day < count; day += 1) {
      ids.push(
        await createOfferingSessionFixture(t, {
          offeringId: setup.offeringId,
          scheduledStart: new Date(NOW + (7 + day) * DAY),
          scheduledEnd: new Date(NOW + (7 + day) * DAY + HOUR),
        }),
      );
    }
    return ids;
  }

  async function kidFor(...setups: OfferingFixture[]): Promise<string> {
    const kid = await child(t, [parent]);
    for (const setup of setups) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: kid,
        policyVersionId: setup.formPolicyVersionId,
        signedByPersonId: parent.personId,
      });
    }
    return kid;
  }

  async function quoted(basketId: string): Promise<Body & { id: string }> {
    const res = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Body & { id: string };
  }

  async function pay(quoteId: string): Promise<void> {
    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain(t);
  }

  /** Buys a place of `setup` for `kid` through a basket and answers its enrollment. */
  async function buy(setup: OfferingFixture, kid: string, line: Body = {}): Promise<string> {
    const created = await post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId });
    const basketId = created.body.id as string;
    const added = await post(t, `/v1/baskets/${basketId}/lines`, parent.header, {
      participantPersonId: kid,
      offeringId: setup.offeringId,
      intent: 'youth',
      ...line,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const held = await post(t, `/v1/baskets/${basketId}/hold`, parent.header, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    await pay((await quoted(basketId)).id);
    return ((held.body.lines as Body[])[0] as Body)['enrollmentId'] as string;
  }

  const enrollment = async (id: string) =>
    (await t.http.get(`/v1/enrollments/${id}`).set(parent.header)).body as Body;

  beforeAll(async () => {
    t = await financeTestApp();
    parent = await adult(t);
    halfBack = await createPolicyVersionFixture(t, {
      kind: 'cancellation',
      content: { refundBasisPoints: 5_000 },
    });
    for (const capability of ['price_tiers_addons', 'uniforms', 'per_session_pricing'] as const) {
      await setCapability(t.db, t.organizationId, capability, true);
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-014, SPK-REG-012 (QA M-2): the quote of a place accepted from the waiting list prices its tier, its add-on and its uniform as their own lines, and the place the offer held is paid', async () => {
    const setup = await offeringOf(1);
    const [mon] = await sessionsOf(setup, 5);
    const priceRuleId = await createPriceRuleFixture(t, {
      offeringId: setup.offeringId,
      basePriceMinor: 30_000,
      effectiveFrom: new Date(NOW - DAY),
    });
    const singleDay = await createPriceRuleTierFixture(t, {
      priceRuleId,
      offeringId: setup.offeringId,
      code: 'single_day',
      name: 'Single day',
      attendance: 'chosen_sessions',
      minSessions: 1,
      maxSessions: 1,
      priceMinor: 7_000,
    });
    const lunch = await createOfferingAddonFixture(t, {
      offeringId: setup.offeringId,
      code: 'lunch',
      name: 'Lunch',
      priceMinor: 900,
      selection: 'per_session',
    });
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'required',
      priceMinor: 2_500,
    });
    const choice = {
      priceTierId: singleDay,
      selectedSessionIds: [mon],
      uniform: { offeringUniformId: uniformId, size: 'YM' },
    };
    // Monday's one seat is held by somebody else, then given back.
    const other = await adult(t);
    const otherKid = await child(t, [other]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: otherKid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: other.personId,
    });
    const blocking = await post(t, '/v1/baskets', other.header, { ownerPersonId: other.personId });
    const blockingId = blocking.body.id as string;
    await post(t, `/v1/baskets/${blockingId}/lines`, other.header, {
      participantPersonId: otherKid,
      offeringId: setup.offeringId,
      intent: 'youth',
      ...choice,
    });
    expect((await post(t, `/v1/baskets/${blockingId}/hold`, other.header, {})).status).toBe(200);

    const kid = await kidFor(setup);
    const joined = await post(t, '/v1/waitlist-entries', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
      ...choice,
      addons: [{ addonId: lunch, sessionIds: [mon] }],
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    await post(t, `/v1/baskets/${blockingId}/release`, other.header, { reason: 'changed plans' });
    await drain(t);
    const entry = await t.http.get(`/v1/waitlist-entries/${joined.body.id}`).set(parent.header);
    const offerId = (entry.body.offers as Body[])[0]?.['id'] as string;
    const accepted = await post(t, `/v1/waitlist-offers/${offerId}/accept`, parent.header, {});
    expect(accepted.status, accepted.body.message).toBe(200);
    const basketId = (accepted.body.basket as Body)['id'] as string;

    // Never TIER_REQUIRED: the line carries its tier, and the quote names it.
    const quote = await quoted(basketId);
    const lines = quote['lines'] as Line[];
    const place = lines.find((l) => l.lineKind === 'registration');
    expect(place).toMatchObject({ unitPriceMinor: 7_000 });
    expect(place?.priceBasis).toMatchObject({
      tier: { code: 'single_day', selectedSessionIds: [mon] },
      unitPriceMinor: 7_000,
    });
    expect(lines.find((l) => l.lineKind === 'addon')).toMatchObject({ baseAmountMinor: 900 });
    expect(lines.find((l) => l.lineKind === 'uniform')).toMatchObject({ baseAmountMinor: 2_500 });
    await pay(quote.id);
    const enrollmentId = (accepted.body.offer as Body)['acceptedEnrollmentId'] as string;
    expect(await enrollment(enrollmentId)).toMatchObject({
      status: 'confirmed',
      priceTierId: singleDay,
      selectedSessionIds: [mon],
    });
    expect(
      await t.db
        .selectFrom('capacity_pools')
        .select(['capacity', 'committed', 'held'])
        .where('scope_type', '=', 'session')
        .where('scope_id', '=', mon as string)
        .executeTakeFirstOrThrow(),
    ).toEqual({ capacity: 1, committed: 1, held: 0 });
  });

  it("SPK-PAY-013, SPK-PAY-014 (QA M-8): after a transfer into a class priced per session, and into a camp sold by tier, the cancellation is a share of the price the place was moved in at, never of the rule's base price", async () => {
    // A term place bought at a plain price.
    const term = await offeringOf();
    await createPriceRuleFixture(t, {
      offeringId: term.offeringId,
      basePriceMinor: 20_000,
      effectiveFrom: new Date(NOW - DAY),
    });
    // A class at 24.00 per session with seven sessions still to come.
    const klass = await offeringOf();
    await sessionsOf(klass, 7);
    await createPriceRuleFixture(t, {
      offeringId: klass.offeringId,
      basePriceMinor: 2_400,
      pricingBasis: 'per_session',
      effectiveFrom: new Date(NOW - DAY),
    });
    const kid = await kidFor(term, klass);
    const termEnrollment = await buy(term, kid);

    const transfer = async (
      enrollmentId: string,
      target: OfferingFixture,
      extra: Body = {},
    ): Promise<Body> => {
      const moved = await post(t, `/v1/enrollments/${enrollmentId}/transfer`, parent.header, {
        targetOfferingId: target.offeringId,
        commit: true,
        expectedRevision: (await enrollment(enrollmentId))['revision'],
        // The transfer itself is for finance to review, as before; the customer accepts that.
        acceptedConsequence: { kind: 'review_required', amountMinor: null, currency: 'USD' },
        ...extra,
      });
      expect(moved.status, moved.body.message).toBe(200);
      expect(moved.body.financialConsequence).toMatchObject({ kind: 'review_required' });
      return moved.body.newEnrollment as Body;
    };
    const cancellation = async (enrollmentId: string) =>
      (await t.http.get(`/v1/enrollments/${enrollmentId}/cancellation-preview`).set(parent.header))
        .body.financialConsequence as Body;

    const inClass = await transfer(termEnrollment, klass);
    // 24.00 x 7 sessions = 168.00 is what the place was moved in at, stored with the enrollment.
    expect(inClass['price']).toMatchObject({
      basePriceMinor: 2_400,
      estimate: { pricingBasis: 'per_session', sessionCount: 7, unitPriceMinor: 16_800 },
    });
    // Half of 168.00, not half of one class (12.00).
    expect(await cancellation(inClass['id'] as string)).toMatchObject({
      kind: 'refund',
      amountMinor: 8_400,
      currency: 'USD',
    });

    // On into a camp sold by tier: the tier named is the price, not the rule's 300.00.
    const camp = await offeringOf();
    const days = await sessionsOf(camp, 5);
    const campRule = await createPriceRuleFixture(t, {
      offeringId: camp.offeringId,
      basePriceMinor: 30_000,
      effectiveFrom: new Date(NOW - DAY),
    });
    const threeDay = await createPriceRuleTierFixture(t, {
      priceRuleId: campRule,
      offeringId: camp.offeringId,
      code: 'three_day',
      name: 'Three days',
      attendance: 'chosen_sessions',
      minSessions: 3,
      maxSessions: 3,
      priceMinor: 19_000,
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: camp.formPolicyVersionId,
      signedByPersonId: parent.personId,
    });
    const inCamp = await transfer(inClass['id'] as string, camp, {
      priceTierId: threeDay,
      selectedSessionIds: days.slice(0, 3),
    });
    expect(inCamp).toMatchObject({ priceTierId: threeDay, selectedSessionIds: days.slice(0, 3) });
    expect(await cancellation(inCamp['id'] as string)).toMatchObject({
      kind: 'refund',
      amountMinor: 9_500,
    });
    // The accepted cancellation records the same amount.
    const canceled = await post(
      t,
      `/v1/enrollments/${inCamp['id'] as string}/cancel`,
      parent.header,
      {
        reason: 'changed plans',
        expectedRevision: inCamp['revision'],
        acceptedConsequence: { kind: 'refund', amountMinor: 9_500, currency: 'USD' },
      },
    );
    expect(canceled.status, canceled.body.message).toBe(200);
    expect(canceled.body.cancellationConsequence).toMatchObject({
      kind: 'refund',
      amountMinor: 9_500,
    });
  });
});
