/**
 * Routes of the "Leagues and tournaments" (SCR-S-08 to SCR-S-13) and "Teams and placement"
 * (SCR-S-16 to SCR-S-19) areas (SPK-UX-005), registered once in App.tsx. Route parameters are
 * opaque record ids only, never names or personal data (§4.14).
 */
import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { CompetitionScreen } from '../../screens/leagues/CompetitionScreen';
import { DisciplineScreen } from '../../screens/leagues/DisciplineScreen';
import { FixtureDisputesScreen } from '../../screens/leagues/FixtureDisputesScreen';
import { FixtureGenerationScreen } from '../../screens/leagues/FixtureGenerationScreen';
import { FixtureScreen } from '../../screens/leagues/FixtureScreen';
import { FixturesScreen } from '../../screens/leagues/FixturesScreen';
import {
  FixtureSpecificationScreen,
  SolverRunScreen,
} from '../../screens/leagues/FixtureSpecificationScreen';
import { IncidentScreen } from '../../screens/leagues/IncidentScreen';
import { LeaguesScreen } from '../../screens/leagues/LeaguesScreen';
import { ResultsReviewQueueScreen } from '../../screens/leagues/ResultsReviewQueueScreen';
import { ResultsReviewScreen } from '../../screens/leagues/ResultsReviewScreen';
import { RuleSetsScreen } from '../../screens/leagues/RuleSetsScreen';
import { SeasonScreen } from '../../screens/leagues/SeasonScreen';
import { StandingsScreen } from '../../screens/leagues/StandingsScreen';
import { PlacementBoardScreen } from '../../screens/teams/PlacementBoardScreen';
import { RosterScreen } from '../../screens/teams/RosterScreen';
import { TeamEntryReviewScreen } from '../../screens/teams/TeamEntryReviewScreen';
import { TeamsScreen } from '../../screens/teams/TeamsScreen';
import { YouthGroupsScreen } from '../../screens/teams/YouthGroupsScreen';
import './competition.css';

const ROUTES: readonly [path: string, element: ReactElement][] = [
  ['/leagues', <LeaguesScreen />],
  ['/leagues/rule-sets', <RuleSetsScreen />],
  ['/leagues/results-review', <ResultsReviewQueueScreen />],
  ['/leagues/discipline', <DisciplineScreen />],
  ['/leagues/discipline/incidents/:incidentId', <IncidentScreen />],
  ['/leagues/competitions/:competitionId', <CompetitionScreen />],
  ['/leagues/seasons/:seasonId', <SeasonScreen />],
  ['/leagues/seasons/:seasonId/fixtures', <FixturesScreen />],
  ['/leagues/seasons/:seasonId/standings', <StandingsScreen />],
  ['/leagues/divisions/:divisionId/fixture-generation', <FixtureGenerationScreen />],
  ['/leagues/fixture-specifications/:specificationId', <FixtureSpecificationScreen />],
  ['/leagues/solver-runs/:runId', <SolverRunScreen />],
  ['/leagues/fixtures/:fixtureId', <FixtureScreen />],
  ['/leagues/fixtures/:fixtureId/results', <ResultsReviewScreen />],
  ['/leagues/fixtures/:fixtureId/disputes', <FixtureDisputesScreen />],
  ['/teams', <TeamsScreen />],
  ['/teams/seasons/:seasonId/entries', <TeamEntryReviewScreen />],
  ['/teams/seasons/:seasonId/placement', <PlacementBoardScreen />],
  ['/teams/entries/:entryId/roster', <RosterScreen />],
  ['/teams/youth-groups', <YouthGroupsScreen />],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function competitionRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </>
  );
}
