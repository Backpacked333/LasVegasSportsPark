/**
 * SCR-S-23 Duplicate candidate review and merge (SPK-IAM-007, §5.3, SPK-AT-024).
 *
 * - One candidate from `GET /v1/duplicate-candidates/{id}`: the detection reasons and score, its
 *   status, and both records side by side as the API gives a reviewer to compare them (name, kind,
 *   status, date of birth, whether a login account is linked, which kinds of contact point each
 *   holds). A child is compared by given name, kind and status only (§4.14).
 * - Merging names the survivor explicitly and a reason, carries the candidate's expected revision
 *   and an idempotency key, and moves participation, financial ownership, source identifiers and
 *   history without importing unverified permissions (the API's rule). The merge operation is
 *   followed at `GET /v1/operations/{id}`; `recovery_required` is shown as needing attention.
 *   Dismissing ("not the same person") needs a reason. Merge is offered to roles holding
 *   `identity.merge_persons` and dismiss to roles holding `identity.dismiss_duplicate`
 *   (GET /v1/me/permissions); the API decides either way. STALE_REVISION or INVALID_TRANSITION
 *   offers "Reload", which re-reads the candidate; a refusal (for example conflicting financial
 *   ownership) is shown with the API's code and the input is kept. Offline, nothing is offered.
 * - The candidate's audit history is offered to roles that may read the audit log. A candidate
 *   the viewer may not read is "not available".
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useOperation } from '../../api/useOperation';
import { PeopleNav } from '../../features/people/PeopleNav';
import { displayName, KEPT_NOT_SHOWN } from '../../features/people/people';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts, RadioGroup, TextAreaField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { AuditHistory } from '../today/AuditHistory';
import { CANDIDATES_KEY, CANDIDATE_STATUS_TONE } from './DuplicateReviewScreen';

type CandidateDetail = Schema<'DuplicateCandidateDetail'>;
type PersonSide = CandidateDetail['personA'];
type PersonMerge = Schema<'PersonMerge'>;

export const CANDIDATE_KEY = ['api', '/duplicate-candidates/{id}'] as const;
export const MERGE_ACTION = 'identity.merge_persons';
export const DISMISS_ACTION = 'identity.dismiss_duplicate';

const OPERATION_TONE: Record<string, StatusTone> = {
  pending: 'pending',
  running: 'pending',
  succeeded: 'success',
  failed: 'danger',
  recovery_required: 'danger',
  compensated: 'warning',
};

function PersonColumn({ person, label }: { person: PersonSide; label: string }) {
  const child = person.kind === 'child';
  return (
    <section className="panel" aria-label={label}>
      <h4>{label}</h4>
      <p>
        <Link to={`/people/${person.personId}`}>{displayName(person)}</Link>
      </p>
      <Facts
        items={
          child
            ? [
                // §4.14: a child is compared by given name, kind and status only.
                ['Kind', person.kind],
                ['Status', person.status],
                ['Date of birth and contacts', KEPT_NOT_SHOWN],
                ['Login account', person.accountLinked ? 'Linked' : 'None'],
                ['Reference', <code key="id">{person.personId}</code>],
              ]
            : [
                ['Kind', person.kind],
                ['Status', person.status],
                ['Date of birth', person.dateOfBirth ?? 'Not recorded'],
                ['Login account', person.accountLinked ? 'Linked' : 'None'],
                [
                  'Contact point kinds',
                  person.contactPointKinds.length > 0
                    ? person.contactPointKinds.join(', ')
                    : 'None',
                ],
                ['Reference', <code key="id">{person.personId}</code>],
              ]
        }
      />
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

function CandidateReview({ candidate }: { candidate: CandidateDetail }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [survivor, setSurvivor] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [merged, setMerged] = useState<PersonMerge | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const invalidate = [CANDIDATE_KEY, CANDIDATES_KEY];
  const merge = useApiCommand('post', '/duplicate-candidates/{id}/merge', { invalidate });
  const dismiss = useApiCommand('post', '/duplicate-candidates/{id}/dismiss', { invalidate });
  const canMerge = permissions.isPermitted(MERGE_ACTION) !== false;
  const canDismiss = permissions.isPermitted(DISMISS_ACTION) !== false;
  const open = candidate.status === 'open' && !merged;
  const reload = () => {
    merge.reset();
    dismiss.reset();
    void Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };

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
      .then((c) => setSuccess(`Candidate ${c.status}.`))
      .catch(() => undefined);
  };

  return (
    <section className="panel" aria-labelledby="candidate-title">
      <h3 id="candidate-title">Candidate</h3>
      <span className="actions-row">
        <StatusBadge
          tone={CANDIDATE_STATUS_TONE[candidate.status]}
          label={`Status: ${candidate.status}`}
        />
      </span>
      <Facts
        items={[
          ['Reasons', candidate.reasons.join('; ')],
          ['Score', String(candidate.score)],
          ['Flagged', formatDateTime(candidate.createdAt)],
          ['Decided', candidate.decidedAt ? formatDateTime(candidate.decidedAt) : 'Not yet'],
          ['Reference', <code key="id">{candidate.id}</code>],
        ]}
      />
      <div className="facts">
        <PersonColumn person={candidate.personA} label="Record A" />
        <PersonColumn person={candidate.personB} label="Record B" />
      </div>
      {open && online && (canMerge || canDismiss) ? (
        <form
          noValidate
          className="form"
          aria-label="Decide this candidate"
          onSubmit={(event) => {
            event.preventDefault();
            doMerge();
          }}
        >
          {canMerge ? (
            <>
              <RadioGroup
                legend="Surviving record"
                name="survivor"
                required
                value={survivor}
                onChange={setSurvivor}
                error={errors['survivor']}
                options={[
                  { value: candidate.personA.personId, label: 'Record A survives' },
                  { value: candidate.personB.personId, label: 'Record B survives' },
                ]}
              />
              <p className="caption">
                Merging moves participation, financial ownership, source identifiers and history to
                the survivor. Permissions that were never verified are not carried over.
              </p>
            </>
          ) : null}
          <TextAreaField
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            error={errors['reason']}
            maxLength={2000}
          />
          <div className="actions-row">
            {canMerge ? (
              <Button type="submit" busy={merge.isProcessing}>
                Merge records
              </Button>
            ) : null}
            {canDismiss ? (
              <Button variant="secondary" busy={dismiss.isProcessing} onClick={doDismiss}>
                Not the same person
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {open && !online ? (
        <p className="caption">Merging and dismissing need a connection.</p>
      ) : null}
      {open && online && !canMerge && !canDismiss ? (
        <p className="caption">Merging and dismissing candidates are not available to you.</p>
      ) : null}
      <CommandSuccess message={success} />
      <CommandError error={merge.error} onRetry={doMerge} onReload={reload} />
      <CommandError error={dismiss.error} onRetry={doDismiss} onReload={reload} />
      {merged ? <MergeOutcome merge={merged} /> : null}
    </section>
  );
}

function CandidateQuery({ id }: { id: string }) {
  const candidate = useApiQuery({ path: '/duplicate-candidates/{id}', request: { path: { id } } });
  return (
    <QueryBoundary
      query={candidate}
      label="the duplicate candidate"
      empty={{ title: '', description: '' }}
      unavailableOffline={['merging and dismissing']}
    >
      {(data) => (
        <>
          <CandidateReview candidate={data} />
          <AuditHistory targetType="duplicate_candidate" targetId={data.id} />
        </>
      )}
    </QueryBoundary>
  );
}

export function DuplicateCandidateScreen() {
  const { candidateId = '' } = useParams();
  return (
    <section aria-labelledby="candidate-screen-title">
      <h2 id="candidate-screen-title">Duplicate review</h2>
      <PeopleNav />
      <p>
        <Link to="/people/duplicates">Back to duplicate candidates</Link>
      </p>
      {isUuid(candidateId) ? (
        <CandidateQuery id={candidateId} />
      ) : (
        <StateView variant="unavailable" />
      )}
    </section>
  );
}
