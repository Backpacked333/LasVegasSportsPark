/**
 * SCR-S-03 resource timeline (SPK-SCHED-001, SPK-SCHED-002, SPK-SCHED-003, SPK-SCHED-008,
 * SPK-FAC-003, SPK-UX-009): every space of the facility as a row on one facility-local time grid.
 * Blocks are the events the calendar loaded (`GET /v1/events`), coloured by activity kind with the
 * kind written in the block's name; unpublished drafts are dashed, canceled events struck through,
 * applied closures and maintenance restrictions hatched, pending closures outlined, and time held by
 * a booking of shared space (a whole pitch and its halves) shaded. A now-line marks the current
 * instant when it falls in the window.
 *
 * Each event or closure block is a button (keyboard reachable, named in full) that selects it for
 * the detail rail; colour and pattern are never the only signal, and the text list of the calendar
 * ("Bookings by space") carries the same information.
 */
import type { Schema } from '@sportspark/api-client';
import { Fragment, type CSSProperties } from 'react';
import { sharesSpace } from '../../features/schedule-facilities/inventory';
import {
  CLOSURE_BADGE,
  EVENT_KIND_LABEL,
  RESOURCE_KIND_LABEL,
  eventBadge,
} from '../../features/schedule-facilities/labels';
import {
  addDaysToLocalDate,
  formatLocalDate,
  formatRange,
  localDateOf,
  localTimeOf,
  occupiedRange,
  startOfLocalDay,
  wallClockAt,
} from '../../features/schedule-facilities/time';

type Resource = Schema<'Resource'>;
type Event = Schema<'Event'>;
type Closure = Schema<'Closure'>;
type EventKind = Event['kind'];

/** Activity kinds share one colour family across Today and the schedule (`--kind-*` tokens). */
export const KIND_TOKEN: Record<EventKind, string> = {
  game: 'league',
  practice: 'league',
  session: 'program',
  rental: 'rental',
  party: 'party',
  pickup: 'dropin',
  maintenance: 'dropin',
  block: 'dropin',
};

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

export type Selection = { type: 'event'; id: string } | { type: 'closure'; id: string } | null;

export function selectionKey(s: Selection): string {
  return s ? `${s.type}:${s.id}` : '';
}

const HOUR = 3_600_000;
const ms = (iso: string) => new Date(iso).getTime();

/** Whether a closure covers a resource: the whole facility, the resource, or shared space. */
export function closureCovers(
  closure: Closure,
  resource: Resource,
  all: readonly Resource[],
): boolean {
  if (closure.resourceId === null) return true;
  if (closure.resourceId === resource.id) return true;
  const closed = all.find((r) => r.id === closure.resourceId);
  return closed ? sharesSpace(closed, resource) : false;
}

interface Tick {
  at: number;
  label: string;
}

interface Window {
  start: number;
  end: number;
  ticks: Tick[];
}

/** The local hour that starts at or before `t` (whole local hours, also for half-hour zones). */
function floorLocalHour(t: number, tz: string): number {
  const w = wallClockAt(t, tz);
  return Math.floor(t / 60_000) * 60_000 - w.minute * 60_000;
}

function hourLabel(t: number, tz: string): string {
  return localTimeOf(t, tz);
}

/**
 * Day view: the local hours the day's bookings and closures use (at least six, never outside the
 * day), else a working day of 08:00 to 22:00. Week view: the seven local days.
 */
export function timelineWindow(
  range: { start: string; end: string },
  span: 1 | 7,
  date: string,
  tz: string,
  intervals: readonly { start: string; end: string }[],
  now: Date,
): Window {
  const rs = ms(range.start);
  const re = ms(range.end);
  if (span === 7) {
    const ticks: Tick[] = [];
    for (let d = 0; d < 7; d += 1) {
      const day = addDaysToLocalDate(date, d);
      ticks.push({ at: ms(startOfLocalDay(day, tz)), label: formatLocalDate(day) });
    }
    return { start: rs, end: re, ticks };
  }
  const inRange = intervals
    .map((i) => ({ s: Math.max(rs, ms(i.start)), e: Math.min(re, ms(i.end)) }))
    .filter((i) => i.e > i.s);
  const n = now.getTime();
  let start: number;
  let end: number;
  if (inRange.length === 0) {
    start = rs + 8 * HOUR;
    end = rs + 22 * HOUR;
  } else {
    start = Math.min(...inRange.map((i) => i.s));
    end = Math.max(...inRange.map((i) => i.e));
  }
  if (n >= rs && n < re) {
    start = Math.min(start, n);
    end = Math.max(end, n + HOUR / 2);
  }
  start = Math.max(rs, floorLocalHour(start, tz));
  end = Math.min(re, end);
  // Round the end up to a whole local hour and keep at least six hours on screen.
  const endFloor = floorLocalHour(end, tz);
  end = Math.min(re, endFloor < end ? endFloor + HOUR : end);
  if (end - start < 6 * HOUR) {
    end = Math.min(re, start + 6 * HOUR);
    if (end - start < 6 * HOUR) start = Math.max(rs, end - 6 * HOUR);
  }
  const ticks: Tick[] = [];
  for (let t = start; t < end; t += HOUR) ticks.push({ at: t, label: hourLabel(t, tz) });
  return { start, end, ticks };
}

