import type {
  AmbiguousTimePolicy,
  DstResolution,
  LocalDate,
  LocalTime,
  NonexistentTimePolicy,
} from '@sportspark/contracts';

/**
 * Facility-local wall-clock time helpers (SPK-SCHED-008). Instants are stored in UTC; the
 * facility's IANA zone converts both ways through Intl, so no timezone database is bundled.
 */

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of an instant in the zone. */
export function toLocal(timezone: string, instant: Date): LocalDateTime {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = read('year');
  const month = read('month');
  const day = read('day');
  const hour = read('hour') % 24;
  const minute = read('minute');
  const second = read('second');
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

/** Offset (local minus UTC) in milliseconds at the instant. */
export function offsetMs(timezone: string, instant: Date): number {
  const l = toLocal(timezone, instant);
  const wall = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

export function localDateOf(timezone: string, instant: Date): LocalDate {
  const l = toLocal(timezone, instant);
  return `${l.year.toString().padStart(4, '0')}-${pad2(l.month)}-${pad2(l.day)}`;
}

export function localTimeOf(timezone: string, instant: Date): LocalTime {
  const l = toLocal(timezone, instant);
  return `${pad2(l.hour)}:${pad2(l.minute)}`;
}

/** Minutes since local midnight of the instant. */
export function minutesSinceMidnight(timezone: string, instant: Date): number {
  const l = toLocal(timezone, instant);
  return l.hour * 60 + l.minute;
}

export interface LocalMinuteSpan {
  /** Local weekday of the start (0 = Sunday). */
  weekday: number;
  /** Minutes since local midnight of the start date. */
  startMinute: number;
  /**
   * Wall-clock minutes of the end, counted from local midnight of the start date: 1440 more per
   * local day the end falls after the start date (an end at the next local midnight is 1440).
   */
  endMinute: number;
}

/**
 * The facility-local wall-clock span of an interval (SPK-SCHED-008, SPK-SCHED-001 operating
 * hours). The end is read from the wall clock at the end instant, never as the start plus the
 * elapsed minutes, so a daylight-saving change inside the interval does not move it: on fall-back
 * night 00:30 PDT to 01:30 PST spans 00:30-01:30, on spring-forward night 01:30 PST to 03:30 PDT
 * spans 01:30-03:30. An interval that runs past local midnight ends beyond minute 1440 and so never
 * fits a single day's opening window (windows never span midnight: `opens_at < closes_at`).
 */
export function localMinuteSpan(timezone: string, start: Date, end: Date): LocalMinuteSpan {
  const s = toLocal(timezone, start);
  const e = toLocal(timezone, end);
  const days = Math.round(
    (Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(s.year, s.month - 1, s.day)) / DAY_MS,
  );
  return {
    weekday: s.weekday,
    startMinute: s.hour * 60 + s.minute,
    // a partial minute past the window still counts as past it
    endMinute: days * 1440 + e.hour * 60 + e.minute + (e.second > 0 ? 1 : 0),
  };
}

export interface ZonedResolution {
  instant: Date;
  resolution: DstResolution;
}

export interface DstPolicy {
  nonexistent: NonexistentTimePolicy;
  ambiguous: AmbiguousTimePolicy;
}

export const DEFAULT_DST_POLICY: DstPolicy = { nonexistent: 'shift_forward', ambiguous: 'first' };

/**
 * Resolves a local date and time in the zone to an instant, explicitly handling daylight-saving
 * transitions (SPK-SCHED-008): a nonexistent local time (spring forward gap) shifts forward by
 * the gap unless the policy skips it; an ambiguous local time (fall back overlap) takes the first
 * occurrence unless the policy chooses the second. Returns null only for a skipped occurrence.
 */
export function resolveLocal(
  date: LocalDate,
  time: LocalTime,
  timezone: string,
  policy: DstPolicy = DEFAULT_DST_POLICY,
): ZonedResolution | null {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetBefore = offsetMs(timezone, new Date(wall - DAY_MS));
  const offsetAfter = offsetMs(timezone, new Date(wall + DAY_MS));
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wall - offset)
    .filter((candidate) => offsetMs(timezone, new Date(candidate)) === wall - candidate)
    .sort((a, b) => a - b);
  if (candidates.length === 1) {
    return { instant: new Date(candidates[0] as number), resolution: 'exact' };
  }
  if (candidates.length >= 2) {
    return policy.ambiguous === 'first'
      ? { instant: new Date(candidates[0] as number), resolution: 'first' }
      : { instant: new Date(candidates[1] as number), resolution: 'second' };
  }
  if (policy.nonexistent === 'skip') return null;
  // Interpreting the wall time with the pre-transition offset lands after the gap (02:30 → 03:30).
  return { instant: new Date(wall - offsetBefore), resolution: 'shifted_forward' };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function weekdayOf(date: LocalDate): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight (24:00 → 1440). */
export function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
