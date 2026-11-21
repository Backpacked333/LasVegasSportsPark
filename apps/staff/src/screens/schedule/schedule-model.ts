/**
 * The redesigned schedule's pure model (handoff S 1b day timeline, S 3e drag, S 2b week by use and
 * "Find a free slot"; SPK-SCHED-001 to SPK-SCHED-008). Everything here is a function of what the
 * screens already read (`GET /v1/events`, `/schedule-drafts`, `/closures`, `/resources`,
 * `/resource-availability`, `/reports/utilization`), so it is tested without a DOM:
 *
 * - one block list for the timeline: published and draft events, plus the changes of open schedule
 *   drafts (a draft "create" is a dashed block; a draft move or resize is a dashed ghost where the
 *   event would go);
 * - kind groups and their counts (League, Program, Rental, Party, Drop-in);
 * - conflicts: two blocks that hold the same space (the same resource or one sharing a conflict
 *   unit) at overlapping occupied times, and draft changes the API's validation flagged. The
 *   database exclusion constraint is the guarantee for published reservations (§4.7); these marks
 *   only point at what a person should look at;
 * - free gaps of at least an hour from now on, the 15-minute snapping of a drag, and the clash
 *   a proposed move would meet (named, so the screen can say what it hits);
 * - the week heatmap's cells and tone, and the free-slot search over the availability read.
 */
import type { Schema } from '@sportspark/api-client';
import { sharesSpace } from '../../features/schedule-facilities/inventory';
import {
  addDaysToLocalDate,
  localDateOf,
  wallClockAt,
  weekdayOfLocalDate,
} from '../../features/schedule-facilities/time';
import { kindTokenOf } from '../../features/schedule-facilities/sport';

type Event = Schema<'Event'>;
type Resource = Schema<'Resource'>;
type Closure = Schema<'Closure'>;
type ScheduleDraft = Schema<'ScheduleDraft'>;
type DraftChange = ScheduleDraft['changes'][number];

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** Moves and resizes snap to quarter hours (INTERACTIONS 1b row 5). */
export const STEP_MS = 15 * MINUTE;
/** A free gap shown as a "book" block is at least this long (S 1b header "free blocks over 1 h"). */
export const FREE_GAP_MIN_MS = HOUR;

const ms = (iso: string) => Date.parse(iso);

// ------------------------------------------------------------------------------------------------
// Kind groups
// ------------------------------------------------------------------------------------------------

export type KindGroup = 'league' | 'program' | 'rental' | 'party' | 'dropin' | 'other';

/** The chips of S 1b, in order, with the colour token each repeats (the word is always written). */
export const KIND_GROUPS: readonly { id: Exclude<KindGroup, 'other'>; label: string }[] = [
  { id: 'league', label: 'League' },
  { id: 'program', label: 'Program' },
  { id: 'rental', label: 'Rental' },
  { id: 'party', label: 'Party' },
  { id: 'dropin', label: 'Drop-in' },
];

export function kindGroupOf(kind: Event['kind']): KindGroup {
  switch (kind) {
    case 'game':
    case 'practice':
      return 'league';
    case 'session':
      return 'program';
    case 'rental':
      return 'rental';
    case 'party':
      return 'party';
    case 'pickup':
      return 'dropin';
    default:
      return 'other';
  }
}

// ------------------------------------------------------------------------------------------------
// Blocks
// ------------------------------------------------------------------------------------------------

export type BlockKind = 'event' | 'draft-create' | 'draft-change';

export interface DraftRef {
  id: string;
  name: string;
  revision: number;
  status: ScheduleDraft['status'];
  sequence: number;
  /** How many changes the draft holds (Delete removes one change, or discards a one-change draft). */
  changeCount: number;
  changes: readonly DraftChange[];
}

