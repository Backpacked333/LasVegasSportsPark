/**
 * Sub-navigation of the "Leagues and tournaments" (SCR-S-08 to SCR-S-13) and "Teams and
 * placement" (SCR-S-16 to SCR-S-19) areas (SPK-UX-005), plus the season-scoped links shared by
 * both. Links carry only opaque ids, never personal data (§4.14).
 */
import { NavLink } from 'react-router';

export function LeaguesNav() {
  return (
    <nav aria-label="Leagues and tournaments screens" className="subnav">
      <ul>
        <li>
          <NavLink to="/leagues" end>
            Competitions
          </NavLink>
        </li>
        <li>
          <NavLink to="/leagues/rule-sets">Rule sets</NavLink>
        </li>
        <li>
          <NavLink to="/leagues/results-review">Result review tasks</NavLink>
        </li>
        <li>
          <NavLink to="/leagues/disputes">Disputes</NavLink>
        </li>
        <li>
          <NavLink to="/leagues/discipline">Discipline</NavLink>
        </li>
      </ul>
    </nav>
  );
}

export function TeamsNav() {
  return (
    <nav aria-label="Teams and placement screens" className="subnav">
      <ul>
        <li>
          <NavLink to="/teams" end>
            Seasons
          </NavLink>
        </li>
        <li>
          <NavLink to="/teams/youth-groups">Youth group placement</NavLink>
        </li>
      </ul>
    </nav>
  );
}

/** Links from a season to its screens in both areas. */
export function SeasonLinks({ seasonId }: { seasonId: string }) {
  return (
    <nav aria-label="Season screens" className="subnav">
      <ul>
        <li>
          <NavLink to={`/leagues/seasons/${seasonId}`} end>
            Season and divisions
          </NavLink>
        </li>
        <li>
          <NavLink to={`/leagues/seasons/${seasonId}/fixtures`}>Fixtures and readiness</NavLink>
        </li>
        <li>
          <NavLink to={`/leagues/seasons/${seasonId}/results`}>Result revisions</NavLink>
        </li>
        <li>
          <NavLink to={`/leagues/seasons/${seasonId}/standings`}>Standings and brackets</NavLink>
        </li>
        <li>
          <NavLink to={`/teams/seasons/${seasonId}/entries`}>Team entries</NavLink>
        </li>
        <li>
          <NavLink to={`/teams/seasons/${seasonId}/placement`}>Placement board</NavLink>
        </li>
      </ul>
    </nav>
  );
}
