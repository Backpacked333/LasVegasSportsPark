/**
 * SCR-S-23 Duplicate review, the queue (SPK-IAM-007, §5.3, SPK-AT-024).
 *
 * - Candidates from `GET /v1/duplicate-candidates` by status (open by default, merged, dismissed),
 *   newest first, page by page: both people by name (a child by given name only, §4.14), the
 *   detection reasons and score, and the status as text. Each opens the candidate review
 *   (`DuplicateCandidateScreen`). The queue is for roles holding `identity.read_duplicates`;
 *   others see "not available to you" (an ACCESS_DENIED answer reads the same) and can still flag
 *   a pair.
 * - Flagging a pair (`POST /v1/duplicate-candidates`) validates two different person references
 *   before any request, leaves the score to the API and opens the candidate it returns.
 * - Duplicates found by data migration depend on DEC-014, DEC-067 and DEC-068 (pending).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { withServerDefaults } from '../../api/server-defaults';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import { displayName } from '../../features/people/people';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError } from '../../ui/CommandFeedback';
import { SelectField, TextAreaField } from '../../ui/FormFields';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';

type CandidateStatus = Schema<'DuplicateCandidate'>['status'];

export const CANDIDATES_PAGE_SIZE = 25;
export const READ_DUPLICATES_ACTION = 'identity.read_duplicates';
export const CANDIDATES_KEY = ['api', '/duplicate-candidates'] as const;

export const CANDIDATE_STATUS_TONE: Record<CandidateStatus, StatusTone> = {
  open: 'pending',
  merged: 'success',
  dismissed: 'neutral',
};

const CANDIDATE_STATUSES: readonly CandidateStatus[] = ['open', 'merged', 'dismissed'];

function CandidateQueue({ status }: { status: CandidateStatus }) {
  const pages = useApiPages({
    path: '/duplicate-candidates',
    request: { query: { status, limit: CANDIDATES_PAGE_SIZE } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="duplicate candidates"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No candidates', description: `No duplicate candidate is ${status}.` }}
        unavailableOffline={['merging and dismissing']}
      >
        {(items) => (
          <ul className="list" aria-label="Duplicate candidates">
            {items.map((c) => (
              <li key={c.id}>
                <div className="row-text">
                  <Link to={`/people/duplicates/${c.id}`} className="row-title">
                    {displayName(c.personA)} and {displayName(c.personB)}
                  </Link>
                  <span className="caption">
                    {c.reasons.join('; ')} · score {c.score} · flagged {formatDateTime(c.createdAt)}
                  </span>
                </div>
                <StatusBadge tone={CANDIDATE_STATUS_TONE[c.status]} label={`Status: ${c.status}`} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="candidates" />
    </>
  );
}

function Candidates() {
  const permissions = usePermissions();
  const [status, setStatus] = useState<CandidateStatus>('open');
  if (permissions.isPermitted(READ_DUPLICATES_ACTION) === false) {
    return (
      <StateView
        variant="unavailable"
        title="Not available to you"
        description="The candidate list is not available to your role. You can still flag a possible duplicate below."
      />
    );
  }
  return (
    <>
      <SelectField
        label="Candidate status"
        options={CANDIDATE_STATUSES.map((s) => ({ value: s, label: s }))}
        value={status}
        onChange={(v) => setStatus(v as CandidateStatus)}
      />
      <CandidateQueue key={status} status={status} />
    </>
  );
}

function FlagForm() {
  const { online } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialA = params.get('personA') ?? '';
  const [personA, setPersonA] = useState(isUuid(initialA) ? initialA : '');
  const [personB, setPersonB] = useState('');
  const [reasons, setReasons] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const flag = useApiCommand('post', '/duplicate-candidates', { invalidate: [CANDIDATES_KEY] });

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
      .then((c) => navigate(`/people/duplicates/${c.id}`))
      .catch(() => undefined);
  };

  return (
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
      {!online ? <p className="caption">Flagging needs a connection.</p> : null}
      <CommandError error={flag.error} onRetry={submit} />
    </section>
  );
}

export function DuplicateReviewScreen() {
  return (
    <section aria-labelledby="duplicates-title">
      <h2 id="duplicates-title">Duplicate review</h2>
      <PeopleNav />
      <section className="panel" aria-labelledby="queue-title">
        <h3 id="queue-title">Candidates</h3>
        <Candidates />
        <StateView
          variant="pending-decision"
          subject="Reviewing duplicates found by data migration"
          decisions={['DEC-014', 'DEC-067', 'DEC-068']}
          owner="Migration owner/operator"
        />
      </section>
      <FlagForm />
    </section>
  );
}