export interface TimelineBlock {
  key: string;
  type: BlockKind;
  title: string;
  kind: Event['kind'];
  sport: string | null;
  /** The colour token (`--kind-<token>`), basketball league play included. */
  token: string;
  group: KindGroup;
  start: number;
  end: number;
  setupMinutes: number;
  cleanupMinutes: number;
  resourceIds: readonly string[];
  status: Event['status'];
  /** The event the block shows (for a draft change: the event it changes). */
  event: Event | null;
  draft: DraftRef | null;
}

export function blockKey(block: Pick<TimelineBlock, 'key'>): string {
  return block.key;
}

export function occupied(block: TimelineBlock): { start: number; end: number } {
  return {
    start: block.start - block.setupMinutes * MINUTE,
    end: block.end + block.cleanupMinutes * MINUTE,
  };
}

const OPEN_DRAFT: ReadonlySet<ScheduleDraft['status']> = new Set([
  'editing',
  'validated',
  'failed',
]);

export function isOpenDraft(draft: Pick<ScheduleDraft, 'status'>): boolean {
  return OPEN_DRAFT.has(draft.status);
}

function eventBlock(event: Event): TimelineBlock {
  return {
    key: `event:${event.id}`,
    type: 'event',
    title: event.title,
    kind: event.kind,
    sport: event.sport ?? null,
    token: kindTokenOf(event),
    group: kindGroupOf(event.kind),
    start: ms(event.scheduledStart),
    end: ms(event.scheduledEnd),
    setupMinutes: event.setupMinutes,
    cleanupMinutes: event.cleanupMinutes,
    resourceIds: event.resourceIds,
    status: event.status,
    event,
    draft: null,
  };
}

/**
 * The timeline's blocks: every event loaded, then each change of an open draft that puts something
 * on the grid. A draft "create" of an event already listed as a draft event marks that event's
 * block with its draft (Publish publishes the draft); a move, resize or space change of a listed
 * event is a ghost at the proposed time and spaces. Changes whose target is not loaded are left out.
 */
export function buildBlocks(
  events: readonly Event[],
  drafts: readonly ScheduleDraft[],
): TimelineBlock[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const blocks = events.map(eventBlock);
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  for (const draft of drafts) {
    if (!isOpenDraft(draft)) continue;
    for (const change of draft.changes) {
      const ref: DraftRef = {
        id: draft.id,
        name: draft.name,
        revision: draft.revision,
        status: draft.status,
        sequence: change.sequence,
        changeCount: draft.changes.length,
        changes: draft.changes,
      };
      const p = change.proposed;
      if (change.kind === 'create') {
        if (change.targetEventId) {
          const block = byKey.get(`event:${change.targetEventId}`);
          if (block) block.draft = ref;
          continue;
        }
        if (!p.scheduledStart || !p.scheduledEnd || !p.kind) continue;
        blocks.push({
          key: `draft:${draft.id}:${change.sequence}`,
          type: 'draft-create',
          title: p.title ?? 'Untitled',
          kind: p.kind,
          sport: p.sport ?? null,
          token: kindTokenOf({ kind: p.kind, sport: p.sport ?? null }),
          group: kindGroupOf(p.kind),
          start: ms(p.scheduledStart),
          end: ms(p.scheduledEnd),
          setupMinutes: p.setupMinutes ?? 0,
          cleanupMinutes: p.cleanupMinutes ?? 0,
          resourceIds: change.resourceIds,
          status: 'draft',
          event: null,
          draft: ref,
        });
        continue;
      }
      if (change.kind === 'cancel' || !change.targetEventId) continue;
      const target = byId.get(change.targetEventId);
      if (!target) continue;
      blocks.push({
        ...eventBlock(target),
        key: `draft:${draft.id}:${change.sequence}`,
        type: 'draft-change',
        start: p.scheduledStart ? ms(p.scheduledStart) : ms(target.scheduledStart),
        end: p.scheduledEnd ? ms(p.scheduledEnd) : ms(target.scheduledEnd),
        resourceIds: change.resourceIds.length > 0 ? change.resourceIds : target.resourceIds,
        status: 'draft',
        draft: ref,
      });
    }
  }
  return blocks;
}

