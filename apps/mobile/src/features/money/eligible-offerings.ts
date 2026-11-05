/**
 * The published offerings an entitlement may be used for (SCR-C-35: a makeup's replacements,
 * SPK-YOUTH-004; a session package's eligible sessions, ENR-11): the offerings it names
 * (`GET /v1/offerings/{id}`) and the published offerings of the programs it names
 * (`GET /v1/offerings?programId=`), each once. The API decides on submit; this only lists what may
 * be chosen. Each read uses the same cache keys as `useApiQuery`.
 */
import { apiQueryKey, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../providers/AppProviders';
import { useApiRecords } from './records';

export type PublicOffering = Schema<'PublicOffering'>;
type OfferingPage = { items: PublicOffering[]; nextCursor: string | null };

/** Offerings of the eligible programs, read with the same keys `useApiQuery` uses. */
function useProgramOfferings(programIds: readonly string[]) {
  const api = useApi();
  return useQueries({
    queries: programIds.map((programId) => {
      const query = { programId, limit: 50 };
      return {
        queryKey: apiQueryKey('/offerings', { query }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          (
            api.request as (
              method: 'get',
              path: string,
              options: object,
            ) => Promise<ApiResponse<OfferingPage>>
          )('get', '/offerings', { query, signal }),
      };
    }),
  });
}

export function useEligibleOfferings(
  offeringIds: readonly string[],
  programIds: readonly string[],
): { offerings: Map<string, PublicOffering>; loading: boolean } {
  const direct = useApiRecords('/offerings/{id}', offeringIds);
  const fromPrograms = useProgramOfferings(programIds);
  const offerings = new Map<string, PublicOffering>();
  for (const id of offeringIds) {
    const record = direct[id]?.data;
    if (record) offerings.set(record.id, record);
  }
  for (const result of fromPrograms) {
    for (const o of result.data?.data.items ?? []) offerings.set(o.id, o);
  }
  const loading =
    Object.values(direct).some((r) => r.loading) || fromPrograms.some((r) => r.isPending);
  return { offerings, loading };
}
