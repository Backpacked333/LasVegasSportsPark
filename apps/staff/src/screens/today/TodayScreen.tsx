/**
 * SCR-S-01 Today, redesigned (handoff S 1a desktop, S 1d phone, S 3a drawer, S 3b weather cancel;
 * SPK-UX-006, SPK-READY-001, SPK-UX-008). The operating home for the facility chosen in the
 * header (the first in the viewer's scope when "all" is chosen):
 *
 * - KPI tiles with a second line that says whether it is bad (`TodayKpis`);
 * - "Starting in the next 60 minutes": every start with its checks, a failed check marked red at
 *   the top and opening its fix (`NextHourStrip`, `start-checks`);
 * - the field board: a day-long mini timeline per space with a now-line, closures hatched and a
 *   red ring on the slot that needs a person (`FieldBoard`);
 * - "Needs action": the Today feed's issues, folded and sorted by start, resolved in place
 *   (`NeedsAction`, `RefereeFix`), and "N resolved today" with the median time to act;
 * - the session drawer and the weather cancellation (`SessionDrawer`, `CancelGamesDialog`).
 *
 * Reads refresh every 60 s and when the window regains focus; a changed number flashes for 1 s.
 * On a phone (under 600 px) the issues come first and the top one is fixed with one 44 px tap
 * (S 1d). Times are the facility's (SPK-SCHED-008). Sources the viewer may not read are named, not
 * hidden (§4.10). The optional assistant (SCR-S-50) stays behind its own button.
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { PHONE_QUERY, useMediaQuery } from '../../layout/useMediaQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import type { StatusTone } from '../../ui/StatusBadge';
import '../../ui/form-fields.css';
import { AssistantPanel } from './AssistantPanel';
import { CancelGamesDialog } from './CancelGamesDialog';
import { FieldBoard } from './FieldBoard';
import { NeedsAction, type IssueContext, type WaiverIssue } from './NeedsAction';
import { NextHourStrip, type StripContext } from './NextHourStrip';
import { ResolvedToday } from './ResolvedToday';
import { SessionDrawer } from './SessionDrawer';
import { isFailed, type FixKind, type StartChecks } from './start-checks';
import { TodayKpis } from './TodayKpis';
import { TodayLocalProvider } from './today-local';
import {
  boardAxis,
  issueCards,
  nextHourStarts,
  peakBand,
  spacesInUse,
  type ScheduledEvent,
  type TodayFacility,
  type TodayItem,
} from './today-model';
import type { RefereeTarget } from './RefereeFix';
import './today.css';

export { exceptionIdOf, TODAY_KEY, EXCEPTIONS_KEY, EXCEPTION_KEY } from './NeedsAction';

/** Staff labels use the machine state names (journeys.md section 3, rule 4). */
export const SEVERITY_BADGE: Record<TodayItem['severity'], { tone: StatusTone; label: string }> = {
  critical: { tone: 'danger', label: 'Severity: critical' },
  high: { tone: 'danger', label: 'Severity: high' },
  warning: { tone: 'warning', label: 'Severity: warning' },
  info: { tone: 'info', label: 'Severity: info' },
};

/** Every read of Today refreshes this often, and on focus (S 1a "Screen states"). */
export const TODAY_REFRESH_MS = 60_000;

const DATE_LINE = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone });

/** Uncovered roles per event id (referee, coach…), from the staffing items of the feed. */
function uncoveredByEvent(
  items: readonly TodayItem[],
  events: readonly ScheduledEvent[],
): Map<string, Set<string>> {
  const byFixture = new Map(
    events.filter((e) => e.sourceType === 'fixture' && e.sourceId).map((e) => [e.sourceId!, e.id]),
  );
  const out = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.category !== 'workforce.uncovered_assignment') continue;
    const eventId =
      (typeof item.details['eventId'] === 'string' ? (item.details['eventId'] as string) : null) ??
      (item.affected?.type === 'fixture' ? byFixture.get(item.affected.id) : null) ??
      (item.affected?.type === 'event' ? item.affected.id : null);
    if (!eventId) continue;
    const role =
      typeof item.details['role'] === 'string' ? (item.details['role'] as string) : 'referee';
    const set = out.get(eventId) ?? new Set<string>();
    set.add(role === 'referee' ? 'referee' : role);
    out.set(eventId, set);
  }
  return out;
}

