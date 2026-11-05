/**
 * Dates and times on the competition screens (SPK-SCHED-008). An instant is shown in the
 * facility's IANA time zone when the API gives one (a fixture's `venue.timezone`, or the time zone
 * of the division's facility from `GET /v1/facilities`); otherwise in the device's time zone. The
 * zone is always named, so a device-zone time is never mistaken for facility-local time. Date-only
 * values (season and specification dates) are calendar dates and are shown without any shift.
 *
 * A date-and-time field is read in the same clock its record is shown in: the facility's zone where
 * the screen knows it (`zonedInputToIso`), otherwise the device's zone, and its hint names that
 * clock (`inputZoneHint`), so a time typed on a device in another zone is never stored as a
 * different instant from the one the staff member meant.
 */
import { deviceZoneHint } from '../../ui/time';
import { localDateOf, localTimeOf, resolveLocal } from '../schedule-facilities/time';

export function formatInstant(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
    } catch {
      // An unknown zone name falls back to the device zone, still named.
    }
  }
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return 'Not set';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** `<input type="datetime-local">` value (device time) to an ISO instant, or undefined when empty. */
export function localInputToIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** ISO instant to an `<input type="datetime-local">` value in device time. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** `timeZone` when the platform knows it as an IANA zone, otherwise null (the device zone, named). */
export function knownTimeZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

/**
 * `<input type="datetime-local">` value read as wall-clock time in `timeZone` (the facility's IANA
 * zone, SPK-SCHED-008), as an ISO instant; read in the device's zone when `timeZone` is null.
 * Undefined when empty or not a date and time. A wall time that happens twice on a daylight-saving
 * change resolves to its first occurrence; one that never happens moves to the same time after the
 * change.
 */
export function zonedInputToIso(value: string, timeZone: string | null): string | undefined {
  const zone = knownTimeZone(timeZone);
  if (!zone) return localInputToIso(value);
  const [date = '', time = ''] = value.trim().split('T');
  const resolved = resolveLocal(date, time.slice(0, 5), zone);
  switch (resolved.kind) {
    case 'exact':
      return resolved.instant;
    case 'ambiguous':
      return resolved.earlier;
    case 'nonexistent':
      return resolved.shiftedForward;
    default:
      return undefined;
  }
}

/** ISO instant to an `<input type="datetime-local">` value in `timeZone` (device time when null). */
export function isoToZonedInput(iso: string, timeZone: string | null): string {
  const zone = knownTimeZone(timeZone);
  if (!zone) return isoToLocalInput(iso);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${localDateOf(date, zone)}T${localTimeOf(date, zone)}`;
}

/**
 * The hint naming the clock a date-and-time field is read in (SPK-SCHED-008): "Facility time
 * (America/Los_Angeles)." when the facility's zone is known, otherwise the device's zone by name.
 */
export function inputZoneHint(timeZone: string | null): string {
  const zone = knownTimeZone(timeZone);
  return zone ? `Facility time (${zone}).` : deviceZoneHint();
}

/** A short, non-identifying reference for an opaque id (never personal data). */
export function shortRef(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'none';
}
