/**
 * Making a competition public or private (SPK-SCHED-010, proposed amendment PA-06; capability
 * `public_schedule`): whether it is public, the links of its public pages, and what blocks
 * publishing. A competition is private until league staff publish it. It can be public only when
 * every division of its seasons states a minimum age of 18 or more, and no competition, season or
 * division name suggests players under 18 (the rule fails closed; proposed, pending decision
 * DEC-100). The panel lists each reason the API gives, with what to set. While any reason stands,
 * a competition that is already public is not served, and the panel says so. The links are built
 * from the organization's slug and public codes; they carry no record id.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandButton } from './CommandButton';
import { CommandError } from './CommandError';
import { keys, SuccessNote, useRefetch } from './feedback';

type Publication = Schema<'CompetitionPublication'>;

const PUBLICATION_KEYS = keys('/competitions/{id}/publication', '/competitions/{id}');

export function publicCompetitionPath(publication: Publication): string | null {
  return publication.publicCode
    ? `/public/${publication.organizationSlug}/competitions/${publication.publicCode}`
    : null;
}

function Links({ publication }: { publication: Publication }) {
  const competition = publicCompetitionPath(publication);
  if (publication.visibility !== 'public' || !competition) return null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <ul className="list" aria-label="Public links">
      <li>
        <div className="row-text">
          <span className="row-title">Competition page</span>
          <a href={competition}>{`${origin}${competition}`}</a>
        </div>
      </li>
      {publication.seasons
        .filter((season) => season.publicCode)
        .map((season) => {
          const base = `/public/${publication.organizationSlug}/seasons/${season.publicCode}`;
          return (
            <li key={season.seasonId}>
              <div className="row-text">
                <span className="row-title">{season.name}</span>
                <a href={`${base}/standings`}>{`${origin}${base}/standings`}</a>
                {season.hasDivisions ? null : (
                  <span className="caption">
                    Not shown yet: this season has no division, so nothing says who plays in it.
                  </span>
                )}
                <span className="caption">
                  Fixtures, results and standings share this link; add the code{' '}
                  <code>{season.publicCode}</code> to a lobby display with <code>?seasons=</code>.
                </span>
              </div>
            </li>
          );
        })}
    </ul>
  );
}

function Controls({ publication }: { publication: Publication }) {
  const publish = useApiCommand('post', '/competitions/{id}/publish', {
    invalidate: PUBLICATION_KEYS,
  });
  const unpublish = useApiCommand('post', '/competitions/{id}/unpublish', {
    invalidate: PUBLICATION_KEYS,
  });
  const reload = useRefetch(['/competitions/{id}/publication']);
  const request = {
    path: { id: publication.competitionId },
    body: { expectedRevision: publication.revision },
  };
  const doPublish = () => {
    unpublish.reset();
    void publish.submit(request).catch(() => undefined);
  };
  const doUnpublish = () => {
    publish.reset();
    void unpublish.submit(request).catch(() => undefined);
  };
  const blocked = publication.blockers.length > 0;
  const isPublic = publication.visibility === 'public';
  return (
    <div className="form">
      <p>
        <StatusBadge
          tone={publication.visibility === 'public' ? 'success' : 'neutral'}
          label={publication.visibility === 'public' ? 'Public' : 'Private'}
        />{' '}
        <span className="caption">
          {isPublic && blocked
            ? 'Made public, but not shown: nothing of this competition is readable without sign-in until the reasons below are resolved.'
            : isPublic
              ? 'Fixtures, results, standings and bracket are readable without sign-in: team names, scores, times and fields only.'
              : 'Nothing of this competition is readable without sign-in.'}
        </span>
      </p>
      {blocked ? (
        <div>
          <StatusBadge tone="warning" label="Cannot be public" />{' '}
          <span className="caption">
            A competition is shown publicly only when every division states a minimum age of 18 or
            more and no name suggests players under 18. Proposed rule, pending decision DEC-100.
          </span>
          <ul className="list" aria-label="Why it cannot be public">
            {publication.blockers.map((blocker, index) => (
              <li key={`${index}-${blocker.scope}-${blocker.reason}`}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="actions">
        {publication.visibility === 'private' ? (
          <CommandButton busy={publish.isProcessing} disabled={blocked} onClick={doPublish}>
            Make public
          </CommandButton>
        ) : (
          <CommandButton variant="secondary" busy={unpublish.isProcessing} onClick={doUnpublish}>
            Make private
          </CommandButton>
        )}
      </div>
      {publish.data ? <SuccessNote>Competition is public</SuccessNote> : null}
      {unpublish.data ? <SuccessNote>Competition is private</SuccessNote> : null}
      <CommandError
        error={publish.error ?? unpublish.error}
        onRetry={publish.error ? doPublish : doUnpublish}
        onReload={() => {
          publish.reset();
          unpublish.reset();
          reload();
        }}
      />
      <Links publication={publication} />
    </div>
  );
}

function PublicationBody({ competitionId }: { competitionId: string }) {
  const publication = useApiQuery({
    path: '/competitions/{id}/publication',
    request: { path: { id: competitionId } },
  });
  return (
    <QueryBoundary
      query={publication}
      label="the public pages"
      empty={{ title: '', description: '' }}
      unavailableOffline={['making the competition public or private']}
    >
      {(data) => <Controls publication={data} />}
    </QueryBoundary>
  );
}

/**
 * With the capability off the panel says so and reads nothing: every public route answers "not
 * available" while the switch is off, whatever a competition's visibility.
 */
export function PublicationPanel({ competitionId }: { competitionId: string }) {
  return (
    <section className="panel" aria-labelledby="publication-title">
      <h3 id="publication-title">Public pages</h3>
      <CapabilityGate capability="public_schedule" subject="Public and lobby views">
        <PublicationBody competitionId={competitionId} />
      </CapabilityGate>
    </section>
  );
}
