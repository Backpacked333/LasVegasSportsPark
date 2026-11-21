/**
 * The reads behind the registrations triage (S 1c, S 2c): several records per row, each read once
 * and shared with the rest of the dashboard through the same query keys (`apiQueryKey`). People are
 * read with `GET /v1/people/{id}` (name and date of birth, which the age reasons need), offerings
 * with `GET /v1/offerings/{id}`, places with `GET /v1/offering-availability` (at most 20 offerings
 * per read). A record the viewer may not read is left out, never guessed.
 */
import { apiQueryKey, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi } from '../../providers/AppProviders';

type Person = Schema<'PersonDetail'>;
type Offering = Schema<'Offering'>;
type Availability = Schema<'OfferingAvailability'>;

const STALE = 60_000;

function useRecords<T>(
  path: '/people/{id}' | '/offerings/{id}',
  ids: readonly string[],
): ReadonlyMap<string, T> {
  const api = useApi();
  const unique = [...new Set(ids)].sort();
  const combine = useCallback(
    (results: readonly { data: unknown }[]) => {
      const map = new Map<string, T>();
      unique.forEach((id, i) => {
        const data = results[i]?.data as T | undefined;
        if (data) map.set(id, data);
      });
      return map as ReadonlyMap<string, T>;
    },
    // The ids, joined, decide the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unique.join(',')],
  );
  return useQueries({
    queries: unique.map((id) => ({
      queryKey: apiQueryKey(path, { path: { id } }),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.request('get', path, { path: { id }, signal })).data,
      staleTime: STALE,
      retry: false,
    })),
    combine,
  });
}

export function usePeople(ids: readonly string[]): ReadonlyMap<string, Person> {
  return useRecords<Person>('/people/{id}', ids);
}

export function useOfferings(ids: readonly string[]): ReadonlyMap<string, Offering> {
  return useRecords<Offering>('/offerings/{id}', ids);
}

/** Places per offering (capacity and what is left), for the first 20 offerings shown. */
export function useAvailability(ids: readonly string[]): ReadonlyMap<string, Availability> {
  const unique = [...new Set(ids)].sort().slice(0, 20);
  const read = useApiQuery({
    path: '/offering-availability',
    request: { query: { offeringIds: unique.join(',') } },
    enabled: unique.length > 0,
  });
  return new Map((read.data?.items ?? []).map((a) => [a.offeringId, a]));
}

export function personName(p: Pick<Person, 'givenName' | 'familyName'> | undefined): string | null {
  return p ? `${p.givenName} ${p.familyName}`.trim() : null;
}
