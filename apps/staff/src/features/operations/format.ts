/**
 * Formatting for the operations screens (arrival, attendance, release, staff and officials,
 * communications, workspace). Times name their zone: facility-local where the payload or the Today
 * feed gives the facility timezone (SPK-SCHED-008), otherwise the device zone, always labelled so a
 * device time is never presented as facility time. Money is minor units plus currency (SPK-PAY-001).
 */
import { resolveLocal } from '../schedule-facilities/time';

/** "Sat 24 Oct, 10:00 PDT" in the given IANA zone (or the device zone when unknown). */
export function formatInstant(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** "Sat 24 Oct, 10:00 PDT to 11:00" */
export function formatRange(startIso: string, endIso: string, timeZone?: string | null): string {
  const end = new Date(endIso);
  const endText = Number.isNaN(end.getTime())
    ? endIso
    : new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        ...(timeZone ? { timeZone } : {}),
      }).format(end);
  return `${formatInstant(startIso, timeZone)} to ${endText}`;
}

/** The calendar date (YYYY-MM-DD) of an instant in a zone, for report and list queries. */
export function localDate(at: Date, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Decimal places of a currency's minor unit (USD 2, JPY 0), from the platform's Intl data. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** "$12.50" from 1250 USD. Never floating-point arithmetic on stored values: display only. */
export function formatMoney(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(minor / 10 ** digits);
  } catch {
    return `${minor} ${currency} (minor units)`;
  }
}

/**
 * Parses a typed amount ("12.50") into minor units for the currency, or null when it is not a
 * non-negative amount with at most the currency's decimal places. String arithmetic, no floats.
 */
export function parseMinor(text: string, currency: string): number | null {
  const digits = minorDigits(currency);
  const trimmed = text.trim();
  const pattern = digits > 0 ? new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`) : /^(\d+)$/;
  const m = pattern.exec(trimmed);
  if (!m) return null;
  const whole = m[1] ?? '0';
  const fraction = (m[2] ?? '').padEnd(digits, '0');
  const value = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(value) ? value : null;
}

/** "front_desk" -> "Front desk"; machine slugs shown to staff in sentence case. */
export function humanize(slug: string): string {
  const text = slug.replace(/_/g, ' ').trim();
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** A short, non-identifying reference for an opaque id ("ref 0192f1a0"). */
export function shortRef(id: string): string {
  return `ref ${id.slice(0, 8)}`;
}

/** "2026-10-24" plus n calendar days (UTC date arithmetic on the date only). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A `datetime-local` input value read in the facility's zone when it is known (SPK-SCHED-008: a
 * device time is never presented as facility time), otherwise in the device zone. A wall time that
 * happens twice on a daylight-saving change resolves to its first occurrence; one that never
 * happens moves to the same time after the change.
 */
export function instantFromZonedInput(value: string, timeZone: string | null): string | null {
  if (!value) return null;
  if (!timeZone) return instantFromLocalInput(value);
  const [date = '', time = ''] = value.split('T');
  const r = resolveLocal(date, time.slice(0, 5), timeZone);
  if (r.kind === 'exact') return r.instant;
  if (r.kind === 'ambiguous') return r.earlier;
  if (r.kind === 'nonexistent') return r.shiftedForward;
  return null;
}

/** The hint naming which clock a `datetime-local` field is read in. */
export function inputZoneHint(timeZone: string | null): string {
  if (timeZone) return `Facility time, ${timeZone}.`;
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Your device time${device ? `, ${device}` : ''}.`;
}

/** A `datetime-local` input value (device zone) as an ISO instant, or null when empty or invalid. */
export function instantFromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One id per line or comma; blank entries dropped. */
export function idList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
