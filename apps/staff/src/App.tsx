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
import { AccessReviewScreen } from './screens/people/AccessReviewScreen';
import { AccessReviewsScreen } from './screens/people/AccessReviewsScreen';
import { DuplicateReviewScreen } from './screens/people/DuplicateReviewScreen';
import { OpenAccessReviewScreen } from './screens/people/OpenAccessReviewScreen';
import { PeopleScreen } from './screens/people/PeopleScreen';
import { PersonRecordScreen } from './screens/people/PersonRecordScreen';
import { RelationshipsScreen } from './screens/people/RelationshipsScreen';
import { ScheduleArea } from './screens/schedule/ScheduleArea';
import { SignInScreen } from './screens/sign-in/SignInScreen';
import { OpenCaseScreen } from './screens/support/OpenCaseScreen';
import { SupportCaseScreen } from './screens/support/SupportCaseScreen';
import { SupportCasesScreen } from './screens/support/SupportCasesScreen';
import { ExceptionDetailScreen } from './screens/today/ExceptionDetailScreen';
import { TodayScreen } from './screens/today/TodayScreen';
import { WorkspaceScreen } from './screens/workspace/WorkspaceScreen';
import { RequireSession } from './session/RequireSession';

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
        <Route path="/today/exceptions/:exceptionId" element={<ExceptionDetailScreen />} />
        <Route path="/people" element={<PeopleScreen />} />
        <Route path="/people/access-reviews" element={<AccessReviewsScreen />} />
        <Route path="/people/access-reviews/new" element={<OpenAccessReviewScreen />} />
        <Route path="/people/access-reviews/:reviewId" element={<AccessReviewScreen />} />
        <Route path="/people/duplicates" element={<DuplicateReviewScreen />} />
        <Route path="/people/:personId" element={<PersonRecordScreen />} />
        <Route path="/people/:personId/relationships" element={<RelationshipsScreen />} />
        <Route path="/admin/cases" element={<SupportCasesScreen />} />
        <Route path="/admin/cases/new" element={<OpenCaseScreen />} />
        <Route path="/admin/cases/:caseId" element={<SupportCaseScreen />} />
        <Route path="/schedule/*" element={<ScheduleArea />} />
        <Route path="/facilities/*" element={<FacilitiesArea />} />
        {STAFF_AREAS.filter((a) => !a.ownRoutes).map((area) => (
          <Route key={area.id} path={area.path} element={<AreaScreen area={area} />} />
        ))}
        <Route path={WORKSPACE_PATH} element={<WorkspaceScreen />} />
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
    </Routes>
  );
}
