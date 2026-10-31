/**
 * SCR-W-01 My assignments, with acceptance from SCR-W-02 (SPK-UX-007, SPK-STAFF-002/003/004).
 * Responsive: one column of cards on a phone beside a field. Shows only what `GET /v1/me/assignments`
 * returns for the viewer (assigned activities, permitted participant information); offers awaiting
 * a response first. "Accept" appears only when the API lists `accept` in `availableActions` (the
 * client never decides authorization) and sends `expectedRevision` (§4.9). Offline the list is
 * read-only: "Accept" is disabled with "Needs a connection" and nothing is queued (§4.15), and a
 * failure without a definite answer reads as an unknown outcome (operations `CommandError`). Decline, withdrawal,
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
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { useApp } from '../../providers/AppProviders';
import { CommandButton } from '../../ui/CommandButton';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

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
  // Offline the answer is never queued (§4.15): the control is disabled, and nothing is sent.
  const submit = () => {
    if (!online) return;
    void accept
      .submit({
        path: { id: item.assignment.id },
        body: { expectedRevision: item.assignment.revision },
      })
      .catch(() => undefined);
  };
  // STALE_REVISION or INVALID_TRANSITION: reload the current assignment, then the user decides again.
  const reload = () => {
    accept.reset();
    void queryClient.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
  };
  const badge = ASSIGNMENT_BADGE[item.assignment.status];
  const canAccept = item.availableActions.includes('accept');
  const participants = item.activity.participants.map((p) => p.name).join(' v ');
  return (
    <li aria-labelledby={`assignment-${item.assignment.id}`}>
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
          {item.assignment.role}
        </span>
        {participants ? <span className="caption">{participants}</span> : null}
        <StatusBadge tone={badge.tone} label={badge.label} />
      </div>
      {canAccept ? (
        <CommandButton
          busy={accept.isProcessing}
          aria-label={`Accept assignment: ${item.activity.title}`}
          onClick={submit}
        >
          Accept
        </CommandButton>
      ) : null}
      {/* A lost answer reads as an unknown outcome, never "Something went wrong" (§4.9). */}
      {accept.error ? (
        <CommandError
          error={accept.error}
          onRetry={submit}
          onReload={reload}
          subject="This assignment"
        />
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

export function WorkspaceScreen() {
  const assignments = useApiQuery({ path: '/me/assignments' });
  return (
    <section aria-labelledby="workspace-title">
      <h2 id="workspace-title">My assignments</h2>
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
          <ul className="list" aria-label="Assignments">
            {orderAssignments(data.items).map((item) => (
              <AssignmentCard key={item.assignment.id} item={item} />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
