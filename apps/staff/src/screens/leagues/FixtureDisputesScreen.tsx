/**
 * SCR-S-12 Disputes and discipline, part 1: the disputes of one fixture (SPK-RESULT-005 eligible
 * submitting role, fixture, submission window, reason, evidence references, reviewer, decision,
 * publication consequences, appeal handling; SPK-UX-008). Review moves follow DisputeMachine with
 * `expectedRevision`; a decision names its outcome, publication consequence and reason, checked
 * here before sending and again by the API. League administration records a withdrawal through
 * the review command; a staff member who submitted the dispute withdraws it with a reason
 * (`POST /v1/disputes/{id}/withdraw`, CMP-12). The dispute and appeal procedure is pending
 * DEC-010. The card and its actions are shared with the season-wide list (DisputesScreen).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, PendingNote, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { SelectField, TextAreaField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import {
  APPEAL_SUMMARY,
  DISPUTE_STATUS,
  PUBLICATION_CONSEQUENCE,
  humanizeCode,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { EntryName, useSeasonEntries, type EntryNames } from '../../features/competition/names';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { fixtureTitle } from './FixtureScreen';

type Dispute = Schema<'Dispute'>;
type Consequence = NonNullable<Schema<'PublicationConsequence'>>;

const CONSEQUENCE_OPTIONS = Object.entries(PUBLICATION_CONSEQUENCE).map(([value, label]) => ({
  value,
  label,
}));

const DISPUTE_KEYS = keys('/fixtures/{id}/disputes', '/disputes/{id}', '/disputes');

/** CMP-12: the submitter withdraws their own dispute with a reason (kept in the audit record). */
function WithdrawOwnDispute({ dispute }: { dispute: Dispute }) {
  const withdraw = useApiCommand('post', '/disputes/{id}/withdraw', { invalidate: DISPUTE_KEYS });
  const reload = useRefetch(['/fixtures/{id}/disputes', '/disputes']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!reason.trim()) {
      setError('Give the reason for withdrawing the dispute.');
      return;
    }
    setError(null);
    void withdraw
      .submit({
        path: { id: dispute.id },
        body: { expectedRevision: dispute.revision, reason: reason.trim() },
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Withdraw my dispute
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label="Withdraw my dispute"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField label="Reason" required value={reason} onChange={setReason} error={error} />
      <div className="actions">
        <CommandButton type="submit" variant="secondary" busy={withdraw.isProcessing}>
          Withdraw the dispute
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep the dispute
        </Button>
      </div>
      {withdraw.status === 'success' && withdraw.data ? (
        <SuccessNote>{`Dispute ${withdraw.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={withdraw.error}
        onRetry={submit}
        onReload={() => {
          withdraw.reset();
          reload();
        }}
      />
    </form>
  );
}

export function DisputeActions({ dispute }: { dispute: Dispute }) {
  const me = useApiQuery({ path: '/me', staleTime: 5 * 60_000 });
  const decide = useApiCommand('post', '/disputes/{id}/decide', { invalidate: DISPUTE_KEYS });
  const reload = useRefetch(['/fixtures/{id}/disputes', '/disputes']);
  const [mode, setMode] = useState<'decide' | 'withdraw' | null>(null);
  const [decision, setDecision] = useState('');
  const [consequence, setConsequence] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastAction, setLastAction] = useState<'review' | 'decide' | 'withdraw'>('review');

  const send = (action: 'review' | 'decide' | 'withdraw') => {
    setLastAction(action);
    if (action === 'decide') {
      const next: Record<string, string> = {};
      if (!decision) next.decision = 'Choose upheld or rejected.';
      if (!consequence) next.consequence = 'Choose the publication consequence.';
      if (!reason.trim()) next.reason = 'Give the reason for the decision.';
      setErrors(next);
      if (Object.keys(next).length > 0) return;
    }
    void decide
      .submit({
        path: { id: dispute.id },
        body: {
          action,
          expectedRevision: dispute.revision,
          ...(action === 'decide'
            ? {
                decision: decision as 'upheld' | 'rejected',
                publicationConsequence: consequence as Consequence,
              }
            : {}),
          ...(action !== 'review' && reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };

  const myPersonId = me.data?.principal.personId ?? null;
  const submittedByMe = myPersonId !== null && dispute.submittedBy.personId === myPersonId;

  if (dispute.status === 'decided' || dispute.status === 'withdrawn') {
    return dispute.publicationConsequence === 'correction_required' ? (
      <Link to={`/leagues/fixtures/${dispute.fixtureId}/results?disputeId=${dispute.id}`}>
        Submit the correction
      </Link>
    ) : null;
  }
  return (
    <div className="form">
      <div className="actions">
        {dispute.status === 'submitted' ? (
          <CommandButton
            variant="secondary"
            busy={decide.isProcessing && lastAction === 'review'}
            onClick={() => send('review')}
          >
            Start review
          </CommandButton>
        ) : null}
        <Button variant="secondary" onClick={() => setMode('decide')}>
          Decide
        </Button>
        {submittedByMe ? null : (
          <Button variant="secondary" onClick={() => setMode('withdraw')}>
            Record withdrawal
          </Button>
        )}
      </div>
      {submittedByMe ? <WithdrawOwnDispute dispute={dispute} /> : null}
      {mode === 'decide' ? (
        <form
          className="form"
          noValidate
          aria-label="Decide the dispute"
          onSubmit={(event) => {
            event.preventDefault();
            send('decide');
          }}
        >
          <SelectField
            label="Decision"
            required
            value={decision}
            onChange={setDecision}
            options={[
              { value: 'upheld', label: 'Upheld' },
              { value: 'rejected', label: 'Rejected' },
            ]}
            error={errors.decision}
          />
          <SelectField
            label="Publication consequence"
            required
            value={consequence}
            onChange={setConsequence}
            options={CONSEQUENCE_OPTIONS}
            error={errors.consequence}
          />
          <TextAreaField
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            error={errors.reason}
          />
          <CommandButton type="submit" busy={decide.isProcessing}>
            Record the decision
          </CommandButton>
        </form>
      ) : null}
      {mode === 'withdraw' ? (
        <form
          className="form"
          noValidate
          aria-label="Record the withdrawal"
          onSubmit={(event) => {
            event.preventDefault();
            send('withdraw');
          }}
        >
          <TextAreaField label="Note" value={reason} onChange={setReason} />
          <CommandButton type="submit" variant="secondary" busy={decide.isProcessing}>
            Record withdrawal
          </CommandButton>
        </form>
      ) : null}
      {decide.status === 'success' && decide.data ? (
        <SuccessNote>{`Dispute ${decide.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={decide.error}
        onRetry={() => send(lastAction)}
        onReload={() => {
          decide.reset();
          reload();
        }}
      />
    </div>
  );
}

export function DisputeCard({
  dispute,
  entries,
  fixtureLabel,
}: {
  dispute: Dispute;
  entries: EntryNames;
  /** The fixture the dispute is about, on lists that span fixtures. */
  fixtureLabel?: ReactNode;
}) {
  const badge = DISPUTE_STATUS[dispute.status];
  return (
    <li aria-labelledby={`dispute-${dispute.id}`}>
      <div className="row-text">
        <span className="row-title" id={`dispute-${dispute.id}`}>
          Dispute {shortRef(dispute.id)}
        </span>
        {fixtureLabel ? <span>{fixtureLabel}</span> : null}
        <StatusBadge tone={badge.tone} label={`Dispute ${badge.label}`} />
        <dl className="facets">
          <div>
            <dt>Submitted by</dt>
            <dd>
              {dispute.submittedBy.actorLabel} ({humanizeCode(dispute.submittingRole)})
              {dispute.submittingTeamEntryId ? (
                <>
                  {' for '}
                  <EntryName entryId={dispute.submittingTeamEntryId} teamIdOf={entries} />
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{formatInstant(dispute.submittedAt)}</dd>
          </div>
          <div>
            <dt>Submission window closed</dt>
            <dd>{formatInstant(dispute.submissionDeadlineAt)}</dd>
          </div>
          <div>
            <dt>Disputed result</dt>
            <dd>{dispute.resultRevisionId ? shortRef(dispute.resultRevisionId) : 'The fixture'}</dd>
          </div>
          <div>
            <dt>Reviewer</dt>
            <dd>{dispute.reviewer?.actorLabel ?? 'Not assigned yet'}</dd>
          </div>
          <div>
            <dt>Decision</dt>
            <dd>
              {dispute.decision
                ? `${humanizeCode(dispute.decision)} ${formatInstant(dispute.decidedAt)}`
                : 'Not decided'}
            </dd>
          </div>
          <div>
            <dt>Publication consequence</dt>
            <dd>
              {dispute.publicationConsequence
                ? PUBLICATION_CONSEQUENCE[dispute.publicationConsequence]
                : 'None yet'}
            </dd>
          </div>
          <div>
            <dt>Appeal</dt>
            <dd>{APPEAL_SUMMARY[dispute.appealStatus]}</dd>
          </div>
        </dl>
        <span>Reason: {dispute.reason}</span>
        {dispute.decisionReason ? <span>Decision reason: {dispute.decisionReason}</span> : null}
        {dispute.evidence.length > 0 ? (
          <ul aria-label="Evidence references">
            {dispute.evidence.map((e, index) => (
              <li key={index}>
                {humanizeCode(e.kind)}: {e.reference}
                {e.description ? ` (${e.description})` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <span className="caption">No evidence references.</span>
        )}
      </div>
      <DisputeActions dispute={dispute} />
    </li>
  );
}

export function FixtureDisputesScreen() {
  const { fixtureId = '' } = useParams();
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const disputes = useApiQuery({
    path: '/fixtures/{id}/disputes',
    request: { path: { id: fixtureId } },
  });
  const { byId } = useSeasonEntries(fixture.data?.seasonId);
  return (
    <section aria-labelledby="disputes-title">
      <h2 id="disputes-title">Disputes{fixture.data ? `: ${fixtureTitle(fixture.data)}` : ''}</h2>
      <LeaguesNav />
      <p>
        <Link to={`/leagues/fixtures/${fixtureId}`}>Back to the fixture</Link>
      </p>
      <PendingNote decision={PENDING.discipline} />
      <QueryBoundary
        query={disputes}
        label="disputes"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No disputes',
          description:
            'Disputes submitted by a competing captain or league administration inside the protest window appear here.',
        }}
        unavailableOffline={['reviewing and deciding disputes']}
      >
        {(data) => (
          <ul className="list" aria-label="Disputes">
            {data.map((dispute) => (
              <DisputeCard key={dispute.id} dispute={dispute} entries={byId} />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
