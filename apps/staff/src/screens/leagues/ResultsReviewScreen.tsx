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
 *
 * A drawn game of a bracket node names its shootout winner (CMP-10, SPK-COMP-001) when the
 * season's rule set says `tiebreak.playoff: shootout`; nothing is preselected, it may stay empty
 * (the bracket then waits), and the API's SHOOTOUT_NOT_ALLOWED refusal is shown on the field.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
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
import {
  RESULT_CLASSIFICATION,
  RESULT_STATUS,
  humanizeCode,
} from '../../features/competition/labels';
import { PersonName } from '../../features/competition/names';
import { LeaguesNav } from '../../features/competition/nav';
import { OperationStatus } from '../../features/competition/OperationStatus';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StatusBadge } from '../../ui/StatusBadge';
import { fixtureTitle } from './FixtureScreen';

type Revision = Schema<'ResultRevision'>;
type Fixture = Schema<'FixtureDetail'>;
type Classification = Schema<'ResultClassification'>;
type PublishOutcome = Schema<'PublishResultOutcome'>;
type Playoff = 'shootout' | 'replay' | 'league_decision';

/** CMP-10: whether a drawn result of this fixture may name a shootout winner. */
interface ShootoutContext {
  /** The fixture is a bracket node's game. */
  inBracket: boolean;
  /** The rule set's `tiebreak.playoff`: null when it states none; undefined until it is read. */
  playoff: Playoff | null | undefined;
}

const PLAYOFF_LABEL: Record<Playoff, string> = {
  shootout: 'a shootout',
  replay: 'a replay',
  league_decision: 'a league decision',
};

function useShootout(fixture: Fixture | undefined): ShootoutContext {
  const seasonId = fixture?.seasonId ?? '';
  const nodes = useApiQuery({
    path: '/seasons/{id}/bracket-nodes',
    request: { path: { id: seasonId } },
    enabled: !!fixture,
    staleTime: 60_000,
  });
  const season = useApiQuery({
    path: '/seasons/{id}',
    request: { path: { id: seasonId } },
    enabled: !!fixture,
    staleTime: 5 * 60_000,
  });
  const ruleSet = useApiQuery({
    path: '/rule-sets/{id}',
    request: { path: { id: season.data?.ruleSetId ?? '' } },
    enabled: !!season.data,
    staleTime: 5 * 60_000,
  });
  return {
    inBracket: !!fixture && (nodes.data ?? []).some((n) => n.fixtureId === fixture.id),
    playoff: ruleSet.data ? (ruleSet.data.content.tiebreak?.playoff ?? null) : undefined,
  };
}

function isShootoutRefusal(error: ApiError | null): boolean {
  return (
    error?.code === 'VALIDATION_FAILED' &&
    (error.details as { code?: unknown } | undefined)?.code === 'SHOOTOUT_NOT_ALLOWED'
  );
}

function sideName(fixture: Fixture, entryId: string): string {
  return entryId === fixture.home.entryId
    ? fixture.home.teamName
    : entryId === fixture.away?.entryId
      ? fixture.away.teamName
      : 'another team';
}

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

type ResultFormMode = 'new' | 'correction' | 'resubmit';

/**
 * Enter a result, a correction of the official one, or resubmit a revision returned for
 * correction (SPK-RESULT-001, SPK-RESULT-004). A correction or resubmission starts from the
 * revision it replaces: classification, scores, forfeit, abandonment and notes are prefilled, and
 * its cards are carried over unchanged unless the user removes one, so a score-only correction
 * never drops the card record (fair-play points read the cards). A correction answering a dispute
 * names it (SPK-RESULT-005).
 */
