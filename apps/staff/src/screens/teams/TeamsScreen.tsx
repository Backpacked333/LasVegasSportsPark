/**
 * "Teams and placement" area home (SPK-UX-005): choose a competition and season to open its team
 * entries (SCR-S-16), rosters (SCR-S-17) and placement board (SCR-S-18), or open youth group
 * placement (SCR-S-19). Lists are what the API returns for this viewer; an area the account may
 * not use shows "not available".
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { SelectField } from '../../features/competition/fields';
import { formatDateOnly } from '../../features/competition/format';
import { SEASON_STATUS } from '../../features/competition/labels';
import { TeamsNav } from '../../features/competition/nav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

export function TeamsScreen() {
  const [competitionId, setCompetitionId] = useState('');
  const competitions = useApiQuery({ path: '/competitions' });
  const seasons = useApiQuery({
    path: '/seasons',
    request: { query: { competitionId } },
    enabled: !!competitionId,
  });
  return (
    <section aria-labelledby="teams-title">
      <h2 id="teams-title">Teams and placement</h2>
      <TeamsNav />
      <QueryBoundary
        query={competitions}
        label="competitions"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No competitions',
          description:
            'Team entries belong to a season of a competition. Create one under Leagues.',
        }}
      >
        {(data) => (
          <SelectField
            label="Competition"
            value={competitionId}
            onChange={setCompetitionId}
            options={data.map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
      </QueryBoundary>
      {competitionId ? (
        <QueryBoundary
          query={seasons}
          label="seasons"
          isEmpty={(data) => data.length === 0}
          empty={{ title: 'No seasons', description: 'This competition has no seasons yet.' }}
        >
          {(data) => (
            <ul className="list" aria-label="Seasons">
              {data.map((season) => {
                const badge = SEASON_STATUS[season.status];
                return (
                  <li key={season.id}>
                    <div className="row-text">
                      <span className="row-title">{season.name}</span>
                      <span className="caption">
                        {formatDateOnly(season.startsOn)} to {formatDateOnly(season.endsOn)}
                      </span>
                      <StatusBadge tone={badge.tone} label={`Season ${badge.label}`} />
                    </div>
                    <div className="actions">
                      <Link to={`/teams/seasons/${season.id}/entries`}>
                        Team entries of {season.name}
                      </Link>
                      <Link to={`/teams/seasons/${season.id}/placement`}>
                        Placement board of {season.name}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      ) : (
        <p className="caption">Choose a competition to list its seasons.</p>
      )}
    </section>
  );
}
