/**
 * SCR-S-03 Schedule, as the redesign draws it (handoff S 1b day timeline, S 3e drag, S 2b week by
 * use with "Find a free slot", S 5a new booking from a held slot; SPK-SCHED-001, SPK-SCHED-002,
 * SPK-SCHED-003, SPK-SCHED-005, SPK-SCHED-006, SPK-SCHED-008, SPK-FAC-003, SPK-REPORT-003).
 *
 * Day: every space as a 68 px row on the facility-local day, with kind filters that count, conflict
 * and draft chips that filter the grid, free time as dashed "book" blocks, and a detail rail with
 * the selected block's readiness checks and its fix. Tapping empty time or a free gap opens New
 * booking with the space and time filled in; dragging a booking moves it (draft, validation, then
 * Notify or Undo; `useScheduleMove`). Week: the use heatmap (`WeekHeatmap`). Day and Week keep the
 * date (`?date=` and `?view=` in the address, so Back works and a week cell can open its day).
 *
 * Reads `GET /v1/resources`, `GET /v1/events` (cursor pages, "Load more events"),
 * `GET /v1/closures`, `GET /v1/schedule-drafts` (open drafts on the grid),
 * `GET /v1/facilities/{id}/operating-status` (field checks), and the program sessions at the
 * facility in the same window (`GET /v1/sessions`).
 *
 * States: loading (skeleton rows); empty (no events: the spaces are still drawn and every free
 * hour is bookable; no resources: first setup); permission restriction (facility scope) as not
 * available; stale version (a refresh brought a changed published revision: banner, the shown data
 * stays until the user asks for the latest); offline (cached, read-only, with its age; dragging and
 * booking are off with the reason); errors with code and retry. While more events exist than are
 * shown, no space reads as free (no free blocks are drawn). Each space's text list ("Bookings by
 * space") carries the same information as the grid.
 */
