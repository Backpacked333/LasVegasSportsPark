/**
 * SCR-S-22 Disputed access reviews, the queue (SPK-IAM-005, DEC-004, POL-023). The API has no list
 * of access reviews, so open reviews are shown as not available; reviews that were escalated
 * became support cases with an `access_review` origin (`GET /v1/cases?category=access`) and are
 * listed from there. Any review opens by its reference; a review the viewer may not see is the
 * API's protected NOT_FOUND, shown as not available.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { PeopleNav } from '../../features/people/PeopleNav';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';

function EscalatedReviews() {
  const cases = useApiQuery({
    path: '/cases',
    request: { query: { category: 'access', limit: 50 } },
  });
  return (
    <QueryBoundary
      query={cases}
      label="escalated access reviews"
      empty={{ title: '', description: '' }}
    >
      {(page) => {
        const escalated = page.items.filter((c) => c.origin?.type === 'access_review');
        if (escalated.length === 0) return <p>No access review has been escalated to support.</p>;
        return (
          <ul className="list" aria-label="Escalated access reviews">
            {escalated.map((c) => (
              <li key={c.id}>
                <div className="row-text">
                  <Link to={`/people/access-reviews/${c.origin?.id ?? ''}`}>{c.title}</Link>
                  <span className="caption">
                    Case {c.status} · owner {c.owner.queue ?? 'unassigned'} · opened{' '}
                    {formatDateTime(c.createdAt)}
                  </span>
                </div>
                <StatusBadge tone="neutral" label={`Case status: ${c.status}`} />
              </li>
            ))}
          </ul>
        );
      }}
    </QueryBoundary>
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
        <h3 id="open-reviews-title">Open reviews</h3>
        <StateView
          variant="unavailable"
          title="The list of open reviews is not available yet"
          description="The API cannot list access reviews yet. Open a review by its reference, or from an escalated case below."
        />
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
