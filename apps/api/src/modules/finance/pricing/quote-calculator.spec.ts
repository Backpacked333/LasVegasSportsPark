import { describe, expect, it } from 'vitest';
import type { ChargeLine, DiscountEvaluation, QuoteLinePriceBasis } from '@sportspark/contracts';
import {
  applyCharges,
  computeQuote,
  priceBasisOf,
  roundHalfUp,
  unitPriceFromBasis,
  type LinePricingFacts,
  type QuoteLineInput,
} from './quote-calculator';

const NOW = new Date('2026-11-02T15:00:00Z');
const policies = {
  eligibilityPolicyVersionId: null,
  cancellationPolicyVersionId: null,
  requiredFormPolicyVersionIds: [],
  approvalPolicyVersionId: null,
};

function line(id: string, price: number, chargeLines: ChargeLine[] = []): QuoteLineInput {
  return {
    basketLineId: id,
    participantPersonId: '00000000-0000-7000-8000-000000000001',
    offeringId: '00000000-0000-7000-8000-000000000002',
    description: `line ${id}`,
    quantity: 1,
    priceRule: { id: `rule-${id}`, basePriceMinor: price, currency: 'USD', chargeLines },
    policies,
    equivalenceKey: null,
    enrollmentId: null,
  };
}

describe('quote arithmetic (SPK-PAY-001/002/003)', () => {
  it('rounds half up on integers only', () => {
    expect(roundHalfUp(5, 10)).toBe(1);
    expect(roundHalfUp(4, 10)).toBe(0);
    expect(roundHalfUp(15, 10)).toBe(2);
  });

  it('SPK-PAY-002: exclusive taxes and fees are added, inclusive ones only shown', () => {
    const charges = applyCharges(10_000, 1, [
      { code: 'tax', label: 'Sales tax', kind: 'tax', basisPoints: 825, inclusive: false },
      { code: 'fee', label: 'Facility fee', kind: 'fee', amountMinor: 300, inclusive: false },
      { code: 'vat', label: 'Included tax', kind: 'tax', basisPoints: 1000, inclusive: true },
    ]);
    expect(charges.taxMinor).toBe(825);
    expect(charges.feeMinor).toBe(300);
    expect(charges.includedMinor).toBe(909);
  });

  it('SPK-PAY-002/003: totals, discounts per line, credits and due now stay consistent', () => {
    const discount: DiscountEvaluation = {
      currency: 'USD',
      evaluatedAt: NOW.toISOString(),
      lines: [
        { lineId: 'a', baseAmountMinor: 12_500, discountMinor: 1_250, netAmountMinor: 11_250 },
        { lineId: 'b', baseAmountMinor: 30_000, discountMinor: 3_000, netAmountMinor: 27_000 },
      ],
      discounts: [
        {
          discountDefinitionId: '00000000-0000-7000-8000-000000000003',
          code: 'SIBLING',
          name: 'Sibling',
          applied: true,
          amountMinor: 4_250,
          allocations: [
            { lineId: 'a', amountMinor: 1_250 },
            { lineId: 'b', amountMinor: 3_000 },
          ],
          explanation: ['10%'],
        },
      ],
      totalBaseMinor: 42_500,
      totalDiscountMinor: 4_250,
      totalNetMinor: 38_250,
      unknownCodes: [],
    };
    const quote = computeQuote({
      currency: 'USD',
      lines: [
        line('a', 12_500, [
          { code: 'fee', label: 'Fee', kind: 'fee', amountMinor: 200, inclusive: false },
        ]),
        line('b', 30_000),
      ],
      discountEvaluation: discount,
      credits: [{ creditId: 'c1', remainingMinor: 1_000 }],
      plan: { kind: 'full' },
      now: NOW,
    });
    expect(quote.subtotalMinor).toBe(42_500);
    expect(quote.discountMinor).toBe(4_250);
    expect(quote.feeMinor).toBe(200);
    expect(quote.totalMinor).toBe(38_450);
    expect(quote.lines.map((l) => l.totalMinor)).toEqual([11_450, 27_000]);
    expect(quote.creditsAppliedMinor).toBe(1_000);
    expect(quote.dueNowMinor).toBe(37_450);
    expect(quote.futureObligations).toEqual([]);
  });

  it('SPK-PAY-006: installments split without losing a minor unit and schedule future obligations', () => {
    const quote = computeQuote({
      currency: 'USD',
      lines: [line('a', 10_000)],
      discountEvaluation: null,
      credits: [],
      plan: { kind: 'installments', count: 3, intervalDays: 30 },
      now: NOW,
    });
    expect(quote.installmentAmounts).toEqual([3_334, 3_333, 3_333]);
    expect(quote.dueNowMinor).toBe(3_334);
    expect(quote.futureMinor).toBe(6_666);
    expect(quote.futureObligations.map((f) => f.dueAt)).toEqual([
      '2026-12-02T15:00:00.000Z',
      '2027-01-01T15:00:00.000Z',
    ]);
  });

  it('credits never exceed the total and a fully covered quote is due zero now', () => {
    const quote = computeQuote({
      currency: 'USD',
      lines: [line('a', 5_000)],
      discountEvaluation: null,
      credits: [
        { creditId: 'c1', remainingMinor: 3_000 },
        { creditId: 'c2', remainingMinor: 9_000 },
      ],
      plan: { kind: 'full' },
      now: NOW,
    });
    expect(quote.appliedCredits).toEqual([
      { creditId: 'c1', amountMinor: 3_000 },
      { creditId: 'c2', amountMinor: 2_000 },
    ]);
    expect(quote.dueNowMinor).toBe(0);
  });

  it('refuses mixed currencies', () => {
    const eur = line('a', 1_000);
    eur.priceRule = { ...eur.priceRule!, currency: 'EUR' };
    expect(() =>
      computeQuote({
        currency: 'USD',
        lines: [eur],
        discountEvaluation: null,
        credits: [],
        plan: { kind: 'full' },
        now: NOW,
      }),
    ).toThrow(/same currency/);
  });
});

