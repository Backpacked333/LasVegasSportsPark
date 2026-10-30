/**
 * SCR-S-22 Disputed access review (SPK-IAM-005, DEC-004, POL-023). One review from
 * `GET /v1/access-reviews/{id}`: subject, reason, parties, evidence references, owner, effective
 * dates, escalation and the full decision history. Decisions (restrict, lift, escalate, decide,
 * close, note, reassign) are recorded with `POST /v1/access-reviews/{id}/decisions`, the review's
 * expected revision and an idempotency key. Only the decisions the API lists in the review's
 * `allowedDecisions` are offered (empty for a reader who may not decide, or a closed review); the
 * API still answers INVALID_TRANSITION or STALE_REVISION, which offer "Reload" and keep the typed
 * input. People are named from `GET /v1/person-names` (a person the viewer may not view reads "not
 * available"). Decisions the system recorded (the end of a restriction window) say so. The
 * review's audit history is offered to roles that may read the audit log.
 *
 * Temporary restrictions state their end explicitly ("until lifted" or a date): a restriction is
 * never given an end the reviewer did not choose. A restriction names one person's permissions
 * over the subject or chosen ones; a lift ends all of this review's restrictions, those on one
 * person's permissions, or chosen ones. Permissions are chosen from the subject's authority
 * (`GET /v1/people/{id}/authority`) where the viewer may read it, each with its holder and state;
 * otherwise by reference. Nothing is inferred from household membership.
 * The workflow is restricted: a review the viewer may not see is shown as not available, and
 * offline the review is read-only.
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import {
  PersonName,
  personNameText,
  usePeopleNames,
  type PeopleNames,
} from '../../features/people/names';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../ui/CommandFeedback';
import {
  CheckboxGroup,
  Facts,
  RadioGroup,
  SelectField,
  TextAreaField,
  TextField,
} from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime, localInputToIso } from '../../ui/time';
import { AuditHistory } from '../today/AuditHistory';
import { REVIEW_OWNER_ROLES, type ReviewOwnerRole } from './OpenAccessReviewScreen';
import { DECISION_KINDS, REVIEW_STATUS_TONE, type DecisionKind } from './review-vocabulary';

type AccessReview = Schema<'AccessReview'>;

const REVIEW_KEY = ['api', '/access-reviews/{id}'] as const;

export { DECISION_KINDS };

function ReviewFacts({ review, names }: { review: AccessReview; names: PeopleNames }) {
  return (
    <>
      <span className="actions-row">
        <StatusBadge tone={REVIEW_STATUS_TONE[review.status]} label={`Status: ${review.status}`} />
      </span>
      <Facts
        label="Review"
        items={[
          ['Subject', <PersonName key="s" id={review.subjectPersonId} names={names} />],
          ['Reason', review.reason],
          ['Owner role', review.ownerRole],
          [
            'Owner person',
            review.ownerPersonId ? (
              <PersonName key="o" id={review.ownerPersonId} names={names} />
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
                {p.personId ? <PersonName id={p.personId} names={names} /> : null}
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
                    {d.bySystem ? ' · recorded by the system' : ''}
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

type GrantView = Schema<'GrantView'>;

/**
 * The permissions held over the review's subject, from the subject's authority
 * (`GET /v1/people/{id}/authority`, `identity.read_authority`), read only while the reviewer is
 * choosing permissions. `grants` is null while the checkbox list is not shown (no read, still
 * loading, failed or nothing held): references are typed instead.
 */
function useSubjectGrants(subjectPersonId: string, wanted: boolean): GrantView[] | null {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted('identity.read_authority');
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: subjectPersonId } },
    enabled: wanted && permitted === true,
  });
  if (!authority.data) return null;
  const grants = authority.data.grants.filter(
    (g) => g.subjectPersonId === subjectPersonId && g.status !== 'revoked' && g.status !== 'ended',
  );
  return grants.length > 0 ? grants : null;
}

/**
 * The permissions chosen one by one, each with its holder (named through
 * `GET /v1/person-names`, a child by given name only, never the grant's composed display name)
 * and state. Where the subject's authority is not readable, permission references are entered.
 */
