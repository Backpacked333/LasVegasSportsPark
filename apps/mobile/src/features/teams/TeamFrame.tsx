/**
 * Frame shared by the screens of one team entry (SCR-C-22 to SCR-C-29): the screen and session
 * frame, the workspace read (`GET /v1/team-entries/{id}`) with its SPK-UX-008 states, and the
 * signed-in person's view of the team (captain tools or the reduced player view, see queries.ts).
 * A malformed route id or a team the person may not see is "not available" (§4.10).
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { useOpenedTeamEntries } from './opened-teams';
import { useViewerPerson, useWorkspace, viewerOf, type Viewer, type Workspace } from './queries';

export function TeamFrame({
  entryId,
  what,
  unavailableOffline,
  children,
}: {
  entryId: string | null;
  /** What the screen shows, for the loading and sign-in prompts: "this team's roster". */
  what: string;
  unavailableOffline?: string[];
  /** The content; `reload` refetches the workspace (after STALE_REVISION or INVALID_TRANSITION). */
  children: (workspace: Workspace, viewer: Viewer, reload: () => void) => ReactNode;
}) {
  const workspace = useWorkspace(entryId);
  const person = useViewerPerson();
  const now = useNow();
  const { remember } = useOpenedTeamEntries();
  const loaded = workspace.data !== undefined;
  useEffect(() => {
    if (loaded && entryId) remember(entryId);
  }, [loaded, entryId, remember]);
  return (
    <Screen>
      <RequireSession what={what}>
        {entryId === null ? (
          <StateView variant="unavailable" />
        ) : (
          <QueryBoundary
            query={workspace}
            label={what}
            empty={{ title: 'No team', description: 'This team has nothing to show yet.' }}
            unavailableOffline={unavailableOffline}
          >
            {(ws) =>
              person.loading ? (
                <StateView variant="loading" label="your role on this team" />
              ) : (
                children(ws, viewerOf(ws, person.personId, now), () => void workspace.refetch())
              )
            }
          </QueryBoundary>
        )}
      </RequireSession>
    </Screen>
  );
}

/** Shown on a captain screen to someone the API's role records do not name captain. */
export function CaptainOnly({ what }: { what: string }) {
  return (
    <StateView
      variant="unavailable"
      description={`${what} is not available to you for this team. Your captain manages it.`}
    />
  );
}
