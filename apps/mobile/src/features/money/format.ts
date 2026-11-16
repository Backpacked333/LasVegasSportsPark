/**
 * Display formatting for the participation, money and support screens (SCR-C-32 to SCR-C-35).
 * Display only: amounts arrive in integer minor units with an explicit currency (SPK-PAY-001) and
 * are formatted exactly as sent; the client never computes a price, refund, credit or balance.
 *
 * Instants are shown with the zone named, in the facility's zone when the screen passes one
 * (SPK-SCHED-008) and the device's otherwise. Obligations, installments, credits and makeup
 * entitlements carry no facility of their own (reported as an API gap), so the screens pass the
 * facility zone the app already knows (`useKnownFacilityZone`), else nothing.
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

/** Formats in `zone` when the platform knows it, else in the device's zone. */
function inZone(date: Date, options: Intl.DateTimeFormatOptions, zone?: string): string {
  if (zone) {
    try {
      return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone }).format(date);
    } catch {
      // RangeError for a zone the platform does not know: the device's zone, named, below.
    }
  }
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

/**
 * An instant as "Sat, Oct 24, 12:10 PM PDT": in `zone` (the facility's, SPK-SCHED-008) when
 * given, else the device's; the zone is always named.
 */
export function formatInstant(iso: string, zone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return inZone(
    date,
    {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    },
    zone,
  );
}

/** The day of an instant as "Nov 1, 2026, PDT", in `zone` when given (zone always named). */
export function formatDay(iso: string, zone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return inZone(
    date,
    { month: 'short', day: 'numeric', year: 'numeric', timeZoneName: 'short' },
    zone,
  );
}

export function hasPassed(iso: string, now: Date): boolean {
  return new Date(iso).getTime() <= now.getTime();
}