function FacilityToday({
  feed,
  facility,
  now,
  phone,
}: {
  feed: Schema<'TodayFeed'>;
  facility: TodayFacility;
  now: Date;
  phone: boolean;
}) {
  const timeZone = facility.timezone;
  const events = useApiQuery({
    path: '/events',
    request: {
      query: {
        facilityId: facility.facilityId,
        start: facility.window.start,
        end: facility.window.end,
        limit: 200,
      },
    },
    enabled: facility.activities.visible,
    refetchInterval: TODAY_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
  const status = useApiQuery({
    path: '/facilities/{id}/operating-status',
    request: { path: { id: facility.facilityId } },
    refetchInterval: TODAY_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
  const sessions = useApiQuery({
    path: '/sessions',
    request: {
      query: {
        facilityId: facility.facilityId,
        from: facility.window.start,
        to: facility.window.end,
        limit: 200,
      },
    },
    enabled: facility.activities.visible,
    staleTime: TODAY_REFRESH_MS,
  });

  const dayEvents = useMemo(
    () => (events.data?.items ?? []).filter((e) => e.status !== 'canceled'),
    [events.data],
  );
  const resources = status.data?.resources;
  const spaceNames = useMemo(
    () => new Map((resources ?? []).map((r) => [r.resourceId, r.name])),
    [resources],
  );
  const items = useMemo(
    () => feed.items.filter((i) => i.facilityId === null || i.facilityId === facility.facilityId),
    [feed.items, facility.facilityId],
  );
  const starts = useMemo(() => nextHourStarts(dayEvents, now), [dayEvents, now]);
  const uncovered = useMemo(() => uncoveredByEvent(items, dayEvents), [items, dayEvents]);
  const cards = useMemo(() => issueCards(items, dayEvents, now), [items, dayEvents, now]);
  const axis = useMemo(() => boardAxis(facility, dayEvents), [facility, dayEvents]);
  const space = resources ? spacesInUse(resources, dayEvents, now) : null;
  const peak = resources ? peakBand(resources, dayEvents, axis) : null;
  const unknownOutcomes = items.filter(
    (i) => i.category === 'finance.unknown_payment_outcome',
  ).length;

  // The strip's checks, reported by each card (for "N ready" and the waivers issue).
  const [checks, setChecks] = useState<ReadonlyMap<string, StartChecks>>(new Map());
  const onChecks = useCallback((eventId: string, result: StartChecks) => {
    setChecks((current) => new Map(current).set(eventId, result));
  }, []);
  const readyCount = starts.filter((e) => {
    const c = checks.get(e.id);
    return c && !c.loading && !c.checks.some(isFailed);
  }).length;
  const waiverIssues: WaiverIssue[] = starts
    .map((event) => ({ event, result: checks.get(event.id) }))
    .filter((x) => x.result && x.result.missingWaivers.length > 0)
    .map(({ event, result }) => ({
      id: `waivers:${event.id}`,
      event,
      names: result!.missingWaivers.map((m) => m.name),
    }));

  const [drawer, setDrawer] = useState<{ event: ScheduledEvent; focus: FixKind | null } | null>(
    null,
  );
  const [cancelling, setCancelling] = useState<ScheduledEvent | null>(null);
  const openDrawer = useCallback(
    (event: ScheduledEvent, focus?: FixKind) => setDrawer({ event, focus: focus ?? null }),
    [],
  );

  const eventsById = useMemo(() => new Map(dayEvents.map((e) => [e.id, e])), [dayEvents]);
  const facilityNames = useMemo(
    () => new Map(feed.facilities.map((f) => [f.facilityId, f.name])),
    [feed.facilities],
  );
  const issueContext: IssueContext = { timeZone, events: eventsById, spaceNames, facilityNames };
  const stripContext: StripContext = {
    timeZone,
    resources,
    sessions: sessions.data?.items,
    spaceNames,
    uncovered,
  };
  const staffingTargetOf = (event: ScheduledEvent): RefereeTarget | null => {
    const card = cards.find((c) => c.kind === 'staffing' && c.eventId === event.id);
    const item = card?.item;
    if (!item?.affected) return null;
    const d = item.details;
    return {
      targetType: item.affected.type as RefereeTarget['targetType'],
      targetId: item.affected.id,
      kind: (typeof d['kind'] === 'string' ? d['kind'] : 'official') as RefereeTarget['kind'],
      role: typeof d['role'] === 'string' ? (d['role'] as string) : 'referee',
      slot: typeof d['slot'] === 'number' ? (d['slot'] as number) : undefined,
      assignmentId: typeof d['assignmentId'] === 'string' ? (d['assignmentId'] as string) : null,
      requirementId: typeof d['requirementId'] === 'string' ? (d['requirementId'] as string) : null,
      title: event.title,
    };
  };
  const needsPerson = new Set(uncovered.keys());
  const eventsLoading = facility.activities.visible && events.isPending;

  const kpis = (
    <TodayKpis
      facility={facility}
      cards={cards}
      space={space}
      peak={peak}
      unknownOutcomes={unknownOutcomes}
      phone={phone}
    />
  );
  const strip = facility.activities.visible ? (
    <NextHourStrip
      starts={starts}
      context={stripContext}
      readyCount={readyCount}
      openEventId={drawer?.event.id ?? null}
      onOpen={openDrawer}
      onChecks={onChecks}
      loading={eventsLoading}
    />
  ) : (
    <section className="card next-hour" aria-label="Starting in the next 60 minutes">
      <p className="next-hour-empty">The schedule of this facility is not available to you.</p>
    </section>
  );
  const board = (
    <FieldBoard
      resources={resources}
      events={dayEvents}
      axis={axis}
      now={now}
      timeZone={timeZone}
      needsPerson={needsPerson}
      onOpen={(e) => openDrawer(e)}
      loading={status.isPending}
      error={status.error}
      onRetry={() => void status.refetch()}
      compact={phone}
    />
  );
  const issues = (
    <NeedsAction
      cards={cards}
      waiverIssues={waiverIssues}
      context={issueContext}
      now={now}
      sources={feed.sources}
      phone={phone}
    />
  );

  return (
    <>
      {phone ? (
        <div className="today-phone">
          {issues}
          {kpis}
          {board}
          {strip}
        </div>
      ) : (
        <>
          {kpis}
          <div className="today-grid">
            <div className="today-main">
              {strip}
              {board}
            </div>
            <div className="today-side">
              {issues}
              <ResolvedToday facilityId={facility.facilityId} window={facility.window} />
            </div>
          </div>
        </>
      )}
      {drawer ? (
        <SessionDrawer
          event={drawer.event}
          focus={drawer.focus}
          context={{
            timeZone,
            resources,
            sessions: sessions.data?.items,
            spaceNames,
            uncovered,
            staffingTargetOf,
            now,
          }}
          onClose={() => setDrawer(null)}
          onCancel={(event) => {
            setDrawer(null);
            setCancelling(event);
          }}
        />
      ) : null}
      {cancelling && resources ? (
        <CancelGamesDialog
          origin={cancelling}
          events={dayEvents}
          resources={resources}
          timeZone={timeZone}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </>
  );
}

export function TodayScreen() {
  const { facilityId } = useApp();
  const now = useNow(15_000);
  const phone = useMediaQuery(PHONE_QUERY);
  const [showAssistant, setShowAssistant] = useState(false);
  // §4.5: the only Today read in the dashboard; scoped to the facility chosen in the header.
  const today = useApiQuery({
    path: '/today',
    request: facilityId ? { query: { facilityId } } : undefined,
    refetchInterval: TODAY_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
  const facility =
    today.data?.facilities.find((f) => f.facilityId === facilityId) ?? today.data?.facilities[0];
  const zone = facility?.timezone ?? 'America/Los_Angeles';
  const issuesCount = today.data?.items.length ?? 0;

  return (
    <TodayLocalProvider>
      <section aria-labelledby="today-title" className="today" data-phone={phone || undefined}>
        <div className="page-head today-head">
          <div className="page-head-text">
            <span className="eyebrow">
              {phone
                ? `${new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone }).format(now)} · ${issuesCount} ${issuesCount === 1 ? 'needs' : 'need'} you`
                : `${DATE_LINE(zone).format(now)}${facility ? ` · ${facility.name}` : ''}`}
            </span>
            <h2 id="today-title">Today</h2>
          </div>
          {phone ? null : (
            <div className="actions-row">
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
              <Link className="button button-secondary" to="/schedule">
                <Icon name="add" size={18} />
                New booking
              </Link>
              <Link className="button button-primary" to="/arrival">
                <Icon name="qr_code_scanner" size={18} />
                Open arrival desk
              </Link>
            </div>
          )}
        </div>
        {showAssistant ? <AssistantPanel facilityId={facilityId} /> : null}
        <QueryBoundary
          query={today}
          label="today's issues"
          agePrefix="Evaluated"
          empty={{ title: '', description: '' }}
          unavailableOffline={[
            'acknowledging and resolving issues',
            'assigning officials',
            'cancelling games',
          ]}
        >
          {(feed) => {
            const chosen =
              feed.facilities.find((f) => f.facilityId === facilityId) ?? feed.facilities[0];
            if (!chosen) {
              return <p>No facility is in your scope.</p>;
            }
            return (
              <div className="today-body">
                {feed.facilities.length > 1 && !facilityId ? (
                  <p className="caption today-scope-note">
                    Showing {chosen.name}. Choose another facility in the header.
                  </p>
                ) : null}
                <FacilityToday
                  key={chosen.facilityId}
                  feed={feed}
                  facility={chosen}
                  now={now}
                  phone={phone}
                />
              </div>
            );
          }}
        </QueryBoundary>
      </section>
    </TodayLocalProvider>
  );
}
