/**
 * Facilities for SCR-S-55 and SCR-S-56: the organization's facility directory (`GET /v1/facilities`,
 * K-04) with each facility's IANA time zone (SPK-SCHED-008) and whether the viewer's staff roles
 * act there (`inStaffScope`, §2.1, §4.14). Registers, sessions, sales and access devices belong to
 * one facility, and their times are shown in that facility's zone with the zone named. The picker
 * offers only facilities in the viewer's staff scope; the API still decides every read and command.
 */
import { useMemo, useState } from 'react';
import type { Schema } from '@sportspark/api-client';
import { useApiQuery, type ApiQueryResult } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { SelectField } from '../../ui/FormFields';
import { shortRef } from '../registration-finance/format';

export type Facility = Schema<'FacilitySummary'>;

export interface FacilityDirectory {
  query: ApiQueryResult<'/facilities'>;
  /** Facilities the viewer acts in (all, when the API states no scope). */
  inScope: readonly Facility[];
  nameOf(id: string | null | undefined): string;
  /** The facility's zone, or null while the directory has not answered. */
  timeZoneOf(id: string | null | undefined): string | null;
}

export function useFacilityDirectory(): FacilityDirectory {
  const query = useApiQuery({ path: '/facilities', staleTime: 5 * 60_000 });
  const items = query.data?.items;
  const derived = useMemo(() => {
    const all = items ?? [];
    const byId = new Map(all.map((f) => [f.id, f]));
    return {
      inScope: all.filter((f) => f.inStaffScope !== false && f.status !== 'archived'),
      nameOf: (id: string | null | undefined) =>
        id ? (byId.get(id)?.name ?? `Facility ${shortRef(id)}`) : 'Every facility',
      timeZoneOf: (id: string | null | undefined) => (id ? (byId.get(id)?.timezone ?? null) : null),
    };
  }, [items]);
  return { query, ...derived };
}

/**
 * The facility a page works in: the viewer's choice, else the shell's selected facility when it
 * is in scope, else the only facility in scope. With several and no choice, nothing is assumed.
 */
export function useFacilityChoice(directory: FacilityDirectory) {
  const { facilityId: shellFacility } = useApp();
  const [chosen, setChosen] = useState<string | null>(null);
  const ids = directory.inScope.map((f) => f.id);
  const fallback =
    shellFacility && ids.includes(shellFacility) ? shellFacility : ids.length === 1 ? ids[0] : null;
  const facilityId = chosen !== null ? chosen || null : (fallback ?? null);
  return { facilityId, setFacilityId: (id: string) => setChosen(id) };
}

export function FacilityField({
  directory,
  value,
  onChange,
  label = 'Facility',
  allowAll,
  required,
  disabled,
}: {
  directory: FacilityDirectory;
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
  /** Offer "Every facility" (an empty filter). */
  allowAll?: boolean;
  required?: boolean;
  disabled?: boolean;
}) {
  const { query } = directory;
  const hint =
    query.error && query.data === undefined
      ? `The facility list could not be loaded (${query.error.code}).`
      : undefined;
  return (
    <SelectField
      label={label}
      required={required}
      disabled={disabled}
      hint={hint}
      value={value ?? ''}
      onChange={onChange}
      placeholder={allowAll ? 'Every facility' : 'Choose a facility'}
      options={directory.inScope.map((f) => ({ value: f.id, label: f.name }))}
    />
  );
}