type Row = { resource: Resource; depth: number };

const GROUP_LABEL: Record<Resource['kind'], string> = {
  pitch: 'Fields and pitches',
  room: 'Rooms',
  other: 'Other spaces',
  subdivision: 'Subdivisions',
};
const GROUP_ORDER: Resource['kind'][] = ['pitch', 'room', 'other', 'subdivision'];

/** Rows grouped by the kind of their top-level space, each space followed by its subdivisions. */
export function groupRows(rows: readonly Row[]): { label: string; rows: Row[] }[] {
  const blocks: { kind: Resource['kind']; rows: Row[] }[] = [];
  for (const row of rows) {
    const last = blocks.at(-1);
    if (row.depth === 0 || !last) blocks.push({ kind: row.resource.kind, rows: [row] });
    else last.rows.push(row);
  }
  return GROUP_ORDER.map((kind) => ({
    label: GROUP_LABEL[kind],
    rows: blocks.filter((b) => b.kind === kind).flatMap((b) => b.rows),
  })).filter((g) => g.rows.length > 0);
}

function resourceSub(resource: Resource, parent: string | null): string {
  const parts = [RESOURCE_KIND_LABEL[resource.kind]];
  if (resource.compatibleFormats.length > 0) parts.push(resource.compatibleFormats.join(', '));
  if (parent) parts.push(`part of ${parent}`);
  return parts.join(' · ');
}

export interface ResourceTimelineProps {
  rows: readonly Row[];
  resources: readonly Resource[];
  events: readonly Event[];
  closures: readonly Closure[];
  range: { start: string; end: string };
  span: 1 | 7;
  date: string;
  timezone: string;
  now: Date;
  hiddenKinds: ReadonlySet<EventKind>;
  selected: Selection;
  onSelect: (s: Selection) => void;
}

