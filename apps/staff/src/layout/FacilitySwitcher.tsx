/**
 * Facility switcher limited to the principal's facility scope as the API returns it
 * (`GET /v1/me` principal.facilityIds; an empty list means every facility in the organization,
 * §4.3). Names come from the Today feed's facilities when the viewer may read it; the API has no
 * facility directory for a principal's scope, so an unnamed facility shows a short reference.
 */
import { useEffect, useId, useMemo } from 'react';
import { useApiQuery } from '../api/useApiQuery';
import { useApp } from '../providers/AppProviders';

export function facilityLabel(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? `Facility ${id.slice(0, 8)}`;
}

export function FacilitySwitcher() {
  const { session, facilityId, setFacilityId } = useApp();
  const selectId = useId();
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const isStaff = me.data?.principal.kind === 'staff';
  const today = useApiQuery({
    path: '/today',
    enabled: signedIn && isStaff,
    staleTime: 5 * 60_000,
  });

  const names = useMemo(
    () => new Map((today.data?.facilities ?? []).map((f) => [f.facilityId, f.name])),
    [today.data],
  );
  const scoped = useMemo(() => me.data?.principal.facilityIds ?? [], [me.data]);
  // Empty scope = whole organization: offer the facilities the API listed for this viewer.
  const options = useMemo(() => (scoped.length > 0 ? scoped : [...names.keys()]), [scoped, names]);

  useEffect(() => {
    if (facilityId !== null && me.data && !options.includes(facilityId)) setFacilityId(null);
  }, [facilityId, me.data, options, setFacilityId]);

  if (!isStaff) return null;
  if (options.length === 1 && scoped.length === 1) {
    return (
      <p className="facility-switcher">Facility: {facilityLabel(options[0] as string, names)}</p>
    );
  }
  return (
    <div className="facility-switcher">
      <label htmlFor={selectId}>Facility</label>
      <select
        id={selectId}
        value={facilityId ?? ''}
        onChange={(event) => setFacilityId(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">{scoped.length > 0 ? 'All my facilities' : 'All facilities'}</option>
        {options.map((id) => (
          <option key={id} value={id}>
            {facilityLabel(id, names)}
          </option>
        ))}
      </select>
    </div>
  );
}
