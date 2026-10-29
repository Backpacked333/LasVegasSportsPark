/**
 * SCR-S-01 Today workspace (SPK-UX-006, SPK-READY-001, SPK-UX-008). The operating home for the
 * viewer's scope and selected facility:
 *
 * - open issues from `GET /v1/today` (exceptions, readiness blockers, uncovered assignments,
 *   restrictions), each with title, severity as text, affected record, owner queue, age, deadline,
 *   next permitted actions and resolution history; money-moved-but-not-fulfilled financial
 *   exceptions are pinned first with their owner; "Acknowledge" appears only where the API lists
 *   it and sends the exception's expected revision (§4.9);
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
import { facilityLabel } from '../../layout/FacilitySwitcher';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandFeedback';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime, formatMinutes, formatTimeRange } from '../../ui/time';
import '../../ui/form-fields.css';
import { AssistantPanel } from './AssistantPanel';
import { ExpectedArrivals } from './ExpectedArrivals';
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
  const revision = item.details['revision'];
  const submit = () =>
    void acknowledge
      .submit({
        path: { id: exceptionId },
        body: typeof revision === 'number' ? { expectedRevision: revision } : {},
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
    <li data-testid={`today-item-${item.id}`} aria-labelledby={titleId}>
      <div className="row-text">
        <span className="row-title" id={titleId}>
          {item.title}
        </span>
        <span className="caption">
          {item.affected ? `Affects ${item.affected.type} ${item.affected.id}` : 'No linked record'}{' '}
          · Owner: {item.ownerQueue}
          {item.facilityId ? ` · ${facilityLabel(item.facilityId, names)}` : ''}
          {item.ageMinutes !== null ? ` · Open ${formatMinutes(item.ageMinutes)}` : ''}
          {item.deadlineAt ? ` · Due ${formatDateTime(item.deadlineAt, zone)}` : ''}
        </span>
        <span className="actions-row">
          {isRecoveryRequired(item) ? (
            <StatusBadge tone="danger" label="Recovery required" />
          ) : null}
          <StatusBadge tone={severity.tone} label={severity.label} />
          <StatusBadge tone={EXCEPTION_STATUS_TONE[item.status]} label={`Status: ${item.status}`} />
          {item.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
        </span>
        {next.length > 0 ? (
          <span className="caption">Next: {next.map((a) => a.label).join(', ')}</span>
        ) : null}
        <details>
          <summary>Resolution history ({item.history.length})</summary>
          {item.history.length === 0 ? (
            <p className="caption">
              No resolution steps yet. A derived condition clears only when its owning record
              changes.
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
      </div>
      <div className="actions-row">
        {exceptionId ? (
          <Link
            to={`/today/exceptions/${exceptionId}`}
            aria-label={`Open exception: ${item.title}`}
          >
            Open exception
          </Link>
        ) : null}
        {exceptionId && verbs.has('acknowledge') ? (
          <AcknowledgeAction item={item} exceptionId={exceptionId} />
        ) : null}
      </div>
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
  if (limited.length === 0) return null;
  return (
    <section aria-label="Issue sources not included">
      <h3>Not included</h3>
      <ul className="list">
        {limited.map((s) => (
          <li key={`${s.source}-${s.facilityId ?? 'all'}`}>
            <span>
              {s.source} · {s.facilityId ? facilityLabel(s.facilityId, names) : 'all facilities'}
            </span>
            <StatusBadge
              tone={s.status === 'unavailable' ? 'warning' : 'neutral'}
              label={SOURCE_STATUS[s.status]}
            />
          </li>
        ))}
      </ul>
    </section>
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

function ActivitiesSection({ facility, now }: { facility: TodayFacility; now: Date }) {
  const window = remainingWindow(facility, now);
  const visible = facility.activities.visible;
  const events = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.facilityId,
        start: window?.start ?? '',
        end: window?.end ?? '',
        limit: 50,
      },
    },
    enabled: visible && window !== null,
  });
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
    body = <p>No more activities today at this facility.</p>;
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
          const items = page.items.filter(
            (e) => new Date(e.scheduledEnd).getTime() > now.getTime(),
          );
          if (items.length === 0) return <p>No more activities today at this facility.</p>;
          return (
            <>
              <ul className="list" aria-label={`Current and upcoming activities, ${facility.name}`}>
                {items.map((e) => {
                  const current = new Date(e.scheduledStart).getTime() <= now.getTime();
                  return (
                    <li key={e.id}>
                      <div className="row-text">
                        <span className="row-title">{e.title}</span>
                        <span className="caption">
                          {formatTimeRange(e.scheduledStart, e.scheduledEnd, facility.timezone)} ·{' '}
                          {e.kind}
                        </span>
                      </div>
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
    <section aria-labelledby={headingId}>
      <h4 id={headingId}>Current and upcoming activities</h4>
      {body}
    </section>
  );
}

function FieldStatusSection({ facility }: { facility: TodayFacility }) {
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.facilityId } },
  });
  const headingId = `field-status-${facility.facilityId}`;
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId}>Field status</h4>
      <QueryBoundary
        query={status}
        label="field status"
        empty={{ title: '', description: '' }}
        unavailableOffline={['releasing areas to service']}
      >
        {(data) =>
          data.resources.length === 0 ? (
            <p>No fields or spaces are recorded for this facility.</p>
          ) : (
            <ul className="list" aria-label={`Field status, ${facility.name}`}>
              {data.resources.map((r) => (
                <li key={r.resourceId}>
                  <div className="row-text">
                    <span className="row-title">{r.name}</span>
                    <span className="caption">{r.kind}</span>
                    {r.restrictions.map((x) => (
                      <span className="caption" key={x.restrictionId}>
                        {x.kind}: {x.reason} until{' '}
                        {formatDateTime(x.interval.end, facility.timezone)}
                      </span>
                    ))}
                  </div>
                  <StatusBadge
                    tone={r.status === 'in_service' ? 'success' : 'warning'}
                    label={`Status: ${r.status}`}
                  />
                </li>
              ))}
            </ul>
          )
        }
      </QueryBoundary>
    </section>
  );
}

function FacilityToday({ facility, now }: { facility: TodayFacility; now: Date }) {
  const headingId = `facility-${facility.facilityId}`;
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {facility.name} · {facility.localDate}
      </h3>
      <p className="caption">
        {facility.activities.visible
          ? `${facility.activities.total} activities today: ${facility.activities.published} published, ${facility.activities.canceled} canceled.`
          : 'Activity counts are not available to you.'}
      </p>
      <ActivitiesSection facility={facility} now={now} />
      <FieldStatusSection facility={facility} />
      <ExpectedArrivals
        facilityId={facility.facilityId}
        facilityName={facility.name}
        timezone={facility.timezone}
        localDate={facility.localDate}
        now={now}
      />
    </section>
  );
}

export function TodayScreen() {
  const { facilityId } = useApp();
  const now = useNow();
  const [showAssistant, setShowAssistant] = useState(false);
  // Without a facility the request (and cache entry) is the one the facility switcher reads.
  const today = useApiQuery({
    path: '/today',
    request: facilityId ? { query: { facilityId } } : undefined,
  });
  return (
    <section aria-labelledby="today-title">
      <div className="actions-row">
        <h2 id="today-title">Today</h2>
        <Button
          variant="secondary"
          aria-expanded={showAssistant}
          aria-controls="assistant-panel"
          onClick={() => setShowAssistant((open) => !open)}
        >
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
            <>
              <section aria-labelledby="issues-title">
                <h3 id="issues-title">Open issues</h3>
                {items.length === 0 ? (
                  <StateView
                    variant="empty"
                    title="No open issues"
                    description={`Nothing needs action in your scope right now. Last evaluated ${formatDateTime(feed.generatedAt)}.`}
                  />
                ) : (
                  <ul className="list" aria-label="Open issues">
                    {items.map((item) => (
                      <IssueRow key={item.id} item={item} names={names} zones={zones} />
                    ))}
                  </ul>
                )}
              </section>
              <SourcesNote sources={feed.sources} names={names} />
              {feed.facilities.map((f) => (
                <FacilityToday key={f.facilityId} facility={f} now={now} />
              ))}
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
