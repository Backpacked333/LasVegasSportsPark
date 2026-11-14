import { describe, expect, it } from 'vitest';
import { createDiscountFixture, createOfferingSessionFixture } from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import { basketFor, offering, quoteFor } from '../../modules/finance/__tests__/support';
import {
  adult,
  child,
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
} from './support';

/**
 * Phase 0 verification of class registration against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md). It records what the assembled application
 * does today; an assertion marked "recorded gap" documents present behaviour, not a requirement.
 * Prices, dates and discount values are test data, not policy.
 *
 * The first scenario runs with every capability off and keeps the gap of proposed amendment
 * PA-02; the second turns `per_session_pricing` on and shows the amendment (SPK-PAY-013,
 * Proposed; its open values are pending DEC-096).
 */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const TERM_START = Date.parse('2026-10-13T00:00:00Z');

describe('Facility class scenarios (assembled application)', () => {
  it('SPK-PAY-003: two siblings join a ten-session class in week four; the sibling discount applies once; the term price is not reduced for sessions already held', async () => {
    // Three sessions have been held; seven remain.
    const t = await journeyApp({ clockStart: '2026-11-02T15:00:00Z' });
    try {
      const parent = await adult(t);
      const first = await child(t, [parent]);
      const second = await child(t, [parent]);
      const klass = await offering(t, { basePriceMinor: 20_000 });
      for (let week = 0; week < 10; week += 1) {
        await createOfferingSessionFixture(t, {
          offeringId: klass.offeringId,
          scheduledStart: new Date(TERM_START + week * WEEK),
          scheduledEnd: new Date(TERM_START + week * WEEK + 3_600_000),
        });
      }
      await createDiscountFixture(t, {
        code: null,
        name: 'Sibling discount',
        amountKind: 'percentage',
        amountValue: 1_000,
        eligibilityRules: { minLines: 2 },
        status: 'active',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      });

      const { basketId } = await basketFor(t, parent, [klass, klass], {
        hold: false,
        participants: [first, second],
      });
      const quote = await quoteFor(t, parent, basketId);
      const lines = quote['lines'] as Array<Record<string, unknown>>;
      // Recorded gap (proposed amendment PA-02), kept for an organization that has not turned
      // per-session pricing on (a new organization has every capability off): three of ten
      // sessions are over and each child is still priced for the whole term, with no price basis.
      expect(lines.map((l) => l['unitPriceMinor'])).toEqual([20_000, 20_000]);
      expect(lines.map((l) => l['priceBasis'])).toEqual([null, null]);
      // The discount is worked out once on the pair and the arithmetic is on the quote.
      expect(lines.map((l) => l['discountMinor'])).toEqual([2_000, 2_000]);
      expect(lines[0]!['discounts']).toEqual([
        expect.objectContaining({
          name: 'Sibling discount',
          amountMinor: 2_000,
          explanation: expect.arrayContaining([
            '10% of 40000 minor units = 4000 (rounding half_up)',
          ]),
        }),
      ]);
      expect(quote.totalMinor).toBe(36_000);

      const checkout = await ok<{ status: string }>(
        post(t, '/v1/registration-checkouts', parent.header, {
          quoteId: quote.id,
          payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
        }),
        201,
      );
      expect(checkout.status).toBe('completed');
      await drain(t);
      for (const kid of [first, second]) {
        const list = await ok<{ items: Array<Record<string, unknown>> }>(
          get(t, `/v1/enrollments?participantPersonId=${kid}`, parent.header),
        );
        expect(list.items).toEqual([
          expect.objectContaining({ status: 'confirmed', offeringId: klass.offeringId }),
        ]);
      }

      // §4.7 (no duplicate equivalent entitlement): the same child cannot be put into the same class twice.
      const basket = await ok<{ id: string }>(
        post(t, '/v1/baskets', parent.header, { ownerPersonId: parent.personId }),
        201,
      );
      const twice = await post(t, `/v1/baskets/${basket.id}/lines`, parent.header, {
        participantPersonId: first,
        offeringId: klass.offeringId,
        intent: 'youth',
      });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('DUPLICATE_ENTITLEMENT');
    } finally {
      await t.close();
    }
  });

  it('SPK-PAY-013: with per-session pricing turned on, a child joining a ten-session class after three sessions pays the per-session price for the seven still to come', async () => {
    // Proposed amendment PA-02 (DEC-096 pending). Three sessions have been held; seven remain.
    const t = await journeyApp({ clockStart: '2026-11-02T15:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const finance = await staff(t, ['finance_operator']);
      const parent = await adult(t);
      const kid = await child(t, [parent]);
      const klass = await offering(t, { basePriceMinor: null });
      const sessionIds: string[] = [];
      for (let week = 0; week < 10; week += 1) {
        sessionIds.push(
          await createOfferingSessionFixture(t, {
            offeringId: klass.offeringId,
            scheduledStart: new Date(TERM_START + week * WEEK),
            scheduledEnd: new Date(TERM_START + week * WEEK + 3_600_000),
          }),
        );
      }
      const perSessionRule = {
        effectiveFrom: '2026-11-02T15:00:00Z',
        basePriceMinor: 2_400,
        currency: 'USD',
        pricingBasis: 'per_session',
      };

      // Off for a new organization: the per-session rule is refused on write.
      const refused = await post(
        t,
        `/v1/offerings/${klass.offeringId}/price-rules`,
        finance.header,
        perSessionRule,
      );
      expect(refused.status).toBe(403);
      expect(refused.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'per_session_pricing',
      });

      await enableCapability(t, admin, 'per_session_pricing', 'DEC-096');
      const rule = await ok<{ id: string; pricingBasis: string }>(
        post(t, `/v1/offerings/${klass.offeringId}/price-rules`, finance.header, perSessionRule),
        201,
      );
      expect(rule.pricingBasis).toBe('per_session');

      // The class listing shows "24.00 per class" and the sessions still to come.
      const listed = await ok<{ price: Record<string, unknown> }>(
        get(t, `/v1/offerings/${klass.offeringId}`, parent.header),
      );
      expect(listed.price).toMatchObject({
        basePriceMinor: 2_400,
        pricingBasis: 'per_session',
        remainingSessionCount: 7,
        remainingSessionsPriceMinor: 16_800,
      });

      const { basketId } = await basketFor(t, parent, [klass], {
        hold: false,
        participants: [kid],
      });
      const quote = await quoteFor(t, parent, basketId);
      const [line] = quote['lines'] as Array<Record<string, unknown>>;
      // 24.00 per class x 7 classes = 168.00: the per-session price, the count and the product.
      expect(line).toMatchObject({
        priceRuleId: rule.id,
        quantity: 1,
        unitPriceMinor: 16_800,
        baseAmountMinor: 16_800,
        priceBasis: {
          pricingBasis: 'per_session',
          standardPriceMinor: 2_400,
          appliedPrice: 'standard',
          sessions: {
            count: 7,
            sessionIds: sessionIds.slice(3),
            countedAt: '2026-11-02T15:00:00.000Z',
          },
          unitPriceMinor: 16_800,
        },
      });
      expect(quote.totalMinor).toBe(16_800);

      const checkout = await ok<{ status: string }>(
        post(t, '/v1/registration-checkouts', parent.header, {
          quoteId: quote.id,
          payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
        }),
        201,
      );
      expect(checkout.status).toBe('completed');
      await drain(t);
      const enrollments = await ok<{ items: Array<Record<string, unknown>> }>(
        get(t, `/v1/enrollments?participantPersonId=${kid}`, parent.header),
      );
      expect(enrollments.items).toEqual([
        expect.objectContaining({ status: 'confirmed', offeringId: klass.offeringId }),
      ]);

      // Turned off again: what was bought stays as it was (the quote still reads with its basis),
      // and a new quote on the per-session rule is refused rather than charged as a term price.
      await disableCapability(t, admin, 'per_session_pricing', 'DEC-096');
      const read = await ok<{ lines: Array<Record<string, unknown>> }>(
        get(t, `/v1/registration-quotes/${quote.id}`, parent.header),
      );
      expect(read.lines[0]).toMatchObject({ unitPriceMinor: 16_800 });
      const sibling = await child(t, [parent]);
      const next = await basketFor(t, parent, [klass], { hold: false, participants: [sibling] });
      const off = await post(t, '/v1/registration-quotes', parent.header, {
        basketId: next.basketId,
      });
      expect(off.status).toBe(403);
      expect(off.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'per_session_pricing',
      });
    } finally {
      await t.close();
    }
  });
});
