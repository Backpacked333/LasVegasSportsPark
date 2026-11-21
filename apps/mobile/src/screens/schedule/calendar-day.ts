/**
 * Handoff M 1h Calendar, the day model (INTERACTIONS 1h rows 2, 4 and "Screen states"; SPK-YOUTH-007,
 * SPK-SCHED-008). Pure: no clock, no state; the screen passes the days, the entries and the zone.
 *
 * - Days with something on them are listed with a heading ("Today · Saturday 21", "Sunday 22");
 *   runs of empty days collapse into one line ("Mon 23 – Tue 24 · nothing scheduled").
 * - Back to back (row 2): one family event ends less than 45 minutes before another starts at a
 *   different space: one sentence naming who, both places and both times, ▲ amber. Two events
 *   that overlap in time are a clash: ✕ red instead. A pair whose spaces the API does not name, or
 *   that are in the same space, is not called out as back to back (nothing to walk). Walk times
 *   between spaces are not in the API, so the sentence names the places without one.
 */
import type { Schema } from '@sportspark/api-client';
import { shortTime } from '../../features/home/when';
import { entryPersonIds, type TodayEntry } from '../../features/today/entries';
import { venueOf } from '../../features/today/fixture-model';
import { isoWeekday, WEEKDAYS } from '../../ui/DateField';

type MyTeamEntry = Schema<'MyTeamEntry'>;

/** Back to back below this gap (INTERACTIONS 1h row 2). */
export const BACK_TO_BACK_MINUTES = 45;

export type DayBlock =
  | { kind: 'day'; key: string; day: string; entries: TodayEntry[] }
  | { kind: 'empty'; key: string; days: string[] };

/**
 * The week as day blocks: each day with entries, and each run of empty days as one block (keyed
 * by its first day).
 */
export function dayBlocks(
  days: readonly string[],
  byDay: ReadonlyMap<string, readonly TodayEntry[]>,
): DayBlock[] {
  const blocks: DayBlock[] = [];
  for (const day of days) {
    const entries = byDay.get(day) ?? [];
    if (entries.length > 0) {
      blocks.push({ kind: 'day', key: day, day, entries: [...entries] });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'empty') last.days.push(day);
    else blocks.push({ kind: 'empty', key: day, days: [day] });
  }
  return blocks;
}

/** The block a day is shown in (an empty day is in its run's block). */
export function blockKeyOf(blocks: readonly DayBlock[], day: string): string | null {
  for (const block of blocks) {
    if (block.kind === 'day' ? block.day === day : block.days.includes(day)) return block.key;
  }
  return null;
}

const short = (day: string) => (WEEKDAYS[isoWeekday(day)] ?? '').slice(0, 3);
const date = (day: string) => Number(day.slice(8, 10));

/** "Today · Saturday 21", "Tomorrow · Sunday 22", "Monday 23". */
export function dayHeading(day: string, today: string, tomorrow: string): string {
  const name = `${WEEKDAYS[isoWeekday(day)] ?? ''} ${date(day)}`;
  if (day === today) return `Today · ${name}`;
  if (day === tomorrow) return `Tomorrow · ${name}`;
  return name;
}

/** "Mon 23 · nothing scheduled", "Mon 23 – Tue 24 · nothing scheduled". */
export function emptyRunLine(days: readonly string[]): string {
  const first = days[0] as string;
  const last = days[days.length - 1] as string;
  const span =
    days.length === 1
      ? `${short(first)} ${date(first)}`
      : `${short(first)} ${date(first)} – ${short(last)} ${date(last)}`;
  return `${span} · nothing scheduled`;
}

/** The space an entry is in: the calendar item's place, or the game's field (else facility). */
export function placeOf(entry: TodayEntry): string | null {
  if (entry.type === 'session') return entry.item.place ?? null;
  const venue = venueOf(entry.fixture);
  return venue?.resources[0]?.name ?? venue?.facilityName ?? null;
}

export interface Juncture {
  kind: 'back-to-back' | 'clash';
  first: TodayEntry;
  second: TodayEntry;
  /** The one sentence shown (without the glyph). */
  sentence: string;
}

/** Who an entry is for, as the sentence names them: "You" for the account holder. */
export interface Who {
  name: string;
  self: boolean;
}

function verb(who: Who, base: 'finish' | 'start'): string {
  const third = base === 'finish' ? 'finishes' : 'starts';
  return `${who.name} ${who.self ? base : third}`;
}

/**
 * Back-to-back and clashing pairs among one day's entries (sorted by start), each named once. A
 * clash is any two entries whose times overlap; back to back is a gap under 45 minutes between two
 * named, different spaces.
 */
export function junctures(
  entries: readonly TodayEntry[],
  whoOf: (entry: TodayEntry) => Who,
  zone: (entry: TodayEntry) => string,
): Juncture[] {
  const sorted = [...entries].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out: Juncture[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i] as TodayEntry;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j] as TodayEntry;
      const aStart = Date.parse(a.start);
      const aEnd = Date.parse(a.end);
      const bStart = Date.parse(b.start);
      const bEnd = Date.parse(b.end);
      const whoA = whoOf(a);
      const whoB = whoOf(b);
      const placeA = placeOf(a);
      const placeB = placeOf(b);
      if (aStart < bEnd && bStart < aEnd) {
        out.push({
          kind: 'clash',
          first: a,
          second: b,
          sentence: `${whoA.name} ${whoA.self ? 'are' : 'is'} ${placeA ? `on ${placeA}` : 'busy'} until ${shortTime(a.end, zone(a))}, but ${verb(whoB, 'start')} at ${shortTime(b.start, zone(b))}${placeB ? ` on ${placeB}` : ''}.`,
        });
        continue;
      }
      const gap = bStart - aEnd;
      if (gap < 0 || gap >= BACK_TO_BACK_MINUTES * 60_000) continue;
      if (!placeA || !placeB || placeA === placeB) continue;
      out.push({
        kind: 'back-to-back',
        first: a,
        second: b,
        sentence: `${verb(whoA, 'finish')} at ${shortTime(a.end, zone(a))} on ${placeA}. ${verb(whoB, 'start')} at ${shortTime(b.start, zone(b))} on ${placeB}.`,
      });
    }
  }
  return out;
}

/** The household person an entry is for (the first of its people the household has). */
export function personFor<T extends { id: string }>(
  entry: TodayEntry,
  people: readonly T[],
  teams: readonly MyTeamEntry[] | undefined,
): T | undefined {
  const ids = entryPersonIds(entry, teams);
  return people.find((p) => ids.includes(p.id));
}
