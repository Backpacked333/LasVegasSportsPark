/**
 * Maintenance task owners (SCR-S-41, SPK-FAC-002): choosing an owner from the staff directory and
 * showing an owner's name.
 *
 * - `OwnerPicker` lists the staff whose roles cover the task's facility, from
 *   `GET /v1/staff-directory?facilityId=` (ID-05: names, roles and facility scopes in effect, never
 *   contacts), in cursor pages with "Load more staff" and a name-prefix search, and assigns the one
 *   chosen. A choice belongs to the results it was made in: a new search clears it, and only a
 *   person the list shows as chosen is sent. Whether a person may own the task is the API's answer
 *   (an inactive or non-adult person is refused with VALIDATION_FAILED on
 *   `assignedOwnerPersonId`). Without identity.read_staff_directory the picker says the directory
 *   is not available and offers no assign command; "Assign to me" stays.
 * - `useOwnerNames` names owners from the same staff directory of the facility: the facilities
 *   operator, who assigns tasks, may read it but is not given other staff names by
 *   `GET /v1/person-names` (identity.read_person). Only owners the loaded directory does not list
 *   (a former staff member, or one on a page not loaded) are read through `GET /v1/person-names`
 *   (names only, §4.14; one read per set of ids). A name the API leaves out reads "assigned (name
 *   not available)"; a failed read says the name could not be loaded, and on the task screen gives
 *   the error code and "Try again" (SPK-UX-008).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useId, useMemo, useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { usePersonNames } from './person-names';

type StaffEntry = Schema<'StaffDirectoryEntry'>;

const STAFF_PAGE = 100;
const staffKey = (s: StaffEntry) => s.personId;

function roleWords(roles: readonly string[]): string {
  return roles.map((r) => r.replace(/_/g, ' ')).join(', ');
}

/** The first page of the facility's staff directory (shared by the picker and the owner names). */
function directoryRequest(facilityId: string, term = '') {
  return {
    query: { facilityId, limit: STAFF_PAGE, ...(term ? { query: term.slice(0, 100) } : {}) },
  };
}

