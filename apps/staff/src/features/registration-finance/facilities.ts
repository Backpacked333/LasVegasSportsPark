/**
 * Facilities the viewer works in, with names and IANA time zones (SPK-SCHED-008: facility-local
 * behaviour derives from the facility's time zone; K-04 facility directory).
 *
 * The authority is `GET /v1/facilities` (any signed-in principal; `inStaffScope` says whether the
 * staff principal may act there). While that read has not answered, or when it fails, names and
 * zones come from the Today feed as before and the scope from `GET /v1/me` (`principal.facilityIds`,
 * empty = the whole organization), so a screen never invents a zone. A facility without a known
 * zone is shown and entered in UTC, and the form says so.
 */
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { shortRef } from './format';

export interface FacilityInfo {
  id: string;
  name: string;
  timeZone: string | null;
}

/**
 * Settled: answered, failed once, or not fetching (disabled or paused offline). A failure counts
 * through `errorUpdatedAt`, which a retry keeps: a form that mounts its own observer of a failed
 * read retries it, and the retry clears `error`, so `error` alone would unsettle and remount it.
 */
function settled(query: {
  data: unknown;
  errorUpdatedAt: number;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}): boolean {
  return query.data !== undefined || query.errorUpdatedAt > 0 || query.fetchStatus !== 'fetching';
}

export function useFacilities() {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const directory = useApiQuery({
    path: '/facilities',
    enabled: signedIn,
    staleTime: 5 * 60_000,
  });
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const directorySettled = settled(directory);
  const useFeed = directory.data === undefined && directorySettled;
  const today = useApiQuery({
    path: '/today',
    enabled: signedIn && useFeed && me.data?.principal.kind === 'staff',
    staleTime: 5 * 60_000,
  });
  const todaySettled = settled(today);
  return useMemo(() => {
    const listed = new Map<string, FacilityInfo>();
    if (directory.data) {
      for (const f of directory.data.items) {
        listed.set(f.id, { id: f.id, name: f.name, timeZone: f.timezone });
      }
    } else {
      for (const f of today.data?.facilities ?? []) {
        listed.set(f.facilityId, { id: f.facilityId, name: f.name, timeZone: f.timezone });
      }
    }
    let ids: string[];
    if (directory.data) {
      // `inStaffScope: null` is a customer or system principal: every listed facility.
      ids = directory.data.items.filter((f) => f.inStaffScope !== false).map((f) => f.id);
    } else {
      const scoped = me.data?.principal.facilityIds ?? [];
      ids = scoped.length > 0 ? scoped : [...listed.keys()];
    }
    const facilities: FacilityInfo[] = ids.map(
      (id) => listed.get(id) ?? { id, name: `Facility ${shortRef(id)}`, timeZone: null },
    );
    const byId = new Map(facilities.map((f) => [f.id, f]));
    return {
      facilities,
      /**
       * Scope and zones have settled once (loaded, failed, or cannot load offline); forms that
       * prefill local times wait for it. A background refetch never unsettles it, so a form that
       * mounts its own observers cannot flip it back.
       */
      ready:
        directory.data !== undefined ||
        (directorySettled &&
          (me.data !== undefined || me.errorUpdatedAt > 0 || me.fetchStatus === 'paused') &&
          todaySettled),
      /** The facility's zone, or null when the API has not stated it to this viewer. */
      timeZoneOf: (id: string | null | undefined): string | null =>
        (id ? (byId.get(id)?.timeZone ?? listed.get(id)?.timeZone) : null) ?? null,
      nameOf: (id: string | null | undefined): string =>
        id
          ? (byId.get(id)?.name ?? listed.get(id)?.name ?? `Facility ${shortRef(id)}`)
          : 'No facility',
    };
  }, [
    directory.data,
    directorySettled,
    me.data,
    me.errorUpdatedAt,
    me.fetchStatus,
    today.data,
    todaySettled,
  ]);
}
