/**
 * Pure derivations of the redesigned Today (S 1a, S 1d, S 3a): what starts in the next hour, the
 * day's axis of the field board, what each space is doing, the issue cards and their order. No
 * reads here; every input is an API answer (or the injected clock), so each rule is tested on its
 * own (`__tests__/today-model.test.ts`).
 */
import type { Schema } from '@sportspark/api-client';

export type TodayItem = Schema<'TodayItem'>;
export type TodayFacility = Schema<'TodayFeed'>['facilities'][number];
export type ScheduledEvent = Schema<'Event'>;
export type ResourceStatus = Schema<'ResourceOperatingStatus'>;

export const MINUTE = 60_000;
export const NEXT_HOUR_MS = 60 * MINUTE;
/** A blocking issue may not be snoozed in the last 15 minutes before its start. */
export const SNOOZE_LOCK_MS = 15 * MINUTE;
export const SNOOZE_MS = 30 * MINUTE;
/** An offer nobody answered for 15 minutes rises to the top and turns red. */
export const ASK_ESCALATE_MS = 15 * MINUTE;

/** Kinds that are something to get ready for (maintenance and blocks are not starts). */
const START_KINDS = new Set<ScheduledEvent['kind']>([
  'game',
  'practice',
  'session',
  'rental',
  'party',
  'pickup',
]);

/** Published activities starting from now to an hour from now, by start then title. */
export function nextHourStarts(events: readonly ScheduledEvent[], now: Date): ScheduledEvent[] {
  const from = now.getTime();
  const to = from + NEXT_HOUR_MS;
  return events
    .filter((e) => e.status === 'published' && START_KINDS.has(e.kind))
    .filter((e) => {
      const t = new Date(e.scheduledStart).getTime();
      return t >= from && t < to;
    })
    .sort(
      (a, b) => a.scheduledStart.localeCompare(b.scheduledStart) || a.title.localeCompare(b.title),
    );
}

/** "Starts in 14 min" / "Starting now" / "Started 3 min ago". */
export function startsIn(startIso: string, now: Date): string {
  const minutes = Math.round((new Date(startIso).getTime() - now.getTime()) / MINUTE);
  if (minutes > 0) return `Starts in ${minutes} min`;
  if (minutes === 0) return 'Starting now';
  return `Started ${-minutes} min ago`;
}

/** The hour (0-23) and minute of an instant in a time zone. */
export function localClock(iso: string | Date, timeZone: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(typeof iso === 'string' ? new Date(iso) : iso);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { h: h === 24 ? 0 : h, m };
}

/** "9:00" or "9:00 PM" style short time in the facility's zone ("9:00" when `bare`). */
export function shortTime(iso: string, timeZone: string, bare = false): string {
  const text = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
  return bare ? text.replace(/\s?[AP]M$/, '') : text;
}

/**
 * The field board's time axis for a facility day: from 8 AM (or the first activity, if earlier)
 * to 8 PM (or the last end, if later), whole hours, in the facility's zone. Returned as instants.
 */
export function boardAxis(
  facility: Pick<TodayFacility, 'window' | 'timezone'>,
  events: readonly ScheduledEvent[],
): { start: number; end: number; hours: number[] } {
  const dayStart = new Date(facility.window.start).getTime();
  const dayEnd = new Date(facility.window.end).getTime();
  // The window starts at local midnight (or the operating day start): hour offsets from it.
  const startHour = localClock(facility.window.start, facility.timezone).h;
  const hourAt = (h: number) => dayStart + (h - startHour) * 60 * MINUTE;
  let start = hourAt(8);
  let end = hourAt(20);
  for (const e of events) {
    const s = new Date(e.scheduledStart).getTime();
    const f = new Date(e.scheduledEnd).getTime();
    if (f <= dayStart || s >= dayEnd) continue;
    start = Math.min(start, Math.max(dayStart, s));
    end = Math.max(end, Math.min(dayEnd, f));
  }
  const hour = 60 * MINUTE;
  start = dayStart + Math.floor((start - dayStart) / hour) * hour;
  end = dayStart + Math.ceil((end - dayStart) / hour) * hour;
  const hours: number[] = [];
  for (let t = start; t <= end; t += 2 * hour) hours.push(t);
  return { start, end, hours };
}

/** "8", "10", "12", "2", "4", "6", "8 PM": the axis labels, the last with its meridiem. */
export function axisLabel(instant: number, timeZone: string, last: boolean): string {
  const { h } = localClock(new Date(instant), timeZone);
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return last ? `${twelve} ${h < 12 ? 'AM' : 'PM'}` : String(twelve);
}

