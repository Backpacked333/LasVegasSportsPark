/**
 * Reads several records of one `GET /…/{id}` path at once (offering names on enrollments, person
 * names, orders behind obligations), with the same cache keys as `useApiQuery` so a record read
 * on one screen shows at once on the next (§4.8). Each record has its own state: one record the
 * customer may not read (protected NOT_FOUND) never hides the others (SPK-UX-008).
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
  /** Reads this one record again. */
  refetch: () => void;
}

/** One state per record id. */
export type Records<P extends GetPath> = Record<string, RecordState<ResponseBody<P, 'get'>>>;

export function useApiRecords<P extends GetPath>(
  path: P,
  ids: readonly string[],
  enabled = true,
): Records<P> {
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
  const out: Records<P> = {};
  unique.forEach((id, index) => {
    const result = results[index];
    out[id] = {
      data: result?.data?.data,
      error: (result?.error as ApiError | null) ?? null,
      loading: enabled && (result?.isPending ?? true),
      refetch: () => void result?.refetch(),
    };
  });
  return out;
}
