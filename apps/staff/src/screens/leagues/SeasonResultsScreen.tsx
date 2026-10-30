/**
 * SCR-S-11 Results review and publication, the season's result revisions
 * (`GET /v1/seasons/{id}/result-revisions`, CMP-05; SPK-RESULT-001 draft → submitted → official →
 * superseded, SPK-RESULT-004 corrections keep the prior result, actor, reason and time;
 * SPK-UX-008). Newest first, filtered by status, paged with the API's cursor ("Load more"; nothing
 * silently cut off). Each revision names its fixture, classification, score, who submitted and
 * published it and when, and what it supersedes; publishing and returning happen on the fixture's
 * results screen (`ResultsReviewScreen`), under the publication authority the API enforces
 * (DEC-065). Times are in the venue's time zone when the fixture has one (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { PendingNote } from '../../features/competition/feedback';
import { SelectField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import { RESULT_CLASSIFICATION, RESULT_STATUS } from '../../features/competition/labels';
import { LeaguesNav, SeasonLinks } from '../../features/competition/nav';
import { PENDING } from '../../features/competition/pending';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Revision = Schema<'ResultRevision'>;
type ResultStatus = Schema<'ResultStatus'>;

const PAGE_SIZE = 25;

/** One revision with its fixture (one cached fixture read per fixture shown). */
export function ResultRevisionRow({ revision }: { revision: Revision }) {
  const fixture = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: revision.fixtureId } },
    staleTime: 5 * 60_000,
  });
  const data = fixture.data;
  const zone = data?.venue?.timezone ?? null;
  const badge = RESULT_STATUS[revision.status];
  const home = data?.home.teamName ?? 'Home';
  const away = data ? (data.away?.teamName ?? 'bye') : 'Away';
  const score =
    revision.homeScore !== null && revision.awayScore !== null
      ? `${home} ${revision.homeScore} – ${revision.awayScore} ${away}`
      : RESULT_CLASSIFICATION[revision.classification];
  return (
    <li aria-labelledby={`revision-${revision.id}`}>
      <div className="row-text">
        <span className="row-title" id={`revision-${revision.id}`}>
          {data
            ? `${home} v ${away}`
            : fixture.error
              ? 'Fixture not available'
              : `Fixture ${shortRef(revision.fixtureId)}`}
          {`, revision ${revision.revisionNo}`}
        </span>
        <StatusBadge tone={badge.tone} label={`Result ${badge.label}`} />
        <span>
          {RESULT_CLASSIFICATION[revision.classification]}: {score}
        </span>
        <span className="caption">
          Submitted by {revision.submittedBy.actorLabel}{' '}
          {revision.submittedAt ? formatInstant(revision.submittedAt, zone) : '(not submitted)'}
          {revision.publishedBy
            ? ` · published by ${revision.publishedBy.actorLabel} ${formatInstant(
                revision.publishedAt,
                zone,
              )}`
            : ''}
        </span>
        {revision.supersedesRevisionId ? (
          <span className="caption">
            Correction of revision {shortRef(revision.supersedesRevisionId)}
            {revision.reason ? `: ${revision.reason}` : ''}
          </span>
        ) : null}
        {revision.supersededAt ? (
          <span className="caption">
            Superseded {formatInstant(revision.supersededAt, zone)}
            {revision.supersededByRevisionId
              ? ` by revision ${shortRef(revision.supersededByRevisionId)}`
              : ''}
          </span>
        ) : null}
        {revision.returnReason ? (
          <span className="caption">Returned for correction: {revision.returnReason}</span>
        ) : null}
      </div>
      <Link to={`/leagues/fixtures/${revision.fixtureId}/results`}>
        {revision.status === 'submitted' ? 'Review and publish' : 'Open the fixture’s results'}
      </Link>
    </li>
  );
}

export function SeasonResultsScreen() {
  const { seasonId = '' } = useParams();
  const [status, setStatus] = useState<ResultStatus | ''>('');
  const season = useApiQuery({ path: '/seasons/{id}', request: { path: { id: seasonId } } });
  const revisions = useApiPages({
    path: '/seasons/{id}/result-revisions',
    request: {
      path: { id: seasonId },
      query: { limit: PAGE_SIZE, ...(status ? { status } : {}) },
    },
  });
  return (
    <section aria-labelledby="season-results-title">
      <h2 id="season-results-title">
        Result revisions{season.data ? `: ${season.data.name}` : ''}
      </h2>
      <LeaguesNav />
      <SeasonLinks seasonId={seasonId} />
      <PendingNote decision={PENDING.publicationAuthority} />
      <SelectField
        label="Result status"
        value={status}
        onChange={(v) => setStatus(v as ResultStatus | '')}
        options={Object.entries(RESULT_STATUS).map(([value, b]) => ({ value, label: b.label }))}
        placeholder="All statuses"
      />
      <QueryBoundary
        query={revisions}
        label="result revisions"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: status === 'submitted' ? 'Nothing submitted' : 'No result revisions',
          description:
            'Result revisions of this season appear here, newest first, once an official or league manager submits one.',
        }}
        unavailableOffline={['publishing and returning results']}
      >
        {(items) => (
          <ul className="list" aria-label="Result revisions">
            {items.map((revision) => (
              <ResultRevisionRow key={revision.id} revision={revision} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={revisions} label="result revisions" />
    </section>
  );
}
