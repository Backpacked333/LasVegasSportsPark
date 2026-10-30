/**
 * Find a person for a reference field (`GET /v1/people?query=`, ID-03; SPK-IAM-002, §4.14): staff
 * search by name prefix or exact contact and get names only (no date of birth, no contact detail).
 * Results are the API's keyset pages with "Load more", so further matches are never cut off
 * silently (§4.5). Choosing a result fills the reference; the search text is never put in a
 * dashboard URL or logged. A viewer without the lookup permission sees "not available" and keeps
 * the reference field.
 *
 * The search sits inside command forms (a basket, a line, a credit): Enter in its field searches
 * and never submits the enclosing form, so a half-typed name can never send a command without the
 * person it was meant to name.
 *
 * `PersonReferenceField` is the reference input with the search beside it, used for every person
 * a registration or finance screen asks for (SCR-S-25, SCR-S-27, SCR-S-35 to SCR-S-37).
 */
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';
import { TextField } from './fields';
import { PersonName } from './names';

export const PERSON_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PersonSearch({
  label,
  onChoose,
}: {
  /** Whose reference is being found, e.g. "Household adult". */
  label: string;
  onChoose: (personId: string) => void;
}) {
  const who = label.toLowerCase();
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const results = useApiPages({
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
    <div role="group" aria-label={`Find the ${who}`}>
      <div className="rf-grid">
        <TextField
          label={`Find the ${who} by name or contact`}
          value={text}
          onChange={setText}
          onEnter={search}
          error={tooShort ? 'Enter at least two characters.' : null}
        />
        <Button variant="secondary" onClick={search} aria-label={`Search for the ${who}`}>
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
        results.data.length === 0 ? (
          <p className="caption">Nobody matches. Check the spelling, or enter a reference.</p>
        ) : (
          <>
            <ul className="list" aria-label={`People matching for the ${who}`}>
              {results.data.map((p) => (
                <li key={p.id}>
                  <span>
                    {p.givenName} {p.familyName} <span className="caption">({p.kind})</span>{' '}
                    {p.status !== 'active' ? <StatusBadge tone="neutral" label={p.status} /> : null}
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={`Use ${p.givenName} ${p.familyName} as the ${who}`}
                    onClick={() => onChoose(p.id)}
                  >
                    Use
                  </Button>
                </li>
              ))}
            </ul>
            <LoadMore pages={results} label={`people matching for the ${who}`} />
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * A person reference field that shows whose record it is once the reference is complete, and the
 * person search while it is not. The reference stays editable, so a person the viewer may not
 * search for can still be entered by reference.
 */
export function PersonReferenceField({
  label,
  person = label,
  value,
  onChange,
  error,
  required,
  hint,
}: {
  /** The reference field's label, e.g. "Customer reference". */
  label: string;
  /** Whose reference it is, e.g. "Customer"; default: the label. */
  person?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
}) {
  const valid = PERSON_REFERENCE.test(value.trim());
  return (
    <div>
      <TextField
        label={label}
        required={required}
        hint={hint}
        value={value}
        onChange={onChange}
        error={error}
      />
      {valid ? (
        <p className="caption" aria-live="polite">
          {person}: <PersonName id={value.trim()} />
        </p>
      ) : (
        <PersonSearch label={person} onChoose={onChange} />
      )}
    </div>
  );
}
