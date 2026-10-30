/**
 * SCR-S-10 Fixtures and match readiness, part 2: one fixture with its full readiness explanation
 * (SPK-READY-001 to SPK-READY-004, SPK-CAP-003, SPK-UX-008) and its field-limited match sheet
 * (`GET /v1/fixtures/{id}/match-sheet`, CMP-06; SPK-UX-007, SPK-STAFF-002, §4.14): names, jersey
 * numbers, playing status and team roles from the effective roster at kickoff, never a date of
 * birth, contact, eligibility reason or suspension detail. RSVP counts are shown per side and
 * labelled as RSVP: they are neither attendance nor eligibility, and a missing RSVP is never a
 * block. Times are in the venue's time zone when the fixture has one (SPK-SCHED-008). Results
 * (SCR-S-11) and disputes (SCR-S-12) of the fixture are linked.
 */
import type { Schema } from '@sportspark/api-client';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/competition/format';
import { FIXTURE_STATUS, ROSTER_STATUS, humanizeCode } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { ReadinessPanel } from './Readiness';

type FixtureSide = Schema<'FixtureSide'>;
type MatchSheet = Schema<'MatchSheet'>;

function Rsvp({ side }: { side: FixtureSide }) {
  const a = side.availability;
  return (
    <li>
      <span className="row-title">{side.teamName}</span>{' '}
      <span className="caption">
        RSVP: {a.available} available, {a.tentative} tentative, {a.unavailable} unavailable,{' '}
        {a.noResponse} no response
      </span>
    </li>
  );
}

export function fixtureTitle(fixture: Schema<'FixtureDetail'>): string {
  return `${fixture.home.teamName} v ${fixture.away ? fixture.away.teamName : 'bye'}`;
}

function MatchSheetSide({ side, view }: { side: MatchSheet['sides'][number]; view: string }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption>{`Match sheet: ${side.teamName}`}</caption>
        <thead>
          <tr>
            <th scope="col">Number</th>
            <th scope="col">Player</th>
            {view === 'full' ? <th scope="col">Playing status</th> : null}
            {view === 'full' ? <th scope="col">Team role</th> : null}
          </tr>
        </thead>
        <tbody>
          {side.players.map((player, index) => {
            const status = player.playingStatus ? ROSTER_STATUS[player.playingStatus] : null;
            return (
              <tr key={player.personId ?? `${side.entryId}-${index}`}>
                <td>{player.jerseyNumber ?? 'None'}</td>
                <th scope="row">{player.displayName}</th>
                {view === 'full' ? (
                  <td>
                    {status ? (
                      <StatusBadge tone={status.tone} label={status.label} />
                    ) : (
                      'Not stated'
                    )}
                  </td>
                ) : null}
                {view === 'full' ? (
                  <td>
                    {player.roles.length > 0 ? player.roles.map(humanizeCode).join(', ') : 'Player'}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** CMP-06: the effective rosters at kickoff, field-limited (SPK-UX-007, §4.14). */
function MatchSheetPanel({ fixtureId }: { fixtureId: string }) {
  const sheet = useApiQuery({
    path: '/fixtures/{id}/match-sheet',
    request: { path: { id: fixtureId } },
  });
  return (
    <section className="panel" aria-labelledby="match-sheet-title">
      <h3 id="match-sheet-title">Match sheet</h3>
      <p className="caption">
        The effective rosters at kickoff: names, numbers, playing status and team roles only. Dates
        of birth, contacts, eligibility reasons and suspension details are never on the sheet.
      </p>
      <QueryBoundary
        query={sheet}
        label="the match sheet"
        isEmpty={(data) => data.sides.every((side) => side.players.length === 0)}
        empty={{
          title: 'No players on the match sheet',
          description: 'Neither roster has a player effective at kickoff.',
        }}
      >
        {(data) => (
          <>
            {data.view === 'captain' ? (
              <p className="caption">Captain view: names and numbers only.</p>
            ) : null}
            {data.sides.map((side) => (
              <MatchSheetSide key={side.entryId} side={side} view={data.view} />
            ))}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

export function FixtureScreen() {
  const { fixtureId = '' } = useParams();
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  return (
    <section aria-labelledby="fixture-title">
      <h2 id="fixture-title">{fixture.data ? fixtureTitle(fixture.data) : 'Fixture'}</h2>
      <LeaguesNav />
      <QueryBoundary
        query={fixture}
        label="the fixture"
        empty={{ title: '', description: '' }}
        unavailableOffline={['re-evaluating readiness']}
      >
        {(data) => {
          const state = FIXTURE_STATUS[data.status];
          const zone = data.venue?.timezone ?? null;
          return (
            <>
              <dl className="facets" aria-label="Fixture">
                <div>
                  <dt>Fixture state</dt>
                  <dd>
                    <StatusBadge tone={state.tone} label={state.label} />
                  </dd>
                </div>
                <div>
                  <dt>Start</dt>
                  <dd>
                    {data.scheduledStart ? formatInstant(data.scheduledStart, zone) : 'No time yet'}
                  </dd>
                </div>
                <div>
                  <dt>Venue</dt>
                  <dd>
                    {data.venue
                      ? `${data.venue.facilityName}${
                          data.venue.resources.length > 0
                            ? `, ${data.venue.resources.map((r) => r.name).join(', ')}`
                            : ''
                        }`
                      : 'Not set'}
                  </dd>
                </div>
                <div>
                  <dt>Round</dt>
                  <dd>{data.round ?? 'None'}</dd>
                </div>
              </dl>
              <nav aria-label="Fixture screens" className="subnav">
                <ul>
                  <li>
                    <Link to={`/leagues/fixtures/${data.id}/results`}>Results and publication</Link>
                  </li>
                  <li>
                    <Link to={`/leagues/fixtures/${data.id}/disputes`}>Disputes</Link>
                  </li>
                  <li>
                    <Link to={`/leagues/seasons/${data.seasonId}/fixtures`}>Season fixtures</Link>
                  </li>
                </ul>
              </nav>
              {data.away ? (
                <ReadinessPanel fixtureId={data.id} timeZone={zone} />
              ) : (
                <p>This fixture is a bye: there is no match to prepare.</p>
              )}
              {data.away ? <MatchSheetPanel fixtureId={data.id} /> : null}
              <section className="panel" aria-labelledby="rsvp-title">
                <h3 id="rsvp-title">Availability (RSVP)</h3>
                <p className="caption">
                  RSVP is neither attendance nor eligibility. A missing RSVP never blocks a match.
                </p>
                <ul>
                  <Rsvp side={data.home} />
                  {data.away ? <Rsvp side={data.away} /> : null}
                </ul>
              </section>
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
