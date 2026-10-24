/**
 * Times on staff screens (SPK-SCHED-008): facility-local when the facility's timezone is known
 * (from the Today feed), otherwise the device's zone, always with the zone named so a time is never
 * mistaken for facility-local time.
 */

export function formatDateTime(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatTime(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** "10:00 to 11:30 PDT" in the facility's zone. */
export function formatTimeRange(start: string, end: string, timeZone?: string | null): string {
  const zone = new Intl.DateTimeFormat(undefined, {
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  })
    .formatToParts(new Date(start))
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${formatTime(start, timeZone)} to ${formatTime(end, timeZone)}${zone ? ` ${zone}` : ''}`;
}

/** "45 min", "2 h 5 min", "3 d". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d`;
}

/** A `datetime-local` input value (device zone) as an ISO instant, or null when empty or invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
