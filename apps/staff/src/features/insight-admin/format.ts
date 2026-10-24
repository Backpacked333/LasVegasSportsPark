/**
 * Formatting for the Reports (SCR-S-43 to SCR-S-45) and Administration (SCR-S-46 to SCR-S-48)
 * screens. Money is integer minor units with its currency and is never summed across currencies
 * (SPK-PAY-001, metric dictionary rule G5). Instants are shown in the facility's time zone when the
 * API names one (SPK-SCHED-008); otherwise the zone is printed so it is never mistaken for
 * facility-local time. A null figure is "not available", never zero (rule G13).
 */
import type { Schema } from '@sportspark/api-client';

const LOCALE = 'en-US';

/** Fraction digits of a currency's minor unit (2 for USD, 0 for JPY), or null when unknown. */
export function minorDigits(currency: string): number | null {
  try {
    return (
      new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? null
    );
  } catch {
    return null;
  }
}

export function formatMinor(amountMinor: number, currency: string | null | undefined): string {
  if (!currency) return `${amountMinor.toLocaleString(LOCALE)} (minor units, currency not stated)`;
  const digits = minorDigits(currency);
  if (digits === null) return `${amountMinor.toLocaleString(LOCALE)} minor units ${currency}`;
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).format(
    amountMinor / 10 ** digits,
  );
}

/** Major-unit text typed by a person ("12.50") to integer minor units, or null when invalid. */
export function parseMajorToMinor(text: string, currency: string): number | null {
  const digits = minorDigits(currency);
  if (digits === null) return null;
  const trimmed = text.trim();
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`);
  if (!pattern.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
}

export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}

export function formatHours(value: number): string {
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: 2 })} hours`;
}

export function formatRatio(value: number): string {
  return `${(value * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}%`;
}

type MetricUnit = Schema<'ReportingMetricUnit'>;

export function formatQuantity(
  value: number,
  unit: MetricUnit | Schema<'ReportColumn'>['type'],
  currency: string | null,
): string {
  switch (unit) {
    case 'count':
      return formatCount(value);
    case 'hours':
      return formatHours(value);
    case 'ratio':
      return formatRatio(value);
    case 'minutes':
      return `${value.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} minutes`;
    case 'minor_units':
      return formatMinor(value, currency);
    default:
      return String(value);
  }
}

/** "Mar 3, 2026, 09:30 PST" in the given IANA zone, or in the device zone with its name. */
export function formatInstant(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return 'not recorded';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(LOCALE, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone ?? undefined,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Whether the API's time zone is a valid IANA name this browser understands (SPK-SCHED-008). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD of an instant in a time zone (the device zone when none is given). */
export function localDateOf(at: Date, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timeZone ?? undefined,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Device-local midnight of a YYYY-MM-DD date as an ISO instant (organization-wide periods). */
export function deviceMidnight(date: string, addDays = 0): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(y, m - 1, d + addDays, 0, 0, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A `datetime-local` value (device zone) as an ISO instant, or null when empty or invalid. */
export function localDateTimeToInstant(value: string): string | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The device's IANA zone name, for labels such as "your time zone (America/Denver)". */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'device time zone';
}

/** First eight characters of an opaque id, for dense tables (the full id stays in `title`). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scalar the API sent in a report row or reconciliation evidence, as plain text. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatCount(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
