/**
 * SCR-W-01 My assignments, with acceptance from SCR-W-02 (SPK-UX-007, SPK-STAFF-002/003/004).
 * Responsive: one column of cards on a phone beside a field. Shows only what `GET /v1/me/assignments`
 * returns for the viewer (assigned activities, permitted participant information); offers awaiting
 * a response first. "Accept" appears only when the API lists `accept` in `availableActions` (the
 * client never decides authorization) and sends `expectedRevision` (§4.9). Decline, withdrawal,
 * attendance, match reports, messages and fees (SCR-W-02 to SCR-W-09) open from each card
 * (AssignmentWorkspaceScreen). The offline queue status (SCR-W-10) shows above the list.
 *
 * Times: the workspace payload carries no facility timezone, so times are shown in the device's
 * time zone with the zone named, not presented as facility-local time (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
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

export function formatActivityTime(start: string, end: string): string {
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const endFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${fmt.format(new Date(start))} to ${endFmt.format(new Date(end))}`;
}

function AssignmentCard({ item }: { item: WorkspaceAssignment }) {
  const queryClient = useQueryClient();
  const accept = useApiCommand('post', '/assignments/{id}/accept', {
    invalidate: [ASSIGNMENTS_KEY],
  });
  const submit = () =>
    void accept
      .submit({
        path: { id: item.assignment.id },
        body: { expectedRevision: item.assignment.revision },
      })
      .catch(() => undefined);
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
          {formatActivityTime(item.activity.scheduledStart, item.activity.scheduledEnd)} ·{' '}
          {item.assignment.role}
        </span>
        {participants ? <span className="caption">{participants}</span> : null}
        <StatusBadge tone={badge.tone} label={badge.label} />
      </div>
      {canAccept ? (
        <Button
          busy={accept.isProcessing}
          aria-label={`Accept assignment: ${item.activity.title}`}
          onClick={submit}
        >
          Accept
        </Button>
      ) : null}
      {accept.error ? (
        <StateView variant="error" error={accept.error} onRetry={submit} onAction={reload} />
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
