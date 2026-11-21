/**
 * SCR-S-03 resource timeline, as the redesign draws it (handoff S 1b day timeline and S 3e drag;
 * SPK-SCHED-001, SPK-SCHED-002, SPK-SCHED-003, SPK-SCHED-005, SPK-SCHED-008, SPK-FAC-003,
 * SPK-UX-009): every space of the facility as a 68 px row on one facility-local hour grid.
 *
 * - Blocks are the day's events and the changes of open drafts (`schedule-model.ts`), coloured by
 *   activity kind with the kind written in the block's name; drafts are dashed, applied closures
 *   and maintenance restrictions hatched, pending closures outlined, time held through shared
 *   space shaded. A block that clashes says what it overlaps. A now-line marks the current instant.
 * - Free gaps of an hour or more from now on are dashed "+ Free 12–2 · book" blocks; tapping one,
 *   or empty time on a row, books that space at that time (INTERACTIONS 1b rows 1 and 2).
 * - Dragging (pointer: press and move; touch: long-press, then move) moves a booking to another
 *   time or space in 15-minute steps; dragging a block's edge resizes it. While dragging the block
 *   tilts, its old place says "was here", gaps it fits glow green, and over a clash it turns red
 *   and names what it hits. Dropping on a clash snaps back; Escape cancels. A valid drop is handed
 *   to `useScheduleMove` (draft, validation, then Notify or Undo). Keyboard users move through the
 *   detail rail's "Move" form; the drag is a shortcut, never the only way (SPK-UX-009).
 *
 * Each block is a button named in full (kind, time, status, clash); colour and pattern are never the
 * only signal, and the calendar's text list carries the same information.
 */
import type { Schema } from '@sportspark/api-client';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { sharesSpace } from '../../features/schedule-facilities/inventory';
import { CLOSURE_BADGE, EVENT_KIND_LABEL } from '../../features/schedule-facilities/labels';
import { KIND_TOKEN, sportLabel } from '../../features/schedule-facilities/sport';
import { formatRange, localTimeOf, wallClockAt } from '../../features/schedule-facilities/time';
import { plainWords } from '../../ui/StatusBadge';
import {
  HOUR,
  STEP_MS,
  blockClock,
  clashAt,
  lanesOf,
  closureCoversResource,
  fittingGaps,
  occupied,
  shortClock,
  snap,
  type Clash,
  type Conflict,
  type Gap,
  type TimelineBlock,
} from './schedule-model';
import type { MoveAbility, MoveProposal, PendingMove } from './useScheduleMove';

type Resource = Schema<'Resource'>;
type Event = Schema<'Event'>;
type Closure = Schema<'Closure'>;
type EventKind = Event['kind'];

export { KIND_TOKEN };

export const KIND_ORDER: readonly EventKind[] = [
  'game',
  'practice',
  'session',
  'rental',
  'party',
  'pickup',
  'maintenance',
  'block',
];

/** What the detail rail shows: a block (event or draft change) or a closure. */
export type Selection = { type: 'block'; key: string } | { type: 'closure'; id: string } | null;

export function selectionKey(s: Selection): string {
  if (!s) return '';
  return s.type === 'block' ? s.key : `closure:${s.id}`;
}

/** Whether a closure covers a resource: the whole facility, the resource, or shared space. */
export function closureCovers(
  closure: Closure,
  resource: Resource,
  all: readonly Resource[],
): boolean {
  return closureCoversResource(closure, resource, all);
}

export interface Tick {
  at: number;
  label: string;
}

export interface TimelineWindow {
  start: number;
  end: number;
  ticks: Tick[];
}

/** The local hour that starts at or before `t` (whole local hours, also for half-hour zones). */
function floorLocalHour(t: number, tz: string): number {
  const w = wallClockAt(t, tz);
  return Math.floor(t / 60_000) * 60_000 - w.minute * 60_000;
}

/** "8 AM", "9", …, "12 PM", "1": the hour axis of S 1b (AM/PM on the first tick and at noon). */
export function tickLabel(t: number, tz: string, first: boolean): string {
  const h = wallClockAt(t, tz).hour;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  if (first || h === 12 || h === 0) return `${twelve} ${h < 12 ? 'AM' : 'PM'}`;
  return String(twelve);
}

