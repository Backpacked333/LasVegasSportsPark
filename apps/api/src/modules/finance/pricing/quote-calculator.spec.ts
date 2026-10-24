import { describe, expect, it } from 'vitest';
import type { ChargeLine, DiscountEvaluation } from '@sportspark/contracts';
import { applyCharges, computeQuote, roundHalfUp, type QuoteLineInput } from './quote-calculator';

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
