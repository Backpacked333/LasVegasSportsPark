/**
 * SCR-S-22 Disputed access reviews, the queue (SPK-IAM-005, DEC-004, POL-023).
 *
 * - Reviews from `GET /v1/access-reviews` (default: every review that is not closed; filters by
 *   status and owning role), newest first, page by page: subject (as the API names them), reason,
 *   status as text, owning role and whether a person owns it, the end of the review's effect, how
 *   many permissions its restrictions suspend now, and the decisions its state allows
 *   (`allowedDecisions`, the API's, never computed here). The queue is for review deciders
 *   (`identity.read_access_review`); other roles see "not available to you", and an ACCESS_DENIED
 *   answer reads the same.
 * - Reviews escalated to support are the support cases with an `access_review` origin
 *   (`GET /v1/cases?origin=access_review`, filtered by the API), each linking to its review.
 * - A review opens by its reference too (for example from a case), and anyone who may open a review
 *   can start one. A shared household, address or surname is never evidence of authority.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { PeopleNav } from '../../features/people/PeopleNav';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/FormFields';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { REVIEW_OWNER_ROLES, type ReviewOwnerRole } from './OpenAccessReviewScreen';
import { REVIEW_STATUS_TONE } from './review-vocabulary';

type ReviewStatus = Schema<'AccessReviewSummary'>['status'];

export const REVIEWS_PAGE_SIZE = 25;
export const ESCALATED_PAGE_SIZE = 25;
export const READ_REVIEW_ACTION = 'identity.read_access_review';

const REVIEW_STATUSES: readonly ReviewStatus[] = ['open', 'escalated', 'decided', 'closed'];

function ReviewQueue({ status, ownerRole }: { status: string; ownerRole: string }) {
  const pages = useApiPages({
    path: '/access-reviews',
    request: {
      query: {
        limit: REVIEWS_PAGE_SIZE,
        ...(status ? { status: status as ReviewStatus } : {}),
        ...(ownerRole ? { ownerRole: ownerRole as ReviewOwnerRole } : {}),
      },
    },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="access reviews"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No reviews',
          description: status
            ? `No access review is ${status}.`
            : 'No access review is open, escalated or decided.',
        }}
        unavailableOffline={['recording decisions']}
      >
        {(items) => (
          <ul className="list" aria-label="Access reviews">
            {items.map((r) => (
              <li key={r.id}>
                <div className="row-text">
                  <Link to={`/people/access-reviews/${r.id}`} className="row-title">
                    {r.subjectDisplayName ?? 'Subject not available to you'}
                  </Link>
                  <span>{r.reason}</span>
                  <span className="caption">
                    owner {r.ownerRole}
                    {r.ownerPersonId ? ' (assigned)' : ' (unassigned)'} · opened{' '}
                    {formatDateTime(r.createdAt)} · in effect{' '}
                    {r.effectiveTo ? `until ${formatDateTime(r.effectiveTo)}` : 'until closed'}
                  </span>
                  <span className="caption">
                    {r.restrictedGrantCount} permission(s) restricted now · decisions available:{' '}
                    {r.allowedDecisions.length > 0 ? r.allowedDecisions.join(', ') : 'none'}
                  </span>
                </div>
                <span className="actions-row">
                  <StatusBadge tone={REVIEW_STATUS_TONE[r.status]} label={`Status: ${r.status}`} />
                  {r.restrictedGrantCount > 0 ? (
                    <StatusBadge tone="warning" label="Restriction in force" />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="access reviews" />
    </>
  );
}

function OpenReviews() {
  const permissions = usePermissions();
  const [status, setStatus] = useState('');
  const [ownerRole, setOwnerRole] = useState('');
  if (permissions.isPermitted(READ_REVIEW_ACTION) === false) {
    return (
      <StateView
        variant="unavailable"
        title="Not available to you"
        description="The review queue is for review owners. Open a review you started by its reference below."
      />
    );
  }
  return (
    <>
      <div className="actions-row" role="group" aria-label="Filter reviews">
        <SelectField
          label="Review status"
          placeholder="Open, escalated and decided"
          options={REVIEW_STATUSES.map((s) => ({ value: s, label: s }))}
          value={status}
          onChange={setStatus}
        />
        <SelectField
          label="Owning role"
          placeholder="Any role"
          options={REVIEW_OWNER_ROLES}
          value={ownerRole}
          onChange={setOwnerRole}
        />
      </div>
      <ReviewQueue key={`${status}|${ownerRole}`} status={status} ownerRole={ownerRole} />
    </>
  );
}

function EscalatedReviews() {
  const pages = useApiPages({
    path: '/cases',
    request: { query: { origin: 'access_review', limit: ESCALATED_PAGE_SIZE } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="escalated access reviews"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'None escalated',
          description: 'No access review has been escalated to support.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Escalated access reviews">
            {items.map((c) => (
              <li key={c.id}>
                <div className="row-text">
                  {c.origin ? (
                    <Link to={`/people/access-reviews/${c.origin.id}`}>{c.title}</Link>
                  ) : (
                    <span>{c.title}</span>
                  )}
                  <span className="caption">
                    owner {c.owner.queue ?? 'unassigned'} · opened {formatDateTime(c.createdAt)} ·{' '}
                    <Link to={`/admin/cases/${c.id}`}>Open the support case</Link>
                  </span>
                </div>
                <StatusBadge tone="neutral" label={`Case status: ${c.status}`} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="escalated cases" />
    </>
  );
}

export function AccessReviewsScreen() {
  const navigate = useNavigate();
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    if (!isUuid(reference)) {
      setError('Enter a review reference: 36 characters.');
      return;
    }
    setError(null);
    void navigate(`/people/access-reviews/${reference.trim().toLowerCase()}`);
  };
  return (
    <section aria-labelledby="reviews-title">
      <h2 id="reviews-title">Disputed access reviews</h2>
      <PeopleNav />
      <p className="caption">
        A restricted workflow for contradictory or disputed access. A shared household, address or
        surname is never treated as evidence of authority.
      </p>
      <p>
        <Link to="/people/access-reviews/new">Open a new review</Link>
      </p>
      <section className="panel" aria-labelledby="open-reviews-title">
        <h3 id="open-reviews-title">Reviews</h3>
        <OpenReviews />
        <form
          noValidate
          className="form"
          aria-label="Open a review by reference"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <TextField
            label="Review reference"
            required
            value={reference}
            onChange={setReference}
            error={error}
          />
          <Button type="submit">Open review</Button>
        </form>
      </section>
      <section className="panel" aria-labelledby="escalated-title">
        <h3 id="escalated-title">Escalated to support</h3>
        <EscalatedReviews />
      </section>
    </section>
  );
}
