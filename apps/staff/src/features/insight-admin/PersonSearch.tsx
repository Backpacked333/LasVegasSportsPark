/**
 * Find a staff person by name for the Administration screens (SCR-S-46: assigning staff roles,
 * the staff membership person filter, the audit actor filter; `GET /v1/people`, ID-03;
 * SPK-IAM-002, §4.14). Staff search by name prefix or exact contact and get names only (no date of
 * birth, no contact detail); the search asks for adult person records only, so a child record is
 * never listed here. Results are the API's keyset pages with "Load more" (§4.5). Choosing a result
 * fills the person id; the search text stays in page state, never in the dashboard address, and is
 * never logged. A viewer the API refuses sees "not available to you" and can still enter an id.
 *
 * The search sits inside forms (assigning roles, filters): Enter in its field searches and never
 * submits the enclosing form, so a half-typed name can never send a command.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError } from './feedback';
import { TextField } from './fields';
import { UUID_PATTERN } from './format';

type PersonStatus = Schema<'PersonStatus'>;

export interface ChosenPerson {
  id: string;
  name: string;
}

export function PersonSearch({
  who,
  status,
  onChoose,
}: {
  /** Whom the search finds, e.g. "the staff member" or "the actor". */
  who: string;
  /** Only people with this status (assigning roles needs an active person). */
  status?: PersonStatus;
  onChoose: (person: ChosenPerson) => void;
}) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const results = useApiPages({
    path: '/people',
    request: { query: { query: term, kind: 'adult', ...(status ? { status } : {}), limit: 10 } },
    enabled: term.length >= 2,
  });
  const search = () => {
    const value = text.trim();
    if (value.length < 2 || value.length > 100) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    setTerm(value);
  };
  return (
    <div role="group" aria-label={`Find ${who}`} className="ia-person-search">
      <div className="ia-inline-form">
        <TextField
          label={`Find ${who} by name`}
          value={text}
          onChange={setText}
          onEnter={search}
          maxLength={100}
          hint="At least two characters of a name, or an exact email or phone number."
          error={tooShort ? 'Enter two to one hundred characters.' : null}
        />
        <Button variant="secondary" onClick={search} aria-label={`Search for ${who}`}>
          Search
        </Button>
      </div>
      {term && results.error ? (
        <>
          <CommandError error={results.error} onRetry={() => void results.refetch()} />
          <p className="caption">You can still enter the person id.</p>
        </>
      ) : null}
      {term && !results.error && results.data === undefined ? (
        <p className="caption" aria-busy="true">
          Searching…
        </p>
      ) : null}
      {term && results.data ? (
        results.data.length === 0 ? (
          <p className="caption" role="status">
            No adult person matches “{term}”{status ? ` with status ${status}` : ''}. Check the
            spelling, or enter the person id.
          </p>
        ) : (
          <>
            <ul className="list" aria-label={`People matching for ${who}`}>
              {results.data.map((p) => {
                const name = `${p.givenName} ${p.familyName}`;
                return (
                  <li key={p.id}>
                    <span>
                      {name}{' '}
                      {p.status !== 'active' ? (
                        <StatusBadge tone="neutral" label={p.status} />
                      ) : null}
                    </span>
                    <Button
                      variant="secondary"
                      aria-label={`Use ${name} as ${who}`}
                      onClick={() => onChoose({ id: p.id, name })}
                    >
                      Use
                    </Button>
                  </li>
                );
              })}
            </ul>
            <LoadMore pages={results} label={`people matching for ${who}`} />
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * A person id field with the name search beside it. The id stays editable (a person the viewer
 * may not search for can still be entered by id); once a search result is used, its name is shown.
 */
export function PersonIdField({
  label,
  who,
  value,
  onChange,
  status,
  required,
  hint,
  error,
}: {
  label: string;
  who: string;
  value: string;
  onChange: (personId: string) => void;
  status?: PersonStatus;
  required?: boolean;
  hint?: string;
  error?: string | null;
}) {
  const [chosen, setChosen] = useState<ChosenPerson | null>(null);
  const shown = chosen && chosen.id === value.trim() ? chosen : null;
  return (
    <div className="ia-field-group">
      <TextField
        label={label}
        required={required}
        value={value}
        onChange={onChange}
        hint={hint}
        error={error}
      />
      {shown ? (
        <p className="caption" role="status">
          Chosen: {shown.name}
        </p>
      ) : null}
      {UUID_PATTERN.test(value.trim()) ? null : (
        <PersonSearch
          who={who}
          status={status}
          onChoose={(person) => {
            setChosen(person);
            onChange(person.id);
          }}
        />
      )}
    </div>
  );
}
