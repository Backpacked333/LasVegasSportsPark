/**
 * Dates and times on the competition screens (SPK-SCHED-008). An instant is shown in the
 * facility's IANA time zone when the API gives one (a fixture's `venue.timezone`, or the time zone
 * of the division's facility from `GET /v1/facilities`); otherwise in the device's time zone. The
 * zone is always named, so a device-zone time is never mistaken for facility-local time. Date-only
 * values (season and specification dates) are calendar dates and are shown without any shift.
 *
 * A date-and-time field is read in the same clock its record is shown in: the facility's zone where
 * the screen knows it, otherwise the device's zone (`readZonedInput` in schedule-facilities/time,
 * which refuses a time that happens twice or never on a daylight-saving change instead of guessing),
 * and its hint names that clock (`inputZoneHint` in ui/time), so a time typed on a device in another
 * zone is never stored as a different instant from the one the staff member meant.
 */
import { knownTimeZone } from '../../ui/time';
import { localDateOf, localTimeOf } from '../schedule-facilities/time';

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

/** ISO instant to an `<input type="datetime-local">` value in `timeZone` (device time when null). */
export function isoToZonedInput(iso: string, timeZone: string | null): string {
  const zone = knownTimeZone(timeZone);
  if (!zone) return isoToLocalInput(iso);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${localDateOf(date, zone)}T${localTimeOf(date, zone)}`;
}

/** A short, non-identifying reference for an opaque id (never personal data). */
export function shortRef(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'none';
}
