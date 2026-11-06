/**
 * SCR-W-01 My assignments, with acceptance from SCR-W-02 (SPK-UX-007, SPK-STAFF-002/003/004).
 * Responsive: one column of cards on a phone beside a field. Shows only what `GET /v1/me/assignments`
 * returns for the viewer (assigned activities, permitted participant information); offers awaiting
 * a response first. "Accept" appears only when the API lists `accept` in `availableActions` (the
 * client never decides authorization) and sends `expectedRevision` (§4.9). Offline the list is
 * read-only: "Accept" and "Try again" are disabled with "Needs a connection" and nothing is queued
 * (§4.15). A failure without a definite answer reads as an unknown outcome (operations
 * `CommandError`), and "Try again" resends exactly the accept that was sent (`resend`: same
 * expected revision, so the same idempotency key), never one rebuilt from the list read again
 * after it, where a committed accept already shows a new revision. Decline, withdrawal,
 * attendance, match reports, messages and fees (SCR-W-02 to SCR-W-09) open from each card
 * (AssignmentWorkspaceScreen). The offline queue status (SCR-W-10) shows above the list.
 *
 * Times: each activity's facility time zone from the workspace payload (WRK-01
 * `activity.facility.timezone`, SPK-SCHED-008), with the zone named.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { CommandError } from '../../features/operations/feedback';
import { formatClock, humanize } from '../../features/operations/format';
import {
  OfflineQueueChip,
  OfflineQueueStatus,
} from '../../features/operations/offline/OfflineQueueStatus';
import { useApp, useNow } from '../../providers/AppProviders';
import { CommandButton } from '../../ui/CommandButton';
import { PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import './workspace.css';

type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;
type AssignmentStatus = WorkspaceAssignment['assignment']['status'];

/** Official-facing labels from journeys.md section 3 ("Covered" is never used for an offer). */
export const ASSIGNMENT_BADGE: Record<AssignmentStatus, { tone: StatusTone; label: string }> = {
  proposed: { tone: 'info', label: 'Proposed' },
  offered: { tone: 'pending', label: 'Offered: response needed' },
  accepted: { tone: 'success', label: 'Accepted' },
  declined: { tone: 'neutral', label: 'Declined' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
  completed: { tone: 'success', label: 'Completed' },
};

const ASSIGNMENTS_KEY = ['api', '/me/assignments'] as const;

/** The activity's time in its facility's zone (SPK-SCHED-008), the zone named. */
export function formatActivityTime(start: string, end: string, timeZone?: string | null): string {
  const zone = timeZone ? { timeZone } : {};
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...zone,
  });
  const endFmt = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...zone,
  });
  return `${fmt.format(new Date(start))} to ${endFmt.format(new Date(end))}`;
}

/** The facility time zone of a workspace activity (WRK-01). */
export function activityZone(item: WorkspaceAssignment): string | null {
  return item.activity.facility?.timezone ?? null;
}

function AssignmentCard({ item }: { item: WorkspaceAssignment }) {
  const queryClient = useQueryClient();
  const { online } = useApp();
  const accept = useApiCommand('post', '/assignments/{id}/accept', {
    invalidate: [ASSIGNMENTS_KEY],
  });
  // Offline the answer is never queued (§4.15): the controls are disabled, and nothing is sent.
  const submit = () => {
    if (!online) return;
    void accept
      .submit({
        path: { id: item.assignment.id },
        body: { expectedRevision: item.assignment.revision },
      })
      .catch(() => undefined);
  };
  // "Try again": the accept that was sent, unchanged (same key, §4.9). After an unknown outcome the
  // list is read again; if the accept committed, it already shows the next revision.
  const retry = () => {
    if (!online) return;
    void accept.resend().catch(() => undefined);
  };
  // STALE_REVISION or INVALID_TRANSITION: reload the current assignment, then the user decides again.
  const reload = () => {
    accept.reset();
    void queryClient.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
  };
  const badge = ASSIGNMENT_BADGE[item.assignment.status];
  const canAccept = item.availableActions.includes('accept');
  const participants = item.activity.participants.map((p) => p.name).join(' v ');
  const zone = activityZone(item);
  return (
    <li
      aria-labelledby={`assignment-${item.assignment.id}`}
      className="ws-card"
      data-status={item.assignment.status}
    >
      <span className="ws-when" aria-hidden="true">
        <span className="ws-when-day">{formatDay(item.activity.scheduledStart, zone)}</span>
        <span className="ws-when-time">{formatClock(item.activity.scheduledStart, zone)}</span>
      </span>
      <div className="row-text">
        <Link
          className="row-title"
          id={`assignment-${item.assignment.id}`}
          to={`/workspace/assignments/${item.assignment.id}`}
        >
          {item.activity.title}
        </Link>
        <span className="caption">
          {formatActivityTime(
            item.activity.scheduledStart,
            item.activity.scheduledEnd,
            activityZone(item),
          )}{' '}
          · {item.activity.facility?.name ? `${item.activity.facility.name} · ` : ''}
          {humanize(item.assignment.role)}
        </span>
        {participants ? <span className="caption">{participants}</span> : null}
        <StatusBadge tone={badge.tone} label={badge.label} />
      </div>
      {canAccept ? (
        <CommandButton
          className="ws-accept"
          busy={accept.isProcessing}
          aria-label={`Accept assignment: ${item.activity.title}`}
          onClick={submit}
        >
          Accept
        </CommandButton>
      ) : null}
      {/* A lost answer reads as an unknown outcome, never "Something went wrong" (§4.9). */}
      {accept.error ? (
        <div className="ws-card-error">
          <CommandError
            error={accept.error}
            onRetry={retry}
            onReload={reload}
            subject="This assignment"
          />
        </div>
      ) : null}
    </li>
  );
}

