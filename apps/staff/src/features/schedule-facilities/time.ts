/**
 * Facility-local time for the schedule and facilities screens (SPK-SCHED-008): instants travel as
 * UTC ISO strings and are shown, and entered, in the facility's IANA time zone, never the browser's.
 * Local times that do not exist (clocks move forward) or occur twice (clocks move back) are reported
 * so the screen can ask the user to resolve them instead of guessing.
 */

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    wallFormatters.set(timeZone, f);
  }
  return f;
}

function toMs(instant: string | number | Date): number {
  return typeof instant === 'number' ? instant : new Date(instant).getTime();
}

/** The wall-clock reading in `timeZone` at an instant. */
export function wallClockAt(instant: string | number | Date, timeZone: string): WallClock {
  const parts = wallFormatter(timeZone).formatToParts(new Date(toMs(instant)));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/** UTC offset of `timeZone` at an instant, in minutes (Los Angeles in summer: -420). */
export function offsetMinutesAt(instant: string | number | Date, timeZone: string): number {
  const ms = toMs(instant);
  const w = wallClockAt(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' in the zone. */
export function localDateOf(instant: string | number | Date, timeZone: string): string {
  const w = wallClockAt(instant, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** 'HH:MM' (24-hour) in the zone. */
export function localTimeOf(instant: string | number | Date, timeZone: string): string {
  const w = wallClockAt(instant, timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** Calendar arithmetic on a local date string (no time zone involved). */
export function addDaysToLocalDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday, matching the API's `Weekday`. */
export function weekdayOfLocalDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type LocalResolution =
  | { kind: 'exact'; instant: string }
  /** Clocks moved back: the wall time happened twice; `earlier` is the first occurrence. */
  | { kind: 'ambiguous'; earlier: string; later: string }
  /** Clocks moved forward: the wall time never happened; `shiftedForward` is the same time after the change. */
  | { kind: 'nonexistent'; shiftedForward: string }
  | { kind: 'invalid' };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Resolves a facility-local date and time to UTC instants, exposing DST gaps and overlaps. */
export function resolveLocal(date: string, time: string, timeZone: string): LocalResolution {
  const dm = DATE_RE.exec(date);
  const tm = TIME_RE.exec(time);
  if (!dm || !tm) return { kind: 'invalid' };
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(local);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return { kind: 'invalid' };
  const day = 86_400_000;
  const before = offsetMinutesAt(local - day, timeZone);
  const offsets = new Set([
    before,
    offsetMinutesAt(local, timeZone),
    offsetMinutesAt(local + day, timeZone),
  ]);
  const candidates = [...offsets]
    .map((o) => local - o * 60_000)
    .filter((t) => {
      const w = wallClockAt(t, timeZone);
      return w.year === y && w.month === mo && w.day === d && w.hour === h && w.minute === mi;
    })
    .sort((a, b) => a - b);
  const unique = [...new Set(candidates)];
  const first = unique[0];
  const last = unique[unique.length - 1];
  if (first !== undefined && last !== undefined) {
    return first === last
      ? { kind: 'exact', instant: new Date(first).toISOString() }
      : {
          kind: 'ambiguous',
          earlier: new Date(first).toISOString(),
          later: new Date(last).toISOString(),
        };
  }
  return { kind: 'nonexistent', shiftedForward: new Date(local - before * 60_000).toISOString() };
}

/** The first instant of a local day (shifted forward when midnight does not exist that day). */
export function startOfLocalDay(date: string, timeZone: string): string {
  const r = resolveLocal(date, '00:00', timeZone);
  switch (r.kind) {
    case 'exact':
      return r.instant;
    case 'ambiguous':
      return r.earlier;
    case 'nonexistent':
      return r.shiftedForward;
    case 'invalid':
      throw new Error(`Invalid local date ${date}`);
  }
}

/** The local-day window [start of `date`, start of `date + days`) as UTC instants. */
export function localDaysWindow(
  date: string,
  days: number,
  timeZone: string,
): { start: string; end: string } {
  return {
    start: startOfLocalDay(date, timeZone),
    end: startOfLocalDay(addDaysToLocalDate(date, days), timeZone),
  };
}

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, { timeZone, ...options });
}

/** Short zone name at the instant, e.g. "PDT" (it changes across daylight saving). */
export function zoneName(instant: string | number | Date, timeZone: string): string {
  const parts = formatter(timeZone, { timeZoneName: 'short' }).formatToParts(
    new Date(toMs(instant)),
  );
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/** "18:00" in the facility zone. */
export function formatLocalTime(instant: string | number | Date, timeZone: string): string {
  return localTimeOf(instant, timeZone);
}

/** "Sat, Oct 24" (locale order) for a local date string. */
export function formatLocalDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "Sat, Oct 24, 18:00 PDT" in the facility zone. */
export function formatInstant(instant: string | number | Date, timeZone: string): string {
  return `${formatLocalDate(localDateOf(instant, timeZone))}, ${localTimeOf(instant, timeZone)} ${zoneName(instant, timeZone)}`;
}

/**
 * "Sat, Oct 24, 18:00 to 19:30 PDT"; the end carries its own date when it falls on another local
 * day, and its own zone name when daylight saving changed in between.
 */
export function formatRange(
  start: string | number | Date,
  end: string | number | Date,
  timeZone: string,
): string {
  const startDate = localDateOf(start, timeZone);
  const endDate = localDateOf(end, timeZone);
  const startZone = zoneName(start, timeZone);
  const endZone = zoneName(end, timeZone);
  const head = `${formatLocalDate(startDate)}, ${localTimeOf(start, timeZone)}`;
  const tailDate = endDate === startDate ? '' : `${formatLocalDate(endDate)}, `;
  const tail = `${tailDate}${localTimeOf(end, timeZone)}`;
  return startZone === endZone
    ? `${head} to ${tail} ${endZone}`
    : `${head} ${startZone} to ${tail} ${endZone}`;
}

/** Minutes between two instants. */
export function minutesBetween(start: string | number | Date, end: string | number | Date): number {
  return Math.round((toMs(end) - toMs(start)) / 60_000);
}

/** Expands a scheduled interval by its buffers (SPK-SCHED-003 occupied interval). */
export function occupiedRange(
  start: string,
  end: string,
  setupMinutes: number,
  cleanupMinutes: number,
): { start: string; end: string } {
  return {
    start: new Date(toMs(start) - setupMinutes * 60_000).toISOString(),
    end: new Date(toMs(end) + cleanupMinutes * 60_000).toISOString(),
  };
}

export function overlaps(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return toMs(a.start) < toMs(b.end) && toMs(b.start) < toMs(a.end);
}
