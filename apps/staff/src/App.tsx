/**
 * Staff dashboard routes (SPK-UX-005): Today is the operating home, the fourteen areas, the coach
 * and referee workspace (SPK-UX-007), sign-in, and a not-available page for unknown paths.
 */
import { Navigate, Route, Routes } from 'react-router';
import { Shell } from './layout/Shell';
import { STAFF_AREAS, WORKSPACE_PATH } from './navigation/areas';
import { AreaScreen } from './screens/area/AreaScreen';
import { NotFoundScreen } from './screens/not-found/NotFoundScreen';
import { SignInScreen } from './screens/sign-in/SignInScreen';
import { TodayScreen } from './screens/today/TodayScreen';
import { WorkspaceScreen } from './screens/workspace/WorkspaceScreen';
import { RequireSession } from './session/RequireSession';
import { registrationFinanceRoutes } from './features/registration-finance/routes';

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
        {/* Before the area placeholders: the first of equal routes wins. */}
        {registrationFinanceRoutes()}
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayScreen />} />
        {STAFF_AREAS.filter((a) => a.id !== 'today').map((area) => (
          <Route key={area.id} path={area.path} element={<AreaScreen area={area} />} />
        ))}
        <Route path={WORKSPACE_PATH} element={<WorkspaceScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}
