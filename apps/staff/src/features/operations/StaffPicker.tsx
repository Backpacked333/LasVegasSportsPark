/**
 * The directory of officials, coaches and other staff for the staffing screens (SCR-S-32,
 * SCR-S-33; SPK-STAFF-001 to SPK-STAFF-003, §2.1, §4.14).
 *
 * `GET /v1/staff-directory` (ID-05) lists the people holding staff roles now, with their roles and
 * facility scopes: names only, never contacts. Coaches and officials are listed only to viewers
 * with the workforce directory permission (the API leaves them out otherwise). The list is paged
 * by the API's cursor ("Load more staff") and searched by name prefix. Without the directory
 * permission the picker says it is not available; whether a person may take an assignment is
 * still the API's answer to the command (qualification, availability, overlap, turnaround).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { SelectField, TextField } from './fields';
import { humanize } from './format';

export type StaffEntry = Schema<'StaffDirectoryEntry'>;
export type StaffRole = StaffEntry['roles'][number];

const STAFF_PAGE = 50;
export const staffKey = (s: StaffEntry) => s.personId;

export function roleWords(roles: readonly string[]): string {
  return roles.map((r) => humanize(r).toLowerCase()).join(', ');
}

/** The paged directory read (facility and role filters, name prefix). */
export function useStaffDirectory({
  facilityId,
  role,
  query,
  enabled = true,
}: {
  facilityId?: string | null;
  role?: StaffRole;
  query?: string;
  enabled?: boolean;
}) {
  const term = (query ?? '').trim().slice(0, 100);
  return useApiPages({
    path: '/staff-directory',
    request: {
      query: {
        limit: STAFF_PAGE,
        ...(facilityId ? { facilityId } : {}),
        ...(role ? { role } : {}),
        ...(term ? { query: term } : {}),
      },
    },
    keyOf: staffKey,
    enabled,
  });
}

/**
 * Choose a person from the staff directory. `role` narrows the list (an official for an official
 * assignment); the chosen person id is the command's input, never typed by hand.
 */
export function StaffPicker({
  label,
  value,
  onChange,
  facilityId,
  role,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (personId: string, entry: StaffEntry | null) => void;
  facilityId?: string | null;
  role?: StaffRole;
  error?: string;
  hint?: string;
}) {
  const [search, setSearch] = useState('');
  const staff = useStaffDirectory({ facilityId, role, query: search });
  if (staff.error && (staff.error.isPermissionRestriction || staff.error.isNotFound)) {
    return (
      <div role="group" aria-label={`${label} from the staff directory`}>
        <StateView
          variant="unavailable"
          title="Staff directory not available"
          description="The staff directory is not available to you, so a person cannot be chosen here. Ask an administrator for the directory permission."
        />
        <p className="caption">Error code: {staff.error.code}</p>
      </div>
    );
  }
  const items = staff.data ?? [];
  const placeholder =
    staff.data === undefined
      ? staff.error
        ? 'Staff could not be loaded'
        : 'Loading staff…'
      : items.length === 0
        ? 'Nobody found'
        : 'Choose a person';
  return (
    <div className="ops-section" role="group" aria-label={`${label} from the staff directory`}>
      <TextField
        label={`Find ${label.toLowerCase()} by name`}
        value={search}
        onChange={setSearch}
        type="search"
        hint="The first letters of the given or family name."
      />
      <SelectField
        label={label}
        value={value}
        onChange={(id) => onChange(id, items.find((s) => s.personId === id) ?? null)}
        placeholder={placeholder}
        disabled={staff.data === undefined}
        hint={hint}
        error={error}
        options={items.map((s) => ({
          value: s.personId,
          label: `${s.displayName} (${roleWords(s.roles)})`,
        }))}
      />
      {staff.error ? (
        <StateView variant="error" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : null}
      <LoadMore pages={staff} label="staff" />
    </div>
  );
}