describe('inclusive charges extracted together (R3-TIME-MONEY-09, SPK-PAY-002)', () => {
  it('SPK-PAY-002: a price including 5% and 3% contains 500 and 300 of a 10000 base, not 514 and 315', () => {
    const charges = applyCharges(10_800, 1, [
      { code: 'state', label: 'State tax', kind: 'tax', basisPoints: 500, inclusive: true },
      { code: 'city', label: 'City tax', kind: 'tax', basisPoints: 300, inclusive: true },
    ]);
    expect(charges.charges.map((c) => c.amountMinor)).toEqual([500, 300]);
    expect(charges.includedMinor).toBe(800);
    expect(charges.taxMinor).toBe(0);
  });

  it('the parts add up to the included total by the largest remainder, and one rate is unchanged', () => {
    // 9999 including 7.25% and 2.5%: included = round(9999 * 975 / 10975) = 888, split 660 / 228.
    const two = applyCharges(9_999, 1, [
      { code: 'a', label: 'A', kind: 'tax', basisPoints: 725, inclusive: true },
      { code: 'fee', label: 'Fee', kind: 'fee', amountMinor: 150, inclusive: false },
      { code: 'b', label: 'B', kind: 'tax', basisPoints: 250, inclusive: true },
    ]);
    expect(two.charges.map((c) => c.amountMinor)).toEqual([660, 150, 228]);
    expect(two.includedMinor).toBe(888);
    expect(two.feeMinor).toBe(150);
    // A single inclusive rate keeps its earlier extraction (net * bp / (10000 + bp), half up).
    expect(
      applyCharges(10_000, 1, [
        { code: 'vat', label: 'VAT', kind: 'tax', basisPoints: 1_000, inclusive: true },
      ]).includedMinor,
    ).toBe(roundHalfUp(10_000 * 1_000, 11_000));
  });
});

