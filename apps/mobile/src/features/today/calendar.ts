/**
 * Family calendar windows (SPK-YOUTH-007, `GET /v1/me/family-calendar`). The API serves a window of
 * at most 120 days (`MAX_WINDOW_DAYS` in the enrollment module); the screens read consecutive
 * windows that start at local midnight, so a window Home reads is the same cached response the
 * Schedule reads first.
 */
import type { Schema } from '@sportspark/api-client';
import { addLocalDays, formatDay, localDayKey, startOfLocalDay } from './time';

type FamilyCalendar = Schema<'FamilyCalendar'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;

/** The API's limit on one calendar window. */
export const MAX_CALENDAR_WINDOW_DAYS = 120;

/** The `from`/`to` query of window `index` of `days` days starting at `anchor`'s local midnight. */
export function calendarWindowQuery(anchor: Date, index: number, days: number, zone: string) {
  const start = addLocalDays(startOfLocalDay(anchor, zone), index * days, zone);
  const end = addLocalDays(start, days, zone);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Several consecutive windows as one calendar: items de-duplicated, overlaps merged. */
export function mergeCalendars(calendars: readonly FamilyCalendar[]): FamilyCalendar | undefined {
  const [first] = calendars;
  if (!first) return undefined;
  const items = new Map<string, FamilyCalendarItem>();
  const overlaps = new Map<string, FamilyCalendar['overlaps'][number]>();
  const people = new Set<string>();
  for (const c of calendars) {
    c.participantPersonIds.forEach((id) => people.add(id));
    c.items.forEach((i) => items.set(i.id, i));
    c.overlaps.forEach((o) => overlaps.set(o.itemIds.join('|'), o));
  }
  const last = calendars[calendars.length - 1] ?? first;
  return {
    from: first.from,
    to: last.to,
    participantPersonIds: [...people],
    items: [...items.values()].sort(
      (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id),
    ),
    overlaps: [...overlaps.values()],
  };
}

/** The first activity that has not ended yet (ongoing or upcoming). */
export function nextActivity(
  items: readonly FamilyCalendarItem[],
  now: Date,
): FamilyCalendarItem | null {
  return items.find((i) => new Date(i.end).getTime() > now.getTime()) ?? null;
}

export interface DayGroup {
  key: string;
  heading: string;
  items: FamilyCalendarItem[];
}

/** Items grouped by calendar day in `zone`, in time order. */
export function groupByDay(items: readonly FamilyCalendarItem[], zone: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const key = localDayKey(item.start, zone);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, heading: formatDay(item.start, zone), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** For each item, the other items it overlaps (SPK-YOUTH-007: highlighted, never prevented). */
export function overlapIndex(calendar: Pick<FamilyCalendar, 'overlaps'>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const o of calendar.overlaps) {
    const [a, b] = o.itemIds;
    index.set(a, [...(index.get(a) ?? []), b]);
    index.set(b, [...(index.get(b) ?? []), a]);
  }
  return index;
}
