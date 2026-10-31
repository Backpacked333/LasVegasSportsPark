import type { DiscountEvaluationLine } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  allocateAcrossLines,
  evaluateDiscounts,
  roundBasisPoints,
  type EvaluableDiscount,
} from './discount-evaluator';

const AT = new Date('2026-10-23T12:00:00Z');

function definition(overrides: Partial<EvaluableDiscount> = {}): EvaluableDiscount {
  return {
    id: overrides.id ?? `d-${overrides.code ?? 'auto'}`,
    code: null,
    name: 'Discount',
    kind: 'automatic',
    amountKind: 'percentage',
    amountValue: 1000,
    currency: null,
    eligibilityRules: {},
    stackingRule: 'exclusive',
    stackingPriority: 100,
    capMinor: null,
    redemptionLimit: null,
    perPersonLimit: null,
    rounding: 'half_up',
    allocationMethod: 'proportional',
    effectiveFrom: '2026-01-01T00:00:00Z',
    effectiveTo: null,
    status: 'active',
    redeemedCount: 0,
    ...overrides,
  };
}

function line(
  lineId: string,
  baseAmountMinor: number,
  extra: Partial<DiscountEvaluationLine> = {},
): DiscountEvaluationLine {
  return {
    lineId,
    offeringId: `o-${lineId}`,
    offeringKind: 'term',
    programId: null,
    participantPersonId: null,
    baseAmountMinor,
    ...extra,
  };
}

const evaluate = (
  lines: DiscountEvaluationLine[],
  definitions: EvaluableDiscount[],
  codes: string[] = [],
  at = AT,
) => evaluateDiscounts({ currency: 'USD', at, lines, codes, definitions });

