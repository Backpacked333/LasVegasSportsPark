import { describe, expect, it } from 'vitest';
import { TaxFeeContent, applyRate, chargeFor, returnedShare } from './pos-charges';

// FIN-06, SPK-PAY-002 (DEC-057): the arithmetic of approved POS taxes and fees. Rates and
// rounding below are test inputs, not policy values.

describe('applyRate', () => {
  it('rounds a half minor unit up under half_up', () => {
    // 250 * 1000 bp = 25.0 exactly; 255 * 1000 bp = 25.5
    expect(applyRate(250, 1000, 'half_up')).toBe(25);
    expect(applyRate(255, 1000, 'half_up')).toBe(26);
    expect(applyRate(254, 1000, 'half_up')).toBe(25);
  });

  it('rounds a half minor unit to even under half_even', () => {
    expect(applyRate(255, 1000, 'half_even')).toBe(26); // 25.5 -> 26
    expect(applyRate(245, 1000, 'half_even')).toBe(24); // 24.5 -> 24
    expect(applyRate(246, 1000, 'half_even')).toBe(25); // 24.6 -> 25
  });

  it('truncates under down', () => {
    expect(applyRate(259, 1000, 'down')).toBe(25);
    expect(applyRate(0, 1000, 'down')).toBe(0);
  });

  it('stays exact for large amounts', () => {
    expect(applyRate(9_007_199_254_740, 825, 'half_up')).toBe(743_093_938_516);
  });
});

describe('TaxFeeContent', () => {
  const base = { code: 'T', label: 'Test charge', kind: 'tax', rounding: 'half_up' } as const;

  it('accepts a rate or a fixed amount with its currency, not both or neither', () => {
    expect(TaxFeeContent.safeParse({ ...base, rateBasisPoints: 825 }).success).toBe(true);
    expect(TaxFeeContent.safeParse({ ...base, amountMinor: 100, currency: 'USD' }).success).toBe(
      true,
    );
    expect(
      TaxFeeContent.safeParse({ ...base, rateBasisPoints: 825, amountMinor: 100, currency: 'USD' })
        .success,
    ).toBe(false);
    expect(TaxFeeContent.safeParse({ ...base }).success).toBe(false);
    expect(TaxFeeContent.safeParse({ ...base, amountMinor: 100 }).success).toBe(false);
  });

  it('refuses content without an approved rounding rule', () => {
    const { rounding: _rounding, ...withoutRounding } = base;
    expect(TaxFeeContent.safeParse({ ...withoutRounding, rateBasisPoints: 825 }).success).toBe(
      false,
    );
  });
});

describe('chargeFor', () => {
  it('applies a rate once to the line base and a fixed amount per unit', () => {
    const rate = TaxFeeContent.parse({
      code: 'RATE',
      label: 'Rate',
      kind: 'tax',
      rateBasisPoints: 1000,
      rounding: 'half_up',
    });
    const fixed = TaxFeeContent.parse({
      code: 'FIX',
      label: 'Fixed',
      kind: 'fee',
      amountMinor: 50,
      currency: 'USD',
      rounding: 'down',
    });
    expect(chargeFor(rate, 'v1', 1_005, 3)).toEqual({
      policyVersionId: 'v1',
      code: 'RATE',
      label: 'Rate',
      kind: 'tax',
      amountMinor: 101,
    });
    expect(chargeFor(fixed, 'v2', 1_005, 3).amountMinor).toBe(150);
  });
});

describe('returnedShare', () => {
  const line = {
    quantity: 3,
    baseMinor: 1_000,
    currency: 'USD',
    charges: [
      {
        policyVersionId: 'v1',
        code: 'RATE',
        label: 'Rate',
        kind: 'tax' as const,
        amountMinor: 100,
      },
    ],
  };

  it('SPK-PAY-010: returning every unit in parts returns exactly what was paid', () => {
    const first = returnedShare(line, 0, 1);
    const second = returnedShare(line, 1, 2);
    expect(first.baseMinor + second.baseMinor).toBe(1_000);
    expect(first.charges[0]!.amountMinor + second.charges[0]!.amountMinor).toBe(100);
    // largest remainder: 334 + 333 + 333
    expect(first.baseMinor).toBe(334);
    expect(second.baseMinor).toBe(666);
  });
});