export function ResourceTimeline({
  rows,
  resources,
  events,
  closures,
  range,
  span,
  date,
  timezone: tz,
  now,
  hiddenKinds,
  selected,
  onSelect,
}: ResourceTimelineProps) {
  const intervals = [
    ...events
      .filter((e) => e.status !== 'canceled')
      .map((e) =>
        occupiedRange(e.scheduledStart, e.scheduledEnd, e.setupMinutes, e.cleanupMinutes),
      ),
    ...closures.map((c) => c.interval),
  ];
  const win = timelineWindow(range, span, date, tz, intervals, now);
  const width = win.end - win.start;
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - win.start) / width) * 100));
  const place = (start: string, end: string): CSSProperties | null => {
    const s = ms(start);
    const e = ms(end);
    if (e <= win.start || s >= win.end) return null;
    const left = pct(s);
    return { left: `${left}%`, width: `${Math.max(0.6, pct(e) - left)}%` };
  };
  const names = new Map(resources.map((r) => [r.id, r.name]));
  const nowAt = now.getTime();
  const showNow = nowAt >= win.start && nowAt < win.end;
  const key = selectionKey(selected);
  const columns = { '--tl-cols': String(win.ticks.length) } as CSSProperties;

  return (
    <div className="tl" data-span={span} style={columns}>
      <div className="tl-scroll">
        <div className="tl-grid">
          <div className="tl-head" aria-hidden="true">
            <span className="tl-head-space label-caps">Space</span>
            <div className="tl-head-track">
              {win.ticks.map((t) => (
                <span key={t.at} className="tl-tick" style={{ left: `${pct(t.at)}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>
          <div className="tl-body">
            {groupRows(rows).map((group) => (
              <Fragment key={group.label}>
                <div className="tl-group label-caps" aria-hidden="true">
                  {group.label}
                </div>
                {group.rows.map(({ resource, depth }) => {
                  const parent = resource.parentResourceId
                    ? (names.get(resource.parentResourceId) ?? null)
                    : null;
                  const own = events.filter((e) => e.resourceIds.includes(resource.id));
                  const sharing = resources.filter((r) => sharesSpace(r, resource));
                  const shared = events.filter(
                    (e) =>
                      e.status !== 'canceled' &&
                      !e.resourceIds.includes(resource.id) &&
                      e.resourceIds.some((id) => sharing.some((r) => r.id === id)),
                  );
                  const covering = closures.filter((c) => closureCovers(c, resource, resources));
                  return (
                    <div
                      className="tl-row"
                      key={resource.id}
                      role="group"
                      aria-label={`Timeline, ${resource.name}`}
                      data-testid={`timeline-row-${resource.id}`}
                      data-restricted={resource.status !== 'active' || undefined}
                    >
                      <div className="tl-space" style={{ paddingInlineStart: 14 + depth * 14 }}>
                        <span className="tl-space-name">{resource.name}</span>
                        <span className="tl-space-sub">{resourceSub(resource, parent)}</span>
                      </div>
                      <div className="tl-track">
                        {win.ticks.map((t) => (
                          <span
                            key={t.at}
                            className="tl-line"
                            style={{ left: `${pct(t.at)}%` }}
                            aria-hidden="true"
                          />
                        ))}
                        {shared.map((e) => {
                          const occ = occupiedRange(
                            e.scheduledStart,
                            e.scheduledEnd,
                            e.setupMinutes,
                            e.cleanupMinutes,
                          );
                          const style = place(occ.start, occ.end);
                          return style ? (
                            <span
                              key={`s-${e.id}`}
                              className="tl-shared"
                              style={style}
                              title={`Shared space in use: ${e.title}`}
                              aria-hidden="true"
                            />
                          ) : null;
                        })}
                        {covering.map((c) => {
                          const style = place(c.interval.start, c.interval.end);
                          if (!style) return null;
                          const label = `${c.source === 'maintenance' ? 'Maintenance restriction' : 'Closure'}: ${c.reason}`;
                          const k = `closure:${c.id}`;
                          return (
                            <button
                              type="button"
                              key={`c-${c.id}`}
                              className={`tl-block tl-closure${c.status === 'pending' ? ' track-closure-pending' : ' track-closure'}`}
                              style={style}
                              aria-pressed={key === k}
                              aria-label={`${label}, ${formatRange(c.interval.start, c.interval.end, tz)}, ${CLOSURE_BADGE[c.status].label}`}
                              onClick={() =>
                                onSelect(key === k ? null : { type: 'closure', id: c.id })
                              }
                            >
                              <span className="tl-block-title" aria-hidden="true">
                                {c.status === 'pending' ? '◷ ' : '▲ '}
                                {c.reason}
                              </span>
                              <span className="tl-block-time" aria-hidden="true">
                                {c.status === 'pending' ? 'Closure pending' : 'Closed'}
                              </span>
                            </button>
                          );
                        })}
                        {own.map((e) => {
                          const style = place(e.scheduledStart, e.scheduledEnd);
                          if (!style) return null;
                          const occ = occupiedRange(
                            e.scheduledStart,
                            e.scheduledEnd,
                            e.setupMinutes,
                            e.cleanupMinutes,
                          );
                          const buffer =
                            e.setupMinutes > 0 || e.cleanupMinutes > 0
                              ? place(occ.start, occ.end)
                              : null;
                          const k = `event:${e.id}`;
                          const badge = eventBadge(e.status, e.publishedRevision);
                          return (
                            <Fragment key={e.id}>
                              {buffer && e.status !== 'canceled' ? (
                                <span className="tl-buffer" style={buffer} aria-hidden="true" />
                              ) : null}
                              <button
                                type="button"
                                className="tl-block tl-event"
                                data-kind={KIND_TOKEN[e.kind]}
                                data-status={e.status}
                                data-dim={hiddenKinds.has(e.kind) || undefined}
                                style={style}
                                aria-pressed={key === k}
                                aria-label={`${e.title}, ${EVENT_KIND_LABEL[e.kind]}, ${formatRange(e.scheduledStart, e.scheduledEnd, tz)}, ${badge.label}`}
                                onClick={() =>
                                  onSelect(key === k ? null : { type: 'event', id: e.id })
                                }
                              >
                                <span className="tl-block-title" aria-hidden="true">
                                  {e.status === 'draft' ? '◷ ' : ''}
                                  {e.title}
                                </span>
                                <span className="tl-block-time" aria-hidden="true">
                                  {span === 1
                                    ? `${localTimeOf(e.scheduledStart, tz)}–${localTimeOf(e.scheduledEnd, tz)}`
                                    : `${formatLocalDate(localDateOf(e.scheduledStart, tz))}, ${localTimeOf(e.scheduledStart, tz)}`}
                                  {e.status === 'canceled' ? ' · canceled' : ''}
                                </span>
                              </button>
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </Fragment>
            ))}
            {showNow ? (
              <div className="tl-now-layer" aria-hidden="true">
                <span className="tl-now" style={{ left: `${pct(nowAt)}%` }}>
                  <span className="tl-now-label">{localTimeOf(nowAt, tz)}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