import { idOf, mergePages, pagesReceivedAt, type Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { PageHeader } from '../../ui/Page';
import { Drawer } from '../../ui/Drawer';
import { useToast } from '../../ui/Toast';
import { useMediaQuery } from '../../layout/useMediaQuery';
import {
  FacilityGate,
  ZoneCaption,
  type FacilityContext,
} from '../../features/schedule-facilities/facility-scope';
import { orderedInventory, sharesSpace } from '../../features/schedule-facilities/inventory';
import {
  CLOSURE_BADGE,
  EVENT_KIND_LABEL,
  RESOURCE_BADGE,
  RESOURCE_KIND_LABEL,
  eventBadge,
} from '../../features/schedule-facilities/labels';
import {
  addDaysToLocalDate,
  formatLocalDate,
  formatRange,
  localDateOf,
  localDaysWindow,
  occupiedRange,
  overlaps,
} from '../../features/schedule-facilities/time';
import { usePinnedData } from '../../features/schedule-facilities/usePinnedData';
import { Icon } from '../../ui/Icon';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { ResourceTimeline, timelineWindow, visibleRows, type Selection } from './ResourceTimeline';
import { TimelineDetail } from './TimelineDetail';
import { FacilitySessions } from './FacilitySessions';
import { WeekHeatmap, useWeekRate } from './WeekHeatmap';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { FreeSlotPanel } from './FreeSlotPanel';
import { NewBookingDrawer, type BookingSlot } from './NewBookingDrawer';
import {
  KIND_GROUPS,
  buildBlocks,
  conflictCount,
  byRowRank,
  findConflicts,
  freeGaps,
  isDraftBlock,
  isOpenDraft,
  kindCounts,
  passesFilter,
  weekDates,
  weekStart,
  type GridFilter,
  type SlotMatch,
  type TimelineBlock,
} from './schedule-model';
import { useMoveAbility, useScheduleMove, type MoveProposal } from './useScheduleMove';
import { RefundNoteDialog, needsRefundNote } from './RefundNoteDialog';
import './schedule.css';
import './schedule-redesign.css';

type Resource = Schema<'Resource'>;
type Event = Schema<'Event'>;
type Closure = Schema<'Closure'>;

/** Events per page (`GET /v1/events` takes at most 200). */
const EVENT_PAGE = 200;

/**
 * The events shown and whether more exist after them in the range. `more` is kept with the events
 * it belongs to: while a changed refresh is held back, the shown events (and not the latest read)
 * decide whether a space may read as free.
 */
interface ShownEvents {
  items: Event[];
  more: boolean;
}

function eventSignature(shown: ShownEvents): string {
  return shown.items
    .map((e) => `${e.id}:${e.revision}:${e.status}:${e.publishedRevision ?? ''}`)
    .join('|');
}

/** What `refetch` of the paged event read resolves with (TanStack infinite query result). */
interface EventPagesRefetch {
  data?: {
    pages: { data: { items: Event[]; nextCursor: string | null }; receivedAt: Date }[];
  };
}

/** Names each mark of the timeline in text, so no block is read by colour or pattern alone. */
const TRACK_LEGEND: readonly { kind: string; label: string }[] = [
  { kind: 'event', label: 'Booked (colour by activity kind)' },
  { kind: 'draft', label: 'Not published (dashed)' },
  { kind: 'gap', label: 'Free for an hour or more' },
  { kind: 'shared', label: 'Shared space in use' },
  { kind: 'closure', label: 'Closed' },
  { kind: 'closure-pending', label: 'Closure pending (not applied; still bookable)' },
];

export function TrackLegend() {
  return (
    <ul className="track-legend" aria-label="Timeline key">
      {TRACK_LEGEND.map((l) => (
        <li key={l.kind}>
          <span className={`legend-swatch legend-${l.kind}`} aria-hidden="true" />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

function EventLine({ event, timezone }: { event: Event; timezone: string }) {
  const badge = eventBadge(event.status, event.publishedRevision);
  const hasBuffers = event.setupMinutes > 0 || event.cleanupMinutes > 0;
  const occupied = occupiedRange(
    event.scheduledStart,
    event.scheduledEnd,
    event.setupMinutes,
    event.cleanupMinutes,
  );
  return (
    <li data-testid={`calendar-event-${event.id}`}>
      <div className="row-text">
        <span className="row-title">{event.title}</span>
        <span className="caption">
          {EVENT_KIND_LABEL[event.kind]} ·{' '}
          {formatRange(event.scheduledStart, event.scheduledEnd, timezone)}
        </span>
        {hasBuffers ? (
          <span className="caption">
            Space occupied {formatRange(occupied.start, occupied.end, timezone)} (setup{' '}
            {event.setupMinutes} min, cleanup {event.cleanupMinutes} min)
          </span>
        ) : null}
        {event.dstResolution !== 'exact' ? (
          <span className="caption">
            Daylight-saving resolution: {event.dstResolution.replace('_', ' ')}
          </span>
        ) : null}
        {event.status === 'canceled' && event.cancelReason ? (
          <span className="caption">Canceled: {event.cancelReason}</span>
        ) : null}
      </div>
      <StatusBadge tone={badge.tone} label={badge.label} />
    </li>
  );
}

function ResourceRow({
  resource,
  depth,
  resources,
  events,
  closures,
  timezone,
  truncated,
}: {
  resource: Resource;
  depth: number;
  resources: readonly Resource[];
  events: readonly Event[];
  closures: readonly Closure[];
  timezone: string;
  /** More events exist in the range than were loaded: never claim the space is free. */
  truncated: boolean;
}) {
  const names = new Map(resources.map((r) => [r.id, r.name]));
  const own = events.filter((e) => e.resourceIds.includes(resource.id));
  const sharing = resources.filter((r) => sharesSpace(r, resource));
  const blocked = events.filter(
    (e) =>
      e.status !== 'canceled' &&
      !e.resourceIds.includes(resource.id) &&
      e.resourceIds.some((id) => sharing.some((r) => r.id === id)),
  );
  const covering = closures.filter(
    (c) =>
      c.resourceId === null ||
      c.resourceId === resource.id ||
      sharing.some((r) => r.id === c.resourceId),
  );
  const parent = resource.parentResourceId ? names.get(resource.parentResourceId) : null;
  const headingId = `resource-${resource.id}`;
  return (
    <section
      className="resource-row"
      aria-labelledby={headingId}
      style={{ marginInlineStart: `${depth * 24}px` }}
      data-testid={`calendar-resource-${resource.id}`}
    >
      <h4 id={headingId}>
        {resource.name}{' '}
        <span className="caption">
          {RESOURCE_KIND_LABEL[resource.kind]}
          {parent ? `, part of ${parent}` : ''}
        </span>
      </h4>
      {resource.status !== 'active' ? (
        <StatusBadge
          tone={RESOURCE_BADGE[resource.status].tone}
          label={`Inventory status: ${RESOURCE_BADGE[resource.status].label}`}
        />
      ) : null}
      {sharing.length > 0 ? (
        <p className="caption">Shares space with {sharing.map((r) => r.name).join(', ')}.</p>
      ) : null}
      <ul className="list" aria-label={`Bookings and closures on ${resource.name}`}>
        {covering.map((c) => (
          <li key={c.id}>
            <div className="row-text">
              <span className="row-title">
                {c.source === 'maintenance' ? 'Maintenance restriction' : 'Closure'}: {c.reason}
              </span>
              <span className="caption">
                {formatRange(c.interval.start, c.interval.end, timezone)}
                {c.resourceId === null
                  ? ' · whole facility'
                  : c.resourceId !== resource.id
                    ? ` · on ${names.get(c.resourceId) ?? 'shared space'}`
                    : ''}
              </span>
            </div>
            <StatusBadge
              tone={CLOSURE_BADGE[c.status].tone}
              label={CLOSURE_BADGE[c.status].label}
            />
            <Link to={`/schedule/closures/${c.id}`}>Closure impact</Link>
          </li>
        ))}
        {own.map((e) => (
          <EventLine key={e.id} event={e} timezone={timezone} />
        ))}
        {blocked.map((e) => (
          <li key={`shared-${e.id}`}>
            <div className="row-text">
              <span className="row-title">Blocked by shared space: {e.title}</span>
              <span className="caption">
                Booked on {e.resourceIds.map((id) => names.get(id) ?? 'another space').join(', ')} ·{' '}
                {(() => {
                  const occ = occupiedRange(
                    e.scheduledStart,
                    e.scheduledEnd,
                    e.setupMinutes,
                    e.cleanupMinutes,
                  );
                  return formatRange(occ.start, occ.end, timezone);
                })()}
              </span>
            </div>
            <StatusBadge tone="neutral" label="Unavailable: shared space" />
          </li>
        ))}
        {covering.every((c) => c.status === 'pending') &&
        own.length === 0 &&
        blocked.length === 0 ? (
          <li className="caption">
            {truncated
              ? 'Nothing among the events loaded; more events exist in this range than were loaded.'
              : covering.length > 0
                ? 'Free for the whole range (a planned closure is not applied yet).'
                : 'Free for the whole range.'}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** Other schedule sections, under the grid (the redesign's page has no section tabs). */
const MORE = [
  { to: '/schedule/drafts', label: 'Drafts and publication' },
  { to: '/schedule/closures', label: 'Closures' },
  { to: '/schedule/resources', label: 'Resource inventory' },
  { to: '/schedule/rentals', label: 'Rentals' },
  { to: '/schedule/parties', label: 'Parties' },
  { to: '/schedule/public', label: 'Public schedule' },
] as const;

function TimelineSkeleton() {
  return (
    <SkeletonGroup label="the schedule" className="tl-loading">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="tl-loading-row">
          <Skeleton width={70} height={16} />
          <Skeleton width={`${30 + ((i * 17) % 40)}%`} height={44} radius={10} />
        </div>
      ))}
    </SkeletonGroup>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function CalendarBody({ facility }: { facility: FacilityContext }) {
  const now = useNow();
  const navigate = useNavigate();
  const toast = useToast();
  const { online } = useApp();
  const tz = facility.timezone;
  const today = facility.localDate ?? localDateOf(now, tz);
  const [params, setParams] = useSearchParams();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '')
    ? (params.get('date') as string)
    : today;
  const view: 'day' | 'week' = params.get('view') === 'week' ? 'week' : 'day';
  const setDate = (next: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (next === today) n.delete('date');
        else n.set('date', next);
        return n;
      },
      { replace: true },
    );
  const setView = (next: 'day' | 'week') =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (next === 'week') n.set('view', 'week');
      else n.delete('view');
      return n;
    });
  const [showCanceled, setShowCanceled] = useState(false);
  const [filter, setFilter] = useState<GridFilter>({ type: 'all' });
  const [selected, setSelected] = useState<Selection>(null);
  const [slotPanel, setSlotPanel] = useState(false);
  const [booking, setBooking] = useState<BookingSlot | null>(null);
  const [noteFor, setNoteFor] = useState<MoveProposal | null>(null);
  const [matches, setMatches] = useState<readonly SlotMatch[]>([]);
  const [announcement, setAnnouncement] = useState('');
  // Narrow (a phone, or a tablet in portrait): the rail opens over the page.
  const wide = !useMediaQuery('(max-width: 1099px)');
  const range = useMemo(
    () =>
      view === 'week' ? localDaysWindow(weekStart(date), 7, tz) : localDaysWindow(date, 1, tz),
    [date, view, tz],
  );

  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.id } },
  });
  const eventPages = useApiPages({
    path: '/events',
    request: {
      query: { facilityId: facility.id, start: range.start, end: range.end, limit: EVENT_PAGE },
    },
  });
  const closures = useApiQuery({
    path: '/closures',
    request: { query: { facilityId: facility.id } },
  });
  // Open drafts put their changes on the grid; a viewer who may not read drafts sees none.
  const drafts = useApiQuery({
    path: '/schedule-drafts',
    request: { query: { facilityId: facility.id } },
  });
  const operating = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.id } },
  });
  const latest = useMemo<ShownEvents | undefined>(
    () => (eventPages.data ? { items: eventPages.data, more: eventPages.hasNextPage } : undefined),
    [eventPages.data, eventPages.hasNextPage],
  );
  const pinned = usePinnedData(
    latest,
    eventPages.updatedAt,
    `${facility.id}|${range.start}|${range.end}`,
    eventSignature,
  );
  const events = { ...eventPages, data: pinned.data?.items, updatedAt: pinned.updatedAt };
  // From the events shown: a held-back refresh never makes the shown list look complete.
  const truncated = pinned.data?.more ?? false;
  const refresh = () => {
    // Pin what this refresh returned (the closure's own data would be the old pages).
    void Promise.resolve(eventPages.refetch()).then((result) => {
      const pages = (result as EventPagesRefetch).data?.pages;
      if (pages)
        pinned.pin(
          {
            items: mergePages(
              pages.map((p) => p.data),
              idOf,
            ),
            more: (pages.at(-1)?.data.nextCursor ?? null) !== null,
          },
          pagesReceivedAt(pages),
        );
    });
    void closures.refetch();
    void drafts.refetch();
  };

  const inventory = resources.data ?? [];
  const spaceName = (id: string) => inventory.find((r) => r.id === id)?.name ?? 'another space';
  const ability = useMoveAbility(facility.id);
  const mover = useScheduleMove({
    facilityId: facility.id,
    timeZone: tz,
    spaceName,
    onPublished: () => pinned.showLatest(),
  });
  const openDrafts = (drafts.data ?? []).filter(isOpenDraft);

  const step = (days: number) => {
    setSelected(null);
    setDate(addDaysToLocalDate(date, days));
  };
  const span = view === 'week' ? 7 : 1;
  const rangeLabel =
    view === 'day'
      ? formatLocalDate(date)
      : `${formatLocalDate(weekStart(date))} to ${formatLocalDate(addDaysToLocalDate(weekStart(date), 6))}`;

  const openBooking = (slot: BookingSlot) => {
    if (!online) {
      toast.show({ tone: 'warning', message: 'Booking needs a connection.' });
      return;
    }
    setBooking(slot);
  };

  const onDrop = (proposal: MoveProposal) => {
    if (needsRefundNote(proposal)) {
      setNoteFor(proposal);
      return;
    }
    void mover.propose(proposal);
  };

  const mayReadUse = useActionAllowed('reporting.view_utilization', facility.id);
  const weekRate = useWeekRate(facility.id, weekDates(date), mayReadUse && view === 'week');
  // Everything the grid, the chips and the header count, from the data shown.
  const items = events.data ?? [];
  const visibleEvents = items.filter((e) => showCanceled || e.status !== 'canceled');
  const activeClosures = (closures.data ?? []).filter(
    (c) => (c.status === 'active' || c.status === 'pending') && overlaps(c.interval, range),
  );
  const blocks = buildBlocks(visibleEvents, openDrafts).filter(
    (b) => b.end > Date.parse(range.start) && b.start < Date.parse(range.end),
  );
  const conflicts = findConflicts(blocks, inventory, openDrafts);
  const counts = kindCounts(blocks);
  const total = blocks.filter((b) => b.status !== 'canceled' && b.type !== 'draft-change').length;
  const draftCount = blocks.filter(isDraftBlock).length;
  const rows = byRowRank(orderedInventory(inventory));
  const win = timelineWindow(range, tz, [
    ...blocks.map((b) => ({ start: b.start, end: b.end })),
    ...activeClosures.map((c) => ({
      start: Date.parse(c.interval.start),
      end: Date.parse(c.interval.end),
    })),
  ]);
  const shownRows = visibleRows(rows, blocks, activeClosures);
  // While more events exist than were loaded, no space reads as free.
  const gaps =
    truncated || view === 'week' || !events.data
      ? []
      : shownRows.flatMap(({ resource }) =>
          freeGaps(
            resource,
            blocks,
            activeClosures,
            inventory,
            { start: win.start, end: win.end },
            now.getTime(),
          ),
        );
  const visible = (b: TimelineBlock) => passesFilter(b, filter, conflicts);
  const known = new Set(inventory.map((r) => r.id));
  const unplaced = visibleEvents.filter((e) => !e.resourceIds.some((id) => known.has(id)));
  const eyebrow = !events.data
    ? facility.name
    : view === 'day'
      ? `${facility.name} · ${plural(total, 'booking')} · ${plural(gaps.length, 'free block')} over 1 h`
      : `${facility.name} · week of ${formatLocalDate(weekStart(date))}${weekRate === null ? '' : ` · ${Math.round(weekRate * 100)}% booked`}`;

  const header = (
    <PageHeader
      eyebrow={<span data-testid="schedule-eyebrow">{eyebrow}</span>}
      title="Schedule"
      titleId="area-schedule"
      actions={
        <>
          <div className="sched-date" role="group" aria-label="Date">
            <button
              type="button"
              className="sched-date-step"
              aria-label={view === 'day' ? 'Previous day' : 'Previous week'}
              onClick={() => step(-span)}
            >
              ‹
            </button>
            <button
              type="button"
              className="sched-date-today"
              aria-pressed={date === today}
              onClick={() => {
                setSelected(null);
                setDate(today);
              }}
            >
              Today
            </button>
            <label className="sched-date-pick">
              <span className="visually-hidden">Date</span>
              <span aria-hidden="true">{formatLocalDate(date)}</span>
              <input
                type="date"
                value={date}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="sched-date-step"
              aria-label={view === 'day' ? 'Next day' : 'Next week'}
              onClick={() => step(span)}
            >
              ›
            </button>
          </div>
          <SegmentedControl
            label="View"
            segments={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
            ]}
            value={view}
            onChange={(v) => {
              setSelected(null);
              setView(v);
            }}
          />
          <Button
            className="sched-find"
            aria-expanded={slotPanel}
            onClick={() => setSlotPanel((v) => !v)}
          >
            <Icon name="search" size={18} />
            Find a free slot
          </Button>
        </>
      }
    />
  );

  return (
    <div className="schedule-calendar" data-view={view}>
      {header}
      {pinned.changed ? (
        <div className="banner" role="status" data-testid="schedule-changed">
          <StatusBadge tone="warning" label="Schedule changed" />
          <span>The published schedule changed since this view was loaded.</span>
          <Button onClick={pinned.showLatest}>Show the latest</Button>
        </div>
      ) : null}
      <QueryBoundary
        query={resources}
        label="the resource inventory"
        isEmpty={(list) => list.length === 0}
        empty={{
          title: 'No resources at this facility yet',
          description:
            'Pitches, subdivisions and other spaces appear here once they are set up in the resource inventory.',
          actionLabel: 'Set up resources',
          onAction: () => void navigate('/schedule/resources'),
        }}
        unavailableOffline={['refreshing the schedule']}
        loading={<TimelineSkeleton />}
        hideAge
      >
        {() => (
          <QueryBoundary
            query={events}
            label="events"
            empty={{ title: '', description: '' }}
            unavailableOffline={['refreshing the schedule', 'moving bookings', 'booking']}
            loading={<TimelineSkeleton />}
            hideAge
          >
            {() => {
              const chip = (
                f: GridFilter,
                label: string,
                extra?: { kind?: string; tone?: string },
              ) => {
                const pressed =
                  filter.type === f.type &&
                  (f.type !== 'kind' || (filter.type === 'kind' && filter.group === f.group));
                return (
                  <button
                    type="button"
                    key={label}
                    className="sched-chip"
                    data-kind={extra?.kind}
                    data-tone={extra?.tone}
                    aria-pressed={pressed}
                    onClick={() => setFilter(pressed && f.type !== 'all' ? { type: 'all' } : f)}
                  >
                    {extra?.kind ? <i className="kind-swatch" aria-hidden="true" /> : null}
                    {label}
                  </button>
                );
              };
              const rail = (
                <TimelineDetail
                  selected={selected}
                  blocks={blocks}
                  closures={activeClosures}
                  resources={inventory}
                  operating={operating.data?.resources}
                  timezone={tz}
                  facilityId={facility.id}
                  rangeLabel={rangeLabel}
                  truncated={truncated}
                  moveTip={ability.reason}
                  onClear={() => setSelected(null)}
                  onPublished={() => pinned.showLatest()}
                />
              );
              const panel = slotPanel ? (
                <FreeSlotPanel
                  facility={facility}
                  resources={inventory}
                  fromDate={view === 'week' ? weekStart(date) : date}
                  onClose={() => {
                    setSlotPanel(false);
                    setMatches([]);
                  }}
                  onHold={(slot) => openBooking({ ...slot, held: true })}
                  onMatches={setMatches}
                />
              ) : null;
              return (
                <>
                  {view === 'day' ? (
                    <div className="sched-chips" role="group" aria-label="Show on the grid">
                      {chip({ type: 'all' }, `All ${total}`)}
                      {KIND_GROUPS.filter((g) => counts[g.id] > 0).map((g) =>
                        chip({ type: 'kind', group: g.id }, `${g.label} ${counts[g.id]}`, {
                          kind: g.id,
                        }),
                      )}
                      <span className="sched-chips-gap" />
                      {conflicts.size > 0
                        ? chip(
                            { type: 'conflicts' },
                            `✕ ${plural(conflictCount(conflicts, blocks), 'conflict')}`,
                            { tone: 'danger' },
                          )
                        : null}
                      {draftCount > 0
                        ? chip({ type: 'drafts' }, `◷ ${plural(draftCount, 'draft')}`, {
                            tone: 'pending',
                          })
                        : null}
                    </div>
                  ) : null}
                  {visibleEvents.length === 0 && !truncated && view === 'day' ? (
                    <p className="caption" role="status">
                      Nothing is booked on this day yet. Tap a free block to book it.
                    </p>
                  ) : null}
                  {truncated ? (
                    <p className="caption" role="status" data-testid="events-truncated">
                      Showing the {items.length} events loaded so far; more exist in this range and
                      are not shown yet, so a space may look free when it is not.{' '}
                      {pinned.changed && !eventPages.hasNextPage
                        ? 'Show the latest schedule above to see them.'
                        : 'Load more events below.'}
                    </p>
                  ) : null}
                  {closures.error ? (
                    <p className="caption">
                      Closures could not be loaded ({closures.error.code}); closed spaces may not be
                      marked.
                    </p>
                  ) : null}
                  {view === 'week' ? (
                    <div className="sched-layout" data-panel={slotPanel || undefined}>
                      <WeekHeatmap
                        facility={facility}
                        resources={inventory}
                        date={date}
                        today={today}
                        blocks={blocks}
                        conflicts={conflicts}
                        closures={activeClosures}
                        matches={slotPanel ? matches : []}
                        onOpenDay={(d, resourceId) => {
                          setSelected(null);
                          setParams((p) => {
                            const n = new URLSearchParams(p);
                            n.delete('view');
                            if (d === today) n.delete('date');
                            else n.set('date', d);
                            if (resourceId) n.set('space', resourceId);
                            return n;
                          });
                        }}
                      />
                      {panel}
                    </div>
                  ) : (
                    <div className="sched-layout">
                      <section className="card card-flush cal-timeline" aria-label="Day timeline">
                        <ResourceTimeline
                          rows={shownRows}
                          resources={inventory}
                          blocks={blocks}
                          closures={activeClosures}
                          window={win}
                          timezone={tz}
                          now={now}
                          visible={visible}
                          conflicts={conflicts}
                          gaps={gaps}
                          selected={selected}
                          onSelect={setSelected}
                          onBook={
                            online
                              ? (resourceId, start, end) =>
                                  openBooking({ resourceId, start, end, held: false })
                              : undefined
                          }
                          move={{
                            ability,
                            pending: mover.pending,
                            onDrop,
                            onRefused: (message) => {
                              setAnnouncement(message);
                              toast.show({ tone: 'error', message });
                            },
                          }}
                        />
                        <div className="card-foot">
                          <TrackLegend />
                        </div>
                      </section>
                      {panel ?? (wide ? rail : null)}
                    </div>
                  )}
                  {!wide && view === 'day' && selected ? (
                    <Drawer
                      open
                      onClose={() => setSelected(null)}
                      labelledBy="sched-drawer-title"
                      header={<h3 id="sched-drawer-title">Booking</h3>}
                      testId="schedule-drawer"
                    >
                      {rail}
                    </Drawer>
                  ) : null}
                  <p className="visually-hidden" role="status">
                    {announcement}
                  </p>
                  <details className="card by-space" data-testid="bookings-by-space">
                    <summary>
                      <h4 id="by-space-title">Bookings by space</h4>
                      <span className="caption">The day as text, space by space</span>
                    </summary>
                    <label className="cal-check">
                      <input
                        type="checkbox"
                        checked={showCanceled}
                        onChange={(e) => setShowCanceled(e.target.checked)}
                      />{' '}
                      Show canceled events
                    </label>
                    {rows.map(({ resource, depth }) => (
                      <ResourceRow
                        key={resource.id}
                        resource={resource}
                        depth={depth}
                        resources={inventory}
                        events={visibleEvents}
                        closures={activeClosures}
                        timezone={tz}
                        truncated={truncated}
                      />
                    ))}
                    <LoadMore
                      pages={{
                        ...eventPages,
                        loadMore: () => {
                          // The next page continues the latest read, so a held-back change is
                          // shown first: held and new pages are never mixed.
                          if (pinned.changed) pinned.showLatest();
                          pinned.extend();
                          eventPages.loadMore();
                        },
                      }}
                      label="events"
                    />
                  </details>
                  {unplaced.length > 0 ? (
                    <section className="card" aria-labelledby="unplaced-events">
                      <h4 id="unplaced-events">Events on spaces not in this inventory</h4>
                      <ul className="list">
                        {unplaced.map((e) => (
                          <EventLine key={e.id} event={e} timezone={tz} />
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              );
            }}
          </QueryBoundary>
        )}
      </QueryBoundary>
      <FacilitySessions facility={facility} range={range} showCanceled={showCanceled} />
      <ZoneCaption facility={facility} />
      <div className="sched-more">
        <Button variant="secondary" className="button-sm" disabled={!online} onClick={refresh}>
          <Icon name="refresh" size={16} />
          Refresh
        </Button>
      </div>
      {booking ? (
        <NewBookingDrawer
          facility={facility}
          resources={inventory}
          slot={booking}
          onClose={() => setBooking(null)}
        />
      ) : null}
      {noteFor ? (
        <RefundNoteDialog
          proposal={noteFor}
          timeZone={tz}
          onCancel={() => setNoteFor(null)}
          onConfirm={(note) => {
            const p = { ...noteFor, note };
            setNoteFor(null);
            void mover.propose(p);
          }}
        />
      ) : null}
    </div>
  );
}

export function ScheduleCalendarScreen() {
  return (
    <section aria-label="Calendar and resources" className="schedule-screen">
      <FacilityGate purpose="see its schedule">
        {(facility) => <CalendarBody key={facility.id} facility={facility} />}
      </FacilityGate>
      <nav className="sched-more" aria-label="Schedule sections">
        <span className="caption">More:</span>
        {MORE.map((m) => (
          <Link key={m.to} to={m.to}>
            {m.label}
          </Link>
        ))}
      </nav>
    </section>
  );
}
