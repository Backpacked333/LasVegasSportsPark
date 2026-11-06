/**
 * SCR-S-20 Person search (SPK-IAM-001, SPK-IAM-002, SPK-SUPPORT-001, SPK-SUPPORT-002, §4.14, §4.3).
 * Staff find a person without customer credentials with `GET /v1/people?query`: a name prefix (of
 * the given or family name, or "given family") or an exact email address or phone number, at
 * least 2 characters (validated before any request), optionally narrowed by kind and status
 * (merged records only when asked for). Results are names only, never dates of birth or
 * contacts; a child is shown by given name only. Results page with the API's cursor ("Load
 * more"). The search term stays in the screen's state, never in the page address (§4.14: the
 * route holds only the opaque person id). It does travel in the API request URL, because the
 * contract makes it a query parameter (`SearchPeopleQuery`), so it can reach server and proxy
 * access logs; a body-carried search is reported as an API issue. Only this organization's
 * people are searched (§4.3); "no
 * match" never says anything about another organization. Roles without `identity.lookup_person`
 * see "not available to you"; an ACCESS_DENIED answer reads the same. Lookup latency is DEC-036.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { PeopleNav } from '../../features/people/PeopleNav';
import { displayName } from '../../features/people/people';
import { Button } from '../../ui/Button';
import { SelectField, TextField } from '../../ui/FormFields';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { Icon } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { Avatar } from '../../features/grow/Grow';
import './people.css';

type PersonKind = Schema<'PersonKind'>;
type PersonStatus = Schema<'PersonStatus'>;

export const SEARCH_PAGE_SIZE = 25;
export const LOOKUP_ACTION = 'identity.lookup_person';
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 100;

interface Search {
  query: string;
  kind: string;
  status: string;
}

/** Validation before any request (SCR-S-20 validation failure: search input). */
export function searchError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < SEARCH_MIN) {
    return 'Enter at least 2 characters of a name, or a full email address or phone number.';
  }
  if (trimmed.length > SEARCH_MAX) return 'Enter at most 100 characters.';
  return null;
}

function SearchResults({ search }: { search: Search }) {
  const pages = useApiPages({
    path: '/people',
    request: {
      query: {
        query: search.query,
        limit: SEARCH_PAGE_SIZE,
        ...(search.kind ? { kind: search.kind as PersonKind } : {}),
        ...(search.status ? { status: search.status as PersonStatus } : {}),
      },
    },
  });
  return (
    <section aria-label="Search results">
      <QueryBoundary
        query={pages}
        label="matching people"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No person matches',
          description:
            'Only people of this organization are searched. Try another spelling, the family name, or the full email address or phone number.',
        }}
      >
        {(items) => (
          <ul className="list person-results" aria-label="Matching people">
            {items.map((p) => (
              <li key={p.id}>
                <Avatar name={displayName(p)} seed={p.id} />
                <div className="row-text">
                  <Link to={`/people/${p.id}`} className="row-title">
                    {displayName(p)}
                  </Link>
                  <span className="caption">
                    {p.kind} · matched on {p.matchedOn}
                  </span>
                </div>
                <StatusBadge
                  tone={p.status === 'active' ? 'success' : 'neutral'}
                  label={`Status: ${p.status}`}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="people" />
    </section>
  );
}

export function PeopleScreen() {
  const permissions = usePermissions();
  const [input, setInput] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const permitted = permissions.isPermitted(LOOKUP_ACTION);
  const submit = () => {
    const problem = searchError(input);
    setError(problem);
    if (!problem) setSearch({ query: input.trim(), kind, status });
  };
  return (
    <section aria-labelledby="people-title" className="grow">
      <PageHeader
        eyebrow="Grow · Households, pickup authority and history"
        title="People and families"
        titleId="people-title"
        intro="Find a participant or adult; their record brings household and pickup authority, activities, money and history together."
      />
      <PeopleNav />
      <div className="split">
        <section className="card split-main people-lookup" aria-labelledby="lookup-title">
          <h3 id="lookup-title">Find a person</h3>
          {permitted === false ? (
            <StateView
              variant="unavailable"
              title="Not available to you"
              description="Person search is not available to your role. Open a person from a case, an exception or a receipt."
            />
          ) : (
            <>
              <form
                noValidate
                role="search"
                className="form people-search"
                aria-label="Search people"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <TextField
                  label="Name, email address or phone number"
                  type="search"
                  required
                  hint="The start of a given or family name, or a full email address or phone number."
                  value={input}
                  onChange={setInput}
                  error={error}
                />
                <SelectField
                  label="Kind"
                  placeholder="Adults and children"
                  options={[
                    { value: 'adult', label: 'adult' },
                    { value: 'child', label: 'child' },
                  ]}
                  value={kind}
                  onChange={setKind}
                />
                <SelectField
                  label="Status"
                  placeholder="Active and inactive"
                  hint="Merged records are listed only when merged is chosen."
                  options={[
                    { value: 'active', label: 'active' },
                    { value: 'inactive', label: 'inactive' },
                    { value: 'merged', label: 'merged' },
                  ]}
                  value={status}
                  onChange={setStatus}
                />
                <Button type="submit">Search</Button>
              </form>
              {search ? (
                <SearchResults
                  key={`${search.query}|${search.kind}|${search.status}`}
                  search={search}
                />
              ) : null}
            </>
          )}
        </section>
        <aside className="split-side" aria-label="Also in People and families">
          <section className="card card-flush">
            <div className="card-head">
              <h4>Also here</h4>
            </div>
            <ul className="list people-links">
              <li>
                <span className="icon-tile" data-tone="warning" aria-hidden="true">
                  <Icon name="person_off" size={20} />
                </span>
                <div className="row-text">
                  <Link className="row-title" to="/people/duplicates">
                    Duplicate review
                  </Link>
                  <span className="caption">
                    Records that may be the same person, to merge or keep apart.
                  </span>
                </div>
              </li>
              <li>
                <span className="icon-tile" data-tone="pending" aria-hidden="true">
                  <Icon name="shield_person" size={20} />
                </span>
                <div className="row-text">
                  <Link className="row-title" to="/people/access-reviews">
                    Access reviews
                  </Link>
                  <span className="caption">
                    Disputed guardian or pickup access, decided with evidence.
                  </span>
                </div>
              </li>
              <li>
                <span className="icon-tile" data-tone="info" aria-hidden="true">
                  <Icon name="mail" size={20} />
                </span>
                <div className="row-text">
                  <Link className="row-title" to="/people/invitations">
                    Invitations
                  </Link>
                  <span className="caption">
                    Household and guardian invitations and their expiry.
                  </span>
                </div>
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </section>
  );
}
