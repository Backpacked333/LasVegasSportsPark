/**
 * SCR-S-11 Results review and publication (SPK-RESULT-001 draft → submitted → official →
 * superseded, SPK-RESULT-002 classifications, SPK-RESULT-004 reviewed corrections, SPK-STAFF-005,
 * SPK-AT-014, §4.7 invariant 8, SPK-UX-008). A submitted revision is published as official under
 * the configured authority (DEC-065 pending: the API answers ACCESS_DENIED to anyone without it) or
 * returned for correction with a reason. A correction is a new revision: publishing it supersedes
 * the official one and keeps the prior result, actor, reason and publication time. When a
 * correction touches a published bracket or a downstream game already played, the API rewrites
 * nothing and opens a management review task; the reviewing manager then publishes it against
 * that task. Standings recalculate on publication; the publication's operation is shown, and an
 * operation in `recovery_required` is the recovery state.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { keys, PendingNote, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  NumberField,
  SelectField,
  TextAreaField,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import { RESULT_CLASSIFICATION, RESULT_STATUS } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { OperationStatus } from '../../features/competition/OperationStatus';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { fixtureTitle } from './FixtureScreen';

type Revision = Schema<'ResultRevision'>;
type Fixture = Schema<'FixtureDetail'>;
type Classification = Schema<'ResultClassification'>;
type PublishOutcome = Schema<'PublishResultOutcome'>;

export const RESULT_REVIEW_CATEGORY = 'competition.result_correction_review';

const RESULT_KEYS = keys('/fixtures/{id}/results', '/results/{id}', '/seasons/{id}/standings');
const CLASSIFICATION_OPTIONS = Object.entries(RESULT_CLASSIFICATION).map(([value, label]) => ({
  value,
  label,
}));

function scoreLine(revision: Revision, fixture: Fixture): string {
  if (revision.homeScore === null || revision.awayScore === null) {
    return RESULT_CLASSIFICATION[revision.classification];
  }
  return `${fixture.home.teamName} ${revision.homeScore} – ${revision.awayScore} ${
    fixture.away?.teamName ?? 'bye'
  }`;
}

/** Open management review tasks raised for a revision (exceptions of the league manager queue). */
function useReviewTasks() {
  const open = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'league_manager', status: 'open', limit: 100 } },
  });
  const acknowledged = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'league_manager', status: 'acknowledged', limit: 100 } },
  });
  const items = [...(open.data?.items ?? []), ...(acknowledged.data?.items ?? [])].filter(
    (e) => e.category === RESULT_REVIEW_CATEGORY,
  );
  return { items, error: open.error ?? acknowledged.error };
}

function PublishOutcomeView({ outcome, seasonId }: { outcome: PublishOutcome; seasonId: string }) {
  if (!outcome.published) {
    return (
      <div role="status" data-testid="review-required">
        <StatusBadge tone="warning" label="Management review required" />
        <p>
          This correction affects a published bracket or a game already played, so nothing was
          rewritten. A review task{' '}
          {outcome.reviewExceptionId ? shortRef(outcome.reviewExceptionId) : ''} is open in the
          league manager queue; the reviewing manager publishes the correction against it.
        </p>
      </div>
    );
  }
  return (
    <div role="status" data-testid="publish-outcome">
      <StatusBadge tone="success" label={`Result ${outcome.revision.status}`} />
      {outcome.supersededRevisionId ? (
        <p>
          The previous official result (revision {shortRef(outcome.supersededRevisionId)}) is now
          superseded and kept in the history.
        </p>
      ) : null}
      {outcome.standings ? (
        <p>
          Standings recalculated.{' '}
          <Link to={`/leagues/seasons/${seasonId}/standings`}>Open standings</Link>
        </p>
      ) : (
        <p>No league standings changed (a playoff game, or nothing to recalculate).</p>
      )}
      {outcome.proposedSuspensionIds.length > 0 ? (
        <p>
          {outcome.proposedSuspensionIds.length} suspension
          {outcome.proposedSuspensionIds.length === 1 ? ' was' : 's were'} proposed by the rule set
          and await approval. <Link to="/leagues/discipline">Open discipline</Link>
        </p>
      ) : null}
      {outcome.progressedBracketNodeIds.length > 0 ? (
        <p>The bracket progressed for {outcome.progressedBracketNodeIds.length} node(s).</p>
      ) : null}
      <OperationStatus operationId={outcome.operationId} />
    </div>
  );
}

