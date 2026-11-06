/**
 * "Teams and placement" area home (SPK-UX-005): choose a competition and season to open its team
 * entries (SCR-S-16), rosters (SCR-S-17) and placement board (SCR-S-18), or open youth group
 * placement (SCR-S-19). Lists are what the API returns for this viewer; an area the account may
 * not use shows "not available". Each season card shows where today falls between the season's
 * own first and last day; nothing else is inferred.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { SelectField } from '../../features/competition/fields';
import { formatDateOnly } from '../../features/competition/format';
import { SEASON_STATUS } from '../../features/competition/labels';
import { TeamsNav } from '../../features/competition/nav';
import { CompeteHeader, localDay, seasonProgress } from '../../features/competition/page';
import { useNow } from '../../providers/AppProviders';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

export function TeamsScreen() {
  const [competitionId, setCompetitionId] = useState('');
  const now = useNow(60_000);
  const competitions = useApiQuery({ path: '/competitions' });
  const seasons = useApiQuery({
    path: '/seasons',
    request: { query: { competitionId } },
    enabled: !!competitionId,
  });
  const today = localDay(now);
  return (
    <section aria-labelledby="teams-title" className="compete">
      <CompeteHeader
        eyebrow="Compete"
        title="Teams and placement"
        titleId="teams-title"
        intro="Review team entries and rosters, and place individual players on teams. Choose a competition, then open a season."
      />
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
          <div className="toolbar">
            <SelectField
              label="Competition"
              value={competitionId}
              onChange={setCompetitionId}
              options={data.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
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
            <ul className="comp-grid" aria-label="Seasons">
              {data.map((season) => {
                const badge = SEASON_STATUS[season.status];
                const progress = seasonProgress(season, today);
                return (
                  <li key={season.id} className="comp-card">
                    <span className="comp-kind">
                      <Icon name="calendar_month" size={16} />
                      {formatDateOnly(season.startsOn)} to {formatDateOnly(season.endsOn)}
                    </span>
                    <span className="row-title">{season.name}</span>
                    <StatusBadge tone={badge.tone} label={`Season ${badge.label}`} />
                    {progress ? (
                      <>
                        <span className="comp-meta">{progress.label}</span>
                        <span className="season-bar" aria-hidden="true">
                          <span style={{ width: `${progress.pct}%` }} />
                        </span>
                      </>
                    ) : null}
                    <div className="actions-row">
                      <Link
                        className="button button-secondary button-sm"
                        to={`/teams/seasons/${season.id}/entries`}
                      >
                        Team entries of {season.name}
                      </Link>
                      <Link
                        className="button button-primary button-sm"
                        to={`/teams/seasons/${season.id}/placement`}
                      >
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
        <div className="state">
          <StatusBadge tone="neutral" label="Choose a competition" />
          <p className="caption">Choose a competition to list its seasons.</p>
        </div>
      )}
    </section>
  );
}
