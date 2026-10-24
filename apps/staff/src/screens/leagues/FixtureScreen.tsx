/**
 * SCR-S-10 Fixtures and match readiness, part 2: one fixture with its full readiness explanation
 * (SPK-READY-001 to SPK-READY-004, SPK-CAP-003, SPK-UX-008). RSVP counts are shown per side and
 * labelled as RSVP: they are neither attendance nor eligibility, and a missing RSVP is never a
 * block. Results (SCR-S-11) and disputes (SCR-S-12) of the fixture are linked.
 */
import type { Schema } from '@sportspark/api-client';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/competition/format';
import { FIXTURE_STATUS } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { ReadinessPanel } from './Readiness';

type FixtureSide = Schema<'FixtureSide'>;

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
                    {data.scheduledStart ? formatInstant(data.scheduledStart) : 'No time yet'}
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
                <ReadinessPanel fixtureId={data.id} />
              ) : (
                <p>This fixture is a bye: there is no match to prepare.</p>
              )}
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