/**
 * The day's window: at least the bookable day (08:00 to 22:00 local), widened to every booking and
 * closure of the day, never outside the day, in whole local hours.
 */
export function timelineWindow(
  range: { start: string; end: string },
  tz: string,
  intervals: readonly { start: number; end: number }[],
): TimelineWindow {
  const rs = Date.parse(range.start);
  const re = Date.parse(range.end);
  const inRange = intervals
    .map((i) => ({ s: Math.max(rs, i.start), e: Math.min(re, i.end) }))
    .filter((i) => i.e > i.s);
  let start = rs + 8 * HOUR;
  let end = rs + 22 * HOUR;
  for (const i of inRange) {
    start = Math.min(start, i.s);
    end = Math.max(end, i.e);
  }
  start = Math.max(rs, floorLocalHour(start, tz));
  const endFloor = floorLocalHour(end, tz);
  end = Math.min(re, endFloor < end ? endFloor + HOUR : end);
  const ticks: Tick[] = [];
  for (let t = start; t < end; t += HOUR) {
    ticks.push({ at: t, label: tickLabel(t, tz, ticks.length === 0) });
  }
  return { start, end, ticks };
}

export type Row = { resource: Resource; depth: number };

/** The rows of S 1b: every top-level space, and a subdivision only on a day it is booked. */
export function visibleRows(rows: readonly Row[], blocks: readonly TimelineBlock[]): Row[] {
  return rows.filter(
    (r) => r.depth === 0 || blocks.some((b) => b.resourceIds.includes(r.resource.id)),
  );
}

function resourceSub(resource: Resource, parent: string | null): string {
  if (resource.status !== 'active') return plainWords(resource.status);
  if (parent) return `part of ${parent}`;
  if (resource.compatibleFormats.length > 0) {
    return plainWords(resource.compatibleFormats.slice(0, 2).join(', '));
  }
  return resource.kind === 'room' ? 'room' : resource.kind === 'other' ? 'indoor' : 'pitch';
}

interface DragState {
  block: TimelineBlock;
  mode: 'move' | 'resize-start' | 'resize-end';
  pointerId: number;
  /** Where the pointer grabbed the block, as time from its start. */
  grab: number;
  start: number;
  end: number;
  resourceId: string;
  clash: Clash | null;
  active: boolean;
}

export interface MoveControl {
  ability: MoveAbility;
  pending: ReadonlyMap<string, PendingMove>;
  /** A valid drop (the screen may ask for a refund note before proposing). */
  onDrop: (proposal: MoveProposal) => void;
  /** Said aloud when a drop is refused or cancelled. */
  onRefused: (message: string) => void;
}

export interface ResourceTimelineProps {
  rows: readonly Row[];
  resources: readonly Resource[];
  blocks: readonly TimelineBlock[];
  closures: readonly Closure[];
  window: TimelineWindow;
  timezone: string;
  now: Date;
  visible: (block: TimelineBlock) => boolean;
  conflicts: ReadonlyMap<string, Conflict>;
  gaps: readonly Gap[];
  selected: Selection;
  onSelect: (s: Selection) => void;
  /** Empty time or a free gap: book this space from `start` (to `end` for a whole gap). */
  onBook?: (resourceId: string, start: number, end: number) => void;
  move?: MoveControl;
}

const LONG_PRESS_MS = 400;
const DRAG_SLOP = 6;

function blockLabel(block: TimelineBlock, tz: string, conflict: Conflict | undefined): string {
  const kind = EVENT_KIND_LABEL[block.kind];
  const sport = block.sport ? `, ${sportLabel(block.sport)}` : '';
  const when = formatRange(
    new Date(block.start).toISOString(),
    new Date(block.end).toISOString(),
    tz,
  );
  const status =
    block.type === 'draft-create'
      ? 'Draft, not published'
      : block.type === 'draft-change'
        ? 'Draft change, not published'
        : block.status === 'draft'
          ? 'Not published'
          : block.status === 'canceled'
            ? 'Canceled'
            : 'Published';
  const clash = conflict ? `, conflict: overlaps ${conflict.with}` : '';
  return `${block.title}, ${kind}${sport}, ${when}, ${status}${clash}`;
}

