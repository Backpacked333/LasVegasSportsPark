/**
 * Maintenance task owners (SCR-S-41, SPK-FAC-002): choosing an owner from the staff directory and
 * showing an owner's name.
 *
 * - `OwnerPicker` lists the staff whose roles cover the task's facility, from
 *   `GET /v1/staff-directory?facilityId=` (ID-05: names, roles and facility scopes in effect, never
 *   contacts), in cursor pages with "Load more staff" and a name-prefix search. Whether a person
 *   may own the task is the API's answer (an inactive or non-adult person is refused with
 *   VALIDATION_FAILED on `assignedOwnerPersonId`). Without identity.read_staff_directory the
 *   picker says the directory is not available; "Assign to me" stays.
 * - `useOwnerNames` and `ownerLabel` read owners' names through `GET /v1/person-names` (names
 *   only, §4.14; one read per set of ids); a name the viewer may not see reads "assigned (name not
 *   available)".
 */
import type { Schema } from '@sportspark/api-client';
import { useId, useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { usePersonNames, type PersonNameEntry } from './person-names';

type StaffEntry = Schema<'StaffDirectoryEntry'>;

const STAFF_PAGE = 100;
const staffKey = (s: StaffEntry) => s.personId;

function roleWords(roles: readonly string[]): string {
  return roles.map((r) => r.replace(/_/g, ' ')).join(', ');
}

export function OwnerPicker({
  facilityId,
  value,
  onChange,
  disabled,
  label = 'Owner',
}: {
  facilityId: string;
  value: string;
  onChange: (personId: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const selectId = useId();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const term = search.trim();
  const staff = useApiPages({
    path: '/staff-directory',
    request: {
      query: { facilityId, limit: STAFF_PAGE, ...(term ? { query: term.slice(0, 100) } : {}) },
    },
    keyOf: staffKey,
  });
  if (staff.error && (staff.error.isPermissionRestriction || staff.error.isNotFound)) {
    return (
      <StateView
        variant="unavailable"
        title="Staff directory not available"
        description="The staff directory is not available to you, so another owner cannot be chosen here. You can still assign the task to yourself."
      />
    );
  }
  return (
    <div className="field-row" role="group" aria-label={`${label} from the staff directory`}>
      <label htmlFor={searchId}>Find staff by name</label>
      <input
        id={searchId}
        value={search}
        maxLength={100}
        onChange={(e) => setSearch(e.target.value)}
      />
      <label htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        value={value}
        disabled={disabled || staff.data === undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {staff.data === undefined
            ? staff.error
              ? 'Staff could not be loaded'
              : 'Loading staff…'
            : staff.data.length === 0
              ? 'No staff found'
              : 'Choose…'}
        </option>
        {(staff.data ?? []).map((s) => (
          <option key={s.personId} value={s.personId}>
            {s.displayName} ({roleWords(s.roles)})
          </option>
        ))}
      </select>
      {staff.error ? (
        <StateView variant="error" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : null}
      <LoadMore pages={staff} label="staff" />
    </div>
  );
}

/** Names of task owners (one `GET /v1/person-names` per set of ids), leaving out the viewer. */
export function useOwnerNames(
  ownerIds: readonly (string | null)[],
  me: string | null,
): ReadonlyMap<string, PersonNameEntry> {
  return usePersonNames(ownerIds.filter((id): id is string => id !== null && id !== me));
}

/** "unassigned", "you", the owner's name, or "assigned (name not available)". */
export function ownerLabel(
  personId: string | null,
  me: string | null,
  names: ReadonlyMap<string, PersonNameEntry>,
): string {
  if (personId === null) return 'unassigned';
  if (personId === me) return 'you';
  const entry = names.get(personId);
  if (entry?.state === 'ready') return entry.name.displayName;
  if (entry === undefined || entry.state === 'loading') return 'assigned';
  return 'assigned (name not available)';
}