/**
 * Proposed amendments PA-02 (SPK-PAY-013) and PA-04 (SPK-PAY-015). The order is fixed (ADR-003):
 * the member price is chosen first, then a per-session price is multiplied by the sessions
 * counted. Prices are test data, not policy.
 */
describe('per-session and member price arithmetic (SPK-PAY-013, SPK-PAY-015)', () => {
  const COUNTED_AT = NOW.toISOString();
  const sessionIds = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `00000000-0000-7000-8000-0000000001${String(i).padStart(2, '0')}`,
    );
  const member = (holds: boolean): NonNullable<LinePricingFacts['member']> => ({
    priceMinor: 2_000,
    entitlementDefinitionId: '00000000-0000-7000-8000-000000000010',
    entitlementName: 'Annual membership',
    holds,
    reason: holds ? 'active_membership' : 'no_active_membership',
    membershipEnrollmentId: holds ? '00000000-0000-7000-8000-000000000011' : null,
    checkedAt: COUNTED_AT,
  });
  const priced = (pricing: LinePricingFacts | null, quantity = 1): QuoteLineInput => ({
    ...line('a', 2_400),
    quantity,
    pricing,
  });
  const quote = (lines: QuoteLineInput[], discountEvaluation: DiscountEvaluation | null = null) =>
    computeQuote({
      currency: 'USD',
      lines,
      discountEvaluation,
      credits: [],
      plan: { kind: 'full' },
      now: NOW,
    });

  it('SPK-PAY-013: a per-session price is multiplied by the sessions counted, inside the unit price; quantity stays the basket quantity', () => {
    const [computed] = quote([
      priced({
        pricingBasis: 'per_session',
        member: null,
        sessions: { sessionIds: sessionIds(7), countedAt: COUNTED_AT },
      }),
    ]).lines;
    expect(computed).toMatchObject({
      quantity: 1,
      unitPriceMinor: 16_800,
      baseAmountMinor: 16_800,
      totalMinor: 16_800,
    });
    // The quote shows the per-session price, the count and the product.
    expect(computed?.priceBasis).toEqual({
      pricingBasis: 'per_session',
      standardPriceMinor: 2_400,
      appliedPrice: 'standard',
      appliedPriceMinor: 2_400,
      member: null,
      sessions: { count: 7, sessionIds: sessionIds(7), countedAt: COUNTED_AT },
      unitPriceMinor: 16_800,
    });
    // base = unit x quantity keeps holding for a basket quantity above one.
    const [two] = quote([
      priced(
        {
          pricingBasis: 'per_session',
          member: null,
          sessions: { sessionIds: sessionIds(7), countedAt: COUNTED_AT },
        },
        2,
      ),
    ]).lines;
    expect(two).toMatchObject({ quantity: 2, unitPriceMinor: 16_800, baseAmountMinor: 33_600 });
  });

  it('SPK-PAY-015: the member price applies only when the participant holds the membership, and the basis says which price applied and why', () => {
    const applied = quote([priced({ pricingBasis: 'term', member: member(true), sessions: null })])
      .lines[0];
    expect(applied).toMatchObject({ unitPriceMinor: 2_000, baseAmountMinor: 2_000 });
    expect(applied?.priceBasis).toMatchObject({
      pricingBasis: 'term',
      standardPriceMinor: 2_400,
      appliedPrice: 'member',
      appliedPriceMinor: 2_000,
      member: {
        applied: true,
        reason: 'active_membership',
        entitlementName: 'Annual membership',
        membershipEnrollmentId: '00000000-0000-7000-8000-000000000011',
      },
      sessions: null,
    });
    const standard = quote([
      priced({ pricingBasis: 'term', member: member(false), sessions: null }),
    ]).lines[0];
    expect(standard).toMatchObject({ unitPriceMinor: 2_400 });
    expect(standard?.priceBasis).toMatchObject({
      appliedPrice: 'standard',
      appliedPriceMinor: 2_400,
      member: { applied: false, reason: 'no_active_membership', membershipEnrollmentId: null },
    });
  });

  it('SPK-PAY-013, SPK-PAY-015: the order is member price, then per-session multiplication; discounts and charges follow on the result', () => {
    const facts: LinePricingFacts = {
      pricingBasis: 'per_session',
      member: member(true),
      sessions: { sessionIds: sessionIds(7), countedAt: COUNTED_AT },
    };
    // Member price 20.00 per session x 7 sessions = 140.00 (not 24.00 x 7 less something).
    expect(priceBasisOf(2_400, facts)).toMatchObject({
      appliedPrice: 'member',
      appliedPriceMinor: 2_000,
      sessions: { count: 7 },
      unitPriceMinor: 14_000,
    });
    const discount: DiscountEvaluation = {
      currency: 'USD',
      evaluatedAt: NOW.toISOString(),
      lines: [
        { lineId: 'a', baseAmountMinor: 14_000, discountMinor: 1_400, netAmountMinor: 12_600 },
      ],
      discounts: [],
      totalBaseMinor: 14_000,
      totalDiscountMinor: 1_400,
      totalNetMinor: 12_600,
      unknownCodes: [],
    };
    const computed = quote(
      [
        {
          ...priced(facts),
          priceRule: {
            id: 'rule-a',
            basePriceMinor: 2_400,
            currency: 'USD',
            chargeLines: [
              {
                code: 'tax',
                label: 'Sales tax',
                kind: 'tax',
                basisPoints: 1_000,
                inclusive: false,
              },
            ],
          },
        },
      ],
      discount,
    );
    expect(computed.lines[0]).toMatchObject({
      unitPriceMinor: 14_000,
      baseAmountMinor: 14_000,
      discountMinor: 1_400,
      taxMinor: 1_260,
      totalMinor: 13_860,
    });
    expect(computed.totalMinor).toBe(13_860);
  });

  it('SPK-PAY-002: the unit price is reproducible from the stored basis alone', () => {
    const cases: LinePricingFacts[] = [
      {
        pricingBasis: 'per_session',
        member: null,
        sessions: { sessionIds: sessionIds(7), countedAt: COUNTED_AT },
      },
      {
        pricingBasis: 'per_session',
        member: member(true),
        sessions: { sessionIds: sessionIds(3), countedAt: COUNTED_AT },
      },
      {
        pricingBasis: 'per_session',
        member: member(false),
        sessions: { sessionIds: sessionIds(1), countedAt: COUNTED_AT },
      },
      { pricingBasis: 'term', member: member(true), sessions: null },
      { pricingBasis: 'term', member: member(false), sessions: null },
    ];
    for (const facts of cases) {
      // Through JSON, as the database stores it.
      const stored = JSON.parse(JSON.stringify(priceBasisOf(2_400, facts))) as QuoteLinePriceBasis;
      expect(unitPriceFromBasis(stored)).toBe(stored.unitPriceMinor);
      expect(stored.sessions?.count ?? null).toBe(stored.sessions?.sessionIds.length ?? null);
    }
    expect(cases.map((facts) => priceBasisOf(2_400, facts).unitPriceMinor)).toEqual([
      16_800, 6_000, 2_400, 2_000, 2_400,
    ]);
  });

  it('SPK-PAY-013: a per-session line with no session left has no price (no minimum charge is invented)', () => {
    expect(() =>
      priceBasisOf(2_400, {
        pricingBasis: 'per_session',
        member: null,
        sessions: { sessionIds: [], countedAt: COUNTED_AT },
      }),
    ).toThrow(/No session of this offering can still be attended/);
  });

  it('a line without pricing facts is priced at the base price with no basis, exactly as before the amendments', () => {
    const [plain] = quote([line('a', 2_400)]).lines;
    expect(plain).toMatchObject({ unitPriceMinor: 2_400, baseAmountMinor: 2_400 });
    expect(plain?.priceBasis).toBeNull();
    expect(quote([priced(null)]).lines[0]?.priceBasis).toBeNull();
  });
});
