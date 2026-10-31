/**
 * The facility directory every staff screen shares (K-04, SPK-SCHED-008, §4.3): `GET /v1/facilities`
 * answers each facility's name, IANA time zone and status, with `inStaffScope` (the API's answer
 * for the principal's staff scope), and `GET /v1/facilities/{id}` one facility the listing leaves
 * out (archived). Both are single indexed reads of configuration, cached for minutes, so the shell
 * and every screen take names, zones and scope from here (one cached read), never from the Today
 * feed, which computes every operational source for every facility in scope (§4.5 bounded reads).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from './useApiQuery';

export type FacilitySummary = Schema<'FacilitySummary'>;

/** Names and zones are configuration (DEC-001): one read every few minutes is enough. */
export const FACILITY_DIRECTORY_STALE_MS = 5 * 60_000;

/** The facility directory read (one cache entry for the whole dashboard). */
export function useFacilityDirectory(enabled = true) {
  return useApiQuery({ path: '/facilities', enabled, staleTime: FACILITY_DIRECTORY_STALE_MS });
}

/**
 * A read has answered for now: it holds data, has failed at least once (a retry keeps
 * `errorUpdatedAt`, so a later observer cannot unsettle it), or cannot run offline (paused).
 */
export function hasAnswered(query: {
  data: unknown;
  errorUpdatedAt: number;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}): boolean {
  return query.data !== undefined || query.errorUpdatedAt > 0 || query.fetchStatus === 'paused';
}

/**
 * One facility's directory entry: from the listing when it names the facility, otherwise from
 * `GET /v1/facilities/{id}` once the listing has answered. `settled` is true once the entry is
 * known or cannot be read, so a screen never starts in a guessed zone.
 */
export function useFacilitySummary(
  facilityId: string | null | undefined,
  enabled = true,
): { summary: FacilitySummary | undefined; settled: boolean } {
  const directory = useFacilityDirectory(enabled);
  const listed = facilityId ? directory.data?.items.find((f) => f.id === facilityId) : undefined;
  const singleEnabled = enabled && !!facilityId && hasAnswered(directory) && listed === undefined;
  const single = useApiQuery({
    path: '/facilities/{id}',
    request: { path: { id: facilityId ?? '' } },
    enabled: singleEnabled,
    staleTime: 60 * 60_000,
  });
  const summary = listed ?? (facilityId ? single.data : undefined);
  const settled = facilityId
    ? summary !== undefined || (singleEnabled && hasAnswered(single))
    : enabled && hasAnswered(directory);
  return { summary, settled };
}