/** Position of an interval on the axis, in percent, clipped. */
export function span(
  startIso: string,
  endIso: string,
  axis: { start: number; end: number },
): { left: number; width: number } | null {
  const total = axis.end - axis.start;
  const s = Math.max(axis.start, new Date(startIso).getTime());
  const e = Math.min(axis.end, new Date(endIso).getTime());
  if (!(e > s) || total <= 0) return null;
  return { left: ((s - axis.start) / total) * 100, width: ((e - s) / total) * 100 };
}

export interface SpaceNow {
  current: ScheduledEvent | undefined;
  next: ScheduledEvent | undefined;
  /** Percent of the current activity done. */
  progress: number | null;
  minutesLeft: number | null;
  /** Every activity of the day on the space, by start. */
  day: ScheduledEvent[];
}

/** What a space is doing now and next (a parent space counts its halves' activities too). */
export function spaceNow(
  resource: Pick<ResourceStatus, 'resourceId'>,
  events: readonly ScheduledEvent[],
  now: Date,
  childIds: readonly string[] = [],
): SpaceNow {
  const ids = new Set([resource.resourceId, ...childIds]);
  const day = events
    .filter((e) => e.status !== 'canceled' && e.resourceIds.some((id) => ids.has(id)))
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  const t = now.getTime();
  const current = day.find(
    (e) => new Date(e.scheduledStart).getTime() <= t && new Date(e.scheduledEnd).getTime() > t,
  );
  const next = day.find((e) => new Date(e.scheduledStart).getTime() > t);
  let progress: number | null = null;
  let minutesLeft: number | null = null;
  if (current) {
    const s = new Date(current.scheduledStart).getTime();
    const e = new Date(current.scheduledEnd).getTime();
    progress = Math.min(100, Math.max(0, Math.round(((t - s) / (e - s)) * 100)));
    minutesLeft = Math.max(0, Math.round((e - t) / MINUTE));
  }
  return { current, next, progress, minutesLeft, day };
}

/** Spaces in use now, out of the top-level spaces, and how many are closed. */
export function spacesInUse(
  resources: readonly ResourceStatus[],
  events: readonly ScheduledEvent[],
  now: Date,
): { inUse: number; total: number; closed: number } {
  const top = resources.filter((r) => r.parentResourceId === null);
  let inUse = 0;
  let closed = 0;
  for (const r of top) {
    const children = resources.filter((c) => c.parentResourceId === r.resourceId);
    if (r.restrictions.some((x) => x.kind === 'closed') || r.inventoryStatus === 'closed') {
      closed += 1;
    }
    if (
      spaceNow(
        r,
        events,
        now,
        children.map((c) => c.resourceId),
      ).current
    ) {
      inUse += 1;
    }
  }
  return { inUse, total: top.length, closed };
}

/**
 * The busiest two hours of the day: the start of the two-hour band where the most top-level
 * spaces are booked, and how many. Null when nothing is booked.
 */
export function peakBand(
  resources: readonly ResourceStatus[],
  events: readonly ScheduledEvent[],
  axis: { start: number; end: number },
): { start: number; booked: number; total: number } | null {
  const top = resources.filter((r) => r.parentResourceId === null);
  const hour = 60 * MINUTE;
  let best: { start: number; booked: number } | null = null;
  for (let t = axis.start; t + 2 * hour <= axis.end; t += hour) {
    let booked = 0;
    for (const r of top) {
      const ids = new Set([
        r.resourceId,
        ...resources.filter((c) => c.parentResourceId === r.resourceId).map((c) => c.resourceId),
      ]);
      const busy = events.some(
        (e) =>
          e.status !== 'canceled' &&
          e.resourceIds.some((id) => ids.has(id)) &&
          new Date(e.scheduledStart).getTime() < t + 2 * hour &&
          new Date(e.scheduledEnd).getTime() > t,
      );
      if (busy) booked += 1;
    }
    if (booked > 0 && (!best || booked > best.booked)) best = { start: t, booked };
  }
  return best ? { ...best, total: top.length } : null;
}

