/**
 * Find a person by name or exact contact for a Package G command (SCR-S-51, SCR-S-52 booker;
 * SCR-S-54 participant filter): `GET /v1/people?query=` (ID-02, staff person search, names only,
 * §4.14). The search runs when asked ("Search"), never on every keystroke, and shows only names
 * and whether the person is an adult or a child; nothing is preselected. The chosen person's id
 * stays in the form, never in the URL.
 */
import { useId, useState } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import { Button } from '../../../ui/Button';
import { TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';

export interface ChosenPerson {
  id: string;
  name: string;
}

export function PersonPicker({
  label,
  value,
  onChange,
  error,
  required,
}: {
  label: string;
  value: ChosenPerson | null;
  onChange: (person: ChosenPerson | null) => void;
  error?: string | null;
  required?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const results = useApiQuery({
    path: '/people',
    request: { query: { query, limit: 10 } },
    enabled: query.length >= 2,
  });
  if (value) {
    return (
      <div className="field" role="group" aria-label={label}>
        <span>
          {label}: <strong>{value.name}</strong>
        </span>
        <Button variant="secondary" onClick={() => onChange(null)}>
          Choose someone else
        </Button>
      </div>
    );
  }
  const searchLabel = `${label}: name or exact email or phone`;
  return (
    <fieldset className="field fieldset" aria-describedby={error ? `${id}-error` : undefined}>
      <legend>
        {label}
        {required ? <span className="field-required"> (required)</span> : null}
      </legend>
      <div className="pg-toolbar">
        <TextField label={searchLabel} type="search" value={text} onChange={setText} />
        <Button
          variant="secondary"
          disabled={text.trim().length < 2}
          onClick={() => setQuery(text.trim())}
        >
          Search
        </Button>
      </div>
      {query.length >= 2 ? (
        <QueryBoundary
          query={results}
          label="matching people"
          isEmpty={(page) => page.items.length === 0}
          empty={{ title: 'No one found', description: 'Check the spelling or try a contact.' }}
        >
          {(page) => (
            <ul className="pg-choices" aria-label={`People matching “${query}”`}>
              {page.items.map((person) => {
                const name = `${person.givenName} ${person.familyName}`;
                return (
                  <li key={person.id}>
                    <Button
                      variant="secondary"
                      onClick={() => onChange({ id: person.id, name })}
                      aria-label={`Choose ${name}`}
                    >
                      {name}
                    </Button>{' '}
                    <span className="caption">{person.kind}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
      ) : null}
      {error ? (
        <span className="error-text" id={`${id}-error`}>
          <span aria-hidden="true">✕ </span>
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
