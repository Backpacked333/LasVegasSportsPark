/**
 * SCR-S-01 Today workspace (SPK-UX-006, SPK-READY-001, SPK-UX-008). The operating home for the
 * viewer's scope and selected facility:
 *
 * - open issues from `GET /v1/today` (exceptions, readiness blockers, uncovered assignments,
 *   restrictions), each with title, severity as text, affected record, owner queue, age, deadline,
 *   next permitted actions and resolution history; money-moved-but-not-fulfilled financial
 *   exceptions are pinned first with their owner; "Acknowledge" appears only where the API lists
 *   that lifecycle step (`verb`, whether by `exceptions.manage` or the queue owner's
 *   `exceptions.manage_own_queue`) and sends the exception's expected revision (§4.9); domain
 *   steps link to the owning module's staff screen;
 * - per facility, only current and upcoming activities (`GET /v1/events` from now to the end of the
 *   facility-local day, times in the facility's timezone, SPK-SCHED-008) and field status
 *   (`GET /v1/facilities/{id}/operating-status`);
 * - per facility, expected arrivals for the facility-local day from the reporting module's
 *   `GET /v1/reports/expected-arrivals` (counts only, never names; `ExpectedArrivals.tsx`);
 * - sources the viewer may not read are listed as not available, never hidden or inferred;
 * - the optional assistant panel (SCR-S-50), which the rest of Today never depends on.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  daySummaryParts,
  useFacilityDaySummary,
} from '../../features/schedule-facilities/DaySummary';
import { kindTokenOf, sportLabel } from '../../features/schedule-facilities/sport';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandFeedback';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { Icon } from '../../ui/Icon';
import { Kpi, KpiRow } from '../../ui/Page';
import { formatDateTime, formatMinutes, formatTime, formatTimeRange } from '../../ui/time';
import './today.css';
import '../../ui/form-fields.css';
import { AssistantPanel } from './AssistantPanel';
import { ExpectedArrivals } from './ExpectedArrivals';
import { NextActionLink } from './NextActionLink';
import {
  EXCEPTION_STATUS_TONE,
  RECOVERY_CATEGORIES,
  domainActions,
  permittedVerbs,
} from './exception-actions';

type TodayItem = Schema<'TodayItem'>;
type TodayFacility = Schema<'TodayFeed'>['facilities'][number];
type Severity = TodayItem['severity'];

/** Staff labels use the machine state names (journeys.md section 3, rule 4). */
export const SEVERITY_BADGE: Record<Severity, { tone: StatusTone; label: string }> = {
  critical: { tone: 'danger', label: 'Severity: critical' },
  high: { tone: 'danger', label: 'Severity: high' },
  warning: { tone: 'warning', label: 'Severity: warning' },
  info: { tone: 'info', label: 'Severity: info' },
};

const SOURCE_STATUS: Record<'ok' | 'not_permitted' | 'unavailable', string> = {
  ok: 'Included',
  not_permitted: 'Not available to you',
  unavailable: 'Unavailable right now',
};

export const TODAY_KEY = ['api', '/today'] as const;
export const EXCEPTIONS_KEY = ['api', '/exceptions'] as const;
export const EXCEPTION_KEY = ['api', '/exceptions/{id}'] as const;

/** Exception id of a Today item from the `exception` source, else null. */
export function exceptionIdOf(item: TodayItem): string | null {
  if (item.source !== 'exception') return null;
  const fromDetails = item.details['exceptionId'];
  if (typeof fromDetails === 'string') return fromDetails;
  return item.id.startsWith('exception:') ? item.id.slice('exception:'.length) : null;
}

export function isRecoveryRequired(item: TodayItem): boolean {
  return item.group === 'financial' && RECOVERY_CATEGORIES.has(item.category);
}

/** Recovery-required financial issues first (with their owner), then the API's order. */
export function orderTodayItems(items: readonly TodayItem[]): TodayItem[] {
  const pinned = items.filter(isRecoveryRequired);
  return [...pinned, ...items.filter((i) => !isRecoveryRequired(i))];
}