/** Whether two blocks hold the same physical space (the same resource, or a shared conflict unit). */
export function sameSpace(
  a: readonly string[],
  b: readonly string[],
  resources: readonly Resource[],
): boolean {
  if (a.some((id) => b.includes(id))) return true;
  const byId = new Map(resources.map((r) => [r.id, r]));
  return a.some((x) =>
    b.some((y) => {
      const rx = byId.get(x);
      const ry = byId.get(y);
      return !!rx && !!ry && sharesSpace(rx, ry);
    }),
  );
}

export interface Conflict {
  key: string;
  /** "overlaps Lee rental" */
  with: string;
}

/**
 * Blocks that clash: two live blocks on the same space at overlapping occupied times (a draft
 * ghost never clashes with the event it moves), and draft changes the API's last validation
 * flagged with a conflict. Each conflicting block names the first thing it overlaps.
 */
export function findConflicts(
  blocks: readonly TimelineBlock[],
  resources: readonly Resource[],
  drafts: readonly ScheduleDraft[] = [],
): Map<string, Conflict> {
  const out = new Map<string, Conflict>();
  const live = blocks.filter((b) => b.status !== 'canceled');
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i] as TimelineBlock;
      const b = live[j] as TimelineBlock;
      if (a.event && b.event && a.event.id === b.event.id) continue;
      // A draft ghost replaces its event: it is compared with everything except that event.
      const oa = occupied(a);
      const ob = occupied(b);
      if (!(oa.start < ob.end && ob.start < oa.end)) continue;
      if (!sameSpace(a.resourceIds, b.resourceIds, resources)) continue;
      // Two published events cannot overlap in the database; a pair where one is a draft can.
      if (!out.has(a.key)) out.set(a.key, { key: a.key, with: b.title });
      if (!out.has(b.key)) out.set(b.key, { key: b.key, with: a.title });
    }
  }
  for (const draft of drafts) {
    if (!isOpenDraft(draft)) continue;
    for (const issue of draft.validationResults?.issues ?? []) {
      if (issue.severity !== 'error' || !issue.detail) continue;
      const sequences =
        issue.detail.changeSequences ??
        (issue.changeSequence !== undefined ? [issue.changeSequence] : []);
      for (const sequence of sequences) {
        const block = blocks.find((b) => b.draft?.id === draft.id && b.draft.sequence === sequence);
        if (block && !out.has(block.key)) {
          out.set(block.key, { key: block.key, with: issue.detail.message });
        }
      }
    }
  }
  return out;
}

/** Counts per kind group of the live blocks (canceled and draft ghosts are not bookings). */
export function kindCounts(blocks: readonly TimelineBlock[]): Record<KindGroup, number> {
  const counts: Record<KindGroup, number> = {
    league: 0,
    program: 0,
    rental: 0,
    party: 0,
    dropin: 0,
    other: 0,
  };
  for (const b of blocks) {
    if (b.status === 'canceled' || b.type === 'draft-change') continue;
    counts[b.group] += 1;
  }
  return counts;
}

/** Draft blocks: unpublished events and open draft changes. */
export function isDraftBlock(block: TimelineBlock): boolean {
  return block.status === 'draft' || block.draft !== null;
}

export type GridFilter =
  { type: 'all' } | { type: 'kind'; group: KindGroup } | { type: 'conflicts' } | { type: 'drafts' };

/** Whether a block stays visible under the chip filter of S 1b. */
export function passesFilter(
  block: TimelineBlock,
  filter: GridFilter,
  conflicts: ReadonlyMap<string, Conflict>,
): boolean {
  switch (filter.type) {
    case 'all':
      return true;
    case 'kind':
      return block.group === filter.group;
    case 'conflicts':
      return conflicts.has(block.key);
    case 'drafts':
      return isDraftBlock(block);
  }
}

