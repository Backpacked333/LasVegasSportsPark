/**
 * Facilities a staff member may choose on the competition screens: the principal's facility scope
 * from `GET /v1/me` (empty = the whole organization, then the facilities the Today feed lists),
 * named from the Today feed as the facility switcher does (§4.3). The API has no facility
 * directory, so an unnamed facility shows a short reference.
 */
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { facilityLabel } from '../../layout/FacilitySwitcher';
import type { Option } from './fields';

export function useFacilityOptions(): Option[] {
  const me = useApiQuery({ path: '/me' });
  const today = useApiQuery({ path: '/today', staleTime: 5 * 60_000 });
  return useMemo(() => {
    const names = new Map((today.data?.facilities ?? []).map((f) => [f.facilityId, f.name]));
    const scoped = me.data?.principal.facilityIds ?? [];
    const ids = scoped.length > 0 ? scoped : [...names.keys()];
    return ids.map((id) => ({ value: id, label: facilityLabel(id, names) }));
  }, [me.data, today.data]);
}