function AcknowledgeAction({ item, exceptionId }: { item: TodayItem; exceptionId: string }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const acknowledge = useApiCommand('post', '/exceptions/{id}/acknowledge', {
    invalidate: [TODAY_KEY, EXCEPTIONS_KEY, EXCEPTION_KEY],
  });
  // STALE_REVISION or INVALID_TRANSITION: reload Today, then the user decides again.
  const reload = () => {
    acknowledge.reset();
    void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
  };
  // SUP-01: the item's own `revision` is the exception's (the details copy is the older form).
  const fromDetails = item.details['revision'];
  const revision = item.revision ?? (typeof fromDetails === 'number' ? fromDetails : null);
  const submit = () =>
    void acknowledge
      .submit({
        path: { id: exceptionId },
        body: revision !== null ? { expectedRevision: revision } : {},
      })
      .catch(() => undefined);
  return (
    <>
      <Button
        variant="secondary"
        busy={acknowledge.isProcessing}
        disabled={!online}
        aria-label={`Acknowledge: ${item.title}`}
        onClick={submit}
      >
        Acknowledge
      </Button>
      <CommandError error={acknowledge.error} onRetry={submit} onReload={reload} />
    </>
  );
}

/** Severity drives the row's edge colour; the severity is also always written (SPK-UX-009). */
const SEVERITY_EDGE: Record<Severity, string> = {
  critical: 'danger',
  high: 'danger',
  warning: 'warning',
  info: 'info',
};

function IssueRow({
  item,
  names,
  zones,
}: {
  item: TodayItem;
  names: ReadonlyMap<string, string>;
  zones: ReadonlyMap<string, string>;
}) {
  const severity = SEVERITY_BADGE[item.severity];
  const exceptionId = exceptionIdOf(item);
  const verbs = permittedVerbs(item.nextActions);
  const next = domainActions(item.nextActions);
  const zone = item.facilityId ? zones.get(item.facilityId) : null;
  const titleId = `today-item-title-${item.id}`;
  return (
    <li
      data-testid={`today-item-${item.id}`}
      aria-labelledby={titleId}
      className="issue"
      data-edge={isRecoveryRequired(item) ? 'danger' : SEVERITY_EDGE[item.severity]}
    >
      <span className="actions-row issue-badges">
        {isRecoveryRequired(item) ? <StatusBadge tone="danger" label="Recovery required" /> : null}
        <StatusBadge tone={severity.tone} label={severity.label} />
        <StatusBadge tone={EXCEPTION_STATUS_TONE[item.status]} label={`Status: ${item.status}`} />
        {item.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
      </span>
      <span className="issue-title" id={titleId}>
        {item.title}
      </span>
      <span className="caption">
        {item.affected ? `Affects ${item.affected.type} ${item.affected.id}` : 'No linked record'} ·
        Owner: {item.ownerQueue}
        {item.facilityId ? ` · ${facilityLabel(item.facilityId, names)}` : ''}
        {item.ageMinutes !== null ? ` · Open ${formatMinutes(item.ageMinutes)}` : ''}
        {item.deadlineAt ? ` · Due ${formatDateTime(item.deadlineAt, zone)}` : ''}
      </span>
      {next.length > 0 ? (
        <span className="caption issue-next">
          Next:{' '}
          {next.map((a, i) => (
            <span key={`${a.action}-${a.href ?? i}`}>
              {i > 0 ? ', ' : null}
              <NextActionLink action={a} />
            </span>
          ))}
        </span>
      ) : null}
      {exceptionId ? (
        <div className="actions-row">
          <Link
            className="button button-primary button-sm"
            to={`/today/exceptions/${exceptionId}`}
            aria-label={`Open exception: ${item.title}`}
          >
            Open exception
          </Link>
          {verbs.has('acknowledge') ? (
            <AcknowledgeAction item={item} exceptionId={exceptionId} />
          ) : null}
        </div>
      ) : null}
      <details>
        <summary>Resolution history ({item.history.length})</summary>
        {item.history.length === 0 ? (
          <p className="caption">
            No resolution steps yet. A derived condition clears only when its owning record changes.
          </p>
        ) : (
          <ol className="caption">
            {item.history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                {formatDateTime(h.at, zone)}: {h.action} by {h.actorLabel}
                {h.reason ? ` (${h.reason})` : ''}
              </li>
            ))}
          </ol>
        )}
      </details>
    </li>
  );
}

