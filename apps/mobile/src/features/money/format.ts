/**
 * Display formatting for the participation, money and support screens (SCR-C-32 to SCR-C-35).
 * Display only: amounts arrive in integer minor units with an explicit currency (SPK-PAY-001) and
 * are formatted exactly as sent; the client never computes a price, refund, credit or balance.
 *
 * Instants are shown in the device time zone with the zone named. Obligations, installments,
 * credits and makeup entitlements carry no facility, so the facility time zone (SPK-SCHED-008) is
 * not available to these screens (reported as an API gap).
 */

/**
 * `formatMoney(12550, 'USD')` is "$125.50"; negative amounts keep their sign. An unknown currency
 * code falls back to "12550 minor units XYZ" rather than guessing an exponent.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  } catch {
    return `${amountMinor} minor units ${currency}`;
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** digits);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date (`2026-11-02`) as "Nov 2, 2026", with no time-zone shift. */
export function formatDateOnly(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

export function formatDateRange(startsOn: string, endsOn: string): string {
  return startsOn === endsOn
    ? formatDateOnly(startsOn)
    : `${formatDateOnly(startsOn)} to ${formatDateOnly(endsOn)}`;
}

/** An instant as "Sat, Oct 24, 12:10 PM UTC" in the device time zone (zone always named). */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** The day of an instant as "Nov 1, 2026, UTC" in the device time zone (zone always named). */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZoneName: 'short',
  }).format(date);
}

export function hasPassed(iso: string, now: Date): boolean {
  return new Date(iso).getTime() <= now.getTime();
}
