/**
 * Facility names and time zones of the organization from `GET /v1/facilities` (K-04,
 * SPK-SCHED-008), one cached read shared by the Today, People and support screens, so every
 * facility-local time is shown in its facility's zone. Until the read answers, or when it fails,
 * a facility is named by its reference and times fall back to the device zone with the zone named
 * (`formatDateTime` without a zone).
 */
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';

export interface FacilityDirectory {
  name(id: string | null | undefined): string | null;
  timezone(id: string | null | undefined): string | null;
}

export const FACILITIES_STALE_MS = 5 * 60_000;

export function useFacilityDirectory(): FacilityDirectory {
  const facilities = useApiQuery({ path: '/facilities', staleTime: FACILITIES_STALE_MS });
  return useMemo(() => {
    const items = facilities.data?.items ?? [];
    const names = new Map(items.map((f) => [f.id, f.name]));
    const zones = new Map(items.map((f) => [f.id, f.timezone]));
    return {
      name: (id) => (id ? facilityLabel(id, names) : null),
      timezone: (id) => (id ? (zones.get(id) ?? null) : null),
    };
  }, [facilities.data]);
}
