/**
 * Money display for both clients (SPK-PAY-001: the API sends integer minor units with an explicit
 * currency; SPK-PAY-002 quotes, receipts and balances read the same way everywhere, SPK-UX-010).
 * Display only: the client never computes a price, it formats what the API sent.
 */

/** Minor-unit digits of an ISO 4217 currency as the platform's Intl data knows it (USD 2, JPY 0). */
export function currencyDigits(currency: string, locale = 'en-US'): number {
  try {
    const digits = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' ? digits : 2;
  } catch {
    return 2;
  }
}

/**
 * `formatMinorUnits(12550, 'USD')` is "$125.50"; negative amounts (discounts, credits applied)
 * keep their sign. An unknown currency code falls back to "12550 minor units XYZ" rather than
 * guessing an exponent.
 */
export function formatMinorUnits(amountMinor: number, currency: string, locale = 'en-US'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(`amount must be a safe integer of minor units, got ${amountMinor}`);
  }
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency });
  } catch {
    return `${amountMinor} minor units ${currency}`;
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}
