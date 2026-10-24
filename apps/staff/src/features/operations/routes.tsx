/**
 * Routes of the "Arrival and attendance" (SCR-S-28 to SCR-S-31), "Staff and officials" (SCR-S-32
 * to SCR-S-34) and "Communications" (SCR-S-39, SCR-S-40) areas (SPK-UX-005), and of the coach and
 * referee workspace (SCR-W-01 to SCR-W-10, SPK-UX-007), registered once in App.tsx before the area
 * placeholders. One layout holds the device's offline queue for all of them (§4.15). Route
 * parameters are opaque record ids only, never names or personal data (§4.14).
 */
import type { ReactElement } from 'react';
import { Outlet, Route } from 'react-router';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { ArrivalScannerScreen } from '../../screens/arrival/ArrivalScannerScreen';
import { OfflineQueueScreen } from '../../screens/arrival/OfflineQueueScreen';
import { SessionAttendanceScreen } from '../../screens/arrival/SessionAttendanceScreen';
import { SupervisedReleaseScreen } from '../../screens/arrival/SupervisedReleaseScreen';
import { MessageComposerScreen } from '../../screens/communications/MessageComposerScreen';
import { NotificationScreen } from '../../screens/communications/NotificationScreen';
import { NotificationsScreen } from '../../screens/communications/NotificationsScreen';
import { AssignmentDetailScreen } from '../../screens/staff/AssignmentDetailScreen';
import { AssignmentsScreen } from '../../screens/staff/AssignmentsScreen';
import { AvailabilityQualificationsScreen } from '../../screens/staff/AvailabilityQualificationsScreen';
import { FeeApprovalsScreen } from '../../screens/staff/FeeApprovalsScreen';
import { AssignmentWorkspaceScreen } from '../../screens/workspace/AssignmentWorkspaceScreen';
import { MatchReportScreen } from '../../screens/workspace/MatchReportScreen';
import { MyFeesScreen } from '../../screens/workspace/MyFeesScreen';
import {
  AssessmentsScreen,
  WorkspaceAttendanceScreen,
  WorkspaceMessageScreen,
  WorkspaceReleaseScreen,
} from '../../screens/workspace/WorkspaceActivityScreens';
import { WorkspaceScreen } from '../../screens/workspace/WorkspaceScreen';
import { WORKSPACE_TABS } from './AreaTabs';
import './operations.css';

/** The offline queue provider is mounted once in the shell (layout/Shell.tsx), above all areas. */
function OperationsLayout() {
  return <Outlet />;
}

const ROUTES: readonly [path: string, element: ReactElement][] = [
  ['/arrival', <ArrivalScannerScreen />],
  ['/arrival/attendance', <SessionAttendanceScreen />],
  ['/arrival/release', <SupervisedReleaseScreen />],
  ['/arrival/offline', <OfflineQueueScreen />],
  ['/staff', <AssignmentsScreen />],
  ['/staff/assignments/:assignmentId', <AssignmentDetailScreen />],
  ['/staff/availability', <AvailabilityQualificationsScreen />],
  ['/staff/fees', <FeeApprovalsScreen />],
  ['/communications', <NotificationsScreen />],
  ['/communications/compose', <MessageComposerScreen />],
  ['/communications/notifications/:notificationId', <NotificationScreen />],
  [WORKSPACE_PATH, <WorkspaceScreen />],
  [`${WORKSPACE_PATH}/assignments/:assignmentId`, <AssignmentWorkspaceScreen />],
  [`${WORKSPACE_PATH}/assignments/:assignmentId/attendance`, <WorkspaceAttendanceScreen />],
  [`${WORKSPACE_PATH}/assignments/:assignmentId/report`, <MatchReportScreen />],
  [`${WORKSPACE_PATH}/assignments/:assignmentId/release`, <WorkspaceReleaseScreen />],
  [`${WORKSPACE_PATH}/assignments/:assignmentId/message`, <WorkspaceMessageScreen />],
  [`${WORKSPACE_PATH}/fees`, <MyFeesScreen />],
  [`${WORKSPACE_PATH}/assessments`, <AssessmentsScreen />],
  [
    `${WORKSPACE_PATH}/offline`,
    <OfflineQueueScreen tabs={WORKSPACE_TABS} tabsLabel="Workspace screens" />,
  ],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function operationsRoutes() {
  return (
    <Route element={<OperationsLayout />}>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </Route>
  );
}
