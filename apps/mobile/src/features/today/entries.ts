/**
 * One list of what is coming up for the today screens (SCR-C-03 next activity, SCR-C-18 Schedule,
 * SCR-C-19 family calendar): program sessions and session bookings from
 * `GET /v1/me/family-calendar`, and fixtures of the viewer's and their children's teams from
 * `GET /v1/me/fixtures` (CMP-02). Each entry carries the facility zone the API gave for it
 * (calendar item `timezone`, fixture `venue.timezone`; SPK-SCHED-008), so it is grouped into days
 * and shown on its own facility's clock.
 */
import type { Schema } from '@sportspark/api-client';
import { localDayKey, formatDay, zoneOf, type DisplayZone } from './time';

type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

export type TodayEntry =
  | {
      type: 'session';
      id: string;
      start: string;
      end: string;
      zone: DisplayZone;
      item: FamilyCalendarItem;
    }
  | {
      type: 'fixture';
      id: string;
      start: string;
      end: string;
      zone: DisplayZone;
      fixture: FixtureDetail;
    };

/** Fixture states that are still to be played (the next-activity slot skips the others). */
const UPCOMING_FIXTURE: ReadonlySet<string> = new Set(['scheduled']);

export function sessionEntry(item: FamilyCalendarItem): TodayEntry {
  return {
    type: 'session',
    id: item.id,
    start: item.start,
    end: item.end,
    zone: zoneOf(item.timezone),
    item,
  };
}

/** A fixture with a time; an unscheduled fixture has no place in a day list. */
export function fixtureEntry(fixture: FixtureDetail): TodayEntry | null {
  if (!fixture.scheduledStart || !fixture.scheduledEnd) return null;
  return {
    type: 'fixture',
    id: `fixture:${fixture.id}`,
    start: fixture.scheduledStart,
    end: fixture.scheduledEnd,
    zone: zoneOf(fixture.venue?.timezone),
    fixture,
  };
}

/** Milliseconds since the epoch of an ISO 8601 instant with offset (contracts `Instant`). */
export function instant(iso: string): number {
  return Date.parse(iso);
}

/** Sessions and fixtures in time order, each once (windows may overlap at their edges). */
export function mergeEntries(
  items: readonly FamilyCalendarItem[],
  fixtures: readonly FixtureDetail[],
): TodayEntry[] {
  const byId = new Map<string, TodayEntry>();
  for (const item of items) byId.set(`item:${item.id}`, sessionEntry(item));
  for (const fixture of fixtures) {
    const entry = fixtureEntry(fixture);
    if (entry) byId.set(entry.id, entry);
  }
  // Instants are compared as times, not strings: the API's `Instant` allows offsets and optional
  // fractions, so "…T17:30:00Z" and "…T17:30:00.000Z" are the same moment.
  return [...byId.values()].sort(
    (a, b) => instant(a.start) - instant(b.start) || a.id.localeCompare(b.id),
  );
}

/** The first entry that has not ended (ongoing or upcoming); fixtures only while still to play. */
export function nextEntry(entries: readonly TodayEntry[], now: Date): TodayEntry | null {
  return (
    entries.find(
      (e) =>
        new Date(e.end).getTime() > now.getTime() &&
        (e.type === 'session' || UPCOMING_FIXTURE.has(e.fixture.status)),
    ) ?? null
  );
}

export interface EntryDay {
  key: string;
  heading: string;
  entries: TodayEntry[];
}

/** Entries grouped by their local day on their own facility clock, days in time order. */
export function groupEntriesByDay(entries: readonly TodayEntry[]): EntryDay[] {
  const days = new Map<string, EntryDay>();
  for (const entry of entries) {
    const key = localDayKey(entry.start, entry.zone.zone);
    let day = days.get(key);
    if (!day) {
      day = { key, heading: formatDay(entry.start, entry.zone.zone), entries: [] };
      days.set(key, day);
    }
    day.entries.push(entry);
  }
  return [...days.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The people an entry is for: the calendar's participant, or the viewer's members of the team. */
export function entryPersonIds(
  entry: TodayEntry,
  teams: readonly MyTeamEntry[] | undefined,
): string[] {
  if (entry.type === 'session') return [entry.item.personId];
  const f = entry.fixture;
  const entryIds = new Set([f.home.entryId, f.away?.entryId].filter(Boolean));
  return [
    ...new Set(
      (teams ?? [])
        .filter((t) => entryIds.has(t.teamEntry.id))
        .flatMap((t) => t.members.map((m) => m.personId)),
    ),
  ];
}

/**
 * Fixtures that overlap another commitment of the same person (SPK-YOUTH-007: highlighted, never
 * prevented). The calendar API compares sessions and bookings itself (`overlaps`); this adds the
 * fixtures it does not see, comparing the same half-open time ranges.
 */
export function fixtureOverlaps(
  entries: readonly TodayEntry[],
  teams: readonly MyTeamEntry[] | undefined,
): { ids: [string, string]; personIds: string[] }[] {
  const out: { ids: [string, string]; personIds: string[] }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const a = entries[i] as TodayEntry;
    for (let j = i + 1; j < entries.length; j += 1) {
      const b = entries[j] as TodayEntry;
      if (a.type === 'session' && b.type === 'session') continue;
      if (!(instant(a.start) < instant(b.end) && instant(b.start) < instant(a.end))) continue;
      const people = entryPersonIds(b, teams);
      const shared = entryPersonIds(a, teams).filter((p) => people.includes(p));
      if (shared.length > 0) out.push({ ids: [a.id, b.id], personIds: shared });
    }
  }
  return out;
}
