/**
 * Display names of staff people shown on the Administration screens (SCR-S-46, SCR-S-47): who
 * changed a capability switch, who acted in an audit record. One `GET /v1/person-names` read per
 * set of ids (ID-02; names only, never a date of birth or contact point, §4.14); a person the
 * viewer may not see is left out by the API and shown as "not available" here (§4.10). Nothing is
 * logged or put in a route.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';

export type PersonName = Schema<'PersonName'>;

/** The API reads at most 100 ids at a time (PersonNamesQuery). */
const MAX_IDS = 100;

export interface DisplayNames {
  /** The name, `null` when the API left the person out, `undefined` while loading or failed. */
  nameOf(personId: string): string | null | undefined;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

export function useDisplayNames(ids: readonly (string | null | undefined)[]): DisplayNames {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort().slice(0, MAX_IDS);
  const query = useApiQuery({
    path: '/person-names',
    request: { query: { ids: unique } },
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
  });
  const byId = new Map((query.data?.items ?? []).map((p) => [p.personId, p.displayName]));
  return {
    nameOf: (personId) => {
      if (!query.data) return undefined;
      return byId.get(personId) ?? null;
    },
    loading: unique.length > 0 && query.isLoading,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}

/** "Name (role)" text for a person reference: the name, or what is known instead. */
export function personText(names: DisplayNames, personId: string | null | undefined): string {
  if (!personId) return 'not recorded';
  const name = names.nameOf(personId);
  if (name) return name;
  if (name === null) return 'a person not available to you';
  if (names.error) return 'name could not be read';
  return 'loading name';
}
