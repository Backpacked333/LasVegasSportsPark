/**
 * The published offerings a membership's included sessions may be used for (ENR-12; §3.16
 * Memberships "entitlement effects"): the offerings its definition names (`GET /v1/offerings/{id}`)
 * and the published offerings of the programs it names (`GET /v1/offerings?programId=`), each
 * once. The API decides on submit; this only lists what may be chosen. Each read uses the same
 * cache keys as `useApiQuery`, so an offering read for a facility zone is reused here.
 */
import { apiQueryKey, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../providers/AppProviders';
import { useApiRecords } from '../money/records';

export type PublicOffering = Schema<'PublicOffering'>;
type OfferingPage = { items: PublicOffering[]; nextCursor: string | null };

export const PROGRAM_OFFERINGS_LIMIT = 50;

export function useIncludedOfferings(
  offeringIds: readonly string[],
  programIds: readonly string[],
): { offerings: Map<string, PublicOffering>; loading: boolean } {
  const api = useApi();
  const direct = useApiRecords('/offerings/{id}', offeringIds);
  const fromPrograms = useQueries({
    queries: [...new Set(programIds)].map((programId) => {
      const query = { programId, limit: PROGRAM_OFFERINGS_LIMIT };
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
