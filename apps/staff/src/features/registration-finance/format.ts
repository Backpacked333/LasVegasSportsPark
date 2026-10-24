/**
 * Money and time formatting for the registration and finance screens (SCR-S-14, SCR-S-15,
 * SCR-S-24 to SCR-S-27, SCR-S-35 to SCR-S-38).
 *
 * - Money is integer minor units with an explicit currency (SPK-PAY-001). The client formats what
 *   the API computed and never derives a price: `parseMoneyInput` only turns what a staff member
 *   typed (a refund amount, a reported settlement total) into minor units without floating point.
 * - Instants are shown in the facility's time zone when the API named it (SPK-SCHED-008), with the
 *   zone always written out; otherwise in the device's zone, also named, never presented as
 *   facility-local time.
 */

/** Minor-unit exponent of an ISO 4217 currency (2 for USD, 0 for JPY); 2 when unknown. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** "$125.00" from 12500 USD. A missing amount is said in words, never shown as zero. */
export function formatMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined) return 'Not stated';
  if (!currency) return `${minor} minor units (currency not stated)`;
  const digits = minorDigits(currency);
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 10 ** digits);
  const fraction = abs % 10 ** digits;
  const text = digits > 0 ? `${major}.${String(fraction).padStart(digits, '0')}` : String(major);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Number(negative ? `-${text}` : text));
  } catch {
    return `${negative ? '-' : ''}${text} ${currency}`;
  }
}

/**
 * Minor units from typed text ("125", "125.5", "125.50"), or null when the text is not a positive
 * amount with at most the currency's decimals. Pure string arithmetic: no floating point.
 */
export function parseMoneyInput(text: string, currency: string, allowZero = false): number | null {
  const digits = minorDigits(currency);
  const trimmed = text.trim().replace(/,/g, '');
  const pattern = digits > 0 ? new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`) : /^(\d+)$/;
  const match = pattern.exec(trimmed);
  if (!match) return null;
  const whole = match[1] as string;
  const fraction = (match[2] ?? '').padEnd(digits, '0');
  const minor = Number(`${whole}${fraction}`);
  if (!Number.isSafeInteger(minor)) return null;
  if (minor === 0 && !allowZero) return null;
  return minor;
}

const INSTANT_PARTS: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
};

/** "Sat, Oct 24, 2026, 05:00 AM PDT" in the named zone (or the device zone, also named). */
export function formatInstant(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Not set';
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...INSTANT_PARTS,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', INSTANT_PARTS).format(date);
  }
}

/** A calendar date ("2026-10-24") written out without shifting it through any time zone. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return 'Not set';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * A `datetime-local` value ("2026-11-02T18:30") read as wall-clock time in `timeZone` (the
 * facility's zone, SPK-SCHED-008), as an ISO instant; null when the text is not a local time.
 * Without a zone the value is read as UTC, and the form says so.
 */
export function localToInstant(local: string, timeZone: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (!timeZone) return new Date(wall).toISOString();
  try {
    const first = zoneOffsetMinutes(new Date(wall), timeZone);
    let instant = wall - first * 60_000;
    const second = zoneOffsetMinutes(new Date(instant), timeZone);
    if (second !== first) instant = wall - second * 60_000;
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}

/** The `datetime-local` text of an instant in `timeZone` (UTC when no zone), for edit forms. */
export function instantToLocal(iso: string | null | undefined, timeZone: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = timeZone ? zoneOffsetMinutes(date, timeZone) : 0;
  return new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 16);
}

/** Start of a calendar day in UTC as an instant, for report periods ("2026-10-01" -> instant). */
export function dateToInstant(date: string, endOfDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const at = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + (endOfDay ? 86_400_000 : 0)).toISOString();
}

/** A short reference for an opaque id, for staff to quote (never a name or personal data). */
export function shortRef(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'none';
}

/** "registration_window_missing" -> "registration window missing". */
export function humanize(code: string): string {
  return code.replace(/[._]/g, ' ');
}