describe('discount evaluation (SPK-PAY-003)', () => {
  describe('rounding', () => {
    it('rounds a percentage under each mode', () => {
      // 12.5% of 1001 = 125.125
      expect(roundBasisPoints(1001, 1250, 'down')).toBe(125);
      expect(roundBasisPoints(1001, 1250, 'up')).toBe(126);
      expect(roundBasisPoints(1001, 1250, 'half_up')).toBe(125);
      // 2.5% of 1000 = 25 exactly; 5% of 1005 = 50.25; 15% of 1010 = 151.5
      expect(roundBasisPoints(1010, 1500, 'half_up')).toBe(152);
      expect(roundBasisPoints(1010, 1500, 'half_even')).toBe(152);
      expect(roundBasisPoints(1030, 1500, 'half_even')).toBe(154); // 154.5 → even
      expect(roundBasisPoints(1030, 1500, 'half_up')).toBe(155);
      expect(roundBasisPoints(0, 1500, 'up')).toBe(0);
    });

    it('applies the definition rounding to the eligible subtotal', () => {
      const lines = [line('a', 1030)];
      expect(
        evaluate(lines, [definition({ amountValue: 1500, rounding: 'half_even' })])
          .totalDiscountMinor,
      ).toBe(154);
      expect(
        evaluate(lines, [definition({ amountValue: 1500, rounding: 'half_up' })])
          .totalDiscountMinor,
      ).toBe(155);
      expect(
        evaluate(lines, [definition({ amountValue: 1500, rounding: 'down' })]).totalDiscountMinor,
      ).toBe(154);
    });
  });

  describe('eligibility', () => {
    it('limits by offering kind, offering id, program id and minimum line amount', () => {
      const lines = [
        line('camp', 30_000, { offeringKind: 'camp', programId: 'p1' }),
        line('term', 15_000, { offeringKind: 'term', programId: 'p2' }),
        line('small', 500, { offeringKind: 'camp', programId: 'p1' }),
      ];
      const byKind = evaluate(lines, [
        definition({ eligibilityRules: { offeringKinds: ['camp'] } }),
      ]);
      expect(byKind.lines.map((l) => l.discountMinor)).toEqual([3000, 0, 50]);
      const byProgram = evaluate(lines, [definition({ eligibilityRules: { programIds: ['p2'] } })]);
      expect(byProgram.lines.map((l) => l.discountMinor)).toEqual([0, 1500, 0]);
      const byId = evaluate(lines, [
        definition({ eligibilityRules: { offeringIds: ['o-small'] } }),
      ]);
      expect(byId.lines.map((l) => l.discountMinor)).toEqual([0, 0, 50]);
      const byAmount = evaluate(lines, [
        definition({ eligibilityRules: { minLineAmountMinor: 1000 } }),
      ]);
      expect(byAmount.lines.map((l) => l.discountMinor)).toEqual([3000, 1500, 0]);
    });

    it('sibling discounts need the minimum number of eligible lines', () => {
      const def = definition({ eligibilityRules: { minLines: 2 } });
      const single = evaluate([line('a', 10_000)], [def]);
      expect(single.discounts[0]).toMatchObject({ applied: false });
      expect(single.discounts[0]?.explanation.join(' ')).toMatch(/needs at least 2 eligible lines/);
      const pair = evaluate([line('a', 10_000), line('b', 10_000)], [def]);
      expect(pair.totalDiscountMinor).toBe(2000);
    });

    it('early registration applies only before the cutoff; effective dates and status gate every definition', () => {
      const early = definition({
        eligibilityRules: { registrationBefore: '2026-11-01T00:00:00Z' },
      });
      expect(evaluate([line('a', 10_000)], [early]).totalDiscountMinor).toBe(1000);
      expect(
        evaluate([line('a', 10_000)], [early], [], new Date('2026-11-01T00:00:00Z'))
          .totalDiscountMinor,
      ).toBe(0);
      const future = definition({ effectiveFrom: '2027-01-01T00:00:00Z' });
      const expired = definition({ effectiveTo: '2026-10-23T12:00:00Z' });
      const draft = definition({ status: 'draft' });
      const retired = definition({ status: 'retired' });
      const result = evaluate([line('a', 10_000)], [future, expired, draft, retired]);
      expect(result.totalDiscountMinor).toBe(0);
      expect(result.discounts).toEqual([]);
    });

    it('promo codes apply only when submitted, case-insensitively; unknown codes are reported', () => {
      const promo = definition({ code: 'Spring10', kind: 'promo_code' });
      const none = evaluate([line('a', 10_000)], [promo]);
      expect(none.totalDiscountMinor).toBe(0);
      const withCode = evaluate([line('a', 10_000)], [promo], ['SPRING10', 'bogus']);
      expect(withCode.totalDiscountMinor).toBe(1000);
      expect(withCode.unknownCodes).toEqual(['bogus']);
    });

    it('a fixed discount needs the basket currency and never exceeds the eligible subtotal', () => {
      const eur = definition({ amountKind: 'fixed', amountValue: 500, currency: 'EUR' });
      expect(evaluate([line('a', 10_000)], [eur]).discounts[0]).toMatchObject({ applied: false });
      const big = definition({ amountKind: 'fixed', amountValue: 50_000, currency: 'USD' });
      const result = evaluate([line('a', 10_000)], [big]);
      expect(result.totalDiscountMinor).toBe(10_000);
      expect(result.lines[0]?.netAmountMinor).toBe(0);
    });
  });

  describe('caps, redemption limits and per-person limits', () => {
    it('caps the amount and explains it', () => {
      const result = evaluate([line('a', 100_000)], [definition({ capMinor: 2_500 })]);
      expect(result.totalDiscountMinor).toBe(2_500);
      expect(result.discounts[0]?.explanation).toContain('capped at 2500 minor units');
    });

    it('skips an exhausted definition', () => {
      const result = evaluate(
        [line('a', 10_000)],
        [definition({ redemptionLimit: 3, redeemedCount: 3 })],
      );
      expect(result.discounts[0]).toMatchObject({ applied: false });
      expect(result.discounts[0]?.explanation.join(' ')).toMatch(/redemption limit 3 reached/);
      expect(
        evaluate([line('a', 10_000)], [definition({ redemptionLimit: 3, redeemedCount: 2 })])
          .totalDiscountMinor,
      ).toBe(1000);
    });

    it('excludes participants who already used their per-person allowance', () => {
      const def = definition({ perPersonLimit: 1, redeemedByPerson: { alice: 1 } });
      const result = evaluate(
        [
          line('a', 10_000, { participantPersonId: 'alice' }),
          line('b', 10_000, { participantPersonId: 'bob' }),
        ],
        [def],
      );
      expect(result.lines.map((l) => l.discountMinor)).toEqual([0, 1000]);
    });
  });

  describe('stacking', () => {
    const exclusive = definition({
      id: 'ex',
      name: 'Exclusive 20%',
      amountValue: 2000,
      stackingPriority: 10,
    });
    const stackA = definition({
      id: 'sa',
      name: 'Stack A 10%',
      stackingRule: 'stackable',
      stackingPriority: 20,
    });
    const stackB = definition({
      id: 'sb',
      name: 'Stack B 10%',
      stackingRule: 'stackable',
      stackingPriority: 30,
    });

    it('an applied exclusive discount blocks everything after it', () => {
      const result = evaluate([line('a', 10_000)], [exclusive, stackA, stackB]);
      expect(result.totalDiscountMinor).toBe(2000);
      expect(result.discounts.map((d) => d.applied)).toEqual([true, false, false]);
      expect(result.discounts[1]?.explanation.join(' ')).toMatch(
        /cannot stack with exclusive discount Exclusive 20%/,
      );
    });

    it('stackable discounts apply sequentially on the remaining amount; a later exclusive one is skipped', () => {
      const lateExclusive = definition({
        id: 'ex2',
        name: 'Late exclusive',
        amountValue: 5000,
        stackingPriority: 40,
      });
      const result = evaluate([line('a', 10_000)], [stackA, stackB, lateExclusive]);
      expect(result.discounts.map((d) => [d.name, d.applied, d.amountMinor])).toEqual([
        ['Stack A 10%', true, 1000],
        ['Stack B 10%', true, 900],
        ['Late exclusive', false, 0],
      ]);
      expect(result.totalNetMinor).toBe(8100);
    });

    it('never discounts a line below zero', () => {
      const sixty = (id: string) =>
        definition({ id, amountValue: 6000, stackingRule: 'stackable' });
      const result = evaluate([line('a', 1000)], [sixty('x'), sixty('y')]);
      expect(result.lines[0]).toMatchObject({ discountMinor: 840, netAmountMinor: 160 });
    });

    it('is deterministic: priority, then exclusive first, then id', () => {
      const a = definition({
        id: 'b-id',
        name: 'B',
        stackingRule: 'stackable',
        stackingPriority: 5,
      });
      const b = definition({
        id: 'a-id',
        name: 'A',
        stackingRule: 'stackable',
        stackingPriority: 5,
      });
      const result = evaluate([line('a', 10_000)], [a, b]);
      expect(result.discounts.map((d) => d.name)).toEqual(['A', 'B']);
    });
  });

  describe('allocation across lines (SPK-PAY-003)', () => {
    const lines = [
      { lineId: 'a', remaining: 15_000 },
      { lineId: 'b', remaining: 30_000 },
      { lineId: 'c', remaining: 100 },
    ];

    it('proportional allocation sums exactly to the amount (largest remainder)', () => {
      const result = allocateAcrossLines(1001, lines, 'proportional', 'USD');
      expect(result.reduce((s, a) => s + a.amountMinor, 0)).toBe(1001);
      expect(result).toEqual([
        { lineId: 'a', amountMinor: 333 },
        { lineId: 'b', amountMinor: 666 },
        { lineId: 'c', amountMinor: 2 },
      ]);
    });

    it('largest-first and first-line fill lines in order without exceeding their remaining amount', () => {
      expect(allocateAcrossLines(31_000, lines, 'largest_first', 'USD')).toEqual([
        { lineId: 'a', amountMinor: 1_000 },
        { lineId: 'b', amountMinor: 30_000 },
        { lineId: 'c', amountMinor: 0 },
      ]);
      expect(allocateAcrossLines(16_000, lines, 'first_line', 'USD')).toEqual([
        { lineId: 'a', amountMinor: 15_000 },
        { lineId: 'b', amountMinor: 1_000 },
        { lineId: 'c', amountMinor: 0 },
      ]);
    });

    it('even allocation clamps to a small line and hands the rest to lines with room', () => {
      const result = allocateAcrossLines(3_000, lines, 'even', 'USD');
      expect(result.reduce((s, a) => s + a.amountMinor, 0)).toBe(3_000);
      expect(result.find((a) => a.lineId === 'c')?.amountMinor).toBe(100);
      expect(result.find((a) => a.lineId === 'b')?.amountMinor).toBe(1_900);
      expect(result.find((a) => a.lineId === 'a')?.amountMinor).toBe(1_000);
    });

    it('the evaluation reports per-line allocations that reconcile with totals', () => {
      const result = evaluate(
        [line('a', 15_000), line('b', 30_000)],
        [definition({ allocationMethod: 'largest_first', amountValue: 500 })],
      );
      expect(result.discounts[0]?.allocations).toEqual([{ lineId: 'b', amountMinor: 2250 }]);
      expect(result.totalDiscountMinor).toBe(2250);
      expect(result.totalNetMinor).toBe(42_750);
      expect(result.evaluatedAt).toBe(AT.toISOString());
    });
  });
});
