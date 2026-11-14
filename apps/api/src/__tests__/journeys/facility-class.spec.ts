import { describe, expect, it } from 'vitest';
import { createDiscountFixture, createOfferingSessionFixture } from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import { basketFor, offering, quoteFor } from '../../modules/finance/__tests__/support';
import { adult, child, drain, get, journeyApp, ok, post } from './support';

/**
 * Phase 0 verification of class registration against the way the facility's current system is
 * used (docs/package-a/legacy-parity-verification.md). It records what the assembled application
 * does today; an assertion marked "recorded gap" documents present behaviour, not a requirement.
 * Prices, dates and discount values are test data, not policy.
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
      // Recorded gap (proposed amendment PA-02): three of ten sessions are over and each child is
      // still priced for the whole term.
      expect(lines.map((l) => l['unitPriceMinor'])).toEqual([20_000, 20_000]);
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
});
