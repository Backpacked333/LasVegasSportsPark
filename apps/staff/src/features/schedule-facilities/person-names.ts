/**
 * Names of the people a closure impact lists by id (SPK-SCHED-009 customers), through
 * `GET /v1/person-names` (ID-02; SPK-IAM-002, SPK-IAM-003, §4.14): names only, never a date of
 * birth, contact point or household, and only for people the viewer may view. The API leaves the
 * others out; they read "Name not available" (§4.10: nothing implies that a record exists).
 *
 * One read per set of ids (sorted and deduplicated, at most 100 per read; more are split), cached
 * under `['person-names', ...]`, and only while `enabled` (the screen asks for names on demand).
 * Nothing is logged and no id is put in a route.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useApi } from '../../providers/AppProviders';

export type PersonName = Schema<'PersonName'>;

/** The API reads at most 100 ids at a time (PersonNamesQuery). */
export const PERSON_NAMES_MAX = 100;

export type PersonNameEntry =
  | { state: 'loading' }
  | { state: 'ready'; name: PersonName }
  /** The API omitted the person: the viewer may not view them (never "exists but hidden"). */
  | { state: 'unavailable' }
  | { state: 'error'; error: ApiError; retry: () => void };

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PERSON_NAMES_MAX) {
    out.push(ids.slice(i, i + PERSON_NAMES_MAX));
  }
  return out;
}

export function usePersonNames(
  ids: readonly string[],
  enabled = true,
): ReadonlyMap<string, PersonNameEntry> {
  const api = useApi();
  const key = [...new Set(ids)].sort().join(',');
  const groups = useMemo(() => chunks(key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (
      results: readonly {
        data: readonly PersonName[] | undefined;
        error: ApiError | null;
        refetch: () => unknown;
      }[],
    ) => {
      const map = new Map<string, PersonNameEntry>();
      groups.forEach((group, index) => {
        const result = results[index];
        const byId = new Map((result?.data ?? []).map((n) => [n.personId, n]));
        for (const id of group) {
          if (result?.data) {
            const name = byId.get(id);
            map.set(id, name ? { state: 'ready', name } : { state: 'unavailable' });
          } else if (result?.error) {
            const retry = () => void result.refetch();
            map.set(
              id,
              result.error.isNotFound || result.error.isPermissionRestriction
                ? { state: 'unavailable' }
                : { state: 'error', error: result.error, retry },
            );
          } else {
            map.set(id, { state: 'loading' });
          }
        }
      });
      return map as ReadonlyMap<string, PersonNameEntry>;
    },
    [groups],
  );
  return useQueries({
    queries: groups.map((group) => ({
      queryKey: ['person-names', ...group],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.get('/person-names', { query: { ids: group }, signal })).items,
      enabled,
      staleTime: 5 * 60_000,
    })),
    combine: combine as (
      results: readonly { data: unknown; error: unknown; refetch: () => unknown }[],
    ) => ReadonlyMap<string, PersonNameEntry>,
  });
}
