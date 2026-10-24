/**
 * Facilities the viewer works in, with names and time zones where the API states them
 * (SPK-SCHED-008: facility-local behaviour derives from the facility's time zone). The API has no
 * facility directory for a principal's scope: ids come from `GET /v1/me` (`principal.facilityIds`,
 * empty = the whole organization) and names and zones from the Today feed when the viewer may read
 * it, like the shell's facility switcher. A facility without a known zone is shown and entered in
 * UTC, and the form says so.
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

export function useFacilities() {
  const { session } = useApp();
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const today = useApiQuery({
    path: '/today',
    enabled: signedIn && me.data?.principal.kind === 'staff',
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const listed = new Map(
      (today.data?.facilities ?? []).map((f) => [
        f.facilityId,
        { id: f.facilityId, name: f.name, timeZone: f.timezone },
      ]),
    );
    const scoped = me.data?.principal.facilityIds ?? [];
    const ids = scoped.length > 0 ? scoped : [...listed.keys()];
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
        (me.data !== undefined || me.error !== null || me.fetchStatus === 'paused') &&
        (today.data !== undefined || today.error !== null || today.fetchStatus !== 'fetching'),
      /** The facility's zone, or null when the API has not stated it to this viewer. */
      timeZoneOf: (id: string | null | undefined): string | null =>
        (id ? (byId.get(id)?.timeZone ?? listed.get(id)?.timeZone) : null) ?? null,
      nameOf: (id: string | null | undefined): string =>
        id ? (byId.get(id)?.name ?? `Facility ${shortRef(id)}`) : 'No facility',
    };
  }, [me.data, me.error, me.fetchStatus, today.data, today.error, today.fetchStatus]);
}
