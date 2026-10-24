/**
 * Dates and times on the competition screens. The competition payloads carry no facility time
 * zone and the API has no facility directory, so instants are shown in the device's time zone with
 * the zone named, never presented as facility-local time (SPK-SCHED-008). Date-only values
 * (season and specification dates) are calendar dates and are shown without any time-zone shift.
 */

export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
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

/** A short, non-identifying reference for an opaque id (never personal data). */
export function shortRef(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : 'none';
}
