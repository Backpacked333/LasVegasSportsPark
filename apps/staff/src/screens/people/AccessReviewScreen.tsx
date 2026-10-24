/**
 * SCR-S-22 Disputed access review (SPK-IAM-005, DEC-004, POL-023). One review from
 * `GET /v1/access-reviews/{id}`: subject, reason, parties, evidence references, owner, effective
 * dates, escalation and the full decision history. Decisions (restrict, lift, escalate, decide,
 * close, note, reassign) are recorded with `POST /v1/access-reviews/{id}/decisions`, the review's
 * expected revision and an idempotency key; the API decides which decision is allowed now and
 * answers INVALID_TRANSITION or STALE_REVISION, which offer "Reload" and keep the typed input.
 *
 * Temporary restrictions state their end explicitly ("until lifted" or a date): a restriction is
 * never given an end the reviewer did not choose. Nothing is inferred from household membership.
 * The workflow is restricted: a review the viewer may not see is shown as not available, and
 * offline the review is read-only.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../ui/CommandFeedback';
import { Facts, RadioGroup, SelectField, TextAreaField, TextField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime, localInputToIso } from '../../ui/time';
import { REVIEW_OWNER_ROLES, type ReviewOwnerRole } from './OpenAccessReviewScreen';

type AccessReview = Schema<'AccessReview'>;
type DecisionKind = Schema<'AccessReviewDecision'>['kind'];

const REVIEW_KEY = ['api', '/access-reviews/{id}'] as const;

const STATUS_TONE: Record<AccessReview['status'], StatusTone> = {
  open: 'warning',
  escalated: 'danger',
  decided: 'info',
  closed: 'neutral',
};

export const DECISION_KINDS: readonly { value: DecisionKind; label: string }[] = [
  { value: 'restrict', label: 'restrict: suspend permissions while the review runs' },
  { value: 'lift', label: 'lift: end a restriction' },
  { value: 'escalate', label: 'escalate: hand to the escalation owner' },
  { value: 'decide', label: 'decide: record the outcome' },
  { value: 'close', label: 'close: end the review' },
  { value: 'note', label: 'note: add to the history only' },
  { value: 'reassign', label: 'reassign: change the review owner' },
];

function ReviewFacts({ review }: { review: AccessReview }) {
  return (
    <>
      <span className="actions-row">
        <StatusBadge tone={STATUS_TONE[review.status]} label={`Status: ${review.status}`} />
      </span>
      <Facts
        label="Review"
        items={[
          [
            'Subject',
            <Link key="s" to={`/people/${review.subjectPersonId}`}>
              {review.subjectPersonId}
            </Link>,
          ],
          ['Reason', review.reason],
          ['Owner role', review.ownerRole],
          [
            'Owner person',
            review.ownerPersonId ? (
              <Link key="o" to={`/people/${review.ownerPersonId}`}>
                {review.ownerPersonId}
              </Link>
            ) : (
              'Not assigned'
            ),
          ],
          ['In effect from', formatDateTime(review.effectiveFrom)],
          [
            'In effect until',
            review.effectiveTo ? formatDateTime(review.effectiveTo) : 'Until closed',
          ],
          ['Escalated', review.escalatedAt ? formatDateTime(review.escalatedAt) : 'No'],
          ['Decided', review.decidedAt ? formatDateTime(review.decidedAt) : 'No'],
          ['Closed', review.closedAt ? formatDateTime(review.closedAt) : 'No'],
          ['Revision', String(review.revision)],
        ]}
      />
      {review.outcome ? (
        <Facts
          label="Outcome"
          items={Object.entries(review.outcome).map(
            ([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string],
          )}
        />
      ) : null}
      <section aria-labelledby="parties-title">
        <h3 id="parties-title">Parties</h3>
        {review.parties.length === 0 ? (
          <p>No parties are recorded.</p>
        ) : (
          <ul className="list" aria-label="Parties">
            {review.parties.map((p, i) => (
              <li key={i}>
                <span>{p.description}</span>
                {p.personId ? <Link to={`/people/${p.personId}`}>{p.personId}</Link> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="evidence-title">
        <h3 id="evidence-title">Evidence references</h3>
        {review.evidence.length === 0 ? (
          <p>No evidence references are recorded.</p>
        ) : (
          <ul className="list" aria-label="Evidence references">
            {review.evidence.map((e, i) => (
              <li key={i}>
                <span>
                  {e.type}: <span className="mono">{e.reference}</span>
                </span>
                {e.note ? <span className="caption">{e.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="decisions-title">
        <h3 id="decisions-title">Decision history</h3>
        {review.decisions.length === 0 ? (
          <p>No decisions yet.</p>
        ) : (
          <ol className="list" aria-label="Decision history">
            {review.decisions.map((d) => (
              <li key={d.id}>
                <div className="row-text">
                  <span className="row-title">
                    {d.sequence}. {d.kind}
                  </span>
                  <span className="caption">
                    {formatDateTime(d.occurredAt)}
                    {d.effectiveFrom ? ` · from ${formatDateTime(d.effectiveFrom)}` : ''}
                    {d.effectiveTo ? ` · until ${formatDateTime(d.effectiveTo)}` : ''}
                    {d.affectedGrantIds.length > 0
                      ? ` · ${d.affectedGrantIds.length} permission(s) affected`
                      : ''}
                  </span>
                  {d.note ? <span>{d.note}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function parseGrantIds(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function DecisionForm({ review }: { review: AccessReview }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<'actor' | 'grants' | 'all'>('actor');
  const [actor, setActor] = useState('');
  const [grantIds, setGrantIds] = useState('');
  const [ends, setEnds] = useState('');
  const [until, setUntil] = useState('');
  const [outcome, setOutcome] = useState('');
  const [ownerRole, setOwnerRole] = useState('');
  const [ownerPerson, setOwnerPerson] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const decide = useApiCommand('post', '/access-reviews/{id}/decisions', {
    invalidate: [REVIEW_KEY],
  });
  const apiErrors = fieldErrorsOf(decide.error);
  const targeting = kind === 'restrict' || kind === 'lift';
  // The API lifts by review and optional permission references only, never by person: a lift
  // offers "everything this review restricted" or specific references (SPK-IAM-005).
  const liftTarget: 'all' | 'grants' = target === 'grants' ? 'grants' : 'all';
  const restrictTarget: 'actor' | 'grants' = target === 'grants' ? 'grants' : 'actor';
  const effectiveTarget = kind === 'lift' ? liftTarget : restrictTarget;

  const reload = () => {
    decide.reset();
    void queryClient.invalidateQueries({ queryKey: REVIEW_KEY });
  };

  const submit = () => {
    setSuccess(null);
    const problems: Record<string, string> = {};
    if (!kind) problems['kind'] = 'Choose a decision.';
    if (kind === 'note' && !note.trim()) problems['note'] = 'Write the note.';
    if (targeting) {
      if (effectiveTarget === 'all') {
        // Nothing to check: every restriction this review placed.
      } else if (effectiveTarget === 'actor') {
        const a = referenceError(actor, true);
        if (a) problems['actor'] = a;
      } else {
        const ids = parseGrantIds(grantIds);
        if (ids.length === 0 || ids.some((id) => !isUuid(id))) {
          problems['grantIds'] = 'Enter one or more permission references, separated by spaces.';
        }
      }
    }
    let effectiveTo: string | null = null;
    if (kind === 'restrict') {
      if (!ends) problems['ends'] = 'Choose when the restriction ends.';
      if (ends === 'date') {
        effectiveTo = localInputToIso(until);
        if (!effectiveTo) problems['until'] = 'Enter the date and time the restriction ends.';
      }
    }
    if (kind === 'decide' && !outcome.trim()) problems['outcome'] = 'Summarize the outcome.';
    if (kind === 'reassign' && !ownerRole && !ownerPerson.trim()) {
      problems['owner'] = 'Choose a new owner role or person.';
    }
    if (kind === 'reassign' && ownerPerson.trim()) {
      const o = referenceError(ownerPerson, false);
      if (o) problems['ownerPerson'] = o;
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void decide
      .submit({
        path: { id: review.id },
        body: {
          kind: kind as DecisionKind,
          expectedRevision: review.revision,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(targeting && effectiveTarget === 'actor'
            ? { actorPersonId: actor.trim().toLowerCase() }
            : {}),
          ...(targeting && effectiveTarget === 'grants'
            ? { grantIds: parseGrantIds(grantIds) }
            : {}),
          ...(effectiveTo ? { effectiveTo } : {}),
          ...(kind === 'decide' ? { outcome: { summary: outcome.trim() } } : {}),
          ...(kind === 'reassign' && ownerRole ? { ownerRole: ownerRole as ReviewOwnerRole } : {}),
          ...(kind === 'reassign' && ownerPerson.trim()
            ? { ownerPersonId: ownerPerson.trim().toLowerCase() }
            : {}),
        },
      })
      .then((next) => {
        setSuccess(`Decision recorded: ${kind}. Review status: ${next.status}.`);
        setNote('');
        setOutcome('');
      })
      .catch(() => undefined);
  };

  if (!online) {
    return (
      <section className="panel" aria-labelledby="decision-title">
        <h3 id="decision-title">Record a decision</h3>
        <p>Offline: this review is read-only until you reconnect.</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="decision-title">
      <h3 id="decision-title">Record a decision</h3>
      <form
        noValidate
        className="form"
        aria-label="Record a decision"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Decision"
          required
          placeholder="Choose a decision"
          options={DECISION_KINDS}
          value={kind}
          onChange={setKind}
          error={errors['kind'] ?? apiErrors['kind']}
        />
        {targeting ? (
          <>
            <RadioGroup
              legend="Which permissions"
              name="target"
              required
              value={effectiveTarget}
              onChange={(v) => setTarget(v as 'actor' | 'grants' | 'all')}
              options={
                kind === 'lift'
                  ? [
                      { value: 'all', label: 'All restrictions placed by this review' },
                      {
                        value: 'grants',
                        label:
                          'Only the permissions with these references (others stay restricted)',
                      },
                    ]
                  : [
                      {
                        value: 'actor',
                        label: 'Every permission one person holds over the subject',
                      },
                      { value: 'grants', label: 'Specific permissions by reference' },
                    ]
              }
            />
            {effectiveTarget === 'all' ? null : effectiveTarget === 'actor' ? (
              <PersonReferenceField
                label="Person holding the permissions"
                required
                value={actor}
                onChange={setActor}
                error={errors['actor'] ?? apiErrors['actorPersonId']}
              />
            ) : (
              <TextAreaField
                label="Permission references"
                required
                value={grantIds}
                onChange={setGrantIds}
                error={errors['grantIds'] ?? apiErrors['grantIds']}
              />
            )}
          </>
        ) : null}
        {kind === 'restrict' ? (
          <>
            <RadioGroup
              legend="Restriction ends"
              name="ends"
              required
              value={ends}
              onChange={setEnds}
              error={errors['ends']}
              options={[
                { value: 'lifted', label: 'When it is lifted by a later decision' },
                { value: 'date', label: 'At a date and time' },
              ]}
            />
            {ends === 'date' ? (
              <TextField
                label="Ends at"
                type="datetime-local"
                required
                value={until}
                onChange={setUntil}
                error={errors['until'] ?? apiErrors['effectiveTo']}
              />
            ) : null}
          </>
        ) : null}
        {kind === 'decide' ? (
          <TextAreaField
            label="Outcome"
            required
            value={outcome}
            onChange={setOutcome}
            error={errors['outcome']}
          />
        ) : null}
        {kind === 'reassign' ? (
          <>
            <SelectField
              label="New owner role"
              placeholder="Keep the current role"
              options={REVIEW_OWNER_ROLES}
              value={ownerRole}
              onChange={setOwnerRole}
              error={errors['owner']}
            />
            <PersonReferenceField
              label="New owner person reference"
              hint="Optional."
              value={ownerPerson}
              onChange={setOwnerPerson}
              error={errors['ownerPerson'] ?? apiErrors['ownerPersonId']}
            />
          </>
        ) : null}
        <TextAreaField
          label="Note"
          required={kind === 'note'}
          hint="Kept in the decision history."
          value={note}
          onChange={setNote}
          error={errors['note'] ?? apiErrors['note']}
          maxLength={4000}
        />
        <Button type="submit" busy={decide.isProcessing}>
          Record decision
        </Button>
      </form>
      <CommandSuccess message={success} />
      <CommandError error={decide.error} onRetry={submit} onReload={reload} />
    </section>
  );
}

function ReviewQuery({ id }: { id: string }) {
  const review = useApiQuery({ path: '/access-reviews/{id}', request: { path: { id } } });
  return (
    <QueryBoundary
      query={review}
      label="the access review"
      empty={{ title: '', description: '' }}
      unavailableOffline={['recording decisions']}
    >
      {(data) => (
        <>
          <ReviewFacts review={data} />
          <DecisionForm review={data} />
        </>
      )}
    </QueryBoundary>
  );
}

export function AccessReviewScreen() {
  const { reviewId = '' } = useParams();
  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title">Access review</h2>
      <PeopleNav />
      <p>
        <Link to="/people/access-reviews">Back to access reviews</Link>
      </p>
      {isUuid(reviewId) ? <ReviewQuery id={reviewId} /> : <StateView variant="unavailable" />}
    </section>
  );
}
