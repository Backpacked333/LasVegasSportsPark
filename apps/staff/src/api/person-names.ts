/**
 * Display names of people for list rows (§4.14 child data minimized, SPK-COMMS-006).
 *
 * The API has no minimal display-name read (reported gap), so a name comes from
 * `GET /v1/people/{id}`, whose PersonDetail also carries the date of birth and contact points.
 * This read keeps only the given name, family name and kind before anything reaches the query
 * cache: under its own key (`['person-name', id]`, never the `/people/{id}` record key) the cache
 * holds no date of birth and no contact point, and nothing else is rendered or logged. The
 * response still crosses the network until the API offers a minimal read.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useApi } from '../providers/AppProviders';

export interface PersonNameRecord {
  givenName: string;
  familyName: string;
  kind: 'adult' | 'child';
}

export const personNameKey = (personId: string) => ['person-name', personId] as const;

const NAME_STALE_MS = 5 * 60_000;

type Api = ReturnType<typeof useApi>;

async function readName(
  api: Api,
  personId: string,
  signal: AbortSignal,
): Promise<PersonNameRecord> {
  const response = await api.request('get', '/people/{id}', { path: { id: personId }, signal });
  const p = response.data as { givenName: string; familyName: string; kind: 'adult' | 'child' };
  // Only these three fields leave this function (and so enter the cache).
  return { givenName: p.givenName, familyName: p.familyName, kind: p.kind };
}

export interface PersonNameState {
  data: PersonNameRecord | undefined;
  error: ApiError | null;
  loading: boolean;
  refetch: () => void;
}

export function usePersonName(personId: string | null | undefined): PersonNameState {
  const api = useApi();
  const query = useQuery({
    queryKey: personNameKey(personId ?? ''),
    queryFn: ({ signal }) => readName(api, personId as string, signal),
    enabled: !!personId,
    staleTime: NAME_STALE_MS,
  });
  return {
    data: query.data,
    error: (query.error as ApiError | null) ?? null,
    loading: !!personId && query.isPending,
    refetch: () => void query.refetch(),
  };
}

/** Names for several people (deduplicated), each with its own state. */
export function usePersonNameRecords(ids: readonly string[]): ReadonlyMap<string, PersonNameState> {
  const api = useApi();
  const key = [...new Set(ids)].sort().join(',');
  const unique = useMemo(() => (key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (
      results: readonly {
        data: PersonNameRecord | undefined;
        error: Error | null;
        isPending: boolean;
        refetch: () => unknown;
      }[],
    ) => {
      const map = new Map<string, PersonNameState>();
      unique.forEach((id, index) => {
        const r = results[index];
        map.set(id, {
          data: r?.data,
          error: (r?.error as ApiError | null) ?? null,
          loading: r?.isPending ?? true,
          refetch: () => void r?.refetch(),
        });
      });
      return map as ReadonlyMap<string, PersonNameState>;
    },
    [unique],
  );
  return useQueries({
    queries: unique.map((id) => ({
      queryKey: personNameKey(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => readName(api, id, signal),
      staleTime: NAME_STALE_MS,
    })),
    combine,
  });
}

/** "Not available" only for a protected NOT_FOUND or a permission restriction (SPK-UX-008). */
export function nameUnavailable(error: ApiError | null): boolean {
  return error !== null && presentationForError(error) === 'unavailable';
}
