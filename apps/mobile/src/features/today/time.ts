/**
 * Facility-local time display for the today screens (SPK-SCHED-008: "Store event instants in UTC
 * and retain the facility's IANA timezone for scheduling and display").
 *
 * The API gives instants in UTC with the facility's IANA zone next to them: family calendar items
 * (`timezone`, ENR-02), fixtures (`venue.timezone`, CMP-04), offerings (`facility.timezone`),
 * enrollments (`offering.timezone`), schedule notices (`EventDetails.timezone`) and
 * `GET /v1/facilities/{id}` (K-04). A screen renders in the facility zone the API states for that
 * record (`zoneOf`), and only where none is given (an item without a facility) falls back to the
 * device's zone and says so. The zone abbreviation is always printed next to the time: a time is
 * never shown without saying which clock it is on.
 *
 * Wording is deterministic for a given zone; nothing here reads the system clock.
 */
import { deviceTimeZone } from './device-time-zone';

const LOCALE = 'en-US';
const DAY_MS = 86_400_000;

export interface DisplayZone {
  /** IANA zone the times are rendered in. */
  zone: string;
  /** True when the zone is the facility's, as stated by the API; false when it is the device's. */
  facility: boolean;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The facility zone when the API stated one, otherwise the device's zone. */
export function displayZone(facilityZone?: string | null): DisplayZone {
  if (facilityZone && isValidTimeZone(facilityZone)) return { zone: facilityZone, facility: true };
  return { zone: deviceTimeZone(), facility: false };
}

/**
 * The first valid facility zone among the API's answers, in order of preference (the newest
 * schedule notice, the record itself, its facility), otherwise the device's zone (SPK-SCHED-008).
 */
export function zoneOf(...candidates: readonly (string | null | undefined)[]): DisplayZone {
  for (const zone of candidates) {
    if (zone && isValidTimeZone(zone)) return { zone, facility: true };
  }
  return displayZone(null);
}

/**
 * The single facility zone shared by every zone given (one facility, or several on one clock), or
 * null when there is none or they differ. Screens that lay out whole days use it.
 */
export function sharedZone(zones: readonly (string | null | undefined)[]): string | null {
  const valid = [...new Set(zones.filter((z): z is string => !!z && isValidTimeZone(z)))];
  return valid.length === 1 ? (valid[0] ?? null) : null;
}

/** ICU separates "AM" with a narrow no-break space; screens and tests use plain spaces. */
function clean(text: string): string {
  return text.replace(/[\u202f\u00a0]/g, ' ');
}

function format(date: Date, zone: string, options: Intl.DateTimeFormatOptions): string {
  return clean(new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: zone }).format(date));
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(date: Date, zone: string): WallClock {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds the zone's wall clock is ahead of UTC at `date`. */
function offsetMs(date: Date, zone: string): number {
  const w = wallClock(date, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight at the start of `now`'s calendar day in `zone` (daylight-saving safe). */
export function startOfLocalDay(now: Date, zone: string): Date {
  const w = wallClock(now, zone);
  const midnightAsUtc = Date.UTC(w.year, w.month - 1, w.day);
  const guess = midnightAsUtc - offsetMs(now, zone);
  return new Date(midnightAsUtc - offsetMs(new Date(guess), zone));
}

/** Midnight `days` calendar days after `start`'s day in `zone`. */
export function addLocalDays(start: Date, days: number, zone: string): Date {
  // Noon of the target day never falls into a daylight-saving gap.
  return startOfLocalDay(new Date(start.getTime() + days * DAY_MS + DAY_MS / 2), zone);
}

/** "2026-10-25": the calendar day of an instant in `zone`, for grouping. */
export function localDayKey(iso: string | Date, zone: string): string {
  const w = wallClock(typeof iso === 'string' ? new Date(iso) : iso, zone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** "Sat, Oct 25". */
export function formatDay(iso: string | Date, zone: string): string {
  return format(typeof iso === 'string' ? new Date(iso) : iso, zone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "10:00 AM". */
export function formatTime(iso: string | Date, zone: string): string {
  return format(typeof iso === 'string' ? new Date(iso) : iso, zone, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "PDT", or "GMT+2" where the zone has no common abbreviation. */
export function zoneAbbreviation(iso: string | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    timeZoneName: 'short',
  }).formatToParts(typeof iso === 'string' ? new Date(iso) : iso);
  return clean(parts.find((p) => p.type === 'timeZoneName')?.value ?? zone);
}

/** "Sat, Oct 25, 10:00 AM PDT". */
export function formatWhen(iso: string, zone: string): string {
  return `${formatDay(iso, zone)}, ${formatTime(iso, zone)} ${zoneAbbreviation(iso, zone)}`;
}

/**
 * "Sat, Oct 25, 10:00 AM to 11:30 AM PDT"; across midnight both days are named. "to" rather than
 * a dash so screen readers read the range the same way it is written.
 */
export function formatRange(startIso: string, endIso: string, zone: string): string {
  const zoneName = zoneAbbreviation(startIso, zone);
  if (localDayKey(startIso, zone) === localDayKey(endIso, zone)) {
    return `${formatDay(startIso, zone)}, ${formatTime(startIso, zone)} to ${formatTime(endIso, zone)} ${zoneName}`;
  }
  return `${formatDay(startIso, zone)}, ${formatTime(startIso, zone)} to ${formatDay(endIso, zone)}, ${formatTime(endIso, zone)} ${zoneName}`;
}

/** The one-line explanation shown wherever times are on the device's clock (SPK-SCHED-008). */
export function zoneNotice(display: DisplayZone, sample: string | Date): string | null {
  if (display.facility) return null;
  return `Times are in this device's time zone (${zoneAbbreviation(sample, display.zone)}). The facility's time zone was not given for this.`;
}

/**
 * The local days in `zone` that a window [from, to) touches, in order: seven for a week on the
 * facility clock, one more when the window was cut on another clock, so nothing in it is hidden.
 */
export function daysInWindow(from: Date, to: Date, zone: string): Date[] {
  const days: Date[] = [];
  let day = startOfLocalDay(from, zone);
  while (day.getTime() < to.getTime() && days.length < 400) {
    days.push(day);
    day = addLocalDays(day, 1, zone);
  }
  return days;
}
