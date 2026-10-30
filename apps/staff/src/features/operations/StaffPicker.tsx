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
import { useEffect, useState } from 'react';
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
 *
 * The select always shows the person the command will name: a chosen person stays in the options
 * (marked "chosen") when a new name search leaves them out, so a command is never sent for a
 * person the screen no longer shows. Enter in the name search only searches; it never submits the
 * enclosing form (SCR-S-32, SCR-S-33).
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
  // The entry behind `value`, kept so the select can still show it when a search drops it.
  const [chosen, setChosen] = useState<StaffEntry | null>(null);
  const staff = useStaffDirectory({ facilityId, role, query: search });
  const items = staff.data ?? [];
  const listed = value ? items.some((s) => s.personId === value) : true;
  // A chosen person outside the current results stays chosen and visible.
  const pinned = !listed && chosen?.personId === value ? chosen : null;
  const shownValue = listed || pinned ? value : '';
  // An id this picker cannot show (set from outside and not in the results) is cleared rather
  // than kept hidden behind the placeholder.
  const hidden = staff.data !== undefined && value !== '' && !listed && !pinned;
  useEffect(() => {
    if (hidden) onChange('', null);
  }, [hidden, onChange]);
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
  const placeholder =
    staff.data === undefined
      ? staff.error
        ? 'Staff could not be loaded'
        : 'Loading staff…'
      : items.length === 0 && !pinned
        ? 'Nobody found'
        : 'Choose a person';
  const choose = (id: string) => {
    const entry = items.find((s) => s.personId === id) ?? (pinned?.personId === id ? pinned : null);
    setChosen(entry);
    onChange(entry ? id : '', entry);
  };
  return (
    <div className="ops-section" role="group" aria-label={`${label} from the staff directory`}>
      <TextField
        label={`Find ${label.toLowerCase()} by name`}
        value={search}
        onChange={setSearch}
        type="search"
        hint="The first letters of the given or family name."
        // The list follows the typed name; Enter must not submit the enclosing form.
        onEnter={() => undefined}
      />
      <SelectField
        label={label}
        value={shownValue}
        onChange={choose}
        placeholder={placeholder}
        disabled={staff.data === undefined && !pinned}
        hint={hint}
        error={error}
        options={[
          ...(pinned
            ? [
                {
                  value: pinned.personId,
                  label: `${pinned.displayName} (${roleWords(pinned.roles)}), chosen`,
                },
              ]
            : []),
          ...items.map((s) => ({
            value: s.personId,
            label: `${s.displayName} (${roleWords(s.roles)})`,
          })),
        ]}
      />
      {staff.error ? (
        <StateView variant="error" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : null}
      <LoadMore pages={staff} label="staff" />
    </div>
  );
}
