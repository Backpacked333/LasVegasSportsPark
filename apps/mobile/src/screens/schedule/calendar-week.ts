/**
 * SCR-C-18 Calendar, the week model (PA-11 **Proposed**: Calendar absorbs SCR-C-19 Family calendar;
 * SPK-YOUTH-007, SPK-IAM-003, SPK-SCHED-008). Pure: no clock, no state; the screen passes `now`.
 *
 * - A week runs Monday to Sunday, so a weekend's games and sessions stay in one week.
 * - Reads are the same 28-day windows Home reads (`SCHEDULE_WINDOW_DAYS`, cut at the device's
 *   local midnight): window 0 is Home's look-ahead, one cached response for both screens. A week
 *   reads every window it touches, with a day either side, because its days may be laid out on a
 *   facility clock other than the device's (SPK-SCHED-008). Window 0 comes first.
 * - Overlaps (SPK-YOUTH-007) are the API's, between sessions and bookings, plus a fixture
 *   overlapping another commitment of the same person; highlighted, never prevented.
 */
import type { Schema } from '@sportspark/api-client';
import { calendarWindowQuery, overlapIndex } from '../../features/today/calendar';
import { entryPersonIds, fixtureOverlaps, type TodayEntry } from '../../features/today/entries';
import { fixtureTitle } from '../../features/today/fixture-model';
import { nameOf, SCHEDULE_WINDOW_DAYS } from '../../features/today/queries';
import { localDayKey, startOfLocalDay } from '../../features/today/time';
import { addIsoDays } from '../../ui/DateField';

type FamilyCalendar = Schema<'FamilyCalendar'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

/** Weeks start on Monday (DateStrip `firstDayOfWeek`). */
export const FIRST_DAY_OF_WEEK = 1;
/** The "Everyone" person filter. */
export const EVERYONE = 'everyone';
/** The label of a booked session whose offering is a pickup session (SPK-PLACE-004, ENR-15). */
export const PICKUP_SESSION_LABEL = 'Pickup session';

const DAY_MS = 86_400_000;

/** Midnight at the start of the ISO date `iso` (`2026-10-24`) in `zone`. */
export function instantOfDay(iso: string, zone: string): Date {
  // Noon UTC is on the same calendar date in every zone the facilities use.
  return startOfLocalDay(new Date(`${iso}T12:00:00.000Z`), zone);
}

/** The seven ISO dates of the week starting `weekStart`. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addIsoDays(weekStart, i));
}

/** The index of the window (as `calendarWindowQuery` counts them) that holds instant `at`. */
function windowIndexAt(now: Date, at: Date, zone: string, days: number): number {
  const base = new Date(calendarWindowQuery(now, 0, days, zone).from).getTime();
  let index = Math.floor((at.getTime() - base) / (days * DAY_MS));
  // The estimate is off by at most one where daylight saving shifts a boundary.
  for (let step = 0; step < 3; step += 1) {
    const window = calendarWindowQuery(now, index, days, zone);
    if (at.getTime() < new Date(window.from).getTime()) index -= 1;
    else if (at.getTime() >= new Date(window.to).getTime()) index += 1;
    else break;
  }
  return index;
}

/**
 * The windows the week starting `weekStart` touches (a day either side), window 0 (Home's) first,
 * then later ones, then earlier ones.
 */
export function weekWindows(
  now: Date,
  weekStart: string,
  zone: string,
  days: number = SCHEDULE_WINDOW_DAYS,
): number[] {
  const from = instantOfDay(addIsoDays(weekStart, -1), zone);
  const to = instantOfDay(addIsoDays(weekStart, 8), zone);
  const first = windowIndexAt(now, from, zone, days);
  const last = windowIndexAt(now, new Date(to.getTime() - 1), zone, days);
  const indices: number[] = [];
  for (let i = first; i <= last; i += 1) indices.push(i);
  return indices.sort((a, b) => Number(a < 0) - Number(b < 0) || Math.abs(a) - Math.abs(b));
}

/** The `from`/`to` query of window `index` (the request Home makes for window 0). */
export function windowQuery(now: Date, index: number, zone: string) {
  return calendarWindowQuery(now, index, SCHEDULE_WINDOW_DAYS, zone);
}

