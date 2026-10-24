/**
 * Facility names and timezones in the viewer's scope, from the unfiltered Today feed (the same
 * cache entry the facility switcher reads). The API has no facility directory for a principal's
 * scope, so screens outside Today use this to show facility-local times (SPK-SCHED-008); when it
 * is not readable, times fall back to the device zone with the zone named.
 */
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';

export interface FacilityDirectory {
  name(id: string | null | undefined): string | null;
  timezone(id: string | null | undefined): string | null;
}

export function useFacilityDirectory(): FacilityDirectory {
  const today = useApiQuery({ path: '/today', staleTime: 5 * 60_000 });
  return useMemo(() => {
    const facilities = today.data?.facilities ?? [];
    const names = new Map(facilities.map((f) => [f.facilityId, f.name]));
    const zones = new Map(facilities.map((f) => [f.facilityId, f.timezone]));
    return {
      name: (id) => (id ? facilityLabel(id, names) : null),
      timezone: (id) => (id ? (zones.get(id) ?? null) : null),
    };
  }, [today.data]);
}
