/**
 * Facilities a staff member may choose on the Reports and Administration screens: the principal's
 * facility scope from `GET /v1/me` (empty = the whole organization, then the facilities the Today
 * feed lists), named from the Today feed as the facility switcher does (§4.3). The API has no
 * facility directory, so an unnamed facility shows a short reference. The time zone and local date
 * come from the same feed (SPK-SCHED-008); nothing here decides authorization.
 */
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';

export interface FacilityChoice {
  id: string;
  label: string;
  timezone: string | null;
  localDate: string | null;
}

export function useFacilityChoices(): {
  choices: FacilityChoice[];
  /** The principal is scoped to listed facilities (organization-wide reports are refused). */
  scoped: boolean;
  loading: boolean;
} {
  const me = useApiQuery({ path: '/me' });
  const today = useApiQuery({ path: '/today', staleTime: 5 * 60_000 });
  return useMemo(() => {
    const feed = today.data?.facilities ?? [];
    const names = new Map(feed.map((f) => [f.facilityId, f.name]));
    const byId = new Map(feed.map((f) => [f.facilityId, f]));
    const scopedIds = me.data?.principal.facilityIds ?? [];
    const ids = scopedIds.length > 0 ? scopedIds : feed.map((f) => f.facilityId);
    return {
      choices: ids.map((id) => ({
        id,
        label: facilityLabel(id, names),
        timezone: byId.get(id)?.timezone ?? null,
        localDate: byId.get(id)?.localDate ?? null,
      })),
      scoped: scopedIds.length > 0,
      loading: me.isLoading || today.isLoading,
    };
  }, [me.data, me.isLoading, today.data, today.isLoading]);
}
