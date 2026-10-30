/**
 * Staff person lookup (SCR-S-28 "look a person up", SCR-S-39 audience; SPK-IAM-002, SPK-IAM-003,
 * §4.14).
 *
 * `GET /v1/people?query=` (ID-02) searches by name prefix or exact contact and answers names, kind
 * and status only: no date of birth, contact point or household is returned or shown. The search
 * runs when staff ask for it (at least two characters, the API's minimum), never on every key, and
 * the term is sent to the API only: it never enters a route, a log or analytics. Which roles may
 * search is the API's answer: ACCESS_DENIED renders the search as not available. Results are
 * paged by the API's cursor ("Load more people").
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { TextField } from './fields';

export type PersonSearchResult = Schema<'PersonSearchResult'>;

/** The API's minimum search length (SearchPeopleQuery). */
export const PERSON_SEARCH_MIN = 2;

export function personLabel(p: Pick<PersonSearchResult, 'givenName' | 'familyName'>): string {
  return `${p.givenName} ${p.familyName}`.trim();
}

export function PersonSearch({
  label = 'Find a person',
  chooseLabel = 'Choose',
  onChoose,
  kind,
  disabled,
}: {
  label?: string;
  /** Verb on each result's button, e.g. "Select" ("Select Alex Rivera"). */
  chooseLabel?: string;
  onChoose: (person: PersonSearchResult) => void;
  kind?: 'adult' | 'child';
  disabled?: boolean;
}) {
  const { online } = useApp();
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const results = useApiPages({
    path: '/people',
    request: { query: { query: submitted, limit: 20, ...(kind ? { kind } : {}) } },
    enabled: submitted.length >= PERSON_SEARCH_MIN,
  });
  const search = () => {
    const value = term.trim().slice(0, 100);
    setTooShort(value.length < PERSON_SEARCH_MIN);
    if (value.length >= PERSON_SEARCH_MIN) setSubmitted(value);
  };
  if (results.error && (results.error.isPermissionRestriction || results.error.isNotFound)) {
    return (
      <div data-testid="person-search-unavailable">
        <StateView
          variant="unavailable"
          title="Person search not available"
          description="Searching people is not available to you. Scan the person's pass, or ask a colleague who may search people."
        />
        <p className="caption">Error code: {results.error.code}</p>
      </div>
    );
  }
  return (
    <div className="ops-section">
      {/* A search landmark, not a form: it can sit inside another form (the composer). */}
      <div className="ops-form" role="search" aria-label={label}>
        <TextField
          label={label}
          value={term}
          onChange={(value) => {
            setTerm(value);
            if (tooShort) setTooShort(false);
          }}
          type="search"
          hint="The first letters of the given or family name, or an exact email or phone number."
          error={tooShort ? `Type at least ${PERSON_SEARCH_MIN} characters.` : undefined}
          disabled={disabled || !online}
          onEnter={search}
        />
        <div className="ops-actions">
          <Button variant="secondary" disabled={disabled || !online} onClick={search}>
            Search
          </Button>
        </div>
        {!online ? <p className="caption">Searching needs a connection.</p> : null}
      </div>
      {submitted.length >= PERSON_SEARCH_MIN ? (
        <>
          <QueryBoundary
            query={results}
            label="people"
            isEmpty={(items) => items.length === 0}
            empty={{
              title: 'Nobody found',
              description:
                'No person matches this search. Check the spelling or search by contact.',
            }}
          >
            {(items) => (
              <ul className="list" aria-label="People found">
                {items.map((p) => {
                  const name = personLabel(p);
                  return (
                    <li key={p.id} aria-label={name}>
                      <div className="row-text">
                        <span className="row-title">{name}</span>
                        <span className="caption">
                          {p.kind === 'child' ? 'Child' : 'Adult'} · matched on{' '}
                          {p.matchedOn === 'contact' ? 'a contact' : 'the name'}
                        </span>
                        {p.status !== 'active' ? (
                          <StatusBadge tone="neutral" label={`Record ${p.status}`} />
                        ) : null}
                      </div>
                      <Button
                        variant="secondary"
                        disabled={disabled || p.status !== 'active'}
                        aria-label={`${chooseLabel} ${name}`}
                        onClick={() => onChoose(p)}
                      >
                        {chooseLabel}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryBoundary>
          <LoadMore pages={results} label="people" />
        </>
      ) : null}
    </div>
  );
}
