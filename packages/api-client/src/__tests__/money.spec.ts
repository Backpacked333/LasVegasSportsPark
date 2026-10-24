import { describe, expect, it } from 'vitest';
import { currencyDigits, formatMinorUnits } from '../money';

describe('money display (SPK-PAY-001)', () => {
  it('formats integer minor units with the currency exponent', () => {
    expect(formatMinorUnits(12550, 'USD')).toBe('$125.50');
    expect(formatMinorUnits(0, 'USD')).toBe('$0.00');
    expect(formatMinorUnits(-500, 'USD')).toBe('-$5.00');
    expect(formatMinorUnits(1200, 'JPY')).toBe('¥1,200');
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
  });

  it('never guesses an exponent for an unknown currency and refuses non-integer amounts', () => {
    expect(formatMinorUnits(100, 'US')).toBe('100 minor units US');
    expect(() => formatMinorUnits(1.5, 'USD')).toThrow(/safe integer/);
  });
});
