/**
 * Staff dashboard routes (SPK-UX-005): Today is the operating home, the fourteen areas, the coach
 * and referee workspace (SPK-UX-007), sign-in, and a not-available page for unknown paths.
 */
import { Navigate, Route, Routes } from 'react-router';
import { Shell } from './layout/Shell';
import { STAFF_AREAS, WORKSPACE_PATH } from './navigation/areas';
import { AreaScreen } from './screens/area/AreaScreen';
import { FacilitiesArea } from './screens/facilities/FacilitiesArea';
import { NotFoundScreen } from './screens/not-found/NotFoundScreen';
import { ScheduleArea } from './screens/schedule/ScheduleArea';
import { SignInScreen } from './screens/sign-in/SignInScreen';
import { TodayScreen } from './screens/today/TodayScreen';
import { WorkspaceScreen } from './screens/workspace/WorkspaceScreen';
import { RequireSession } from './session/RequireSession';

/** Areas with their own routes; the others show their placeholder until built. */
const BUILT_AREAS: ReadonlySet<string> = new Set(['today', 'schedule', 'facilities']);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInScreen />} />
      <Route
        element={
          <RequireSession>
            <Shell />
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayScreen />} />
        <Route path="/schedule/*" element={<ScheduleArea />} />
        <Route path="/facilities/*" element={<FacilitiesArea />} />
        {STAFF_AREAS.filter((a) => !BUILT_AREAS.has(a.id)).map((area) => (
          <Route key={area.id} path={area.path} element={<AreaScreen area={area} />} />
        ))}
        <Route path={WORKSPACE_PATH} element={<WorkspaceScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}
