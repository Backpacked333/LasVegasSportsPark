/**
 * A public competition and the pages of one of its seasons, without sign-in (SPK-SCHED-010,
 * proposed amendment PA-06): fixtures, results, standings and, in a tournament, the bracket.
 *
 * - `/public/:organization/competitions/:code`: the competition and links to its seasons.
 * - `/public/:organization/seasons/:code/:view`: `fixtures`, `results`, `standings` or `bracket`.
 *
 * Team names, scores, times and field names only: the API's public shapes have nothing else.
 */
import type { Schema } from '@sportspark/api-client';
import { Link, NavLink, useParams } from 'react-router';
import { formatPublicDayTime, PublicFrame } from './PublicFrame';
import { usePublicView } from './usePublicView';

export type SeasonView = Schema<'PublicSeasonView'>;
type Fixture = Schema<'PublicFixture'>;
type Division = Schema<'PublicDivision'>;
type BracketMatch = Schema<'PublicBracketMatch'>;

export const SEASON_VIEWS = ['fixtures', 'results', 'standings', 'bracket'] as const;
export type SeasonViewName = (typeof SEASON_VIEWS)[number];

const VIEW_TITLE: Record<SeasonViewName, string> = {
  fixtures: 'Fixtures',
  results: 'Results',
  standings: 'Standings',
  bracket: 'Bracket',
};

const STATUS_WORDS: Record<Fixture['status'], string> = {
  unscheduled: 'Time to be announced',
  scheduled: 'Scheduled',
  played: 'Played',
  forfeit: 'Forfeit',
  canceled: 'Canceled',
  abandoned: 'Abandoned',
  postponed: 'Postponed',
};

/** A game with an official score is a result; every other game is a fixture still to come. */
export function isResult(fixture: Fixture): boolean {
  return fixture.score !== null || fixture.status === 'played' || fixture.status === 'forfeit';
}

