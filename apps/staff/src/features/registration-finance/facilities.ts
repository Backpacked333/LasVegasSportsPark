/**
 * Facilities the viewer works in, with names and IANA time zones (SPK-SCHED-008: facility-local
 * behaviour derives from the facility's time zone; K-04 facility directory).
 *
 * The authority is `GET /v1/facilities` (any signed-in principal; `inStaffScope` says whether the
 * staff principal may act there), the one cached directory read the whole dashboard shares. While
 * that read has not answered, or when it fails, the scope comes from `GET /v1/me`
 * (`principal.facilityIds`, empty = the whole organization) with short references for names and no
 * zone, so a screen never invents a zone; the Today feed is never read for this (§4.5: it is the
 * Today screen's read). A facility without a known zone is shown and entered in UTC, and the form
 * says so.
 */
import { useMemo } from 'react';
import { hasAnswered, useFacilityDirectory } from '../../api/facility-directory';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { shortRef } from './format';

export interface FacilityInfo {
  id: string;
  name: string;
  timeZone: string | null;
}

export function useFacilities() {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const directory = useFacilityDirectory(signedIn);
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const directorySettled = hasAnswered(directory) || directory.fetchStatus === 'idle';
  return useMemo(() => {
    const listed = new Map<string, FacilityInfo>();
    for (const f of directory.data?.items ?? []) {
      listed.set(f.id, { id: f.id, name: f.name, timeZone: f.timezone });
    }
    // `inStaffScope: null` is a customer or system principal: every listed facility.
    const ids = directory.data
      ? directory.data.items.filter((f) => f.inStaffScope !== false).map((f) => f.id)
      : (me.data?.principal.facilityIds ?? []);
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
          (me.data !== undefined || me.errorUpdatedAt > 0 || me.fetchStatus === 'paused')),
      /** The facility's zone, or null when the API has not stated it to this viewer. */
      timeZoneOf: (id: string | null | undefined): string | null =>
        (id ? (byId.get(id)?.timeZone ?? listed.get(id)?.timeZone) : null) ?? null,
      nameOf: (id: string | null | undefined): string =>
        id
          ? (byId.get(id)?.name ?? listed.get(id)?.name ?? `Facility ${shortRef(id)}`)
          : 'No facility',
    };
  }, [directory.data, directorySettled, me.data, me.errorUpdatedAt, me.fetchStatus]);
}
