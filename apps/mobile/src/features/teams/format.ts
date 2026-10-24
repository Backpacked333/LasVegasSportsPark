/**
 * Display formatting for the team screens (SCR-C-21 to SCR-C-29). Display only: amounts come from
 * the API in integer minor units with their currency (SPK-PAY-001) and are never computed here;
 * instants are the server's.
 *
 * Times are shown in the device's time zone with the zone named: fixtures do not carry their
 * facility's time zone in the API (SPK-SCHED-008; reported as an API gap).
 */

/** Minor-unit digits of an ISO 4217 currency from the platform's Intl data (USD 2, JPY 0). */
export function currencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' ? digits : 2;
  } catch {
    return 2;
  }
}

/** `formatMoney(12550, 'USD')` is "$125.50". An unknown currency is never guessed. */
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

/**
 * Parses what a captain typed ("25", "25.5", "25.50") into minor units for the currency, or null
 * when it is not a positive amount with at most the currency's decimals. The API still validates
 * the amount against the obligation (SPK-PAY-004, SPK-PAY-005).
 */
export function parseMoneyInput(text: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const trimmed = text.trim().replace(/^\$/, '');
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);
  if (!pattern.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date (`2026-11-02`) as "Nov 2, 2026", without any time-zone shift. */
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

/** An instant as "Sat, Oct 24, 12:10 PM UTC" in the device's time zone (zone always named). */
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

/** An instant's calendar day as "Oct 24, 2026" in the device's time zone. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** "1st", "2nd", "3rd", "11th", "22nd" for a standings position. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Staff role ids the API names as "responsible role" (SPK-READY-003), in customer words. */
const ROLE_WORDS: Record<string, string> = {
  captain: 'Team captain',
  co_captain: 'Co-captain',
  member: 'Team member',
  league_manager: 'League manager',
  finance_operator: 'Finance team',
  front_desk: 'Front desk',
  program_manager: 'Program manager',
  general_manager: 'General manager',
  support_operator: 'Support team',
  official: 'Match official',
  scheduler: 'Scheduling team',
};

export function roleWords(role: string): string {
  return ROLE_WORDS[role] ?? role.replace(/_/g, ' ');
}
