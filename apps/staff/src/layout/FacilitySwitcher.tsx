/**
 * Facility switcher limited to the principal's facility scope as the API answers it (§4.3). Names
 * and scope come from the facility directory, `GET /v1/facilities` (K-04; `inStaffScope` is the
 * API's answer for this staff principal), within `GET /v1/me` `principal.facilityIds` when that is
 * not empty: one cached read of configuration shared with every screen. The shell never reads the
 * Today feed: that read computes every operational source and belongs to the Today screen alone
 * (§4.5 bounded reads). While the directory has not answered, or when it fails, the scope from
 * `GET /v1/me` (`principal.facilityIds`, empty = the whole organization) is offered, and an
 * unnamed facility shows a short reference.
 */
import { useEffect, useId, useMemo } from 'react';
import { hasAnswered, useFacilityDirectory } from '../api/facility-directory';
import { useApiQuery } from '../api/useApiQuery';
import { useApp } from '../providers/AppProviders';
import { Icon } from '../ui/Icon';

export function facilityLabel(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? `Facility ${id.slice(0, 8)}`;
}

export function FacilitySwitcher() {
  const { session, facilityId, setFacilityId } = useApp();
  const selectId = useId();
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me', enabled: signedIn });
  const isStaff = me.data?.principal.kind === 'staff';
  const directory = useFacilityDirectory(signedIn && isStaff);

  const names = useMemo(
    () => new Map((directory.data?.items ?? []).map((f) => [f.id, f.name])),
    [directory.data],
  );
  const scoped = useMemo(() => me.data?.principal.facilityIds ?? [], [me.data]);
  const options = useMemo(
    () =>
      directory.data
        ? directory.data.items
            .filter(
              (f) => f.inStaffScope === true && (scoped.length === 0 || scoped.includes(f.id)),
            )
            .map((f) => f.id)
        : scoped,
    [directory.data, scoped],
  );
  // Only once the scope is known: a choice is never dropped while the directory is still loading.
  const scopeKnown = me.data !== undefined && hasAnswered(directory);

  useEffect(() => {
    if (facilityId !== null && scopeKnown && !options.includes(facilityId)) setFacilityId(null);
  }, [facilityId, scopeKnown, options, setFacilityId]);

  if (!isStaff) return null;
  if (options.length === 1 && scoped.length === 1) {
    return (
      <p className="facility-switcher">
        <Icon name="location_on" size={18} />
        Facility: {facilityLabel(options[0] as string, names)}
      </p>
    );
  }
  return (
    <div className="facility-switcher">
      <Icon name="location_on" size={18} />
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
