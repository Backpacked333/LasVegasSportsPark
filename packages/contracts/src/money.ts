import { z } from './zod';

/**
 * SPK-PAY-001: money is always an integer number of minor units with an explicit currency.
 * Amounts are plain JavaScript numbers constrained to safe integers; the database stores them as bigint.
 */
export const CurrencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const MoneySchema = z.object({
  amountMinor: z.number().int().safe(),
  currency: CurrencyCode,
});
export type Money = z.infer<typeof MoneySchema>;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function money(amountMinor: number, currency: string): Money {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError(`amount must be a safe integer of minor units, got ${amountMinor}`);
  }
  const parsedCurrency = CurrencyCode.safeParse(currency);
  if (!parsedCurrency.success) {
    throw new MoneyError(`invalid currency "${currency}"`);
  }
  return { amountMinor, currency: parsedCurrency.data };
}

export function zero(currency: string): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, item) => add(acc, item), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Split an amount across weighted lines without losing or inventing minor units
 * (largest-remainder allocation). The sum of the result always equals the input.
 * SPK-PAY-003 requires allocation across lines to be explicit and deterministic.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError('cannot allocate across zero lines');
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new MoneyError('weights must be finite and non-negative');
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    throw new MoneyError('weights must not all be zero');
  }
  const sign = total.amountMinor < 0 ? -1 : 1;
  const magnitude = Math.abs(total.amountMinor);
  const raw = weights.map((w) => (magnitude * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = magnitude - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors.map((amount) => money(sign * amount, total.currency));
}

/** Percentage in basis points (1/100 of a percent), rounded half away from zero. */
export function percentageBasisPoints(base: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError('basis points must be an integer');
  }
  const raw = (base.amountMinor * basisPoints) / 10_000;
  const rounded = raw < 0 ? -Math.round(Math.abs(raw)) : Math.round(raw);
  return money(rounded, base.currency);
}

export function formatMoney(a: Money, locale = 'en-US', minorDigits = 2): string {
  const major = a.amountMinor / 10 ** minorDigits;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: a.currency }).format(major);
}
