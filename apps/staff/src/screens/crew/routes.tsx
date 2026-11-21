/**
 * Routes of the staff redesign Phase 8 screens ("specified, not yet drawn"), registered once in
 * App.tsx before the area placeholders: the coach's week, teams, lineup, live game day and team
 * messages, the referee's home, the field crew's fields, the workspace "More" list and the
 * maintenance tasks board. Route parameters are opaque record ids only (§4.14).
 */
import { Navigate, Route } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { useApp } from '../../providers/AppProviders';
import { MaintenanceBoardScreen } from '../facilities/MaintenanceBoardScreen';
import { CoachTeamsScreen } from './CoachTeamsScreen';
import { CoachWeekScreen } from './CoachWeekScreen';
import { FieldsScreen } from './FieldsScreen';
import { GameDayScreen } from './GameDayScreen';
import { LineupScreen } from './LineupScreen';
import { RefereeHomeScreen } from './RefereeHomeScreen';
import { TeamMessagesScreen } from './TeamMessagesScreen';
import { WorkspaceMoreScreen } from './WorkspaceMoreScreen';
import { homePathOf } from './workspace-kind';

/**
 * "/" opens the viewer's home: the coach's week, the referee's home or the crew's fields for those
 * roles, Today for everyone who runs the facility (workspace-kind.ts). Until `GET /v1/me` answers,
 * nothing is shown, so nobody sees a flash of the wrong home.
 */
export function HomeRedirect() {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  if (me.data) return <Navigate to={homePathOf(me.data.principal.staffRoles)} replace />;
  if (me.error) return <Navigate to="/today" replace />;
  return null;
}

const ROUTES: readonly [path: string, element: React.ReactElement][] = [
  [`${WORKSPACE_PATH}/week`, <CoachWeekScreen />],
  [`${WORKSPACE_PATH}/teams`, <CoachTeamsScreen />],
  [`${WORKSPACE_PATH}/messages`, <TeamMessagesScreen />],
  [`${WORKSPACE_PATH}/more`, <WorkspaceMoreScreen />],
  [`${WORKSPACE_PATH}/fixtures/:fixtureId/lineup`, <LineupScreen />],
  [`${WORKSPACE_PATH}/fixtures/:fixtureId/game-day`, <GameDayScreen />],
  [`${WORKSPACE_PATH}/referee`, <RefereeHomeScreen />],
  [`${WORKSPACE_PATH}/fields`, <FieldsScreen />],
  ['/facilities/board', <MaintenanceBoardScreen />],
];

export function crewRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </>
  );
}
