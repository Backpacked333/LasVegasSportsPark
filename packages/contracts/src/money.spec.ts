import { describe, expect, it } from 'vitest';
import { add, allocate, money, percentageBasisPoints, subtract, sum } from './money';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow(/safe integer/);
  });

  it('rejects invalid currencies', () => {
    expect(() => money(100, 'usd')).toThrow(/currency/);
  });

  it('adds and subtracts same-currency amounts only', () => {
    expect(add(money(100, 'USD'), money(50, 'USD'))).toEqual(money(150, 'USD'));
    expect(subtract(money(100, 'USD'), money(150, 'USD'))).toEqual(money(-50, 'USD'));
    expect(() => add(money(1, 'USD'), money(1, 'EUR'))).toThrow(/mismatch/);
  });

  it('allocates without losing or inventing minor units', () => {
    const parts = allocate(money(100, 'USD'), [1, 1, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([34, 33, 33]);
    expect(sum(parts, 'USD')).toEqual(money(100, 'USD'));
  });

  it('allocates negative totals symmetrically', () => {
    const parts = allocate(money(-101, 'USD'), [3, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([-76, -25]);
    expect(sum(parts, 'USD')).toEqual(money(-101, 'USD'));
  });

  it('allocates deterministically across many lines', () => {
    const parts = allocate(money(1000, 'USD'), [7, 3, 3, 3, 3, 3]);
    expect(parts.reduce((a, p) => a + p.amountMinor, 0)).toBe(1000);
  });

  it('computes basis-point percentages with half-away-from-zero rounding', () => {
    expect(percentageBasisPoints(money(1005, 'USD'), 500)).toEqual(money(50, 'USD'));
    expect(percentageBasisPoints(money(1010, 'USD'), 500)).toEqual(money(51, 'USD'));
    expect(percentageBasisPoints(money(-1010, 'USD'), 500)).toEqual(money(-51, 'USD'));
  });
});
