/**
 * Find a person for a reference field (`GET /v1/people?query=`, ID-03; SPK-IAM-002, §4.14): staff
 * search by name prefix or exact contact and get names only (no date of birth, no contact detail).
 * Choosing a result fills the reference; the search text is never put in a URL or logged. A
 * viewer without the lookup permission sees "not available" and keeps the reference field.
 */
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { TextField } from './fields';

export function PersonSearch({
  label,
  onChoose,
}: {
  /** Whose reference is being found, e.g. "Household adult". */
  label: string;
  onChoose: (personId: string) => void;
}) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const results = useApiQuery({
    path: '/people',
    request: { query: { query: term, limit: 10 } },
    enabled: term.length >= 2,
  });
  const search = () => {
    const value = text.trim();
    if (value.length < 2) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    setTerm(value);
  };
  return (
    <div role="group" aria-label={`Find the ${label.toLowerCase()}`}>
      <div className="rf-grid">
        <TextField
          label={`Find the ${label.toLowerCase()} by name or contact`}
          value={text}
          onChange={setText}
          error={tooShort ? 'Enter at least two characters.' : null}
        />
        <Button
          variant="secondary"
          onClick={search}
          aria-label={`Search for the ${label.toLowerCase()}`}
        >
          Search
        </Button>
      </div>
      {term && results.error ? (
        <p className="caption">
          {presentationForError(results.error) === 'unavailable'
            ? 'Person search is not available to you; enter the person reference instead.'
            : `The search did not answer (${results.error.code}); enter the person reference instead.`}
        </p>
      ) : null}
      {term && results.data ? (
        results.data.items.length === 0 ? (
          <p className="caption">Nobody matches. Check the spelling, or enter a reference.</p>
        ) : (
          <ul className="list" aria-label={`People matching for the ${label.toLowerCase()}`}>
            {results.data.items.map((p) => (
              <li key={p.id}>
                <span>
                  {p.givenName} {p.familyName} <span className="caption">({p.kind})</span>{' '}
                  {p.status !== 'active' ? <StatusBadge tone="neutral" label={p.status} /> : null}
                </span>
                <Button
                  variant="secondary"
                  aria-label={`Use ${p.givenName} ${p.familyName} as the ${label.toLowerCase()}`}
                  onClick={() => onChoose(p.id)}
                >
                  Use
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
