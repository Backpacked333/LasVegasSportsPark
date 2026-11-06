/**
 * SCR-S-03 detail rail beside the resource timeline: the selected event or closure in full (kind,
 * time with buffers, spaces, status as glyph and text), with the steps the schedule allows from
 * here: changes go through a schedule draft (SPK-SCHED-005), closure impact is resolved on Closures
 * (SPK-SCHED-009) and maintenance restrictions are released on Facilities (SPK-FAC-004). With
 * nothing selected it summarizes the range from the data loaded; it never invents counts.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { Icon } from '../../ui/Icon';
import { StatusBadge } from '../../ui/StatusBadge';
import { namesOf, resourceNames } from '../../features/schedule-facilities/inventory';
import {
  CLOSURE_BADGE,
  EVENT_KIND_LABEL,
  eventBadge,
} from '../../features/schedule-facilities/labels';
import { formatRange, occupiedRange } from '../../features/schedule-facilities/time';
import { KIND_TOKEN, type Selection } from './ResourceTimeline';

type Resource = Schema<'Resource'>;
type Event = Schema<'Event'>;
type Closure = Schema<'Closure'>;

const CLOSURE_SOURCE: Record<Closure['source'], string> = {
  manual: 'Closure',
  maintenance: 'Maintenance restriction',
  holiday: 'Holiday closure',
};

function EventDetail({
  event,
  resources,
  timezone,
}: {
  event: Event;
  resources: readonly Resource[];
  timezone: string;
}) {
  const badge = eventBadge(event.status, event.publishedRevision);
  const occ = occupiedRange(
    event.scheduledStart,
    event.scheduledEnd,
    event.setupMinutes,
    event.cleanupMinutes,
  );
  const hasBuffers = event.setupMinutes > 0 || event.cleanupMinutes > 0;
  return (
    <>
      <div className="tl-detail-head" data-kind={KIND_TOKEN[event.kind]}>
        <span className="tl-detail-kind">
          <span className="kind-swatch" aria-hidden="true" />
          {EVENT_KIND_LABEL[event.kind]}
        </span>
        <h4 className="tl-detail-title">{event.title}</h4>
        <span className="caption">
          {formatRange(event.scheduledStart, event.scheduledEnd, timezone)} ·{' '}
          {namesOf(event.resourceIds, resourceNames([...resources]))}
        </span>
      </div>
      {event.status === 'draft' ? (
        <p className="tl-detail-alert tone-pending">
          ◷ Not published: customers do not see this event yet.
        </p>
      ) : null}
      {event.status === 'canceled' ? (
        <p className="tl-detail-alert tone-neutral">
          ✕ Canceled{event.cancelReason ? `: ${event.cancelReason}` : ''}
        </p>
      ) : null}
      <dl className="tl-facts">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={badge.tone} label={badge.label} />
        </dd>
        <dt>Occupied</dt>
        <dd>
          {hasBuffers
            ? `${formatRange(occ.start, occ.end, timezone)} (setup ${event.setupMinutes} min, cleanup ${event.cleanupMinutes} min)`
            : 'No setup or cleanup buffer'}
        </dd>
        {event.format ? (
          <>
            <dt>Format</dt>
            <dd>{event.format}</dd>
          </>
        ) : null}
        {event.seriesId ? (
          <>
            <dt>Series</dt>
            <dd>
              Part of a recurring series
              {event.occurrenceIndex !== null ? `, occurrence ${event.occurrenceIndex + 1}` : ''}
            </dd>
          </>
        ) : null}
        {event.commitments.length > 0 ? (
          <>
            <dt>Commitments</dt>
            <dd>
              {event.commitments.length} party commitment
              {event.commitments.length === 1 ? '' : 's'}
            </dd>
          </>
        ) : null}
        {event.dstResolution !== 'exact' ? (
          <>
            <dt>Daylight saving</dt>
            <dd>{event.dstResolution.replace('_', ' ')}</dd>
          </>
        ) : null}
      </dl>
      <div className="tl-detail-actions">
        <Link className="button button-secondary button-sm" to="/schedule/drafts">
          <Icon name="edit_calendar" size={17} />
          {event.status === 'draft' ? 'Review in drafts' : 'Change in a draft'}
        </Link>
      </div>
    </>
  );
}

function ClosureDetail({
  closure,
  resources,
  timezone,
}: {
  closure: Closure;
  resources: readonly Resource[];
  timezone: string;
}) {
  const badge = CLOSURE_BADGE[closure.status];
  const where =
    closure.resourceId === null
      ? 'Whole facility'
      : namesOf([closure.resourceId], resourceNames([...resources]));
  const unresolved = closure.resolution?.unresolvedEventIds.length ?? 0;
  return (
    <>
      <div className="tl-detail-head" data-closure>
        <span className="tl-detail-kind tone-warning">▲ {CLOSURE_SOURCE[closure.source]}</span>
        <h4 className="tl-detail-title">{closure.reason}</h4>
        <span className="caption">
          {formatRange(closure.interval.start, closure.interval.end, timezone)} · {where}
        </span>
      </div>
      {unresolved > 0 ? (
        <p className="tl-detail-alert tone-danger">
          ✕ {unresolved} affected event{unresolved === 1 ? '' : 's'} still need
          {unresolved === 1 ? 's' : ''} a resolution
        </p>
      ) : null}
      <dl className="tl-facts">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={badge.tone} label={badge.label} />
        </dd>
        <dt>Affected</dt>
        <dd>
          {closure.impact
            ? `${closure.impact.affectedEvents.length} event(s) in the interval`
            : 'Impact not evaluated yet'}
        </dd>
      </dl>
      <div className="tl-detail-actions">
        <Link className="button button-primary button-sm" to={`/schedule/closures/${closure.id}`}>
          Review closure impact
        </Link>
        {closure.source === 'maintenance' ? (
          <Link className="button button-secondary button-sm" to="/facilities/restrictions">
            <Icon name="construction" size={17} />
            Release on Facilities
          </Link>
        ) : null}
      </div>
    </>
  );
}

function RangeSummary({
  events,
  closures,
  rangeLabel,
  truncated,
}: {
  events: readonly Event[];
  closures: readonly Closure[];
  rangeLabel: string;
  truncated: boolean;
}) {
  const live = events.filter((e) => e.status !== 'canceled');
  const drafts = events.filter((e) => e.status === 'draft').length;
  const active = closures.filter((c) => c.status === 'active').length;
  const pending = closures.filter((c) => c.status === 'pending').length;
  const byKind = new Map<Event['kind'], number>();
  for (const e of live) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  return (
    <>
      <div className="tl-detail-head">
        <span className="tl-detail-kind">
          <Icon name="calendar_month" size={16} /> {rangeLabel}
        </span>
        <h4 className="tl-detail-title">At a glance</h4>
        <span className="caption">
          Select a block on the timeline to see its details{truncated ? '' : '.'}
          {truncated ? '; counts cover the events loaded so far.' : ''}
        </span>
      </div>
      <dl className="tl-facts">
        <dt>Activities</dt>
        <dd>{live.length}</dd>
        <dt>Not published</dt>
        <dd>{drafts}</dd>
        <dt>Closed spaces</dt>
        <dd>
          {active} active{pending > 0 ? `, ${pending} pending` : ''}
        </dd>
      </dl>
      {byKind.size > 0 ? (
        <ul className="tl-kind-counts" aria-label="Activities by kind">
          {[...byKind.entries()].map(([kind, n]) => (
            <li key={kind} className="kind-tag" data-kind={KIND_TOKEN[kind]}>
              <span className="kind-swatch" aria-hidden="true" />
              {EVENT_KIND_LABEL[kind]}
              <strong>{n}</strong>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export function TimelineDetail({
  selected,
  events,
  closures,
  resources,
  timezone,
  rangeLabel,
  truncated,
  onClear,
}: {
  selected: Selection;
  events: readonly Event[];
  closures: readonly Closure[];
  resources: readonly Resource[];
  timezone: string;
  rangeLabel: string;
  truncated: boolean;
  onClear: () => void;
}) {
  const event = selected?.type === 'event' ? events.find((e) => e.id === selected.id) : undefined;
  const closure =
    selected?.type === 'closure' ? closures.find((c) => c.id === selected.id) : undefined;
  return (
    <aside className="card card-flush tl-detail" aria-label="Selected on the timeline">
      {event ? (
        <EventDetail event={event} resources={resources} timezone={timezone} />
      ) : closure ? (
        <ClosureDetail closure={closure} resources={resources} timezone={timezone} />
      ) : (
        <RangeSummary
          events={events}
          closures={closures}
          rangeLabel={rangeLabel}
          truncated={truncated}
        />
      )}
      {event || closure ? (
        <div className="card-foot">
          <button type="button" className="tl-clear" onClick={onClear}>
            Clear selection
          </button>
        </div>
      ) : null}
    </aside>
  );
}
