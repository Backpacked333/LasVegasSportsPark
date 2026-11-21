/**
 * Coach · Teams (the coach tab bar's second tab, staff redesign Phase 8; SPK-CAP-001). The teams
 * the viewer coaches (holds the captain role of, `GET /v1/me/team-entries`), each with its season,
 * division and next game, and the ways into the lineup and the team's messages. Only what the
 * team read returns is shown.
 */
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { captainedEntries } from './coach-model';
import { lineupPath } from './CoachWeekScreen';
import { clockOf, CrewHero, dayLabelOf } from './crew-ui';
import './crew.css';

export function CoachTeamsScreen() {
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const entries = useApiQuery({ path: '/me/team-entries' });
  return (
    <section aria-labelledby="coach-teams-title" className="crew ops-screen">
      <CrewHero titleId="coach-teams-title" kicker="Coach" title="Teams" />
      <QueryBoundary
        query={entries}
        label="your teams"
        loading={
          <SkeletonGroup label="your teams" className="crew">
            <Skeleton height={140} radius={20} />
            <Skeleton height={140} radius={20} />
          </SkeletonGroup>
        }
        isEmpty={(data) => captainedEntries(data, me.data?.principal.personId ?? null).length === 0}
        empty={{
          title: 'No teams',
          description:
            'Teams you coach appear here once the league names you their captain or coach.',
        }}
      >
        {(data) => (
          <ul className="crew-stack" aria-label="Teams you coach">
            {captainedEntries(data, me.data?.principal.personId ?? null).map((team) => {
              const next = team.nextFixture;
              const zone = next?.venue?.timezone ?? null;
              return (
                <li key={team.teamEntry.id} className="crew-card">
                  <div className="crew-card-head">
                    <h3>{team.teamName}</h3>
                    <Icon name="groups" size={22} />
                  </div>
                  <p className="crew-meta">
                    {team.seasonName}
                    {team.divisionName ? ` · ${team.divisionName}` : ''}
                  </p>
                  {next ? (
                    <p className="crew-meta">
                      Next: vs {next.opponentTeamName ?? 'bye'}
                      {next.scheduledStart
                        ? ` · ${dayLabelOf(next.scheduledStart, zone)} ${clockOf(next.scheduledStart, zone)}`
                        : ''}
                      {next.venue ? ` · ${next.venue.resources.map((r) => r.name).join(', ')}` : ''}
                    </p>
                  ) : (
                    <p className="crew-meta">No game scheduled.</p>
                  )}
                  <div className="crew-actions">
                    {next ? (
                      <Link
                        className="button button-primary"
                        to={lineupPath(next.fixtureId, team.teamEntry.id)}
                      >
                        Lineup
                      </Link>
                    ) : null}
                    <Link className="button button-secondary" to="/workspace/messages">
                      Messages
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
