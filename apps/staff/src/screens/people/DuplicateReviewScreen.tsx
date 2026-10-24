/**
 * SCR-S-23 Duplicate review and merge (SPK-IAM-007, §5.3, SPK-AT-024).
 *
 * The API has no read of duplicate candidates yet (neither a list nor one candidate), so the queue
 * is shown as not available; staff flag a pair (`POST /v1/duplicate-candidates`) and review it
 * here, comparing both records side by side (`GET /v1/people/{id}`). Merging names the survivor
 * explicitly and a reason, carries the candidate's expected revision and an idempotency key, and
 * moves participation, financial ownership, source identifiers and history without importing
 * unverified permissions (the API's rule). The merge operation is followed at
 * `GET /v1/operations/{id}`, and `recovery_required` is shown as needing attention. A refusal such
 * as conflicting ownership is shown with the API's code and the input is kept. Duplicates found
 * by data migration depend on DEC-014, DEC-067 and DEC-068 (pending).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useOperation } from '../../api/useOperation';
import { withServerDefaults } from '../../api/server-defaults';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { personName } from '../../features/people/people';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts, RadioGroup, TextAreaField } from '../../ui/FormFields';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

type DuplicateCandidate = Schema<'DuplicateCandidate'>;
type PersonMerge = Schema<'PersonMerge'>;

const OPERATION_TONE: Record<string, StatusTone> = {
  pending: 'pending',
  running: 'pending',
  succeeded: 'success',
  failed: 'danger',
  recovery_required: 'danger',
  compensated: 'warning',
};

function PersonColumn({ personId, label }: { personId: string; label: string }) {
  const person = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  return (
    <section className="panel" aria-label={label}>
      <h4>{label}</h4>
      {person.data ? (
        <>
          <p>
            <Link to={`/people/${personId}`}>{personName(person.data)}</Link>
          </p>
          <Facts
            items={[
              ['Kind', person.data.kind],
              ['Status', person.data.status],
              ['Date of birth', person.data.dateOfBirth ?? 'Not recorded'],
              [
                'Contact points',
                person.data.contactPoints.length > 0
                  ? person.data.contactPoints.map((c) => `${c.kind}: ${c.value}`).join('; ')
                  : 'None',
              ],
              ['Reference', <code key="id">{personId}</code>],
            ]}
          />
        </>
      ) : person.error ? (
        <StateView variant="unavailable" />
      ) : (
        <StateView variant="loading" label={label} />
      )}
    </section>
  );
}

function MergeOutcome({ merge }: { merge: PersonMerge }) {
  const operation = useOperation(merge.operationId);
  const status = operation.data?.status;
  return (
    <section className="panel" aria-label="Merge outcome">
      <CommandSuccess message="Merge recorded." />
      <p>
        Survivor: <Link to={`/people/${merge.survivorPersonId}`}>{merge.survivorPersonId}</Link>.
        Merged record: <code>{merge.mergedPersonId}</code>.
      </p>
      <Facts
        label="Moved to the survivor"
        items={Object.entries(merge.moved).map(
          ([k, v]) =>
            [k, typeof v === 'number' ? String(v) : JSON.stringify(v)] as [string, string],
        )}
      />
      {status ? (
        <p>
          <StatusBadge tone={OPERATION_TONE[status] ?? 'neutral'} label={`Operation: ${status}`} />
          {status === 'recovery_required'
            ? ' The merge needs attention: an administrator must complete or reverse it before the records are used.'
            : ''}
        </p>
      ) : null}
    </section>
  );
}

function CandidateReview({
  candidate,
  onChange,
  onStartAgain,
}: {
  candidate: DuplicateCandidate;
  onChange: (c: DuplicateCandidate) => void;
  /** The API has no read of one candidate: a stale candidate is reviewed again from the start. */
  onStartAgain: () => void;
}) {
  const { online } = useApp();
  const [survivor, setSurvivor] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [merged, setMerged] = useState<PersonMerge | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const merge = useApiCommand('post', '/duplicate-candidates/{id}/merge');
  const dismiss = useApiCommand('post', '/duplicate-candidates/{id}/dismiss');
  const open = candidate.status === 'open' && !merged;

  const doMerge = () => {
    const problems: Record<string, string> = {};
    if (!survivor) problems['survivor'] = 'Choose which record survives.';
    if (!reason.trim()) problems['reason'] = 'Write why these records are the same person.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void merge
      .submit({
        path: { id: candidate.id },
        body: {
          survivorPersonId: survivor,
          reason: reason.trim(),
          expectedRevision: candidate.revision,
        },
      })
      .then(setMerged)
      .catch(() => undefined);
  };
  const doDismiss = () => {
    if (!reason.trim()) {
      setErrors({ reason: 'Write why these records are different people.' });
      return;
    }
    setErrors({});
    void dismiss
      .submit({
        path: { id: candidate.id },
        body: { reason: reason.trim(), expectedRevision: candidate.revision },
      })
      .then((c) => {
        onChange(c);
        setSuccess(`Candidate ${c.status}.`);
      })
      .catch(() => undefined);
  };

  return (
    <section className="panel" aria-labelledby="candidate-title">
      <h3 id="candidate-title">Candidate</h3>
      <span className="actions-row">
        <StatusBadge
          tone={candidate.status === 'open' ? 'pending' : 'neutral'}
          label={`Status: ${candidate.status}`}
        />
      </span>
      <Facts
        items={[
          ['Reasons', candidate.reasons.join('; ')],
          ['Score', String(candidate.score)],
          ['Reference', <code key="id">{candidate.id}</code>],
        ]}
      />
      <div className="facts">
        <PersonColumn personId={candidate.personAId} label="Record A" />
        <PersonColumn personId={candidate.personBId} label="Record B" />
      </div>
      {open ? (
        <form
          noValidate
          className="form"
          aria-label="Decide this candidate"
          onSubmit={(event) => {
            event.preventDefault();
            doMerge();
          }}
        >
          <RadioGroup
            legend="Surviving record"
            name="survivor"
            required
            value={survivor}
            onChange={setSurvivor}
            error={errors['survivor']}
            options={[
              { value: candidate.personAId, label: 'Record A survives' },
              { value: candidate.personBId, label: 'Record B survives' },
            ]}
          />
          <p className="caption">
            Merging moves participation, financial ownership, source identifiers and history to the
            survivor. Permissions that were never verified are not carried over.
          </p>
          <TextAreaField
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            error={errors['reason']}
            maxLength={2000}
          />
          <div className="actions-row">
            <Button type="submit" busy={merge.isProcessing} disabled={!online}>
              Merge records
            </Button>
            <Button
              variant="secondary"
              busy={dismiss.isProcessing}
              disabled={!online}
              onClick={doDismiss}
            >
              Not the same person
            </Button>
          </div>
          {!online ? <p className="caption">Merging needs a connection.</p> : null}
        </form>
      ) : null}
      <CommandSuccess message={success} />
      <CommandError error={merge.error} onRetry={doMerge} onReload={onStartAgain} />
      <CommandError error={dismiss.error} onRetry={doDismiss} onReload={onStartAgain} />
      {merged ? <MergeOutcome merge={merged} /> : null}
    </section>
  );
}