/** "T. Nguyen" from "Taylor Nguyen" (a single name stays whole). */
export function shortName(name: string | null | undefined): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]![0]}. ${parts.slice(1).join(' ')}`;
}

// ---------------------------------------------------------------------------------------------
// Issues ("Needs action")
// ---------------------------------------------------------------------------------------------

export type IssueKind = 'staffing' | 'readiness' | 'restriction' | 'money' | 'waivers' | 'other';

export interface IssueCard {
  id: string;
  kind: IssueKind;
  title: string;
  /** The activity it is about, when it has one. */
  eventId: string | null;
  startAt: string | null;
  /** It stops something starting (red edge, "Blocks start"). */
  blocking: boolean;
  severity: TodayItem['severity'];
  item: TodayItem | null;
  /** Readiness messages that still apply after folding (S 1a). */
  messages: string[];
}

const SEVERITY_RANK: Record<TodayItem['severity'], number> = {
  critical: 0,
  high: 1,
  warning: 2,
  info: 3,
};

/** At the same start, the fix in hand (a person) comes before the facts (readiness). */
const KIND_RANK: Record<IssueKind, number> = {
  staffing: 0,
  waivers: 1,
  readiness: 2,
  restriction: 3,
  other: 4,
  money: 5,
};

function kindOf(item: TodayItem): IssueKind {
  if (item.category === 'workforce.uncovered_assignment') return 'staffing';
  if (item.source === 'readiness') return 'readiness';
  if (item.source === 'restriction') return 'restriction';
  if (item.group === 'financial') return 'money';
  return 'other';
}

function fixtureOf(item: TodayItem): string | null {
  if (item.affected?.type === 'fixture') return item.affected.id;
  const id = item.details['fixtureId'];
  return typeof id === 'string' ? id : null;
}

function readinessMessages(item: TodayItem): Array<{ code: string; message: string }> {
  const issues = item.details['issues'];
  if (!Array.isArray(issues)) return [];
  return issues
    .filter(
      (i): i is { code: string; message: string; severity: string } =>
        typeof i === 'object' && i !== null && 'message' in i && 'code' in i,
    )
    .filter((i) => i.severity !== 'info')
    .map((i) => ({ code: i.code, message: i.message }));
}

/**
 * The Today feed's items as issue cards: a readiness item drops the officials message an uncovered
 * referee item already shows (and disappears when nothing else is left), events are matched by
 * id or fixture so a card knows its start, and blocking means "high or critical, about an activity
 * starting within the hour" (S 1a "Blocks start").
 */
export function issueCards(
  items: readonly TodayItem[],
  events: readonly ScheduledEvent[],
  now: Date,
): IssueCard[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const byFixture = new Map(
    events.filter((e) => e.sourceType === 'fixture' && e.sourceId).map((e) => [e.sourceId!, e]),
  );
  const staffedFixtures = new Set(
    items
      .filter((i) => kindOf(i) === 'staffing')
      .map(fixtureOf)
      .filter(Boolean) as string[],
  );
  const cards: IssueCard[] = [];
  for (const item of items) {
    const kind = kindOf(item);
    const eventIdDetail = item.details['eventId'];
    const fixtureId = fixtureOf(item);
    const event =
      (typeof eventIdDetail === 'string' ? byId.get(eventIdDetail) : undefined) ??
      (fixtureId ? byFixture.get(fixtureId) : undefined) ??
      (item.affected?.type === 'event' ? byId.get(item.affected.id) : undefined);
    let messages: string[] = [];
    if (kind === 'readiness') {
      const all = readinessMessages(item);
      const left = all.filter(
        (m) =>
          !(
            m.code === 'required_officials_not_accepted' &&
            fixtureId &&
            staffedFixtures.has(fixtureId)
          ),
      );
      if (all.length > 0 && left.length === 0) continue;
      messages = left.map((m) => m.message);
    }
    const startAt =
      event?.scheduledStart ??
      (typeof item.details['startsAt'] === 'string' ? (item.details['startsAt'] as string) : null);
    const soon = startAt !== null && new Date(startAt).getTime() - now.getTime() < NEXT_HOUR_MS;
    cards.push({
      id: item.id,
      kind,
      title:
        kind === 'readiness' && event
          ? `${event.title} ${messages.length === 1 ? 'is not ready' : `has ${messages.length} blocking issues`}`
          : item.title,
      eventId: event?.id ?? null,
      startAt,
      blocking:
        (item.severity === 'critical' || item.severity === 'high') && soon && kind !== 'money',
      severity: item.severity,
      item,
      messages,
    });
  }
  return cards;
}

/** Blocking first, then by start time, then untimed issues by severity (S 1a "Sorted by start time"). */
export function orderIssues(
  cards: readonly IssueCard[],
  escalated: ReadonlySet<string>,
): IssueCard[] {
  const rank = (c: IssueCard) => (escalated.has(c.id) ? 0 : c.blocking ? 1 : c.startAt ? 2 : 3);
  return [...cards].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.startAt && b.startAt ? a.startAt.localeCompare(b.startAt) : 0) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.title.localeCompare(b.title),
  );
}

/** A blocking issue cannot be snoozed in the last 15 minutes before its start. */
export function canSnooze(card: IssueCard, now: Date): boolean {
  if (!card.blocking || !card.startAt) return true;
  return new Date(card.startAt).getTime() - now.getTime() > SNOOZE_LOCK_MS;
}

/** The median of a list of minutes, rounded; null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}
