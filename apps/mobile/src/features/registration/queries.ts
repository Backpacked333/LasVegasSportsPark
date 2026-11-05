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

/**
 * SPK-SCHED-008: the facility time zone of each offering, from `GET /v1/offerings/{id}`
 * (`facility.timezone`; the same cache as the offering screens). A list record that carries only
 * an offering id (a waitlist entry, ENR-01) reads its offering for the zone; until it answers, or
 * when the offering is not readable, the instant is shown in the device zone with the zone named.
 */
export function useOfferingTimeZones(
  offeringIds: readonly string[],
  enabled = true,
): (offeringId: string) => string | undefined {
  const offerings = useApiRecords('/offerings/{id}', offeringIds, enabled);
  return (offeringId) => offerings[offeringId]?.data?.facility.timezone;
}