export function DuplicateReviewScreen() {
  const { online } = useApp();
  const [params] = useSearchParams();
  const initialA = params.get('personA') ?? '';
  const [personA, setPersonA] = useState(isUuid(initialA) ? initialA : '');
  const [personB, setPersonB] = useState('');
  const [reasons, setReasons] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [candidate, setCandidate] = useState<DuplicateCandidate | null>(null);
  const flag = useApiCommand('post', '/duplicate-candidates');

  const submit = () => {
    const problems: Record<string, string> = {};
    const a = referenceError(personA, true);
    const b = referenceError(personB, true);
    if (a) problems['personA'] = a;
    if (b) problems['personB'] = b;
    if (!a && !b && personA.trim().toLowerCase() === personB.trim().toLowerCase()) {
      problems['personB'] = 'Choose two different records.';
    }
    const lines = reasons
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) problems['reasons'] = 'Give at least one reason, one per line.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void flag
      .submit({
        // The API sets the score of a manually flagged pair (its default).
        body: withServerDefaults<Schema<'FlagDuplicateRequest'>, 'score'>({
          personAId: personA.trim().toLowerCase(),
          personBId: personB.trim().toLowerCase(),
          reasons: lines,
        }),
      })
      .then(setCandidate)
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="duplicates-title">
      <h2 id="duplicates-title">Duplicate review</h2>
      <PeopleNav />
      <section className="panel" aria-labelledby="queue-title">
        <h3 id="queue-title">Candidates</h3>
        <StateView
          variant="unavailable"
          title="The candidate list is not available yet"
          description="The API cannot list duplicate candidates yet. Flag a pair below to review and merge it."
        />
        <StateView
          variant="pending-decision"
          subject="Reviewing duplicates found by data migration"
          decisions={['DEC-014', 'DEC-067', 'DEC-068']}
          owner="Migration owner/operator"
        />
      </section>
      {candidate ? (
        <CandidateReview
          candidate={candidate}
          onChange={setCandidate}
          onStartAgain={() => setCandidate(null)}
        />
      ) : (
        <section className="panel" aria-labelledby="flag-title">
          <h3 id="flag-title">Flag a possible duplicate</h3>
          <form
            noValidate
            className="form"
            aria-label="Flag a possible duplicate"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <PersonReferenceField
              label="Record A reference"
              required
              value={personA}
              onChange={setPersonA}
              error={errors['personA']}
            />
            <PersonReferenceField
              label="Record B reference"
              required
              value={personB}
              onChange={setPersonB}
              error={errors['personB']}
            />
            <TextAreaField
              label="Why they may be the same person"
              required
              hint="One reason per line."
              value={reasons}
              onChange={setReasons}
              error={errors['reasons']}
            />
            <Button type="submit" busy={flag.isProcessing} disabled={!online}>
              Flag for review
            </Button>
          </form>
          <CommandError error={flag.error} onRetry={submit} />
        </section>
      )}
    </section>
  );
}
