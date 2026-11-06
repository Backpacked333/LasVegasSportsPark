/**
 * SCR-S-03 Schedule calendar and resource view (SPK-SCHED-001, SPK-SCHED-002, SPK-SCHED-003,
 * SPK-SCHED-008, SPK-FAC-003; DEC-001 pending). Per facility, every pitch with its subdivisions
 * underneath, and per space the events booked on it over a facility-local day or week:
 * scheduled time, occupied time with setup and cleanup buffers, what blocks it through shared space
 * (a whole-pitch booking blocks its halves and the other way round), and closures or maintenance
 * restrictions. Reads `GET /v1/resources`, `GET /v1/events` (cursor pages, "Load more events"),
 * `GET /v1/closures`, and the program sessions at the facility in the same window
 * (`GET /v1/sessions`, cursor pages, with the facility zone the API states).
 *
 * States: loading; empty (no events in range; no resources: first setup); permission restriction
 * (facility scope) as not available; stale version (a refresh brought a changed published
 * revision: banner, the shown data stays until the user asks for the latest); offline (cached,
 * read-only, with its age); errors with code and retry. While more events exist than are shown,
 * no space reads as free: whether more exist is kept with the events shown, so a held-back refresh
 * never makes the shown list look complete, and "Load more events" during a held-back change
 * shows the latest first, then continues it. The bars are a visual aid only and hidden from
 * assistive technology; each space's list carries the same information as text.
 */