/** Offers awaiting a response first, then by start time. */
export function orderAssignments(items: readonly WorkspaceAssignment[]): WorkspaceAssignment[] {
  return [...items].sort((a, b) => {
    const offeredA = a.assignment.status === 'offered' ? 0 : 1;
    const offeredB = b.assignment.status === 'offered' ? 0 : 1;
    if (offeredA !== offeredB) return offeredA - offeredB;
    return a.activity.scheduledStart.localeCompare(b.activity.scheduledStart);
  });
}

/** "Sat" in the activity's facility zone (SPK-SCHED-008). */
function formatDay(iso: string, timeZone?: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** "in 45 min", "in 3 h 10 min" or "in 2 days": how long until an activity starts. */
export function untilText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `in ${h} h${m > 0 ? ` ${m} min` : ''}`;
  }
  const days = Math.round(minutes / (24 * 60));
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function zoneName(at: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

/**
 * The night-pitch "now" board at the top of the workspace (SPK-UX-007): the time in the facility
 * zone of the viewer's next activity, how many offers wait for an answer, and the accepted
 * assignment on now or next, with how far through it is or how long until it starts. Everything
 * is derived from the assignments read; nothing is shown that the list does not hold.
 */
function NowBoard({ items }: { items: readonly WorkspaceAssignment[] }) {
  const now = useNow(30_000);
  const t = now.getTime();
  const offers = items.filter((i) => i.assignment.status === 'offered').length;
  const upcoming = items
    .filter(
      (i) => i.assignment.status === 'accepted' && new Date(i.activity.scheduledEnd).getTime() > t,
    )
    .sort((a, b) => a.activity.scheduledStart.localeCompare(b.activity.scheduledStart));
  const next = upcoming[0];
  const zone = next ? activityZone(next) : null;
  const start = next ? new Date(next.activity.scheduledStart).getTime() : 0;
  const end = next ? new Date(next.activity.scheduledEnd).getTime() : 0;
  const live = next !== undefined && start <= t;
  const progress =
    live && end > start ? Math.min(100, Math.round(((t - start) / (end - start)) * 100)) : 0;
  return (
    <section className="card card-dark ws-now" aria-labelledby="ws-now-title">
      <div className="ws-now-top">
        <h3 id="ws-now-title" className="ws-now-kicker">
          {live ? 'On now' : 'Next up'}
        </h3>
        {live ? (
          <span className="live-chip">
            <span className="live-dot" aria-hidden="true" />
            Live
          </span>
        ) : null}
      </div>
      <span className="ws-now-clock">
        {formatClock(now.toISOString(), zone)}
        {zone ? <span className="ws-now-zone"> {zoneName(now, zone)}</span> : null}
      </span>
      <div className="ws-now-chips">
        <span className="ws-now-chip" data-attention={offers > 0}>
          {offers === 0
            ? 'No offers waiting'
            : `${offers} offer${offers === 1 ? ' needs' : 's need'} your answer`}
        </span>
        <span className="ws-now-chip">{upcoming.length} accepted ahead</span>
      </div>
      {next ? (
        <div className="ws-now-next">
          <span className="ws-now-title">{next.activity.title}</span>
          <span className="ws-now-meta">
            {formatClock(next.activity.scheduledStart, zone)}–
            {formatClock(next.activity.scheduledEnd, zone)}
            {next.activity.facility?.name ? ` · ${next.activity.facility.name}` : ''} ·{' '}
            {humanize(next.assignment.role)}
          </span>
          {live ? (
            <span className="ws-now-progress">
              <span className="ws-now-bar" aria-hidden="true">
                <span style={{ width: `${progress}%` }} />
              </span>
              <span>{Math.max(0, Math.round((end - t) / 60_000))} min left</span>
            </span>
          ) : (
            <span className="ws-now-until">Starts {untilText(start - t)}</span>
          )}
          <Link
            className="button button-lime ws-now-open"
            to={`/workspace/assignments/${next.assignment.id}`}
          >
            Open assignment
          </Link>
        </div>
      ) : (
        <p className="caption">No accepted assignment ahead. Offers you accept appear here.</p>
      )}
    </section>
  );
}

export function WorkspaceScreen() {
  const assignments = useApiQuery({ path: '/me/assignments' });
  return (
    <section aria-labelledby="workspace-title" className="ops-screen workspace">
      <PageHeader
        eyebrow="Workspace · coaches and officials"
        title="My assignments"
        titleId="workspace-title"
        actions={<OfflineQueueChip reviewPath="/workspace/offline" />}
      />
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      <OfflineQueueStatus reviewPath="/workspace/offline" />
      <QueryBoundary
        query={assignments}
        label="your assignments"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No assignments',
          description:
            'Activities you are assigned to, and offers waiting for your answer, appear here.',
        }}
        unavailableOffline={['accepting or declining assignments']}
      >
        {(data) => (
          <div className="ws-layout">
            <NowBoard items={data.items} />
            <ul className="ws-list" aria-label="Assignments">
              {orderAssignments(data.items).map((item) => (
                <AssignmentCard key={item.assignment.id} item={item} />
              ))}
            </ul>
          </div>
        )}
      </QueryBoundary>
    </section>
  );
}