/** The entries whose start falls on one of `days`, laid out on `zone`'s clock. */
export function entriesOnDays(
  entries: readonly TodayEntry[],
  days: readonly string[],
  zone: string,
): TodayEntry[] {
  const set = new Set(days);
  return entries.filter((e) => set.has(localDayKey(e.start, zone)));
}

/** A display title for an entry: the calendar's title or "Lions vs Tigers". */
export function entryTitle(entry: TodayEntry): string {
  return entry.type === 'session' ? entry.item.title : fixtureTitle(entry.fixture);
}

/** The API's overlaps between two of `entries` (sessions and bookings of the week). */
export function overlapsAmong(
  calendar: Pick<FamilyCalendar, 'overlaps'>,
  entries: readonly TodayEntry[],
): FamilyCalendar['overlaps'] {
  // A session entry's id is its calendar item's id.
  const ids = new Set(entries.flatMap((e) => (e.type === 'session' ? [e.item.id] : [])));
  return calendar.overlaps.filter((o) => o.itemIds.every((id) => ids.has(id)));
}

/**
 * Pairs of overlapping commitments among `entries` (SPK-YOUTH-007), each with the people both are
 * for: the API's, then those with a fixture.
 */
export function overlapPairs(
  calendar: Pick<FamilyCalendar, 'overlaps'>,
  entries: readonly TodayEntry[],
  teams: readonly MyTeamEntry[] | undefined,
): string[][] {
  return [
    ...overlapsAmong(calendar, entries).map((o) => o.personIds),
    ...fixtureOverlaps(entries, teams).map((o) => o.personIds),
  ];
}

/**
 * "Overlaps with Swim club (Sam)" for each entry that overlaps another (SPK-YOUTH-007): the API's
 * session overlaps plus fixtures overlapping a commitment of the same person.
 */
export function overlapNotes(
  calendar: Pick<FamilyCalendar, 'overlaps'>,
  entries: readonly TodayEntry[],
  teams: readonly MyTeamEntry[] | undefined,
  names: Map<string, string>,
): Map<string, string> {
  const byEntryId = new Map(entries.map((e) => [e.id, e]));
  const itemEntry = (itemId: string) => byEntryId.get(itemId) ?? byEntryId.get(`item:${itemId}`);
  const others = new Map<string, string[]>();
  const add = (a: string, b: string) => others.set(a, [...(others.get(a) ?? []), b]);
  for (const [itemId, ids] of overlapIndex(calendar)) {
    for (const otherId of ids) {
      const a = itemEntry(itemId);
      const b = itemEntry(otherId);
      if (a && b) add(a.id, b.id);
    }
  }
  for (const o of fixtureOverlaps(entries, teams)) {
    add(o.ids[0], o.ids[1]);
    add(o.ids[1], o.ids[0]);
  }
  const notes = new Map<string, string>();
  for (const [id, ids] of others) {
    const parts = [...new Set(ids)].flatMap((otherId) => {
      const other = byEntryId.get(otherId);
      if (!other) return [];
      const who = entryPersonIds(other, teams)
        .map((p) => nameOf(names, p))
        .join(', ');
      return [who ? `${entryTitle(other)} (${who})` : entryTitle(other)];
    });
    if (parts.length > 0) notes.set(id, `Overlaps with ${parts.join(', ')}`);
  }
  return notes;
}

/** The people to offer a filter for: the signed-in person first, then the others in API order. */
export function peopleInOrder(participants: readonly string[], selfId: string | null): string[] {
  const others = participants.filter((id) => id !== selfId);
  return selfId && participants.includes(selfId) ? [selfId, ...others] : others;
}

type Param = string | string[] | undefined;

function first(value: Param): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== '' ? v.trim() : null;
}

/**
 * The person filter a link asks for: `people=everyone` (the old `/family-calendar` link), or a
 * person id as `people=<id>` or `person=<id>`; null when the link asks for none.
 */
export function requestedFilter(params: { people?: Param; person?: Param }): string | null {
  return first(params.person) ?? first(params.people);
}