// ------------------------------------------------------------------------------------------------
// Free time, snapping and clashes
// ------------------------------------------------------------------------------------------------

export interface Gap {
  resourceId: string;
  start: number;
  end: number;
}

export function ceilToStep(t: number, step = STEP_MS): number {
  return Math.ceil(t / step) * step;
}

export function snap(t: number, step = STEP_MS): number {
  return Math.round(t / step) * step;
}

/** The intervals that hold a space: its blocks, blocks of shared space and covering closures. */
export function busyIntervals(
  resource: Resource,
  blocks: readonly TimelineBlock[],
  closures: readonly Closure[],
  resources: readonly Resource[],
  exclude?: string,
): { start: number; end: number; title: string }[] {
  const out: { start: number; end: number; title: string }[] = [];
  for (const b of blocks) {
    if (b.status === 'canceled' || b.key === exclude) continue;
    if (exclude && b.event && blocks.find((x) => x.key === exclude)?.event?.id === b.event.id) {
      continue;
    }
    if (!sameSpace([resource.id], b.resourceIds, resources)) continue;
    const o = occupied(b);
    out.push({ ...o, title: b.title });
  }
  for (const c of closures) {
    if (c.status !== 'active') continue;
    if (!closureCoversResource(c, resource, resources)) continue;
    out.push({ start: ms(c.interval.start), end: ms(c.interval.end), title: c.reason });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function closureCoversResource(
  closure: Closure,
  resource: Resource,
  all: readonly Resource[],
): boolean {
  if (closure.resourceId === null || closure.resourceId === resource.id) return true;
  const closed = all.find((r) => r.id === closure.resourceId);
  return closed ? sharesSpace(closed, resource) : false;
}

/**
 * Free gaps of at least `minMs` on one space inside the window, from now on (time already gone is
 * not bookable). Inactive spaces have none.
 */
export function freeGaps(
  resource: Resource,
  blocks: readonly TimelineBlock[],
  closures: readonly Closure[],
  resources: readonly Resource[],
  window: { start: number; end: number },
  now: number,
  minMs = FREE_GAP_MIN_MS,
): Gap[] {
  if (resource.status !== 'active') return [];
  const from = Math.max(window.start, ceilToStep(now));
  if (from >= window.end) return [];
  const busy = busyIntervals(resource, blocks, closures, resources);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start > cursor && b.start - cursor >= minMs) {
      gaps.push({ resourceId: resource.id, start: cursor, end: Math.min(b.start, window.end) });
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (window.end - cursor >= minMs)
    gaps.push({ resourceId: resource.id, start: cursor, end: window.end });
  return gaps.filter((g) => g.end - g.start >= minMs);
}

export interface Clash {
  title: string;
  start: number;
  end: number;
}

/**
 * What a block would hit at a proposed time and space: the first booking or closure holding that
 * space then (setup and cleanup included). Null when the slot is free on the data loaded; the
 * API's validation and the database constraint still decide.
 */
export function clashAt(
  moving: TimelineBlock,
  proposal: { start: number; end: number; resourceIds: readonly string[] },
  blocks: readonly TimelineBlock[],
  closures: readonly Closure[],
  resources: readonly Resource[],
): Clash | null {
  const start = proposal.start - moving.setupMinutes * MINUTE;
  const end = proposal.end + moving.cleanupMinutes * MINUTE;
  for (const id of proposal.resourceIds) {
    const resource = resources.find((r) => r.id === id);
    if (!resource) continue;
    for (const b of busyIntervals(resource, blocks, closures, resources, moving.key)) {
      if (b.start < end && start < b.end) return b;
    }
  }
  return null;
}

/** Gaps on any of the rows that a block of this length fits into (they glow while dragging). */
export function fittingGaps(gaps: readonly Gap[], lengthMs: number): Gap[] {
  return gaps.filter((g) => g.end - g.start >= lengthMs);
}

// ------------------------------------------------------------------------------------------------
// Week by use (S 2b)
// ------------------------------------------------------------------------------------------------

/** Monday of the local week holding `date` (the design's week runs Mon to Sun). */
export function weekStart(date: string): string {
  const weekday = weekdayOfLocalDate(date); // 0 = Sunday
  return addDaysToLocalDate(date, weekday === 0 ? -6 : 1 - weekday);
}

export function weekDates(date: string): string[] {
  const monday = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDaysToLocalDate(monday, i));
}

/** Five steps of the use scale (0 to 4) for a share of open hours booked; null when unknown. */
export function heatStep(rate: number | null): number | null {
  if (rate === null || Number.isNaN(rate)) return null;
  if (rate >= 0.9) return 4;
  if (rate >= 0.75) return 3;
  if (rate >= 0.6) return 2;
  if (rate >= 0.4) return 1;
  return 0;
}

export interface HeatClosure {
  /** "Closed" for the whole open day, else "Until 1 PM". */
  label: string;
  reason: string;
}

export interface HeatCell {
  resourceId: string;
  date: string;
  bookings: number;
  rate: number | null;
  conflicts: number;
  closure: HeatClosure | null;
}

/** "1 PM" / "1:30 PM" in the zone. */
export function hourLabel(t: number, timeZone: string): string {
  const w = wallClockAt(t, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  const suffix = w.hour < 12 ? 'AM' : 'PM';
  return w.minute === 0 ? `${h} ${suffix}` : `${h}:${String(w.minute).padStart(2, '0')} ${suffix}`;
}

/** "9:00", "12:30": the clock written in blocks (the axis says AM/PM). */
export function blockClock(t: number, timeZone: string): string {
  const w = wallClockAt(t, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${String(w.minute).padStart(2, '0')}`;
}

/**
 * Lanes of one row: a block that overlaps an earlier one on the same row (only a draft can) is
 * drawn on the lower lane, so both stay readable (S 1b "Skills clinic" over "Lee rental").
 */
export function lanesOf(blocks: readonly TimelineBlock[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const sorted = [...blocks]
    .filter((b) => b.status !== 'canceled')
    .sort((a, b) => a.start - b.start || (a.type === 'event' ? -1 : 1));
  const placed: TimelineBlock[] = [];
  for (const b of sorted) {
    const clash = placed.some(
      (p) => (lanes.get(p.key) ?? 0) === 0 && p.start < b.end && b.start < p.end,
    );
    lanes.set(b.key, clash ? 1 : 0);
    placed.push(b);
  }
  return lanes;
}

/** How many conflicts the chip counts: each clash once (a pair is one conflict). */
export function conflictCount(
  conflicts: ReadonlyMap<string, Conflict>,
  blocks: readonly TimelineBlock[],
): number {
  const drafts = [...conflicts.keys()].filter((k) => {
    const b = blocks.find((x) => x.key === k);
    return b ? isDraftBlock(b) : false;
  }).length;
  return drafts > 0 ? drafts : Math.ceil(conflicts.size / 2);
}

/** Row order of S 1b: fields first, then courts and other spaces, then rooms; by name within. */
export function rowRank(kind: Resource['kind']): number {
  return kind === 'pitch' ? 0 : kind === 'other' ? 1 : kind === 'room' ? 2 : 3;
}

/** Tree rows (each space followed by its subdivisions) reordered by `rowRank` of the space. */
export function byRowRank<R extends { resource: Resource; depth: number }>(
  rows: readonly R[],
): R[] {
  const groups: R[][] = [];
  for (const row of rows) {
    if (row.depth === 0 || groups.length === 0) groups.push([row]);
    else groups[groups.length - 1]!.push(row);
  }
  return groups
    .map((g, i) => ({ g, i, rank: rowRank(g[0]!.resource.kind) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .flatMap((x) => x.g);
}

/** "9", "12", "1:30": a compact clock for block and gap labels (the hour axis says AM/PM). */
export function shortClock(t: number, timeZone: string): string {
  const w = wallClockAt(t, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return w.minute === 0 ? String(h) : `${h}:${String(w.minute).padStart(2, '0')}`;
}

/**
 * One heat cell per space and local day: bookings counted from the events loaded (per local day of
 * their start), conflicts from the block marks, the share of open hours booked from the utilization
 * report (null when the viewer may not read it), and a closure written as "Closed" or "Until 1 PM".
 */
export function heatCells(input: {
  /** The rows (top-level spaces). */
  resources: readonly Resource[];
  /** Every space, so a booking of a subdivision counts on its pitch (shared ground). */
  inventory?: readonly Resource[];
  dates: readonly string[];
  blocks: readonly TimelineBlock[];
  conflicts: ReadonlyMap<string, Conflict>;
  closures: readonly Closure[];
  rates: ReadonlyMap<string, number | null>;
  timeZone: string;
  dayWindow: (date: string) => { start: number; end: number };
}): HeatCell[] {
  const cells: HeatCell[] = [];
  const all = input.inventory ?? input.resources;
  for (const resource of input.resources) {
    for (const date of input.dates) {
      const own = input.blocks.filter(
        (b) =>
          b.status !== 'canceled' &&
          b.type !== 'draft-change' &&
          localDateOf(b.start, input.timeZone) === date &&
          sameSpace([resource.id], b.resourceIds, all),
      );
      const day = input.dayWindow(date);
      const closure = input.closures.find(
        (c) =>
          c.status === 'active' &&
          closureCoversResource(c, resource, all) &&
          ms(c.interval.start) < day.end &&
          ms(c.interval.end) > day.start,
      );
      let heat: HeatClosure | null = null;
      if (closure) {
        const until = ms(closure.interval.end);
        heat = {
          label: until >= day.end ? 'Closed' : `Until ${hourLabel(until, input.timeZone)}`,
          reason: closure.reason,
        };
      }
      cells.push({
        resourceId: resource.id,
        date,
        bookings: own.length,
        rate: input.rates.get(`${resource.id}|${date}`) ?? null,
        conflicts: (() => {
          const marked = own.filter((b) => input.conflicts.has(b.key));
          const drafts = marked.filter(isDraftBlock).length;
          return drafts > 0 ? drafts : Math.ceil(marked.length / 2);
        })(),
        closure: heat,
      });
    }
  }
  return cells;
}

// ------------------------------------------------------------------------------------------------
// Find a free slot (S 2b)
// ------------------------------------------------------------------------------------------------

export type DaysChoice = 'any' | 'weekend' | 'weekdays';

export const DAYS_LABEL: Record<DaysChoice, string> = {
  any: 'Any day',
  weekend: 'Sat–Sun',
  weekdays: 'Mon–Fri',
};

export interface SlotQuery {
  /** A compatible format ("7v7") or a resource kind ("room"); empty means any space. */
  spaceType: string;
  lengthMinutes: number;
  days: DaysChoice;
  /** Local hours [from, to): a start between them whose end is at or before `to`. */
  between: [number, number];
}

export interface SlotMatch {
  resourceId: string;
  resourceName: string;
  date: string;
  start: number;
  end: number;
}

type AvailabilityResource = Schema<'FacilityAvailability'>['resources'][number];

/** Whether a resource is of the chosen space type (its format list or its kind). */
export function matchesSpaceType(resource: Resource | undefined, spaceType: string): boolean {
  if (!spaceType) return true;
  if (!resource) return false;
  if (spaceType.startsWith('kind:')) return resource.kind === spaceType.slice(5);
  return resource.compatibleFormats.includes(spaceType);
}

/**
 * The earliest free start per space and local day that matches the query, earliest first. The
 * availability read already applied conflict units, buffers, closures and operating hours; this
 * keeps the days, hours and space type asked for, from now on.
 */
export function slotMatches(
  availability: readonly AvailabilityResource[],
  resources: readonly Resource[],
  query: SlotQuery,
  timeZone: string,
  now: number,
): SlotMatch[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const best = new Map<string, SlotMatch>();
  const length = query.lengthMinutes * MINUTE;
  for (const entry of availability) {
    const resource = byId.get(entry.resourceId);
    if (!matchesSpaceType(resource, query.spaceType)) continue;
    for (const slot of entry.slots) {
      const start = ms(slot.start);
      const end = start + length;
      if (start < now) continue;
      const date = localDateOf(start, timeZone);
      const weekday = weekdayOfLocalDate(date);
      const weekend = weekday === 0 || weekday === 6;
      if (query.days === 'weekend' && !weekend) continue;
      if (query.days === 'weekdays' && weekend) continue;
      const s = wallClockAt(start, timeZone);
      const e = wallClockAt(end, timeZone);
      const startMin = s.hour * 60 + s.minute;
      const endMin = (localDateOf(end, timeZone) === date ? e.hour * 60 : 24 * 60) + e.minute;
      if (startMin < query.between[0] * 60 || endMin > query.between[1] * 60) continue;
      const key = `${entry.resourceId}|${date}`;
      const known = best.get(key);
      if (!known || start < known.start) {
        best.set(key, { resourceId: entry.resourceId, resourceName: entry.name, date, start, end });
      }
    }
  }
  return [...best.values()].sort(
    (a, b) => a.start - b.start || a.resourceName.localeCompare(b.resourceName),
  );
}

/** The no-match sentence of INTERACTIONS 2b row 3, with the nearest easier search. */
export function noMatchMessage(query: SlotQuery, spaceLabel: string): string {
  const shorter = query.lengthMinutes > 60 ? `${query.lengthMinutes - 30} min` : null;
  const days = query.days === 'weekdays' ? 'weekends' : 'weekdays';
  const tries = [shorter, days].filter(Boolean).join(' or ');
  return `No free ${query.lengthMinutes}-min ${spaceLabel} slot. Try ${tries}.`;
}

// ------------------------------------------------------------------------------------------------
// Regular customers (S 5a)
// ------------------------------------------------------------------------------------------------

type Booking = Schema<'Booking'>;

export interface Regular {
  personId: string;
  bookings: number;
  /** "Rents Field 5 most Saturdays", from their bookings' spaces and weekdays. */
  habit: string;
  offeringId: string;
}

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

/** Bookers by how often they book here, each with what they usually book (from the bookings read). */
export function regularsOf(bookings: readonly Booking[], timeZone: string): Regular[] {
  const by = new Map<string, Booking[]>();
  for (const b of bookings) {
    if (b.status === 'declined' || b.status === 'expired') continue;
    by.set(b.bookerPersonId, [...(by.get(b.bookerPersonId) ?? []), b]);
  }
  const out: Regular[] = [];
  for (const [personId, list] of by) {
    const occurrences = list.flatMap((b) => b.occurrences);
    const spaces = new Map<string, number>();
    const days = new Map<number, number>();
    for (const o of occurrences) {
      const name = o.resources[0]?.name;
      if (name) spaces.set(name, (spaces.get(name) ?? 0) + 1);
      const day = weekdayOfLocalDate(localDateOf(o.start, timeZone));
      days.set(day, (days.get(day) ?? 0) + 1);
    }
    const top = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    const space = top(spaces);
    const day = top(days);
    const verb = list[0]?.kind === 'party' ? 'Books' : 'Rents';
    const habit = space
      ? day && day[1] >= 2
        ? `${verb} ${space[0]} most ${WEEKDAYS[day[0]]}`
        : `${verb} ${space[0]}`
      : `${list.length} booking${list.length === 1 ? '' : 's'} here`;
    out.push({
      personId,
      bookings: occurrences.length,
      habit,
      offeringId: list[0]?.offeringId ?? '',
    });
  }
  return out.sort((a, b) => b.bookings - a.bookings);
}
