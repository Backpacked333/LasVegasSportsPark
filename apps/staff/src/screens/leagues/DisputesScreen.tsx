/**
 * SCR-S-12 Disputes and discipline, disputes across fixtures (`GET /v1/disputes`, CMP-05,
 * SPK-RESULT-005, SPK-UX-008): every dispute of a season (or of the organization), newest first,
 * filtered by status, with the same facts and actions as a fixture's dispute screen: review and
 * decide with `expectedRevision`, a recorded withdrawal, and the submitter's own withdrawal with a
 * reason (CMP-12). Pages follow the API's cursor and nothing is silently cut off ("Load more").
 * Reading needs the dispute read action; an account without it sees "not available". The dispute
 * and appeal procedure is pending DEC-010.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { PendingNote } from '../../features/competition/feedback';
import { SelectField } from '../../features/competition/fields';
import { formatInstant } from '../../features/competition/format';
import { DISPUTE_STATUS } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { PENDING } from '../../features/competition/pending';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { DisputeCard } from './FixtureDisputesScreen';

type Dispute = Schema<'Dispute'>;
type DisputeStatus = Schema<'DisputeStatus'>;

const PAGE_SIZE = 25;
const STATUS_OPTIONS = Object.entries(DISPUTE_STATUS).map(([value, badge]) => ({
  value,
  label: badge.label,
}));

/** The disputed fixture by its teams (one cached read per fixture; disputes are few). */
function DisputeRow({ dispute }: { dispute: Dispute }) {
  const fixture = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: dispute.fixtureId } },
    staleTime: 5 * 60_000,
  });
  const data = fixture.data;
  const entries = useMemo(() => {
    const map = new Map<string, { teamId: string; teamName: string }>();
    if (data) {
      map.set(data.home.entryId, { teamId: data.home.teamId, teamName: data.home.teamName });
      if (data.away) {
        map.set(data.away.entryId, { teamId: data.away.teamId, teamName: data.away.teamName });
      }
    }
    return map;
  }, [data]);
  const label = data ? (
    <Link to={`/leagues/fixtures/${dispute.fixtureId}/disputes`}>
      {`${data.home.teamName} v ${data.away?.teamName ?? 'bye'}`}
      {data.scheduledStart
        ? `, ${formatInstant(data.scheduledStart, data.venue?.timezone ?? null)}`
        : ''}
    </Link>
  ) : fixture.error ? (
    <span>Fixture not available</span>
  ) : (
    <span aria-busy="true">Loading the fixture…</span>
  );
  return <DisputeCard dispute={dispute} entries={entries} fixtureLabel={label} />;
}

export function DisputesScreen() {
  const [seasonId, setSeasonId] = useState('');
  // Every status by default: an open dispute is `submitted` or `under_review`.
  const [status, setStatus] = useState<DisputeStatus | ''>('');
  const seasons = useApiQuery({ path: '/seasons', staleTime: 5 * 60_000 });
  const disputes = useApiPages({
    path: '/disputes',
    request: {
      query: {
        limit: PAGE_SIZE,
        ...(seasonId ? { seasonId } : {}),
        ...(status ? { status } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="all-disputes-title">
      <h2 id="all-disputes-title">Disputes</h2>
      <LeaguesNav />
      <PendingNote decision={PENDING.discipline} />
      <div className="actions">
        <SelectField
          label="Season"
          value={seasonId}
          onChange={setSeasonId}
          options={(seasons.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          placeholder="Every season"
        />
        <SelectField
          label="Dispute status"
          value={status}
          onChange={(v) => setStatus(v as DisputeStatus | '')}
          options={STATUS_OPTIONS}
          placeholder="All statuses"
        />
      </div>
      <QueryBoundary
        query={disputes}
        label="disputes"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No disputes',
          description:
            'Disputes submitted by a competing captain or league administration inside the protest window appear here, newest first.',
        }}
        unavailableOffline={['reviewing, deciding and withdrawing disputes']}
      >
        {(items) => (
          <ul className="list" aria-label="Disputes">
            {items.map((dispute) => (
              <DisputeRow key={dispute.id} dispute={dispute} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={disputes} label="disputes" />
    </section>
  );
}
