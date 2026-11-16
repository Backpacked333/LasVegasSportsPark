/**
 * Routes that need no sign-in (SPK-SCHED-010, proposed amendment PA-06), registered in App.tsx
 * OUTSIDE the session guard: the lobby display and the public pages. Their parameters are an
 * organization's public slug and random public codes, never record ids.
 */
import type { ReactElement } from 'react';
import { Navigate, Route } from 'react-router';
import { LobbyScreen } from './LobbyScreen';
import { PublicScheduleScreen } from './PublicScheduleScreen';
import { PublicCompetitionScreen, PublicSeasonScreen } from './PublicSeasonScreen';

export function publicRoutes(): ReactElement {
  return (
    <>
      <Route path="/lobby/:organization/:code" element={<LobbyScreen />} />
      <Route path="/public/:organization/schedule/:code" element={<PublicScheduleScreen />} />
      <Route
        path="/public/:organization/competitions/:code"
        element={<PublicCompetitionScreen />}
      />
      <Route
        path="/public/:organization/seasons/:code"
        element={<Navigate to="fixtures" replace />}
      />
      <Route path="/public/:organization/seasons/:code/:view" element={<PublicSeasonScreen />} />
    </>
  );
}
