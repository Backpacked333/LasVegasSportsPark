/**
 * Display names of staff people shown on the Administration screens (SCR-S-46, SCR-S-47): who
 * changed a capability switch, who acted in an audit record. `GET /v1/person-names` reads at most
 * 100 ids at a time (ID-02; names only, never a date of birth or contact point, §4.14), so the ids
 * are read in chunks of 100, one query per chunk. A person the viewer may not see is left out of
 * the API's answer and shown as "not available" here (§4.10); that is said only for an id the API
 * was asked about, never for one still loading or not asked yet. Nothing is logged or put in a
 * route.
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type ResponseBody,
  type Schema,
} from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useApi } from '../../providers/AppProviders';

export type PersonName = Schema<'PersonName'>;

/** The API reads at most 100 ids at a time (PersonNamesQuery). */
export const MAX_IDS_PER_READ = 100;

const NAME_STALE_MS = 5 * 60_000;

export interface DisplayNames {
  /**
   * The name; `null` when the API was asked and left the person out (not available to you);
   * `undefined` while loading, after a failed read, or for an id not asked about.
   */
  nameOf(personId: string): string | null | undefined;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * The ids in chunks of at most 100, in order of first appearance (so loading another page of a list
 * adds a chunk instead of re-reading every earlier one); each chunk is sorted for a stable key.
 */
export function chunkIds(ids: readonly (string | null | undefined)[]): string[][] {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += MAX_IDS_PER_READ) {
    chunks.push(unique.slice(i, i + MAX_IDS_PER_READ).sort());
  }
  return chunks;
}

type NamesResponse = ApiResponse<ResponseBody<'/person-names', 'get'>>;

export function useDisplayNames(ids: readonly (string | null | undefined)[]): DisplayNames {
  const api = useApi();
  const signature = chunkIds(ids)
    .map((chunk) => chunk.join(','))
    .join('|');
  const chunks = useMemo(
    () => (signature ? signature.split('|').map((chunk) => chunk.split(',')) : []),
    [signature],
  );
  const combine = useCallback(
    (
      results: readonly {
        data: NamesResponse | undefined;
        error: Error | null;
        isLoading: boolean;
        refetch: () => unknown;
      }[],
    ): DisplayNames => {
      const answered = new Map<string, string | null>();
      chunks.forEach((chunk, index) => {
        const data = results[index]?.data?.data;
        if (!data) return;
        const byId = new Map(data.items.map((p) => [p.personId, p.displayName]));
        for (const id of chunk) answered.set(id, byId.get(id) ?? null);
      });
      const error = (results.find((r) => r.error)?.error as ApiError | undefined) ?? null;
      return {
        nameOf: (personId) => answered.get(personId),
        loading: results.some((r) => r.isLoading),
        error,
        refetch: () => {
          for (const r of results) if (r.error) void r.refetch();
        },
      };
    },
    [chunks],
  );
  return useQueries({
    queries: chunks.map((chunk) => {
      const request = { query: { ids: chunk } };
      return {
        queryKey: apiQueryKey('/person-names', request),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          (api.request as (method: 'get', path: string, options: object) => Promise<NamesResponse>)(
            'get',
            '/person-names',
            { ...request, signal },
          ),
        staleTime: NAME_STALE_MS,
      };
    }),
    combine,
  });
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