/** Each row names its facility, so two restricted facilities never read the same (SCR-S-01). */
function SourcesNote({
  sources,
  names,
}: {
  sources: Schema<'TodaySource'>[];
  names: ReadonlyMap<string, string>;
}) {
  const limited = sources.filter((s) => s.status !== 'ok');
  // R3-PERFORMANCE-01: a source the feed's per-request bound truncated is only partly included.
  const partial = sources.filter((s) => s.status === 'ok' && s.truncated);
  if (limited.length === 0 && partial.length === 0) return null;
  const where = (s: Schema<'TodaySource'>) =>
    s.facilityId ? facilityLabel(s.facilityId, names) : 'all facilities';
  return (
    <>
      {limited.length > 0 ? (
        <section aria-label="Issue sources not included">
          <h3>Not included</h3>
          <ul className="list">
            {limited.map((s) => (
              <li key={`${s.source}-${s.facilityId ?? 'all'}`}>
                <span>
                  {s.source} · {where(s)}
                </span>
                <StatusBadge
                  tone={s.status === 'unavailable' ? 'warning' : 'neutral'}
                  label={SOURCE_STATUS[s.status]}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {partial.length > 0 ? (
        <section aria-label="Issue sources partly included">
          <h3>Partly included</h3>
          <ul className="list">
            {partial.map((s) => (
              <li key={`${s.source}-${s.facilityId ?? 'all'}`}>
                <span>
                  {s.source} · {where(s)} ·{' '}
                  {s.omitted === null ? 'more than shown' : `${s.omitted} more not shown`}
                </span>
                <StatusBadge tone="warning" label="Partly included" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** The request start moves in 5-minute steps so the query key stays stable between ticks. */
const WINDOW_STEP_MS = 5 * 60_000;

/** Start and end of "current and upcoming" for a facility day, or null when the day is over. */
export function remainingWindow(
  facility: TodayFacility,
  now: Date,
): { start: string; end: string } | null {
  const from = Math.floor(now.getTime() / WINDOW_STEP_MS) * WINDOW_STEP_MS;
  const start = Math.max(from, new Date(facility.window.start).getTime());
  const end = new Date(facility.window.end).getTime();
  if (!(end > start)) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

const EVENT_STATUS_TONE: Record<Schema<'Event'>['status'], StatusTone> = {
  draft: 'pending',
  published: 'success',
  canceled: 'neutral',
};

type ScheduledEvent = Schema<'Event'>;

/** Activity kinds keep one colour across Today and the schedule; the kind is always written too. */
export const EVENT_KIND_CLASS: Record<ScheduledEvent['kind'], string> = {
  game: 'league',
  practice: 'league',
  session: 'program',
  rental: 'rental',
  party: 'party',
  pickup: 'dropin',
  maintenance: 'rental',
  block: 'dropin',
};

/** Current and upcoming activities of a facility day: one read shared by the board and the list. */
function useRemainingEvents(facility: TodayFacility, now: Date) {
  const window = remainingWindow(facility, now);
  const query = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.facilityId,
        start: window?.start ?? '',
        end: window?.end ?? '',
        limit: 50,
      },
    },
    enabled: facility.activities.visible && window !== null,
  });
  return { window, query };
}

function stillRunning(events: readonly ScheduledEvent[], now: Date): ScheduledEvent[] {
  return events.filter((e) => new Date(e.scheduledEnd).getTime() > now.getTime());
}

function ActivitiesSection({ facility, now }: { facility: TodayFacility; now: Date }) {
  const { window, query: events } = useRemainingEvents(facility, now);
  const visible = facility.activities.visible;
  const headingId = `activities-${facility.facilityId}`;
  let body;
  if (!visible) {
    body = (
      <StateView
        variant="unavailable"
        title="Not available to you"
        description="You may not read this facility's schedule."
      />
    );
  } else if (!window) {
    body = <p className="card-pad">No more activities today at this facility.</p>;
  } else {
    body = (
      <QueryBoundary
        query={events}
        label="current and upcoming activities"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing activities']}
      >
        {(page) => {
          // The API returns activities overlapping the window; anything already over is excluded.
          const items = stillRunning(page.items, now);
          if (items.length === 0) return <p>No more activities today at this facility.</p>;
          return (
            <>
              <ul
                className="list timeline-list"
                aria-label={`Current and upcoming activities, ${facility.name}`}
              >
                {items.map((e) => {
                  const current = new Date(e.scheduledStart).getTime() <= now.getTime();
                  return (
                    <li key={e.id} data-current={current}>
                      <span className="timeline-time" aria-hidden="true">
                        {formatTime(e.scheduledStart, facility.timezone)}
                      </span>
                      <div className="row-text">
                        <span className="row-title">{e.title}</span>
                        <span className="caption">
                          {formatTimeRange(e.scheduledStart, e.scheduledEnd, facility.timezone)} ·{' '}
                          {e.kind}
                          {e.sport ? ` · ${sportLabel(e.sport)}` : ''}
                        </span>
                      </div>
                      <span className="kind-tag" data-kind={kindTokenOf(e)}>
                        <span className="kind-swatch" aria-hidden="true" />
                        {e.kind}
                      </span>
                      <span className="actions-row">
                        <StatusBadge
                          tone={current ? 'info' : 'neutral'}
                          label={current ? 'In progress' : 'Upcoming'}
                        />
                        <StatusBadge
                          tone={EVENT_STATUS_TONE[e.status]}
                          label={`Status: ${e.status}`}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
              {page.nextCursor ? (
                <p className="caption">
                  More activities are scheduled today; the Schedule area lists them all.
                </p>
              ) : null}
            </>
          );
        }}
      </QueryBoundary>
    );
  }
  return (
    <section className="card card-flush" aria-labelledby={headingId}>
      <div className="card-head">
        <h4 id={headingId}>Current and upcoming activities</h4>
        <Link to="/schedule">Open schedule</Link>
      </div>
      <div className="card-body">{body}</div>
    </section>
  );
}

/** What a space is doing now and next, from the facility's remaining activities. */
function spaceActivity(resourceId: string, events: readonly ScheduledEvent[], now: Date) {
  const mine = events
    .filter((e) => e.status !== 'canceled' && e.resourceIds.includes(resourceId))
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
  const t = now.getTime();
  const current = mine.find(
    (e) => new Date(e.scheduledStart).getTime() <= t && new Date(e.scheduledEnd).getTime() > t,
  );
  const next = mine.find((e) => new Date(e.scheduledStart).getTime() > t);
  let progress: number | null = null;
  if (current) {
    const s = new Date(current.scheduledStart).getTime();
    const e = new Date(current.scheduledEnd).getTime();
    progress = Math.min(100, Math.max(0, Math.round(((t - s) / (e - s)) * 100)));
  }
  return { current, next, progress };
}

/**
 * The field board (SPK-UX-006 field status): every space of the facility on one dark board, with
 * what is on it now (and how far through), what is next, and its machine status. Restrictions are
 * written out with their reason; colour is never the only signal (SPK-UX-009).
 */
function FieldStatusSection({ facility, now }: { facility: TodayFacility; now: Date }) {
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.facilityId } },
  });
  const { query: events } = useRemainingEvents(facility, now);
  const remaining = stillRunning(events.data?.items ?? [], now);
  const headingId = `field-status-${facility.facilityId}`;
  return (
    <section className="card card-dark card-flush field-board" aria-labelledby={headingId}>
      <div className="card-head">
        <span className="field-board-title">
          <h4 id={headingId}>Field status</h4>
          <span className="live-chip" aria-hidden="true">
            <span className="live-dot" />
            Live
          </span>
        </span>
        <Link to="/schedule">Open schedule →</Link>
      </div>
      <div className="card-body">
        <QueryBoundary
          query={status}
          label="field status"
          empty={{ title: '', description: '' }}
          unavailableOffline={['releasing areas to service']}
        >
          {(data) => {
            if (data.resources.length === 0) {
              return <p>No fields or spaces are recorded for this facility.</p>;
            }
            const inUse = data.resources.filter(
              (r) => spaceActivity(r.resourceId, remaining, now).current,
            ).length;
            return (
              <>
                <p className="caption field-board-summary">
                  {inUse} of {data.resources.length} spaces in use now
                </p>
                <div className="board-head" aria-hidden="true">
                  <span>Space</span>
                  <span>Now</span>
                  <span>Next</span>
                  <span>Status</span>
                </div>
                <ul className="board" aria-label={`Field status, ${facility.name}`}>
                  {data.resources.map((r) => {
                    const { current, next, progress } = spaceActivity(r.resourceId, remaining, now);
                    const restricted = r.status !== 'in_service';
                    return (
                      <li key={r.resourceId} data-restricted={restricted} data-live={!!current}>
                        <span className="board-space">
                          <span className="row-title">{r.name}</span>
                          <span className="caption">{r.kind}</span>
                        </span>
                        <span className="board-now">
                          {current ? (
                            <>
                              <span className="board-now-title">{current.title}</span>
                              <span className="board-progress">
                                <span
                                  className="board-bar"
                                  role="progressbar"
                                  aria-label={`${current.title} progress`}
                                  aria-valuenow={progress ?? 0}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                >
                                  <span style={{ width: `${progress ?? 0}%` }} />
                                </span>
                                <span className="caption">
                                  {formatTimeRange(
                                    current.scheduledStart,
                                    current.scheduledEnd,
                                    facility.timezone,
                                  )}
                                </span>
                              </span>
                            </>
                          ) : restricted ? null : (
                            <span className="board-idle">Open now</span>
                          )}
                          {r.restrictions.map((x) => (
                            <span className="caption board-restriction" key={x.restrictionId}>
                              {x.kind}: {x.reason} until{' '}
                              {formatDateTime(x.interval.end, facility.timezone)}
                            </span>
                          ))}
                        </span>
                        <span className="board-next">
                          {next ? (
                            <>
                              <strong>{formatTime(next.scheduledStart, facility.timezone)}</strong>{' '}
                              {next.title}
                            </>
                          ) : (
                            <span className="caption">Nothing else today</span>
                          )}
                        </span>
                        <span className="board-status">
                          {current ? <span className="live-chip">● In use</span> : null}
                          <StatusBadge
                            tone={r.status === 'in_service' ? 'success' : 'warning'}
                            label={`Status: ${r.status}`}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            );
          }}
        </QueryBoundary>
      </div>
    </section>
  );
}

function FacilityToday({ facility, now }: { facility: TodayFacility; now: Date }) {
  const headingId = `facility-${facility.facilityId}`;
  return (
    <section className="facility-today" aria-labelledby={headingId}>
      <div className="facility-today-head">
        <h3 id={headingId}>
          {facility.name} · {facility.localDate}
        </h3>
        <p className="caption">
          {facility.activities.visible
            ? `${facility.activities.total} activities today: ${facility.activities.published} published, ${facility.activities.canceled} canceled.`
            : 'Activity counts are not available to you.'}
        </p>
      </div>
      <FacilityDayCounts facilityId={facility.facilityId} date={facility.localDate} />
      <FieldStatusSection facility={facility} now={now} />
      <ActivitiesSection facility={facility} now={now} />
    </section>
  );
}

/**
 * Restriction, closure and open-task counts for the facility's local day
 * (`GET /v1/facilities/{id}/day-summary`); sections the viewer may not read are left out, and
 * nothing is shown until it has loaded.
 */
function FacilityDayCounts({ facilityId, date }: { facilityId: string; date: string }) {
  const summary = useFacilityDaySummary(facilityId, date);
  if (!summary.data) return null;
  const parts = daySummaryParts(summary.data, { activities: false, tasks: true });
  if (parts.length === 0) return null;
  return (
    <p className="caption facility-day-counts" data-testid={`day-counts-${facilityId}`}>
      {parts.join(' · ')}
    </p>
  );
}

function TodayKpis({ feed }: { feed: Schema<'TodayFeed'> }) {
  const visible = feed.facilities.filter((f) => f.activities.visible);
  const total = visible.reduce((n, f) => n + f.activities.total, 0);
  const published = visible.reduce((n, f) => n + f.activities.published, 0);
  const urgent = feed.items.filter((i) => i.severity === 'critical' || i.severity === 'high');
  const overdue = feed.items.filter((i) => i.overdue).length;
  const recovery = feed.items.filter(isRecoveryRequired).length;
  return (
    <KpiRow label="Today at a glance">
      <Kpi
        icon="warning"
        tone="danger"
        label="Open issues"
        value={String(feed.items.length)}
        sub={`${urgent.length} critical or high`}
      />
      <Kpi
        icon="calendar_month"
        tone="success"
        label="Activities today"
        value={visible.length > 0 ? String(total) : '—'}
        sub={visible.length > 0 ? `${published} published` : 'Not available to you'}
      />
      <Kpi
        icon="schedule"
        tone="warning"
        label="Overdue"
        value={String(overdue)}
        sub="past their deadline"
      />
      <Kpi
        icon="payments"
        tone="pending"
        label="Recovery required"
        value={String(recovery)}
        sub="money moved, not fulfilled"
      />
    </KpiRow>
  );
}

const DATE_LINE = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

export function TodayScreen() {
  const { facilityId } = useApp();
  const now = useNow();
  const [showAssistant, setShowAssistant] = useState(false);
  // §4.5: the only Today read in the dashboard; scoped to the facility chosen in the header.
  const today = useApiQuery({
    path: '/today',
    request: facilityId ? { query: { facilityId } } : undefined,
  });
  return (
    <section aria-labelledby="today-title" className="today">
      <div className="page-head">
        <div className="page-head-text">
          <span className="eyebrow">{DATE_LINE.format(now)} · Operating home</span>
          <h2 id="today-title">Today</h2>
        </div>
        <Button
          variant="secondary"
          aria-expanded={showAssistant}
          aria-controls="assistant-panel"
          onClick={() => setShowAssistant((open) => !open)}
        >
          <span className="tone-pending">
            <Icon name="star_shine" size={18} />
          </span>
          {showAssistant ? 'Hide assistant' : 'Assistant (optional)'}
        </Button>
      </div>
      {showAssistant ? <AssistantPanel facilityId={facilityId} /> : null}
      <QueryBoundary
        query={today}
        label="today's issues"
        agePrefix="Evaluated"
        empty={{ title: '', description: '' }}
        unavailableOffline={['acknowledging and resolving issues']}
      >
        {(feed) => {
          const names = new Map(feed.facilities.map((f) => [f.facilityId, f.name]));
          const zones = new Map(feed.facilities.map((f) => [f.facilityId, f.timezone]));
          const items = orderTodayItems(feed.items);
          return (
            <div className="today-body">
              <TodayKpis feed={feed} />
              <div className="split">
                <div className="split-main">
                  {feed.facilities.map((f) => (
                    <FacilityToday key={f.facilityId} facility={f} now={now} />
                  ))}
                </div>
                <div className="split-side">
                  <section className="card card-flush attention" aria-labelledby="issues-title">
                    <div className="card-head">
                      <h3 id="issues-title">Open issues</h3>
                      <span className="caption">{items.length} open</span>
                    </div>
                    {items.length === 0 ? (
                      <div className="card-body">
                        <StateView
                          variant="empty"
                          title="No open issues"
                          description={`Nothing needs action in your scope right now. Last evaluated ${formatDateTime(feed.generatedAt)}.`}
                        />
                      </div>
                    ) : (
                      <ul className="issues" aria-label="Open issues">
                        {items.map((item) => (
                          <IssueRow key={item.id} item={item} names={names} zones={zones} />
                        ))}
                      </ul>
                    )}
                    <div className="card-foot">
                      <SourcesNote sources={feed.sources} names={names} />
                    </div>
                  </section>
                  {feed.facilities.map((f) => (
                    <div className="card" key={f.facilityId}>
                      <ExpectedArrivals
                        facilityId={f.facilityId}
                        facilityName={f.name}
                        timezone={f.timezone}
                        localDate={f.localDate}
                        now={now}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