function PublishAction({
  revision,
  isCorrection,
  reviewTaskId,
  seasonId,
}: {
  revision: Revision;
  isCorrection: boolean;
  reviewTaskId: string | null;
  seasonId: string;
}) {
  const publish = useApiCommand('post', '/results/{id}/publish', {
    invalidate: [...RESULT_KEYS, ['api', '/exceptions']],
  });
  const reload = useRefetch(['/fixtures/{id}/results']);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needsReason = isCorrection && !revision.reason;

  const submit = (withReview: boolean) => {
    if (needsReason && !reason.trim()) {
      setError('A correction of an official result needs a reason.');
      return;
    }
    setError(null);
    void publish
      .submit({
        path: { id: revision.id },
        body: {
          expectedRevision: revision.revision,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(withReview && reviewTaskId ? { reviewExceptionId: reviewTaskId } : {}),
        },
      })
      .catch(() => undefined);
  };
  const lastWithReview = publish.data?.published === false || !!reviewTaskId;
  return (
    <div className="form">
      {needsReason ? (
        <TextAreaField
          label="Reason for the correction"
          required
          value={reason}
          onChange={setReason}
          error={error}
        />
      ) : null}
      <div className="actions">
        {reviewTaskId ? (
          <CommandButton busy={publish.isProcessing} onClick={() => submit(true)}>
            Publish after review
          </CommandButton>
        ) : (
          <CommandButton busy={publish.isProcessing} onClick={() => submit(false)}>
            {isCorrection ? 'Publish the correction' : 'Publish as official'}
          </CommandButton>
        )}
      </div>
      {reviewTaskId ? (
        <p className="caption">
          Review task {shortRef(reviewTaskId)} is open for this correction. Publishing records your
          review decision and resolves the task.
        </p>
      ) : null}
      {publish.status === 'success' && publish.data ? (
        <PublishOutcomeView outcome={publish.data} seasonId={seasonId} />
      ) : null}
      <CommandError
        error={publish.error}
        onRetry={() => submit(lastWithReview)}
        onReload={() => {
          publish.reset();
          reload();
        }}
      />
    </div>
  );
}

