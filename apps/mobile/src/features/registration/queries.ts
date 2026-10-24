/**
 * Reads several records of one GET path at once (participant names for basket lines, offering
 * names, enrollments of a checkout), with the same cache keys as `useApiQuery` so a record read on
 * one screen is shown instantly on the next (§4.8, SPK-UX-008 per-record states).
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type PathsWithMethod,
  type ResponseBody,
} from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../providers/AppProviders';

type GetPath = PathsWithMethod<'get'>;

export interface RecordState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  /** Reads this one record again (the "Try again" of its error state). */
  refetch: () => void;
}

/** `useApiRecords('/people/{id}', ids)` → one state per id, keyed by id. */
export function useApiRecords<P extends GetPath>(
  path: P,
  ids: readonly string[],
  enabled = true,
): Record<string, RecordState<ResponseBody<P, 'get'>>> {
  const api = useApi();
  const unique = [...new Set(ids)];
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: apiQueryKey(path, { path: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        (
          api.request as (
            method: 'get',
            path: string,
            options: object,
          ) => Promise<ApiResponse<ResponseBody<P, 'get'>>>
        )('get', path, { path: { id }, signal }),
      enabled,
    })),
  });
  const out: Record<string, RecordState<ResponseBody<P, 'get'>>> = {};
  unique.forEach((id, index) => {
    const result = results[index];
    out[id] = {
      data: result?.data?.data,
      error: (result?.error as ApiError | null) ?? null,
      loading: result?.isPending ?? true,
      refetch: () => void result?.refetch(),
    };
  });
  return out;
}
