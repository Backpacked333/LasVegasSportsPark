/**
 * SCR-S-10 Fixtures and match readiness, part 1: the fixtures of a season with their machine
 * state and derived readiness (SPK-READY-001, SPK-READY-002, SPK-READY-004, SPK-STAFF-002,
 * SPK-UX-008). The fixture state (`unscheduled`, `scheduled`, …) and readiness are shown apart: a
 * scheduled fixture may still be blocked. Readiness for the page comes from one season summary
 * read (`GET /v1/seasons/{id}/readiness`, CMP-01), never one read per row; until it answers, or
 * when it cannot, a row says unknown, never ready. Team names come with each fixture (CMP-01);
 * start times are in the division facility's time zone when known (SPK-SCHED-008). Pages follow
 * the API's cursor (§4.5).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { useDivisionZones } from '../../features/competition/facilities';
import { SelectField } from '../../features/competition/fields';
import { formatInstant } from '../../features/competition/format';
import { FIXTURE_STATUS } from '../../features/competition/labels';
import { LeaguesNav, SeasonLinks } from '../../features/competition/nav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { SeasonReadinessStatus, SummaryReadinessBadge, useSeasonReadiness } from './Readiness';

type FixtureStatus = Schema<'FixtureStatus'>;

const PAGE_SIZE = 25;
const STATUS_OPTIONS = Object.entries(FIXTURE_STATUS).map(([value, badge]) => ({
  value,
  label: badge.label,
}));

export function FixturesScreen() {
  const { seasonId = '' } = useParams();
  const [divisionId, setDivisionId] = useState('');
  const [status, setStatus] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];
  const divisions = useApiQuery({ path: '/divisions', request: { query: { seasonId } } });
  const zoneOf = useDivisionZones(divisions.data);
  const fixtures = useApiQuery({
    path: '/seasons/{id}/fixtures',
    request: {
      path: { id: seasonId },
      query: {
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        ...(divisionId ? { divisionId } : {}),
        ...(status ? { status: status as FixtureStatus } : {}),
      },
    },
  });
  const matches = fixtures.data?.items.filter((f) => f.awayEntryId !== null);
  const readiness = useSeasonReadiness(seasonId, matches);
  const divisionName = new Map((divisions.data ?? []).map((d) => [d.id, d.name]));

  return (
    <section aria-labelledby="fixtures-title">
      <h2 id="fixtures-title">Fixtures and readiness</h2>
      <LeaguesNav />
      <SeasonLinks seasonId={seasonId} />
      <div className="actions">
        <SelectField
          label="Division"
          value={divisionId}
          onChange={(v) => {
            setDivisionId(v);
            setCursors([]);
          }}
          options={(divisions.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          placeholder="All divisions"
        />
        <SelectField
          label="Fixture state"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setCursors([]);
          }}
          options={STATUS_OPTIONS}
          placeholder="All states"
        />
      </div>
      <QueryBoundary
        query={fixtures}
        label="fixtures"
        isEmpty={(data) => data.items.length === 0 && cursors.length === 0}
        empty={{
          title: 'No fixtures',
          description:
            'Fixtures of this season appear here once created or generated from a division’s fixture specification.',
        }}
        unavailableOffline={['re-evaluating readiness']}
      >
        {(data) => (
          <>
            <SeasonReadinessStatus readiness={readiness} />
            <div className="table-scroll">
              <table className="data-table">
                <caption>Fixtures</caption>
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col">Match</th>
                    <th scope="col">Start</th>
                    <th scope="col">Fixture state</th>
                    <th scope="col">Readiness</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((fixture) => {
                    const state = FIXTURE_STATUS[fixture.status];
                    return (
                      <tr key={fixture.id}>
                        <td>{fixture.round ?? 'None'}</td>
                        <td>
                          <Link to={`/leagues/fixtures/${fixture.id}`}>
                            {fixture.homeTeamName} v {fixture.awayTeamName ?? 'bye'}
                          </Link>
                          {fixture.divisionId ? (
                            <span className="caption">
                              {' '}
                              · {divisionName.get(fixture.divisionId) ?? 'Division'}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          {fixture.scheduledStart
                            ? formatInstant(fixture.scheduledStart, zoneOf(fixture.divisionId))
                            : 'No time yet'}
                        </td>
                        <td>
                          <StatusBadge tone={state.tone} label={state.label} />
                        </td>
                        <td>
                          {fixture.awayEntryId ? (
                            <SummaryReadinessBadge
                              fixtureId={fixture.id}
                              scheduled={fixture.scheduledStart !== null}
                              readiness={readiness}
                            />
                          ) : (
                            <span className="caption">Bye: no match to prepare</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="actions">
              {cursors.length > 0 ? (
                <Button variant="secondary" onClick={() => setCursors((list) => list.slice(0, -1))}>
                  Previous page
                </Button>
              ) : null}
              {data.nextCursor ? (
                <Button
                  variant="secondary"
                  onClick={() => setCursors((list) => [...list, data.nextCursor as string])}
                >
                  Next page
                </Button>
              ) : null}
            </div>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