function ReturnAction({ revision }: { revision: Revision }) {
  const returnResult = useApiCommand('post', '/results/{id}/return', { invalidate: RESULT_KEYS });
  const reload = useRefetch(['/fixtures/{id}/results']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!reason.trim()) {
      setError('Say what needs correcting.');
      return;
    }
    setError(null);
    void returnResult
      .submit({
        path: { id: revision.id },
        body: { expectedRevision: revision.revision, reason: reason.trim() },
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Return for correction
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label="Return for correction"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField
        label="What needs correcting"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <div className="actions">
        <CommandButton type="submit" variant="secondary" busy={returnResult.isProcessing}>
          Return to the submitter
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {returnResult.status === 'success' && returnResult.data ? (
        <SuccessNote>{`Result ${returnResult.data.status}: returned for correction`}</SuccessNote>
      ) : null}
      <CommandError
        error={returnResult.error}
        onRetry={submit}
        onReload={() => {
          returnResult.reset();
          reload();
        }}
      />
    </form>
  );
}

function CorrectionForm({ fixture, hasOfficial }: { fixture: Fixture; hasOfficial: boolean }) {
  const submitResult = useApiCommand('post', '/fixtures/{id}/results', { invalidate: RESULT_KEYS });
  const [classification, setClassification] = useState('');
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [forfeiting, setForfeiting] = useState('');
  const [minutePlayed, setMinutePlayed] = useState('');
  const [abandonReason, setAbandonReason] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(submitResult.error);
  const err = (key: string) => errors[key] ?? apiErrors[key];
  const needsScores = classification === 'completed' || classification === 'forfeit';

  const submit = () => {
    const next: Record<string, string> = {};
    if (!classification) next.classification = 'Choose how the match ended.';
    const homeScore = home.trim() ? parseWholeNumber(home) : null;
    const awayScore = away.trim() ? parseWholeNumber(away) : null;
    if (needsScores && (homeScore === null || homeScore < 0)) next.homeScore = 'Enter the score.';
    if (needsScores && (awayScore === null || awayScore < 0)) next.awayScore = 'Enter the score.';
    if (classification === 'forfeit' && !forfeiting)
      next.forfeitingEntryId = 'Choose who forfeited.';
    const minute = parseWholeNumber(minutePlayed);
    if (classification === 'abandoned' && (minute === null || !abandonReason.trim()))
      next.abandonment = 'Enter the minute reached and why the match was abandoned.';
    if (hasOfficial && !reason.trim()) next.reason = 'A correction needs a reason.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void submitResult
      .submit({
        path: { id: fixture.id },
        body: {
          classification: classification as Classification,
          ...(needsScores && homeScore !== null ? { homeScore } : {}),
          ...(needsScores && awayScore !== null ? { awayScore } : {}),
          ...(classification === 'forfeit' ? { forfeitingEntryId: forfeiting } : {}),
          ...(classification === 'abandoned' && minute !== null
            ? { abandonment: { minutePlayed: minute, reason: abandonReason.trim() } }
            : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };

  const sides = [
    { value: fixture.home.entryId, label: fixture.home.teamName },
    ...(fixture.away ? [{ value: fixture.away.entryId, label: fixture.away.teamName }] : []),
  ];
  return (
    <form
      className="form"
      noValidate
      aria-label={hasOfficial ? 'Submit a correction' : 'Submit a result'}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SelectField
        label="Classification"
        required
        value={classification}
        onChange={setClassification}
        options={CLASSIFICATION_OPTIONS}
        error={err('classification')}
      />
      {needsScores ? (
        <div className="field-grid">
          <NumberField
            label={`${fixture.home.teamName} score`}
            required
            value={home}
            onChange={setHome}
            error={err('homeScore')}
          />
          <NumberField
            label={`${fixture.away?.teamName ?? 'Away'} score`}
            required
            value={away}
            onChange={setAway}
            error={err('awayScore')}
          />
        </div>
      ) : null}
      {classification === 'forfeit' ? (
        <SelectField
          label="Forfeiting team"
          required
          value={forfeiting}
          onChange={setForfeiting}
          options={sides}
          error={err('forfeitingEntryId')}
        />
      ) : null}
      {classification === 'abandoned' ? (
        <fieldset>
          <legend>Abandonment</legend>
          <NumberField
            label="Minute reached"
            required
            value={minutePlayed}
            onChange={setMinutePlayed}
          />
          <TextAreaField
            label="Why the match was abandoned"
            required
            value={abandonReason}
            onChange={setAbandonReason}
            error={err('abandonment')}
          />
        </fieldset>
      ) : null}
      <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      {hasOfficial ? (
        <TextAreaField
          label="Reason for the correction"
          required
          value={reason}
          onChange={setReason}
          error={err('reason')}
          hint="Kept with the revision; the prior official result stays in the history."
        />
      ) : null}
      <div className="actions">
        <CommandButton type="submit" busy={submitResult.isProcessing}>
          {hasOfficial ? 'Submit the correction for review' : 'Submit the result for review'}
        </CommandButton>
      </div>
      {submitResult.status === 'success' && submitResult.data ? (
        <SuccessNote>{`Revision ${submitResult.data.revisionNo} ${submitResult.data.status}`}</SuccessNote>
      ) : null}
      <CommandError error={submitResult.error} onRetry={submit} />
    </form>
  );
}

function RevisionCard({
  revision,
  fixture,
  hasOfficial,
  reviewTaskId,
}: {
  revision: Revision;
  fixture: Fixture;
  hasOfficial: boolean;
  reviewTaskId: string | null;
}) {
  const badge = RESULT_STATUS[revision.status];
  return (
    <li aria-labelledby={`revision-${revision.id}`}>
      <div className="row-text">
        <span className="row-title" id={`revision-${revision.id}`}>
          Revision {revision.revisionNo}: {scoreLine(revision, fixture)}
        </span>
        <span>
          <StatusBadge tone={badge.tone} label={`Result ${badge.label}`} />{' '}
          <span className="caption">{RESULT_CLASSIFICATION[revision.classification]}</span>
        </span>
        <span className="caption">
          Submitted by {revision.submittedBy.actorLabel}
          {revision.submittedAt ? ` ${formatInstant(revision.submittedAt)}` : ''}
        </span>
        {revision.publishedBy ? (
          <span className="caption">
            Published by {revision.publishedBy.actorLabel} {formatInstant(revision.publishedAt)}
          </span>
        ) : null}
        {revision.reason ? <span>Correction reason: {revision.reason}</span> : null}
        {revision.returnReason ? <span>Returned: {revision.returnReason}</span> : null}
        {revision.supersededAt ? (
          <span className="caption">
            Superseded {formatInstant(revision.supersededAt)}
            {revision.supersededByRevisionId
              ? ` by revision ${shortRef(revision.supersededByRevisionId)}`
              : ''}
          </span>
        ) : null}
        {revision.details.abandonment ? (
          <span className="caption">
            Abandoned at minute {revision.details.abandonment.minutePlayed}:{' '}
            {revision.details.abandonment.reason}
          </span>
        ) : null}
        {revision.details.cards.length > 0 ? (
          <span className="caption">{revision.details.cards.length} card(s) recorded</span>
        ) : null}
        {revision.details.notes ? (
          <span className="caption">Notes: {revision.details.notes}</span>
        ) : null}
      </div>
      {revision.status === 'submitted' ? (
        <div className="actions">
          <PublishAction
            revision={revision}
            isCorrection={hasOfficial}
            reviewTaskId={reviewTaskId}
            seasonId={fixture.seasonId}
          />
          <ReturnAction revision={revision} />
        </div>
      ) : null}
    </li>
  );
}

function reviewTaskFor(
  tasks: readonly Schema<'OperationalException'>[],
  revisionId: string,
): string | null {
  const task = tasks.find(
    (t) => t.affected?.type === 'result_revision' && t.affected.id === revisionId,
  );
  return task?.id ?? null;
}

export function ResultsReviewScreen() {
  const { fixtureId = '' } = useParams();
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
  });
  const tasks = useReviewTasks();
  const [entering, setEntering] = useState(false);
  return (
    <section aria-labelledby="results-title">
      <h2 id="results-title">Results{fixture.data ? `: ${fixtureTitle(fixture.data)}` : ''}</h2>
      <LeaguesNav />
      <p>
        <Link to={`/leagues/fixtures/${fixtureId}`}>Back to the fixture</Link>
      </p>
      <PendingNote decision={PENDING.publicationAuthority} />
      <QueryBoundary
        query={results}
        label="result revisions"
        unavailableOffline={['publishing', 'returning', 'submitting corrections']}
        empty={{ title: '', description: '' }}
      >
        {(revisions) => {
          const fixtureData = fixture.data;
          if (!fixtureData) {
            return fixture.error ? (
              <CommandError
                error={fixture.error as ApiError}
                onRetry={() => void fixture.refetch()}
              />
            ) : (
              <p aria-busy="true">Loading the fixture…</p>
            );
          }
          const ordered = [...revisions].sort((a, b) => b.revisionNo - a.revisionNo);
          const hasOfficial = revisions.some((r) => r.status === 'official');
          const inProgress = revisions.some(
            (r) => r.status === 'submitted' || r.status === 'draft',
          );
          return (
            <>
              {ordered.length === 0 ? (
                <section className="state" data-testid="state-empty">
                  <h3>Nothing submitted</h3>
                  <p>
                    No result has been submitted for this fixture. The assigned official or a league
                    manager submits it.
                  </p>
                </section>
              ) : (
                <ul className="list" aria-label="Result revisions, newest first">
                  {ordered.map((revision) => (
                    <RevisionCard
                      key={revision.id}
                      revision={revision}
                      fixture={fixtureData}
                      hasOfficial={hasOfficial && revision.status !== 'official'}
                      reviewTaskId={reviewTaskFor(tasks.items, revision.id)}
                    />
                  ))}
                </ul>
              )}
              {tasks.error ? (
                <p className="caption">
                  Review tasks could not be checked ({tasks.error.code}); a correction that needs
                  review is reported when you publish it.
                </p>
              ) : null}
              {!inProgress ? (
                <section className="panel" aria-labelledby="enter-result-title">
                  <h3 id="enter-result-title">
                    {hasOfficial ? 'Correct the official result' : 'Enter the result'}
                  </h3>
                  <Button
                    variant="secondary"
                    aria-expanded={entering}
                    onClick={() => setEntering((o) => !o)}
                  >
                    {entering ? 'Close' : hasOfficial ? 'Start a correction' : 'Enter the result'}
                  </Button>
                  {entering ? (
                    <CorrectionForm fixture={fixtureData} hasOfficial={hasOfficial} />
                  ) : null}
                </section>
              ) : (
                <p className="caption">
                  A revision is already in progress; publish or return it before another one.
                </p>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
