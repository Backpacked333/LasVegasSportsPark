/**
 * Choosing a person on the competition screens (SCR-S-17 roster management, SCR-S-12 suspensions;
 * SPK-COMP-005, SPK-IAM-002, §4.10, §4.14). Staff holding `identity.lookup_person` find the person
 * by a name prefix or an exact contact (`GET /v1/people?query`, ID-02) and choose one; results show
 * names, kind and status only, never a date of birth or contact. Anyone may still enter the opaque
 * reference from the person's record instead. The chosen person is confirmed by name through
 * `GET /v1/person-names`; a person the viewer may not view reads "not available", never more.
 * The search text stays in the form: it is never put in the page address or logged.
 */
import { useId, useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { TextField, isRecordReference } from './fields';
import { PersonName } from './names';

export const LOOKUP_PERSON_ACTION = 'identity.lookup_person';
const RESULTS_PER_PAGE = 10;

function SearchResults({
  query,
  label,
  onChoose,
}: {
  query: string;
  label: string;
  onChoose: (personId: string) => void;
}) {
  const pages = useApiPages({
    path: '/people',
    request: { query: { query, limit: RESULTS_PER_PAGE } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="matching people"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No person matches',
          description: 'Try another spelling, a full email address or a phone number.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label={`People matching, ${label.toLowerCase()}`}>
            {items.map((person) => {
              const name = `${person.givenName} ${person.familyName}`.trim();
              return (
                <li key={person.id}>
                  <span>
                    {name}{' '}
                    <span className="caption">
                      · {person.kind} · {person.status}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    aria-label={`Choose ${name} as ${label.toLowerCase()}`}
                    onClick={() => onChoose(person.id)}
                  >
                    Choose
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="people" />
    </>
  );
}

export function PersonSearchField({
  label,
  value,
  onChange,
  error,
  required,
  hint,
}: {
  label: string;
  /** The chosen person's id, or what was typed as a reference. */
  value: string;
  onChange: (personId: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
}) {
  const permissions = usePermissions();
  const groupId = useId();
  const canSearch = permissions.isPermitted(LOOKUP_PERSON_ACTION);
  const [mode, setMode] = useState<'search' | 'reference'>(
    canSearch === false ? 'reference' : 'search',
  );
  const [input, setInput] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const searchOffered = canSearch !== false && mode === 'search';

  if (value && isRecordReference(value) && mode === 'search') {
    return (
      <div className="field" role="group" aria-labelledby={groupId}>
        <span id={groupId}>
          {label}
          {required ? <span className="caption"> (required)</span> : null}
        </span>
        <span data-testid="chosen-person">
          <PersonName personId={value.trim()} />
        </span>
        <Button
          variant="secondary"
          aria-label={`Change ${label.toLowerCase()}`}
          onClick={() => onChange('')}
        >
          Change
        </Button>
        {error ? (
          <span className="error-text" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  if (!searchOffered) {
    return (
      <div className="field">
        <TextField
          label={`${label}: person reference`}
          required={required}
          value={value}
          onChange={onChange}
          error={error}
          hint={
            canSearch === false
              ? 'Person search is not available to your account. Enter the reference shown on the person’s record.'
              : (hint ?? 'The reference shown on the person’s record.')
          }
        />
        {value && isRecordReference(value) ? (
          <span className="caption" data-testid="reference-preview">
            <PersonName personId={value.trim()} />
          </span>
        ) : null}
        {canSearch !== false ? (
          <Button variant="secondary" onClick={() => setMode('search')}>
            Find by name instead
          </Button>
        ) : null}
      </div>
    );
  }

  const search = () => {
    const trimmed = input.trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      setInputError(
        'Enter 2 to 100 characters of a name, or a full email address or phone number.',
      );
      return;
    }
    setInputError(null);
    setQuery(trimmed);
  };

  return (
    <div className="form" role="group" aria-label={`${label}: find a person`}>
      <TextField
        label={`${label}: find by name or contact`}
        required={required}
        value={input}
        onChange={setInput}
        error={inputError ?? error}
        hint={hint}
      />
      <div className="actions">
        <Button variant="secondary" onClick={search}>
          Search
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setMode('reference');
            setQuery(null);
          }}
        >
          Enter a reference instead
        </Button>
      </div>
      {query ? (
        <SearchResults
          key={query}
          query={query}
          label={label}
          onChoose={(personId) => {
            onChange(personId);
            setQuery(null);
          }}
        />
      ) : null}
    </div>
  );
}
