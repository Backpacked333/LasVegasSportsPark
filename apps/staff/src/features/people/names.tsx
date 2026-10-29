/**
 * Names of the people a People and families or support screen refers to by id (relationship
 * parties, review owners, case subjects), from `GET /v1/person-names` (ID-02, SPK-IAM-002, §4.14):
 * names only, never dates of birth or contacts, one read per set of at most 100 ids. A person the
 * viewer may not view is omitted by the API and shown as "not available", never as an id that
 * suggests the record exists or what it holds. A child is shown by given name only (§4.14), as the
 * other staff screens do.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { isUuid } from '../../ui/RecordRef';
import { displayName } from './people';

export type PersonNameEntry = Schema<'PersonName'>;

export const PERSON_NAMES_MAX = 100;

export interface PeopleNames {
  /** The name entry, null when the API omitted the person, undefined while loading. */
  get(id: string): PersonNameEntry | null | undefined;
  loading: boolean;
  failed: boolean;
}

export function usePeopleNames(ids: readonly (string | null | undefined)[]): PeopleNames {
  const unique = [...new Set(ids.filter((id): id is string => !!id && isUuid(id)))]
    .sort()
    .slice(0, PERSON_NAMES_MAX);
  const names = useApiQuery({
    path: '/person-names',
    request: { query: { ids: unique } },
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
  });
  const byId = new Map((names.data?.items ?? []).map((n) => [n.personId, n]));
  return {
    get: (id) => {
      if (byId.has(id)) return byId.get(id) as PersonNameEntry;
      if (names.data) return null;
      return undefined;
    },
    loading: unique.length > 0 && names.isPending,
    failed: names.error !== null && names.data === undefined,
  };
}

/** A link to the person's record named by the API, or "not available" when omitted. */
export function PersonName({
  id,
  names,
  self,
}: {
  id: string;
  names: PeopleNames;
  /** The person whose screen this is: shown as "this person". */
  self?: string;
}) {
  if (self && id === self) return <span>this person</span>;
  const entry = names.get(id);
  if (entry) return <Link to={`/people/${id}`}>{displayName(entry)}</Link>;
  if (entry === null || names.failed) {
    return <span className="caption">a person not available to you</span>;
  }
  return <span className="caption">loading the name…</span>;
}
