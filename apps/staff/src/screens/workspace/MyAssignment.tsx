/**
 * One of the viewer's own assignments, for the workspace screens SCR-W-02 to SCR-W-09
 * (SPK-UX-007). Read from `GET /v1/me/assignments`, which returns only the viewer's assigned
 * activities and the participant information they may see; an id that is not among them is shown
 * as not available, never as "exists but denied" (§4.10).
 */
import type { Schema } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

export type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;

export const MY_ASSIGNMENTS_KEY = ['api', '/me/assignments'] as const;

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
  const assignments = useApiQuery({ path: '/me/assignments' });
  const item = assignments.data?.items.find((i) => i.assignment.id === assignmentId) ?? null;
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
              description="This assignment is not available. It may have been withdrawn, or your access to it has ended."
            />
          )
        }
      </QueryBoundary>
    </section>
  );
}