export function OwnerPicker({
  facilityId,
  currentOwnerId,
  onAssign,
  disabled,
  label = 'Assign to',
}: {
  facilityId: string;
  /** The task's owner now: choosing them again is not sent. */
  currentOwnerId: string | null;
  onAssign: (personId: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const selectId = useId();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState('');
  const [attempted, setAttempted] = useState(false);
  const term = search.trim();
  const staff = useApiPages({
    path: '/staff-directory',
    request: directoryRequest(facilityId, term),
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
  const listed = staff.data ?? [];
  // Only a person the list shows can be the choice: a select whose value matches no option shows
  // its first one ("Choose…"), and what is sent must be what the screen shows as chosen.
  const choice = listed.some((s) => s.personId === chosen) ? chosen : '';
  const loading = staff.data === undefined;
  const assign = () => {
    setAttempted(true);
    if (!choice || choice === currentOwnerId) return;
    onAssign(choice);
  };
  return (
    <div className="field-row" role="group" aria-label={`${label} from the staff directory`}>
      <label htmlFor={searchId}>Find staff by name</label>
      <input
        id={searchId}
        value={search}
        maxLength={100}
        onChange={(e) => {
          // A new search shows other people: the earlier choice is not carried over unseen.
          setSearch(e.target.value);
          setChosen('');
          setAttempted(false);
        }}
      />
      <label htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        value={choice}
        disabled={disabled || loading}
        onChange={(e) => {
          setChosen(e.target.value);
          setAttempted(false);
        }}
      >
        <option value="">
          {loading
            ? staff.error
              ? 'Staff could not be loaded'
              : 'Loading staff…'
            : listed.length === 0
              ? 'No staff found'
              : 'Choose…'}
        </option>
        {listed.map((s) => (
          <option key={s.personId} value={s.personId}>
            {s.displayName} ({roleWords(s.roles)})
          </option>
        ))}
      </select>
      <Button variant="secondary" disabled={disabled || loading} onClick={assign}>
        Assign to the chosen staff member
      </Button>
      {attempted && (!choice || choice === currentOwnerId) ? (
        <span className="error-text" role="alert">
          {choice ? 'This person already owns the task.' : 'Choose a staff member to assign.'}
        </span>
      ) : null}
      {staff.error ? (
        <StateView variant="error" error={staff.error} onRetry={() => void staff.refetch()} />
      ) : null}
      <LoadMore pages={staff} label="staff" />
    </div>
  );
}

export type OwnerNameEntry =
  | { state: 'loading' }
  | { state: 'ready'; displayName: string }
  /** The API left the person out: the viewer may not view them (never "exists but hidden"). */
  | { state: 'unavailable' }
  | { state: 'error'; error: ApiError; retry: () => void };

/**
 * Names of task owners at a facility, leaving out the viewer: the staff directory first, then
 * `GET /v1/person-names` for owners it does not list.
 */
export function useOwnerNames(
  ownerIds: readonly (string | null)[],
  me: string | null,
  facilityId: string,
): ReadonlyMap<string, OwnerNameEntry> {
  const key = [...new Set(ownerIds.filter((id): id is string => id !== null && id !== me))]
    .sort()
    .join(',');
  const wanted = useMemo(() => (key ? key.split(',') : []), [key]);
  const directory = useApiPages({
    path: '/staff-directory',
    request: directoryRequest(facilityId),
    keyOf: staffKey,
    enabled: wanted.length > 0,
  });
  const listed = new Map((directory.data ?? []).map((s) => [s.personId, s.displayName]));
  const settled = directory.data !== undefined || directory.error !== null;
  // A directory the viewer may not read is no failure: names then come from GET /v1/person-names.
  const failed =
    directory.error && !directory.error.isPermissionRestriction && !directory.error.isNotFound
      ? directory.error
      : null;
  const names = usePersonNames(settled ? wanted.filter((id) => !listed.has(id)) : []);
  const map = new Map<string, OwnerNameEntry>();
  for (const id of wanted) {
    const displayName = listed.get(id);
    if (displayName !== undefined) {
      map.set(id, { state: 'ready', displayName });
      continue;
    }
    const entry = settled ? names.get(id) : undefined;
    if (entry === undefined || entry.state === 'loading') {
      map.set(id, { state: 'loading' });
    } else if (entry.state === 'ready') {
      map.set(id, { state: 'ready', displayName: entry.name.displayName });
    } else if (entry.state === 'error') {
      map.set(id, entry);
    } else if (failed) {
      // Left out by the name read, and the directory read itself failed: say so, with a retry.
      map.set(id, { state: 'error', error: failed, retry: () => void directory.refetch() });
    } else {
      map.set(id, { state: 'unavailable' });
    }
  }
  return map;
}

/**
 * "unassigned", "you", the owner's name, "assigned (name not available)" when the API leaves the
 * person out, or "assigned (name could not be loaded)" when the read failed.
 */
export function ownerLabel(
  personId: string | null,
  me: string | null,
  names: ReadonlyMap<string, OwnerNameEntry>,
): string {
  if (personId === null) return 'unassigned';
  if (personId === me) return 'you';
  const entry = names.get(personId);
  if (entry?.state === 'ready') return entry.displayName;
  if (entry === undefined || entry.state === 'loading') return 'assigned';
  if (entry.state === 'error') return 'assigned (name could not be loaded)';
  return 'assigned (name not available)';
}

/** The owner on the task screen: as `ownerLabel`, and a failed name read with its code and retry. */
export function OwnerName({
  personId,
  me,
  names,
}: {
  personId: string | null;
  me: string | null;
  names: ReadonlyMap<string, OwnerNameEntry>;
}) {
  const entry = personId === null || personId === me ? undefined : names.get(personId);
  if (entry?.state === 'error') {
    return (
      <>
        assigned: the name could not be loaded ({entry.error.code}).{' '}
        <Button variant="secondary" onClick={entry.retry}>
          Try again
        </Button>
      </>
    );
  }
  return <>{ownerLabel(personId, me, names)}</>;
}