function GrantChoice({
  grants,
  selected,
  onSelected,
  text,
  onText,
  error,
}: {
  grants: readonly GrantView[] | null;
  selected: readonly string[];
  onSelected: (ids: string[]) => void;
  text: string;
  onText: (value: string) => void;
  error: string | undefined;
}) {
  const names = usePeopleNames((grants ?? []).map((g) => g.actorPersonId));
  if (grants) {
    const holder = (id: string) =>
      personNameText(names, id) ??
      (names.get(id) === undefined && !names.failed
        ? 'a person (loading the name)'
        : names.failed && names.error && presentationForError(names.error) !== 'unavailable'
          ? `a person (name could not be loaded: ${names.error.code})`
          : 'a person not available to you');
    return (
      <CheckboxGroup
        legend="Permissions"
        hint="Choose each permission; the others are not affected."
        options={grants.map((g) => ({
          value: g.grantId,
          label: `${g.permission} held by ${holder(g.actorPersonId)} · state ${g.status}${g.underReview ? ' · under review' : ''}`,
        }))}
        value={selected}
        onChange={onSelected}
        error={error}
      />
    );
  }
  return (
    <TextAreaField
      label="Permission references"
      required
      hint="Separated by spaces, as shown on the person's household, relationships and grants."
      value={text}
      onChange={onText}
      error={error}
    />
  );
}

function DecisionForm({ review }: { review: AccessReview }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [restrictTarget, setRestrictTarget] = useState<'actor' | 'grants'>('actor');
  const [liftTarget, setLiftTarget] = useState<'all' | 'actor' | 'grants'>('all');
  const [actor, setActor] = useState('');
  const [grantIds, setGrantIds] = useState('');
  const [chosenGrants, setChosenGrants] = useState<string[]>([]);
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
  // A lift ends only this review's restrictions: all of them, those on one person's permissions
  // over the subject (ID-08: naming a person never lifts another person's), or named permissions
  // (SPK-IAM-005). A restriction names one person's permissions or specific ones.
  const effectiveTarget = kind === 'lift' ? liftTarget : restrictTarget;
  const grants = useSubjectGrants(
    review.subjectPersonId,
    targeting && effectiveTarget === 'grants',
  );
  // Only the control on screen is sent: the ticked permissions while the list is shown, the typed
  // references otherwise (text typed before the list appeared is never sent hidden).
  const grantIdList = grants
    ? chosenGrants.filter((id) => grants.some((g) => g.grantId === id))
    : parseGrantIds(grantIds);

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
      } else if (grantIdList.length === 0 || grantIdList.some((id) => !isUuid(id))) {
        problems['grantIds'] = 'Choose or enter one or more permissions.';
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
          ...(targeting && effectiveTarget === 'grants' ? { grantIds: grantIdList } : {}),
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

  // Only what the API lists for this review now (SPK-IAM-005); never more.
  const allowed = DECISION_KINDS.filter((k) => review.allowedDecisions.includes(k.value));
  if (allowed.length === 0) {
    return (
      <section className="panel" aria-labelledby="decision-title">
        <h3 id="decision-title">Record a decision</h3>
        <CommandSuccess message={success} />
        <p>
          {review.status === 'closed'
            ? 'This review is closed; it takes no further decisions.'
            : 'No decision on this review is available to you now.'}
        </p>
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
          options={allowed}
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
              onChange={(v) =>
                kind === 'lift'
                  ? setLiftTarget(v as 'all' | 'actor' | 'grants')
                  : setRestrictTarget(v as 'actor' | 'grants')
              }
              options={
                kind === 'lift'
                  ? [
                      { value: 'all', label: 'All restrictions placed by this review' },
                      {
                        value: 'actor',
                        label:
                          'Only the restrictions on one person’s permissions over the subject (others stay restricted)',
                      },
                      {
                        value: 'grants',
                        label: 'Only the permissions chosen (others stay restricted)',
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
              <GrantChoice
                grants={grants}
                selected={chosenGrants}
                onSelected={setChosenGrants}
                text={grantIds}
                onText={setGrantIds}
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

function ReviewView({ review }: { review: AccessReview }) {
  const names = usePeopleNames([
    review.subjectPersonId,
    review.ownerPersonId,
    ...review.parties.map((p) => p.personId),
  ]);
  return (
    <>
      <ReviewFacts review={review} names={names} />
      <DecisionForm review={review} />
      <AuditHistory targetType="access_review" targetId={review.id} />
    </>
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
      {(data) => <ReviewView review={data} />}
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
