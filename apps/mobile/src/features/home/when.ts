/**
 * Words for "when" on the redesigned Home (redesign handoff 1b, INTERACTIONS 1b row 2 and
 * "Times": "today / tomorrow / Sat for the next 6 days and dates after that", always on the
 * facility's clock, SPK-SCHED-008). Pure functions of the injected clock, so tests are exact.
 */
import { addLocalDays, formatDay, formatTime, localDayKey, startOfLocalDay } from '../today/time';

const MINUTE = 60_000;

/** "in 14 min", "in 2 h 15 min", "in 3 h". */
export function inWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours} h` : `in ${hours} h ${rest} min`;
}

/** "Today", "Tomorrow", "Sat" (within 6 days) or "Sat, Dec 5" (later). */
export function dayWord(iso: string, now: Date, zone: string): string {
  const key = localDayKey(iso, zone);
  const today = startOfLocalDay(now, zone);
  if (key === localDayKey(today, zone)) return 'Today';
  if (key === localDayKey(addLocalDays(today, 1, zone), zone)) return 'Tomorrow';
  for (let d = 2; d <= 6; d += 1) {
    if (key === localDayKey(addLocalDays(today, d, zone), zone)) {
      return formatDay(iso, zone).split(',')[0] as string;
    }
  }
  return formatDay(iso, zone);
}

export type CountdownState = 'upcoming' | 'today' | 'now' | 'over';

export interface Countdown {
  state: CountdownState;
  /** "Today · in 2 h 15 min", "Now", "Tomorrow · 9:00 AM", "Sat · 9:00 AM". */
  label: string;
}

/**
 * The hero's live pill: today it counts down (minutes under an hour), at the start time it reads
 * "Now" until the end; another day it names the day and the time.
 */
export function countdown(startIso: string, endIso: string, now: Date, zone: string): Countdown {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const t = now.getTime();
  if (t >= end) return { state: 'over', label: 'Ended' };
  if (t >= start) return { state: 'now', label: 'Now' };
  const day = dayWord(startIso, now, zone);
  if (day === 'Today') return { state: 'today', label: `Today · ${inWords(start - t)}` };
  return { state: 'upcoming', label: `${day} · ${formatTime(startIso, zone)}` };
}

/** "8:40": a clock time without the period, for "Arrive by 8:40". */
export function shortTime(iso: string | Date, zone: string): string {
  return formatTime(iso, zone).replace(/\s?[AP]M$/u, '');
}

/** ["10:30", "AM"]: a row's time column. */
export function timeParts(iso: string, zone: string): [string, string] {
  const text = formatTime(iso, zone);
  const match = /^(.*?)\s?([AP]M)$/u.exec(text);
  return match ? [match[1] as string, match[2] as string] : [text, ''];
}