function FixtureList({ fixtures, results }: { fixtures: readonly Fixture[]; results: boolean }) {
  const shown = fixtures.filter((fixture) => isResult(fixture) === results);
  if (shown.length === 0) {
    return (
      <p className="public-empty">{results ? 'No results yet.' : 'No games are scheduled.'}</p>
    );
  }
  return (
    <table className="public-table">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Game</th>
          <th scope="col">{results ? 'Score' : 'Field'}</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((fixture, index) => (
          <tr key={`${fixture.home}-${fixture.away ?? 'bye'}-${fixture.round ?? 0}-${index}`}>
            <td className="public-time">
              {fixture.startsAt
                ? formatPublicDayTime(fixture.startsAt, fixture.timezone)
                : STATUS_WORDS.unscheduled}
            </td>
            <td>
              {fixture.away ? `${fixture.home} vs ${fixture.away}` : `${fixture.home} (bye)`}
              {fixture.status !== 'scheduled' && fixture.status !== 'played' ? (
                <span className="public-note"> {STATUS_WORDS[fixture.status]}</span>
              ) : null}
            </td>
            <td>
              {results ? (
                fixture.score ? (
                  <span className="public-score">
                    {fixture.score.home} : {fixture.score.away}
                  </span>
                ) : (
                  STATUS_WORDS[fixture.status]
                )
              ) : fixture.fields.length > 0 ? (
                fixture.fields.join(', ')
              ) : (
                'To be announced'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StandingsTable({ division }: { division: Division }) {
  if (division.standings.length === 0) {
    return <p className="public-empty">No teams in the table yet.</p>;
  }
  return (
    <table className="public-table public-standings">
      <caption className="public-sr">Standings of {division.name}</caption>
      <thead>
        <tr>
          <th scope="col">Position</th>
          <th scope="col">Team</th>
          <th scope="col">Played</th>
          <th scope="col">Won</th>
          <th scope="col">Drawn</th>
          <th scope="col">Lost</th>
          <th scope="col">Goals</th>
          <th scope="col">Points</th>
        </tr>
      </thead>
      <tbody>
        {division.standings.map((row) => (
          <tr key={row.team}>
            <td>{row.position}</td>
            <th scope="row">{row.team}</th>
            <td>{row.played}</td>
            <td>{row.won}</td>
            <td>{row.drawn}</td>
            <td>{row.lost}</td>
            <td>
              {row.goalsFor} : {row.goalsAgainst}
            </td>
            <td className="public-points">{row.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Bracket({ matches }: { matches: readonly BracketMatch[] | null }) {
  if (!matches || matches.length === 0) {
    return <p className="public-empty">The bracket has not been published yet.</p>;
  }
  const rounds = [...new Set(matches.map((match) => match.round))].sort((a, b) => a - b);
  return (
    <div className="public-bracket">
      {rounds.map((round) => (
        <section key={round} aria-label={`Round ${round}`}>
          <h3>Round {round}</h3>
          <ul>
            {matches
              .filter((match) => match.round === round)
              .map((match) => (
                <li key={`${round}-${match.slot}`} className="public-match">
                  <span data-winner={match.winner === 'home' ? 'true' : 'false'}>
                    {match.home ?? 'To be decided'}
                    {match.score ? <strong> {match.score.home}</strong> : null}
                  </span>
                  <span data-winner={match.winner === 'away' ? 'true' : 'false'}>
                    {match.away ?? 'To be decided'}
                    {match.score ? <strong> {match.score.away}</strong> : null}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function SeasonContent({ data, view }: { data: SeasonView; view: SeasonViewName }) {
  if (view === 'bracket') return <Bracket matches={data.bracket} />;
  const groups = [
    ...data.divisions,
    ...(data.otherFixtures.length > 0 && view !== 'standings'
      ? [{ name: 'Other games', fixtures: data.otherFixtures, standings: [] }]
      : []),
  ];
  if (groups.length === 0) return <p className="public-empty">Nothing to show yet.</p>;
  return (
    <>
      {groups.map((division) => (
        <section key={division.name} className="public-section" aria-label={division.name}>
          <h2>{division.name}</h2>
          {view === 'standings' ? (
            <StandingsTable division={division} />
          ) : (
            <FixtureList fixtures={division.fixtures} results={view === 'results'} />
          )}
        </section>
      ))}
    </>
  );
}

export function PublicSeasonScreen() {
  const { organization = '', code = '', view: asked = 'fixtures' } = useParams();
  const view: SeasonViewName = (SEASON_VIEWS as readonly string[]).includes(asked)
    ? (asked as SeasonViewName)
    : 'fixtures';
  const state = usePublicView(
    { path: '/public/{organization}/seasons/{code}', request: { path: { organization, code } } },
    `season:${organization}:${code}`,
  );
  const base = `/public/${organization}/seasons/${code}`;
  return (
    <PublicFrame
      view={state}
      organizationName={(data) => data.organizationName}
      title={(data) => `${data.competitionName}: ${VIEW_TITLE[view].toLowerCase()}`}
      subtitle={(data) => data.seasonName}
      nav={
        <nav className="public-nav" aria-label="Season pages">
          {SEASON_VIEWS.filter(
            (name) => name !== 'bracket' || state.data?.competitionKind === 'tournament',
          ).map((name) => (
            <NavLink key={name} to={`${base}/${name}`}>
              {VIEW_TITLE[name]}
            </NavLink>
          ))}
        </nav>
      }
    >
      {(data) => <SeasonContent data={data} view={view} />}
    </PublicFrame>
  );
}

export function PublicCompetitionScreen() {
  const { organization = '', code = '' } = useParams();
  const state = usePublicView(
    {
      path: '/public/{organization}/competitions/{code}',
      request: { path: { organization, code } },
    },
    `competition:${organization}:${code}`,
  );
  return (
    <PublicFrame
      view={state}
      organizationName={(data) => data.organizationName}
      title={(data) => data.name}
    >
      {(data) =>
        data.seasons.length === 0 ? (
          <p className="public-empty">No season is open yet.</p>
        ) : (
          <ul className="public-links" aria-label="Seasons">
            {data.seasons.map((season) => (
              <li key={season.code}>
                <span className="public-link-title">{season.name}</span>
                <Link to={`/public/${organization}/seasons/${season.code}/fixtures`}>
                  Fixtures of {season.name}
                </Link>
                <Link to={`/public/${organization}/seasons/${season.code}/results`}>
                  Results of {season.name}
                </Link>
                <Link to={`/public/${organization}/seasons/${season.code}/standings`}>
                  Standings of {season.name}
                </Link>
                {data.kind === 'tournament' ? (
                  <Link to={`/public/${organization}/seasons/${season.code}/bracket`}>
                    Bracket of {season.name}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )
      }
    </PublicFrame>
  );
}