function ResultForm({
  fixture,
  mode,
  base,
  disputeId,
  shootout,
  onDone,
}: {
  fixture: Fixture;
  mode: ResultFormMode;
  base: Revision | null;
  disputeId: string | null;
  shootout: ShootoutContext;
  onDone?: () => void;
}) {
  const submitResult = useApiCommand('post', '/fixtures/{id}/results', { invalidate: RESULT_KEYS });
  const resubmit = useApiCommand('post', '/results/{id}/submit', { invalidate: RESULT_KEYS });
  const command = mode === 'resubmit' ? resubmit : submitResult;
  const [classification, setClassification] = useState<string>(base?.classification ?? '');
  const [home, setHome] = useState(base?.homeScore !== null && base ? String(base.homeScore) : '');
  const [away, setAway] = useState(base?.awayScore !== null && base ? String(base.awayScore) : '');
  const [forfeiting, setForfeiting] = useState(base?.forfeitingEntryId ?? '');
  // The revision it replaces may have named one; otherwise nothing is preselected (CMP-10).
  const [shootoutWinner, setShootoutWinner] = useState(base?.shootoutWinnerEntryId ?? '');
  const [minutePlayed, setMinutePlayed] = useState(
    base?.details.abandonment ? String(base.details.abandonment.minutePlayed) : '',
  );
  const [abandonReason, setAbandonReason] = useState(base?.details.abandonment?.reason ?? '');
  const [notes, setNotes] = useState(base?.details.notes ?? '');
  const [cards, setCards] = useState(
    (base?.details.cards ?? []).map(({ personId, teamEntryId, kind, minute }) => ({
      personId,
      teamEntryId,
      kind,
      minute,
    })),
  );
  const [reason, setReason] = useState(mode === 'resubmit' ? (base?.reason ?? '') : '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(command.error);
  const err = (key: string) => errors[key] ?? apiErrors[key];
  const needsScores = classification === 'completed' || classification === 'forfeit';
  const needsReason = mode === 'correction';
  const answersDispute = mode === 'correction' && disputeId !== null;
  const typedHome = home.trim() ? parseWholeNumber(home) : null;
  const typedAway = away.trim() ? parseWholeNumber(away) : null;
  const drawn =
    classification === 'completed' &&
    typedHome !== null &&
    typedAway !== null &&
    typedHome === typedAway &&
    !!fixture.away;
  // Offered for a bracket game unless the rule set is known to decide draws another way; the
  // API still refuses with SHOOTOUT_NOT_ALLOWED when its rule set does not allow one.
  const shootoutOffered =
    drawn &&
    shootout.inBracket &&
    (shootout.playoff === undefined || shootout.playoff === 'shootout');
  const shootoutRefused = isShootoutRefusal(command.error);

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
    if (
      classification === 'abandoned' &&
      (minute === null || minute < 0 || minute > 200 || !abandonReason.trim())
    )
      next.abandonment = 'Enter the minute reached (0 to 200) and why the match was abandoned.';
    if (needsReason && !reason.trim()) next.reason = 'A correction needs a reason.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body = {
      classification: classification as Classification,
      ...(needsScores && homeScore !== null ? { homeScore } : {}),
      ...(needsScores && awayScore !== null ? { awayScore } : {}),
      ...(classification === 'forfeit' ? { forfeitingEntryId: forfeiting } : {}),
      ...(shootoutOffered && shootoutWinner ? { shootoutWinnerEntryId: shootoutWinner } : {}),
      ...(classification === 'abandoned' && minute !== null
        ? { abandonment: { minutePlayed: minute, reason: abandonReason.trim() } }
        : {}),
      ...(cards.length > 0 || (base?.details.cards.length ?? 0) > 0 ? { cards } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(answersDispute && disputeId ? { disputeId } : {}),
    };
    const sent =
      mode === 'resubmit' && base
        ? resubmit.submit({
            path: { id: base.id },
            body: { ...body, expectedRevision: base.revision },
          })
        : submitResult.submit({ path: { id: fixture.id }, body });
    void sent.then(() => onDone?.()).catch(() => undefined);
  };

  const sides = [
    { value: fixture.home.entryId, label: fixture.home.teamName },
    ...(fixture.away ? [{ value: fixture.away.entryId, label: fixture.away.teamName }] : []),
  ];
  const teamOf = (entryId: string) => sideName(fixture, entryId);
  const label =
    mode === 'resubmit'
      ? 'Resubmit the returned result'
      : mode === 'correction'
        ? 'Submit a correction'
        : 'Submit a result';
  return (
    <form
      className="form"
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {answersDispute && disputeId ? (
        <p>
          <StatusBadge tone="info" label={`Answers dispute ${shortRef(disputeId)}`} />
        </p>
      ) : null}
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
      {shootoutOffered ? (
        <SelectField
          label="Shootout winner"
          value={shootoutWinner}
          onChange={setShootoutWinner}
          options={sides}
          placeholder="No shootout winner recorded"
          error={
            shootoutRefused
              ? 'A shootout does not decide this game under its rule set. Leave the shootout winner empty.'
              : err('shootoutWinnerEntryId')
          }
          hint="A drawn playoff game decided by a shootout names the side that won it. Leave it empty and the bracket waits."
        />
      ) : drawn && shootout.inBracket && shootout.playoff !== undefined ? (
        <p className="caption" data-testid="no-shootout">
          {shootout.playoff
            ? `Under this rule set a drawn playoff game is decided by ${PLAYOFF_LABEL[shootout.playoff]}, not on this result; the bracket waits.`
            : 'This rule set states no way to decide a drawn playoff game; the bracket waits for a league decision.'}
        </p>
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
      {base && base.details.cards.length > 0 ? (
        <fieldset>
          <legend>Cards carried over from revision {base.revisionNo}</legend>
          {cards.length === 0 ? (
            <p className="caption">
              All cards removed: this revision will record no cards (fair-play points change).
            </p>
          ) : (
            <ul className="list" aria-label="Cards in this revision">
              {cards.map((card, index) => (
                <li key={`${card.personId}-${card.kind}-${card.minute ?? 'none'}-${index}`}>
                  <span>
                    {humanizeCode(card.kind)} card, <PersonName personId={card.personId} /> (
                    {teamOf(card.teamEntryId)})
                    {card.minute !== null ? `, minute ${card.minute}` : ''}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => setCards((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove this card
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
      ) : null}
      <TextAreaField label="Notes" value={notes} onChange={setNotes} />
      {needsReason ? (
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
        <CommandButton type="submit" busy={command.isProcessing}>
          {mode === 'resubmit'
            ? 'Resubmit for review'
            : mode === 'correction'
              ? 'Submit the correction for review'
              : 'Submit the result for review'}
        </CommandButton>
      </div>
      {command.status === 'success' && command.data ? (
        <SuccessNote>{`Revision ${command.data.revisionNo} ${command.data.status}`}</SuccessNote>
      ) : null}
      <CommandError error={command.error} onRetry={submit} />
    </form>
  );
}

function RevisionCard({
  revision,
  fixture,
  hasOfficial,
  reviewTaskId,
  shootout,
}: {
  revision: Revision;
  fixture: Fixture;
  hasOfficial: boolean;
  reviewTaskId: string | null;
  shootout: ShootoutContext;
}) {
  const badge = RESULT_STATUS[revision.status];
  const [resubmitting, setResubmitting] = useState(false);
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
        {revision.shootoutWinnerEntryId ? (
          <span data-testid={`shootout-${revision.id}`}>
            Shootout won by {sideName(fixture, revision.shootoutWinnerEntryId)}
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
      {revision.status === 'draft' ? (
        <div className="panel" data-testid={`returned-${revision.id}`}>
          <StatusBadge tone="warning" label="Returned for correction" />
          {revision.returnReason ? <p>What needs correcting: {revision.returnReason}</p> : null}
          <Button
            variant="secondary"
            aria-expanded={resubmitting}
            onClick={() => setResubmitting((o) => !o)}
          >
            {resubmitting ? 'Close' : 'Correct and resubmit'}
          </Button>
          {resubmitting ? (
            <ResultForm
              fixture={fixture}
              mode="resubmit"
              base={revision}
              disputeId={null}
              shootout={shootout}
              onDone={() => setResubmitting(false)}
            />
          ) : null}
        </div>
      ) : null}
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
  const [search] = useSearchParams();
  const disputeParam = search.get('disputeId');
  const disputeId = disputeParam && isUuid(disputeParam) ? disputeParam : null;
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
  });
  const tasks = useReviewTasks();
  const shootout = useShootout(fixture.data);
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
          const official = revisions.find((r) => r.status === 'official') ?? null;
          const hasOfficial = official !== null;
          const inProgress = revisions.some(
            (r) => r.status === 'submitted' || r.status === 'draft',
          );
          const returned = revisions.some((r) => r.status === 'draft');
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
                      shootout={shootout}
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
                    <ResultForm
                      fixture={fixtureData}
                      mode={hasOfficial ? 'correction' : 'new'}
                      base={official}
                      disputeId={disputeId}
                      shootout={shootout}
                    />
                  ) : null}
                </section>
              ) : (
                <p className="caption">
                  {returned
                    ? 'A returned revision is waiting to be corrected and resubmitted before another one.'
                    : 'A submitted revision is waiting; publish or return it before another one.'}
                </p>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
