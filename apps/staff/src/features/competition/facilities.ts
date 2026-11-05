/**
 * Facilities on the competition screens (§4.3, SPK-SCHED-008): names and IANA time zones from the
 * facility directory `GET /v1/facilities` (K-04). The choices a staff member is offered are the
 * facilities the API marks `inStaffScope`; the API still decides every command. A facility the
 * directory does not list shows a short reference, and its times fall back to the device zone
 * with the zone named (format.ts).
 */
import { useMemo } from 'react';
import { hasAnswered, useFacilitySummary } from '../../api/facility-directory';
import { useApiQuery } from '../../api/useApiQuery';
import type { Option } from './fields';
import { knownTimeZone, shortRef } from './format';

const DIRECTORY_STALE_MS = 5 * 60_000;

export interface FacilityDirectory {
  /** The facility's name, or a short reference when the directory does not list it. */
  name(id: string | null | undefined): string | null;
  /** The facility's IANA time zone, or null when unknown (device zone, named). */
  timezone(id: string | null | undefined): string | null;
  loaded: boolean;
}

export function useFacilityDirectory(): FacilityDirectory {
  const facilities = useApiQuery({ path: '/facilities', staleTime: DIRECTORY_STALE_MS });
  const items = facilities.data?.items;
  return useMemo(() => {
    const byId = new Map((items ?? []).map((f) => [f.id, f]));
    return {
      name: (id) => (id ? (byId.get(id)?.name ?? `Facility ${shortRef(id)}`) : null),
      timezone: (id) => (id ? (byId.get(id)?.timezone ?? null) : null),
      loaded: items !== undefined,
    };
  }, [items]);
}

/** The facilities a staff member may choose: those the API marks in their scope. */
export function useFacilityOptions(): Option[] {
  const facilities = useApiQuery({ path: '/facilities', staleTime: DIRECTORY_STALE_MS });
  return useMemo(
    () =>
      (facilities.data?.items ?? [])
        .filter((f) => f.inStaffScope !== false)
        .map((f) => ({ value: f.id, label: f.name })),
    [facilities.data],
  );
}

/** Time zone of each division's facility, by division id (null: no facility or unknown zone). */
export function useDivisionZones(
  divisions: readonly { id: string; facilityId: string | null }[] | undefined,
): (divisionId: string | null | undefined) => string | null {
  const directory = useFacilityDirectory();
  return useMemo(() => {
    const zones = new Map(
      (divisions ?? []).map((d) => [d.id, directory.timezone(d.facilityId)] as const),
    );
    return (divisionId) => (divisionId ? (zones.get(divisionId) ?? null) : null);
  }, [divisions, directory]);
}

/** The clock a screen's date-and-time fields are read and shown in (SPK-SCHED-008). */
export interface FacilityClock {
  /** The facility's IANA time zone, or null: the device's zone is used, and named. */
  zone: string | null;
  /** False until the reads that decide the zone have answered; a typed time is not read before. */
  settled: boolean;
}

/**
 * The clock of a division's records (SPK-SCHED-008): the time zone of the division's facility
 * (`GET /v1/divisions/{id}`, then the facility directory, K-04) when known; otherwise the device's
 * zone, named (no division, a division without a facility, or a read that failed). `settled` stays
 * false until those reads have answered, so a time typed meanwhile is never read in a guessed zone.
 * `enabled` is false until the caller knows whether there is a division.
 */
export function useDivisionClock(
  divisionId: string | null | undefined,
  enabled = true,
): FacilityClock {
  const division = useApiQuery({
    path: '/divisions/{id}',
    request: { path: { id: divisionId ?? '' } },
    enabled: enabled && !!divisionId,
    staleTime: DIRECTORY_STALE_MS,
  });
  const divisionSettled = !divisionId || hasAnswered(division);
  const facilityId = division.data?.facilityId ?? null;
  const facility = useFacilitySummary(facilityId, enabled && divisionSettled && !!facilityId);
  if (!enabled || !divisionSettled) return { zone: null, settled: false };
  if (!facilityId) return { zone: null, settled: true };
  return { zone: knownTimeZone(facility.summary?.timezone), settled: facility.settled };
}
