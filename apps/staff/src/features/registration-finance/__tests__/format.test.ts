/**
 * Money and time helpers (SPK-PAY-001 integer minor units with a currency; SPK-SCHED-008
 * facility-local time with the zone named).
 */
import { describe, expect, it } from 'vitest';
import {
  dateToInstant,
  formatDate,
  formatInstant,
  formatMoney,
  instantToLocal,
  localToInstant,
  minorDigits,
  parseMoneyInput,
} from '../format';

describe('money (SPK-PAY-001)', () => {
  it('formats minor units with the currency, including negatives, and never shows a missing amount as zero', () => {
    expect(formatMoney(12500, 'USD')).toBe('$125.00');
    expect(formatMoney(-500, 'USD')).toBe('-$5.00');
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
    expect(formatMoney(null, 'USD')).toBe('Not stated');
    expect(formatMoney(100, null)).toBe('100 minor units (currency not stated)');
  });

  it('parses typed amounts into minor units without floating point and refuses extra decimals', () => {
    expect(minorDigits('USD')).toBe(2);
    expect(parseMoneyInput('125', 'USD')).toBe(12500);
    expect(parseMoneyInput('125.5', 'USD')).toBe(12550);
    expect(parseMoneyInput('0.29', 'USD')).toBe(29);
    expect(parseMoneyInput('1,250.00', 'USD')).toBe(125000);
    expect(parseMoneyInput('12.345', 'USD')).toBeNull();
    expect(parseMoneyInput('-5', 'USD')).toBeNull();
    expect(parseMoneyInput('0', 'USD')).toBeNull();
    expect(parseMoneyInput('0', 'USD', true)).toBe(0);
    expect(parseMoneyInput('1500', 'JPY')).toBe(1500);
    expect(parseMoneyInput('15.5', 'JPY')).toBeNull();
  });
});

describe('time (SPK-SCHED-008)', () => {
  it('reads wall-clock input in the facility zone across a daylight saving change', () => {
    expect(localToInstant('2026-10-31T09:00', 'America/Los_Angeles')).toBe(
      '2026-10-31T16:00:00.000Z',
    );
    expect(localToInstant('2026-11-01T09:00', 'America/Los_Angeles')).toBe(
      '2026-11-01T17:00:00.000Z',
    );
    expect(localToInstant('2026-11-01T09:00', null)).toBe('2026-11-01T09:00:00.000Z');
    expect(localToInstant('not a time', 'America/Los_Angeles')).toBeNull();
  });

  it('round-trips an instant to the facility’s wall clock for edit forms', () => {
    expect(instantToLocal('2026-11-01T17:00:00.000Z', 'America/Los_Angeles')).toBe(
      '2026-11-01T09:00',
    );
    expect(instantToLocal(null, 'America/Los_Angeles')).toBe('');
  });

  it('names the zone when formatting and does not shift calendar dates', () => {
    expect(formatInstant('2026-11-02T01:00:00.000Z', 'America/Los_Angeles')).toMatch(
      /Nov 1, 2026, 05:00 PM PST/,
    );
    expect(formatInstant(null)).toBe('Not set');
    expect(formatDate('2026-11-02')).toBe('Nov 2, 2026');
    expect(dateToInstant('2026-10-23')).toBe('2026-10-23T00:00:00.000Z');
    expect(dateToInstant('2026-10-23', true)).toBe('2026-10-24T00:00:00.000Z');
    expect(dateToInstant('23/10/2026')).toBeNull();
  });
});
