/**
 * One of the viewer's own assignments, for the workspace screens SCR-W-02 to SCR-W-09
 * (SPK-UX-007). Read from `GET /v1/me/assignments`, which returns only the viewer's assigned
 * activities and the participant information they may see; an id that is not among them is shown
 * as not available, never as "exists but denied" (§4.10).
 *
 * Without `from` the API lists assignments that ended in the last 30 days and later ones (WRK-01
 * default lookback). An id not in that list is looked up again over the workspace history
 * (`WORKSPACE_HISTORY_DAYS`, the period Hours and fees covers), so an older assignment opened
 * from Hours and fees is shown, and the not-available text names the period it searched.
 */
import type { Schema } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { useNow } from '../../providers/AppProviders';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

export type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;

export const MY_ASSIGNMENTS_KEY = ['api', '/me/assignments'] as const;

/**
 * How far back the workspace reads the viewer's assignments for fees (SCR-W-08) and for an older
 * assignment opened by id: the fee lifecycle (submitted, approved or adjusted, exported to a
 * monthly or later payroll run) runs well past the API's 30-day default. Fee records older than
 * this are still listed from `GET /v1/fee-submissions`.
 */
export const WORKSPACE_HISTORY_DAYS = 180;

/** The start of the workspace history: UTC midnight, so the read's key changes once a day. */
export function workspaceHistoryFrom(now: Date): string {
  const day = Math.floor(now.getTime() / 86_400_000) - WORKSPACE_HISTORY_DAYS;
  return new Date(day * 86_400_000).toISOString();
}

/** "26 Apr 2026" for the start of the workspace history (a UTC date, as it is computed). */
export function formatHistoryStart(from: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(from));
}

export function MyAssignmentPage({
  title,
  unavailableOffline,
  children,
}: {
  title: (item: WorkspaceAssignment | null) => string;
  unavailableOffline?: string[];
  children: (item: WorkspaceAssignment) => ReactNode;
}) {
  const { assignmentId = '' } = useParams();
  const now = useNow(60 * 60_000);
  const recent = useApiQuery({ path: '/me/assignments' });
  const found = recent.data?.items.find((i) => i.assignment.id === assignmentId);
  // Not among the recent ones: look over the workspace history before saying "not available".
  const from = workspaceHistoryFrom(now);
  const history = useApiQuery({
    path: '/me/assignments',
    request: { query: { from } },
    enabled: recent.data !== undefined && found === undefined,
  });
  const assignments = recent.data === undefined || found !== undefined ? recent : history;
  const item = found ?? history.data?.items.find((i) => i.assignment.id === assignmentId) ?? null;
  return (
    <section aria-labelledby="workspace-page-title">
      <h2 id="workspace-page-title">{title(item)}</h2>
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      <OfflineQueueStatus reviewPath="/workspace/offline" />
      <p>
        {item ? (
          <Link to={`/workspace/assignments/${item.assignment.id}`}>Back to the assignment</Link>
        ) : (
          <Link to="/workspace">My assignments</Link>
        )}
      </p>
      <QueryBoundary
        query={assignments}
        label="your assignment"
        empty={{ title: '', description: '' }}
        unavailableOffline={unavailableOffline}
      >
        {() =>
          item ? (
            children(item)
          ) : (
            <StateView
              variant="unavailable"
              description={`This assignment is not available. It is not among your assignments since ${formatHistoryStart(from)}: it may be older, it may have been withdrawn, or your access to it has ended.`}
            />
          )
        }
      </QueryBoundary>
    </section>
  );
}
