/**
 * A person reference input (SPK-IAM-001, SPK-IAM-002, §4.10, §4.14). Staff either paste the
 * opaque person id (from a case, an exception, a receipt or the customer's account) or find the
 * person by name or contact with `GET /v1/people?query` ("Find by name", for roles holding
 * `identity.lookup_person`) and choose one, which fills the reference. The format is checked
 * before any request; a valid reference is previewed with `GET /v1/people/{id}` so staff confirm
 * who they mean. A protected NOT_FOUND reads "no person with this reference is available to you",
 * never that the person exists. Search results show names only (a child by given name only).
 * Enter in the search box runs the search; it never submits the command form around the field.
 */
import { useState, type KeyboardEvent } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { Button } from '../../ui/Button';
import { TextField } from '../../ui/FormFields';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { displayName } from './people';

export const REFERENCE_FORMAT_ERROR =
  'Enter a person reference: 36 characters such as 0192f1a0-0000-7000-8000-000000000001.';

export const LOOKUP_PERSON_ACTION = 'identity.lookup_person';
const FIND_PAGE_SIZE = 10;

export function referenceError(value: string, required: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed) return required ? 'Enter a person reference.' : null;
  return isUuid(trimmed) ? null : REFERENCE_FORMAT_ERROR;
}

export function PersonPreview({ personId }: { personId: string }) {
  const person = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: personId } },
    enabled: isUuid(personId),
  });
  if (!isUuid(personId)) return null;
  if (person.data) {
    return (
      <span className="caption" data-testid="person-preview">
        {displayName(person.data)} · {person.data.kind} · status {person.data.status}
      </span>
    );
  }
  if (person.error) {
    return (
      <span className="caption" data-testid="person-preview">
        {person.error.isNotFound || person.error.isPermissionRestriction
          ? 'No person with this reference is available to you.'
          : `Could not check this reference (${person.error.code}).`}
      </span>
    );
  }
  return <span className="caption">Checking the reference…</span>;
}

function FindResults({
  query,
  fieldLabel,
  onChoose,
}: {
  query: string;
  fieldLabel: string;
  onChoose: (id: string) => void;
}) {
  const pages = useApiPages({
    path: '/people',
    request: { query: { query, limit: FIND_PAGE_SIZE } },
  });
  return (
    <>
      <QueryBoundary
        query={pages}
        label="matching people"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No person matches', description: 'Try another spelling or contact.' }}
      >
        {(items) => (
          <ul className="list" aria-label={`People matching, ${fieldLabel.toLowerCase()}`}>
            {items.map((p) => (
              <li key={p.id}>
                <span>
                  {displayName(p)}{' '}
                  <span className="caption">
                    · {p.kind} · {p.status}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  aria-label={`Use ${displayName(p)} for ${fieldLabel.toLowerCase()}`}
                  onClick={() => onChoose(p.id)}
                >
                  Use this person
                </Button>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="people" />
    </>
  );
}

function FindByName({
  fieldLabel,
  onChoose,
}: {
  fieldLabel: string;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-expanded={false}
        aria-label={`Find by name for ${fieldLabel.toLowerCase()}`}
        onClick={() => setOpen(true)}
      >
        Find by name
      </Button>
    );
  }
  const search = () => {
    const trimmed = input.trim();
    if (trimmed.length < 2 || trimmed.length > 100) {
      setError('Enter 2 to 100 characters of a name, or a full email address or phone number.');
      return;
    }
    setError(null);
    setQuery(trimmed);
  };
  // The field always sits inside a command form (assign, decide, record a relationship): Enter
  // in the search box runs the search and must never submit that form's command (implicit
  // submission), so the keystroke is handled here and stops.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    event.stopPropagation();
    search();
  };
  return (
    <div
      className="form"
      role="group"
      aria-label={`Find by name for ${fieldLabel.toLowerCase()}`}
      onKeyDown={onKeyDown}
    >
      <TextField
        label="Find by name or contact"
        type="search"
        value={input}
        onChange={setInput}
        error={error}
      />
      <div className="actions-row">
        <Button variant="secondary" onClick={search}>
          Search
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Close search
        </Button>
      </div>
      {query ? (
        <FindResults
          key={query}
          query={query}
          fieldLabel={fieldLabel}
          onChoose={(id) => {
            onChoose(id);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function PersonReferenceField({
  label,
  value,
  onChange,
  error,
  required,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  const permissions = usePermissions();
  const canFind = !disabled && permissions.isPermitted(LOOKUP_PERSON_ACTION) === true;
  return (
    <div className="field">
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        error={error}
        required={required}
        hint={hint}
        disabled={disabled}
      />
      <PersonPreview personId={value.trim()} />
      {canFind ? <FindByName fieldLabel={label} onChoose={onChange} /> : null}
    </div>
  );
}