export function ResourceTimeline({
  rows,
  resources,
  blocks,
  closures,
  window: win,
  timezone: tz,
  now,
  visible,
  conflicts,
  gaps,
  selected,
  onSelect,
  onBook,
  move,
}: ResourceTimelineProps) {
  const width = win.end - win.start;
  const pct = useCallback(
    (t: number) => Math.min(100, Math.max(0, ((t - win.start) / width) * 100)),
    [win.start, width],
  );
  const place = (start: number, end: number): CSSProperties | null => {
    if (end <= win.start || start >= win.end) return null;
    const left = pct(start);
    return { left: `${left}%`, width: `${Math.max(0.8, pct(end) - left)}%` };
  };
  const names = new Map(resources.map((r) => [r.id, r.name]));
  const nowAt = now.getTime();
  const showNow = nowAt >= win.start && nowAt < win.end;
  const key = selectionKey(selected);
  const columns = { '--tl-cols': String(win.ticks.length) } as CSSProperties;
  const scroller = useRef<HTMLDivElement>(null);
  const tracks = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const suppressClick = useRef(false);

  // Open on the hour before now (or the first booking) so the morning is not scrolled past.
  const firstAt = Math.min(
    ...blocks.filter(visible).map((b) => b.start),
    showNow ? nowAt - HOUR : Number.POSITIVE_INFINITY,
  );
  const anchor = Number.isFinite(firstAt) ? Math.max(win.start, firstAt - HOUR / 2) : win.start;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const grid = el.firstElementChild as HTMLElement | null;
    const total = (grid?.scrollWidth ?? el.scrollWidth) - 96;
    el.scrollLeft = Math.max(0, ((anchor - win.start) / width) * total);
    // Only when the day changes: a refresh must not jump the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.start, win.end]);

  const timeAt = (clientX: number, resourceId: string): number | null => {
    const track = tracks.current.get(resourceId);
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return win.start + ((clientX - rect.left) / rect.width) * width;
  };
  const rowAt = (clientY: number): string | null => {
    for (const [id, el] of tracks.current) {
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY < rect.bottom) return id;
    }
    return null;
  };

  const evaluate = (d: DragState, clientX: number, clientY: number): DragState => {
    const resourceId = d.mode === 'move' ? (rowAt(clientY) ?? d.resourceId) : d.resourceId;
    const at = timeAt(clientX, resourceId);
    if (at === null) return d;
    const length = d.block.end - d.block.start;
    let start: number;
    let end: number;
    if (d.mode === 'move') {
      start = snap(at - d.grab);
      end = start + length;
    } else if (d.mode === 'resize-end') {
      end = Math.max(d.block.start + STEP_MS, snap(at));
      start = d.block.start;
    } else {
      start = Math.min(d.block.end - STEP_MS, snap(at));
      end = d.block.end;
    }
    const resourceIds =
      d.mode === 'move' && resourceId !== d.block.resourceIds[0]
        ? [resourceId]
        : [...d.block.resourceIds];
    const clash = clashAt(d.block, { start, end, resourceIds }, blocks, closures, resources);
    return { ...d, start, end, resourceId, clash };
  };

  const cancelDrag = useCallback(
    (message?: string) => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
      pressTimer.current = null;
      press.current = null;
      setDrag(null);
      if (message) move?.onRefused(message);
    },
    [move],
  );

  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelDrag('Move cancelled.');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag?.active, cancelDrag]);

  const draggable = (block: TimelineBlock): boolean =>
    !!move?.ability.allowed &&
    block.type === 'event' &&
    block.event?.status === 'published' &&
    block.end > nowAt &&
    !move.pending.has(block.event.id);

  const onPointerDown = (
    e: ReactPointerEvent<HTMLElement>,
    block: TimelineBlock,
    mode: DragState['mode'],
  ) => {
    if (!draggable(block) || e.button > 0) return;
    if (mode !== 'move') e.stopPropagation();
    const resourceId = block.resourceIds[0] ?? '';
    const at = timeAt(e.clientX, resourceId) ?? block.start;
    const state: DragState = {
      block,
      mode,
      pointerId: e.pointerId,
      grab: at - block.start,
      start: block.start,
      end: block.end,
      resourceId,
      clash: null,
      active: false,
    };
    press.current = { x: e.clientX, y: e.clientY, dragged: false };
    const target = e.currentTarget;
    const activate = () => {
      try {
        target.setPointerCapture(state.pointerId);
      } catch {
        // jsdom and some browsers refuse capture for synthetic pointers; moves still arrive.
      }
      setDrag((d) => (d ? { ...d, active: true } : { ...state, active: true }));
    };
    setDrag(state);
    // Touch and pen pick a block up with a long press, so a swipe still scrolls the grid.
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      pressTimer.current = setTimeout(activate, LONG_PRESS_MS);
    } else if (mode !== 'move') {
      activate();
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    const p = press.current;
    if (!d || !p || e.pointerId !== d.pointerId) return;
    const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (!d.active) {
      if (pressTimer.current) {
        // A touch that moves before the long press is a scroll: let it go.
        if (moved > DRAG_SLOP) cancelDrag();
        return;
      }
      if (moved <= DRAG_SLOP) return;
      try {
        e.currentTarget.setPointerCapture(d.pointerId);
      } catch {
        // see above
      }
    }
    p.dragged = true;
    e.preventDefault();
    setDrag(evaluate({ ...d, active: true }, e.clientX, e.clientY));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    if (!d || e.pointerId !== d.pointerId) return;
    const dragged = press.current?.dragged ?? false;
    press.current = null;
    setDrag(null);
    if (!d.active || !dragged) return;
    suppressClick.current = true;
    const final = evaluate(d, e.clientX, e.clientY);
    const unchanged =
      final.start === final.block.start &&
      final.end === final.block.end &&
      (final.mode !== 'move' || final.block.resourceIds.includes(final.resourceId));
    if (unchanged) return;
    if (final.clash) {
      move?.onRefused(
        `Not moved: it clashes with ${final.clash.title} ${shortClock(final.clash.start, tz)}–${shortClock(final.clash.end, tz)}.`,
      );
      return;
    }
    move?.onDrop({
      block: final.block,
      start: final.start,
      end: final.end,
      resourceIds:
        final.mode === 'move' && !final.block.resourceIds.includes(final.resourceId)
          ? [final.resourceId]
          : [...final.block.resourceIds],
      mode: final.mode === 'move' ? 'move' : 'resize',
    });
  };

  const onTrackClick = (e: ReactMouseEvent<HTMLDivElement>, resource: Resource) => {
    if (!onBook || resource.status !== 'active') return;
    if (e.target !== e.currentTarget) return;
    const at = timeAt(e.clientX, resource.id);
    if (at === null) return;
    const start = Math.floor(at / STEP_MS) * STEP_MS;
    if (start + STEP_MS <= nowAt) return;
    onBook(resource.id, start, start + HOUR);
  };

  const dragGlow = drag?.active ? fittingGaps(gaps, drag.block.end - drag.block.start) : [];

  return (
    <div className="tl" style={columns} data-dragging={drag?.active || undefined}>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-grid">
          <div className="tl-head" aria-hidden="true">
            <span className="tl-head-space">Space</span>
            <div className="tl-head-track">
              {win.ticks.map((t) => (
                <span key={t.at} className="tl-tick" style={{ left: `${pct(t.at)}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="tl-body">
            {rows.map(({ resource, depth }) => {
              const parent = resource.parentResourceId
                ? (names.get(resource.parentResourceId) ?? null)
                : null;
              const own = blocks.filter((b) => b.resourceIds.includes(resource.id));
              const lanes = lanesOf(own);
              const sharing = resources.filter((r) => sharesSpace(r, resource));
              const shared = blocks.filter(
                (b) =>
                  b.status !== 'canceled' &&
                  b.type !== 'draft-change' &&
                  !b.resourceIds.includes(resource.id) &&
                  b.resourceIds.some((id) => sharing.some((r) => r.id === id)),
              );
              const covering = closures.filter((c) => closureCovers(c, resource, resources));
              const restricted =
                resource.status !== 'active' ||
                covering.some(
                  (c) =>
                    c.status === 'active' &&
                    Date.parse(c.interval.start) <= nowAt &&
                    Date.parse(c.interval.end) > nowAt,
                );
              const rowGaps = gaps.filter((g) => g.resourceId === resource.id);
              const ghost = drag?.active && drag.resourceId === resource.id ? drag : null;
              return (
                <div
                  className="tl-row"
                  key={resource.id}
                  role="group"
                  aria-label={`Timeline, ${resource.name}`}
                  data-testid={`timeline-row-${resource.id}`}
                  data-restricted={restricted || undefined}
                  data-depth={depth || undefined}
                  data-clash-row={ghost?.clash ? true : undefined}
                >
                  <div className="tl-space">
                    <span className="tl-space-name">{resource.name}</span>
                    <span className="tl-space-sub">
                      {restricted ? '▲ closed' : resourceSub(resource, parent)}
                    </span>
                  </div>
                  <div
                    className="tl-track"
                    ref={(el) => {
                      if (el) tracks.current.set(resource.id, el);
                      else tracks.current.delete(resource.id);
                    }}
                    onClick={(e) => onTrackClick(e, resource)}
                  >
                    {shared.map((b) => {
                      const o = occupied(b);
                      const style = place(o.start, o.end);
                      return style ? (
                        <span
                          key={`s-${b.key}`}
                          className="tl-shared"
                          style={style}
                          title={`Shared space in use: ${b.title}`}
                          aria-hidden="true"
                        />
                      ) : null;
                    })}
                    {covering.map((c) => {
                      const style = place(Date.parse(c.interval.start), Date.parse(c.interval.end));
                      if (!style) return null;
                      const label = `${c.source === 'maintenance' ? 'Maintenance restriction' : 'Closure'}: ${c.reason}`;
                      const k = `closure:${c.id}`;
                      const back = shortClock(Date.parse(c.interval.end), tz);
                      return (
                        <button
                          type="button"
                          key={`c-${c.id}`}
                          className={`tl-block tl-closure${c.status === 'pending' ? ' track-closure-pending' : ' track-closure'}`}
                          style={style}
                          aria-pressed={key === k}
                          aria-label={`${label}, ${formatRange(c.interval.start, c.interval.end, tz)}, ${CLOSURE_BADGE[c.status].label}`}
                          onClick={() => onSelect(key === k ? null : { type: 'closure', id: c.id })}
                        >
                          <span className="tl-block-title" aria-hidden="true">
                            {c.status === 'pending' ? '◷ ' : ''}
                            <b>{c.reason}</b>
                            <span className="tl-closure-note">
                              {' '}
                              · {c.status === 'pending' ? 'closure pending' : `back by ${back}`}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                    {rowGaps.map((g) => {
                      const style = place(g.start, g.end);
                      if (!style) return null;
                      const label = `Free ${shortClock(g.start, tz)}–${shortClock(g.end, tz)}`;
                      const glow = dragGlow.some(
                        (x) => x.resourceId === g.resourceId && x.start === g.start,
                      );
                      return (
                        <button
                          type="button"
                          key={`g-${g.start}`}
                          className="tl-block tl-gap"
                          data-glow={glow || undefined}
                          style={style}
                          disabled={!onBook}
                          aria-label={`${label} on ${resource.name}: book`}
                          onClick={() => onBook?.(resource.id, g.start, g.end)}
                        >
                          <span className="tl-gap-label" aria-hidden="true">
                            + {label} · book
                          </span>
                        </button>
                      );
                    })}
                    {own.map((b) => {
                      const pendingMove = b.event ? move?.pending.get(b.event.id) : undefined;
                      const isDragged = drag?.active && drag.block.key === b.key;
                      const style = place(b.start, b.end);
                      if (!style) return null;
                      const conflict = conflicts.get(b.key);
                      const shown = visible(b);
                      if (isDragged || pendingMove) {
                        return (
                          <span
                            key={b.key}
                            className="tl-block tl-was"
                            style={style}
                            aria-hidden="true"
                          >
                            was here
                          </span>
                        );
                      }
                      const canDrag = draggable(b);
                      const sub = conflict
                        ? `✕ overlaps ${conflict.with}`
                        : b.type !== 'event' || b.status === 'draft'
                          ? b.type === 'draft-change'
                            ? `◷ draft ${b.draft?.name.startsWith('Resize') ? 'resize' : 'move'}`
                            : 'draft'
                          : b.status === 'canceled'
                            ? 'canceled'
                            : `${blockClock(b.start, tz)}–${blockClock(b.end, tz)}`;
                      return (
                        <Fragment key={b.key}>
                          <button
                            type="button"
                            className="tl-block tl-event"
                            data-kind={b.token}
                            data-status={b.status}
                            data-type={b.type}
                            data-conflict={conflict ? true : undefined}
                            data-dim={!shown || undefined}
                            data-lane={lanes.get(b.key) || undefined}
                            data-draggable={canDrag || undefined}
                            style={style}
                            aria-pressed={key === b.key}
                            aria-label={blockLabel(b, tz, conflict)}
                            aria-roledescription={canDrag ? 'draggable booking' : undefined}
                            onPointerDown={(e) => onPointerDown(e, b, 'move')}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                            onPointerCancel={() => cancelDrag()}
                            onClick={() => {
                              if (suppressClick.current) {
                                suppressClick.current = false;
                                return;
                              }
                              onSelect(key === b.key ? null : { type: 'block', key: b.key });
                            }}
                          >
                            <span className="tl-block-title" aria-hidden="true">
                              {b.status === 'draft' && b.type === 'event' ? '◷ ' : ''}
                              {b.title}
                            </span>
                            <span className="tl-block-time" aria-hidden="true">
                              {sub}
                            </span>
                            {canDrag ? (
                              <>
                                <span
                                  className="tl-edge"
                                  data-edge="start"
                                  aria-hidden="true"
                                  onPointerDown={(e) => onPointerDown(e, b, 'resize-start')}
                                  onPointerMove={onPointerMove}
                                  onPointerUp={onPointerUp}
                                />
                                <span
                                  className="tl-edge"
                                  data-edge="end"
                                  aria-hidden="true"
                                  onPointerDown={(e) => onPointerDown(e, b, 'resize-end')}
                                  onPointerMove={onPointerMove}
                                  onPointerUp={onPointerUp}
                                />
                              </>
                            ) : null}
                          </button>
                        </Fragment>
                      );
                    })}
                    {[...(move?.pending.values() ?? [])]
                      .filter((p) => p.resourceIds.includes(resource.id))
                      .map((p) => {
                        const b = blocks.find(
                          (x) => x.event?.id === p.eventId && x.type === 'event',
                        );
                        const style = place(p.start, p.end);
                        if (!b || !style) return null;
                        return (
                          <span
                            key={`p-${p.eventId}`}
                            className="tl-block tl-event tl-pending"
                            data-kind={b.token}
                            data-phase={p.phase}
                            style={style}
                            role="status"
                          >
                            <span className="tl-block-title">{b.title}</span>
                            <span className="tl-block-time">
                              {p.phase === 'checking'
                                ? '◷ Checking…'
                                : p.phase === 'publishing'
                                  ? '◷ Publishing…'
                                  : `◷ ${localTimeOf(p.start, tz)} · not told yet`}
                            </span>
                          </span>
                        );
                      })}
                    {ghost ? (
                      <span
                        className="tl-block tl-event tl-ghost"
                        data-kind={ghost.block.token}
                        data-clash={ghost.clash ? true : undefined}
                        style={place(ghost.start, ghost.end) ?? undefined}
                        aria-hidden="true"
                      >
                        <span className="tl-block-title">{ghost.block.title}</span>
                        <span className="tl-block-time">
                          {localTimeOf(ghost.start, tz)}–{localTimeOf(ghost.end, tz)}
                        </span>
                        {ghost.clash ? (
                          <span className="tl-clash-label">
                            ✕ Clashes with {ghost.clash.title} {shortClock(ghost.clash.start, tz)}–
                            {shortClock(ghost.clash.end, tz)}
                          </span>
                        ) : (
                          <span className="tl-drop-label">✓ Free · drop here</span>
                        )}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {showNow ? (
              <div className="tl-now-layer" aria-hidden="true">
                <span className="tl-now" style={{ left: `${pct(nowAt)}%` }}>
                  <span className="tl-now-label">{shortClock(nowAt, tz)}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {drag?.active ? (
        <p className="visually-hidden" role="status">
          {drag.clash
            ? `Over a clash with ${drag.clash.title}`
            : `Drop at ${localTimeOf(drag.start, tz)} on ${names.get(drag.resourceId) ?? 'this space'}`}
        </p>
      ) : null}
    </div>
  );
}