import { idOf, mergePages, pagesReceivedAt, type Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
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
import {
  KIND_ORDER,
  KIND_TOKEN,
  ResourceTimeline,
  closureCovers,
  type Selection,
} from './ResourceTimeline';
import { TimelineDetail } from './TimelineDetail';
import './schedule.css';
import { FacilitySessions } from './FacilitySessions';

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
  { kind: 'buffer', label: 'Setup or cleanup' },
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
  const covering = closures.filter((c) => closureCovers(c, resource, resources));
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

function CalendarBody({ facility }: { facility: FacilityContext }) {
  const now = useNow();
  const navigate = useNavigate();
  const { online } = useApp();
  const tz = facility.timezone;
  const today = facility.localDate ?? localDateOf(now, tz);
  const [date, setDate] = useState(today);
  const [span, setSpan] = useState<1 | 7>(1);
  const [focusId, setFocusId] = useState('');
  const [showCanceled, setShowCanceled] = useState(false);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<Event['kind']>>(new Set());
  const [selected, setSelected] = useState<Selection>(null);
  const toggleKind = (kind: Event['kind']) =>
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const range = useMemo(() => localDaysWindow(date, span, tz), [date, span, tz]);

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
  // Open drafts for the header shortcut; a viewer who may not read drafts just sees no count.
  const drafts = useApiQuery({
    path: '/schedule-drafts',
    request: { query: { facilityId: facility.id } },
  });
  const openDrafts = (drafts.data ?? []).filter(
    (d) => d.status === 'editing' || d.status === 'validated' || d.status === 'failed',
  ).length;
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
  };

  const rangeLabel =
    span === 1
      ? formatLocalDate(date)
      : `${formatLocalDate(date)} to ${formatLocalDate(addDaysToLocalDate(date, 6))}`;

  const step = (days: number) => {
    setSelected(null);
    setDate(addDaysToLocalDate(date, days));
  };

  return (
    <div className="schedule-calendar">
      <ZoneCaption facility={facility} />
      <div className="cal-toolbar" role="group" aria-label="Calendar range">
        <div className="cal-stepper">
          <button
            type="button"
            className="cal-step"
            aria-label={span === 1 ? 'Previous day' : 'Previous week'}
            onClick={() => step(-span)}
          >
            <Icon name="chevron_left" />
          </button>
          <p className="range-label" aria-live="polite">
            <strong>{rangeLabel}</strong>
          </p>
          <button
            type="button"
            className="cal-step"
            aria-label={span === 1 ? 'Next day' : 'Next week'}
            onClick={() => step(span)}
          >
            <Icon name="chevron_right" />
          </button>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setSelected(null);
            setDate(today);
          }}
        >
          Today
        </Button>
        <label className="cal-field">
          Date{' '}
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </label>
        <label className="cal-field">
          View{' '}
          <select value={span} onChange={(e) => setSpan(e.target.value === '7' ? 7 : 1)}>
            <option value="1">Day</option>
            <option value="7">Week</option>
          </select>
        </label>
        <label className="cal-field">
          Space{' '}
          <select value={focusId} onChange={(e) => setFocusId(e.target.value)}>
            <option value="">All spaces</option>
            {(resources.data ?? [])
              .filter((r) => r.parentResourceId === null)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} and its subdivisions
                </option>
              ))}
          </select>
        </label>
        <label className="cal-check">
          <input
            type="checkbox"
            checked={showCanceled}
            onChange={(e) => setShowCanceled(e.target.checked)}
          />{' '}
          Show canceled events
        </label>
        <span className="cal-toolbar-end">
          <Button variant="secondary" disabled={!online} onClick={refresh}>
            <Icon name="refresh" size={18} />
            Refresh
          </Button>
          <Link className="button button-secondary" to="/schedule/drafts">
            <span className="tone-pending">
              <Icon name="edit_calendar" size={18} />
            </span>
            Drafts
            {openDrafts > 0 ? <span className="cal-count">{openDrafts} open</span> : null}
          </Link>
        </span>
      </div>
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
      >
        {(inventory) => (
          <QueryBoundary
            query={events}
            label="events"
            empty={{ title: '', description: '' }}
            unavailableOffline={['refreshing the schedule']}
          >
            {(items) => {
              const visible = items.filter((e) => showCanceled || e.status !== 'canceled');
              const activeClosures = (closures.data ?? []).filter(
                (c) =>
                  (c.status === 'active' || c.status === 'pending') && overlaps(c.interval, range),
              );
              const focus = inventory.find((r) => r.id === focusId);
              const rows = orderedInventory(inventory).filter(
                ({ resource }) =>
                  !focus || resource.id === focus.id || resource.parentResourceId === focus.id,
              );
              const known = new Set(inventory.map((r) => r.id));
              const unplaced = visible.filter((e) => !e.resourceIds.some((id) => known.has(id)));
              const kinds = KIND_ORDER.filter((k) => visible.some((e) => e.kind === k));
              return (
                <>
                  {visible.length === 0 && !truncated ? (
                    <StateView
                      variant="empty"
                      title="No events in this range"
                      description={`Nothing is booked ${span === 1 ? 'on this day' : 'in this week'}. Plan events in a schedule draft.`}
                      actionLabel="Open drafts"
                      onAction={() => void navigate('/schedule/drafts')}
                    />
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
                  <div className="cal-layout">
                    <section
                      className="card card-flush cal-timeline"
                      aria-labelledby="timeline-title"
                    >
                      <div className="card-head">
                        <h4 id="timeline-title">Timeline</h4>
                        {kinds.length > 0 ? (
                          <div className="kind-filters" role="group" aria-label="Highlight kinds">
                            {kinds.map((k) => (
                              <button
                                type="button"
                                key={k}
                                className="kind-chip"
                                data-kind={KIND_TOKEN[k]}
                                aria-pressed={!hiddenKinds.has(k)}
                                onClick={() => toggleKind(k)}
                              >
                                <span className="kind-swatch" aria-hidden="true" />
                                {EVENT_KIND_LABEL[k]}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <ResourceTimeline
                        rows={rows}
                        resources={inventory}
                        events={visible}
                        closures={activeClosures}
                        range={range}
                        span={span}
                        date={date}
                        timezone={tz}
                        now={now}
                        hiddenKinds={hiddenKinds}
                        selected={selected}
                        onSelect={setSelected}
                      />
                      <div className="card-foot">
                        <TrackLegend />
                      </div>
                    </section>
                    <TimelineDetail
                      selected={selected}
                      events={visible}
                      closures={activeClosures}
                      resources={inventory}
                      timezone={tz}
                      rangeLabel={rangeLabel}
                      truncated={truncated}
                      onClear={() => setSelected(null)}
                    />
                  </div>
                  <section
                    className="card by-space"
                    aria-labelledby="by-space-title"
                    data-testid="bookings-by-space"
                  >
                    <h4 id="by-space-title">Bookings by space</h4>
                    {rows.map(({ resource, depth }) => (
                      <ResourceRow
                        key={resource.id}
                        resource={resource}
                        depth={depth}
                        resources={inventory}
                        events={visible}
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
                  </section>
                  {unplaced.length > 0 && !focus ? (
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
    </div>
  );
}

export function ScheduleCalendarScreen() {
  return (
    <section aria-labelledby="calendar-title">
      <h3 id="calendar-title">Calendar and resources</h3>
      <FacilityGate purpose="see its schedule">
        {(facility) => <CalendarBody key={facility.id} facility={facility} />}
      </FacilityGate>
    </section>
  );
}
