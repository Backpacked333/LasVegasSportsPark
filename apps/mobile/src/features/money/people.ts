/**
 * The people whose participation, balances, credits and makeups the signed-in customer may look
 * at (SCR-C-32, SCR-C-34, SCR-C-35): themselves, and each person the API lists in `GET /v1/me`
 * `authorities` (SPK-IAM-003). The client does not decide authority: every read is checked again
 * by the API, which answers protected NOT_FOUND for anything this account may not see (§4.10).
 *
 * Child data is minimized (§4.14): only the given name is shown, nothing is logged, and person ids
 * never appear in a route (the selected person is screen state).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { useApiRecords } from './records';

export type GrantPermission = Schema<'GrantPermission'>;

export interface AccountPerson {
  personId: string;
  /** "You" for the signed-in person, otherwise the given name. */
  displayName: string;
  self: boolean;
  /** Permissions the API reports this account holds over the person; `null` for oneself. */
  permissions: readonly GrantPermission[] | null;
}

export function useMe() {
  const { session } = useApp();
  return useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
}

/**
 * Oneself first, then the people the API says this account holds permissions over. A person whose
 * record the API does not show is left out: the app never implies a record it may not read.
 */
export function useAccountPeople() {
  const me = useMe();
  const authorities = me.data?.authorities ?? [];
  const person = me.data?.person ?? null;
  const others = authorities.filter((a) => a.subjectPersonId !== person?.id);
  const records = useApiRecords(
    '/people/{id}',
    others.map((a) => a.subjectPersonId),
    me.data !== undefined,
  );
  const people: AccountPerson[] = [];
  if (person) {
    people.push({ personId: person.id, displayName: 'You', self: true, permissions: null });
  }
  let namesLoading = false;
  for (const authority of others) {
    const record = records[authority.subjectPersonId];
    if (!record || record.loading) {
      namesLoading = true;
      continue;
    }
    if (!record.data) continue;
    people.push({
      personId: authority.subjectPersonId,
      displayName: record.data.givenName,
      self: false,
      permissions: authority.permissions,
    });
  }
  return { me, people, namesLoading };
}

/** A participant's display name for a record ("You", a given name, or a neutral word). */
export function useNameOf() {
  const { me, people, namesLoading } = useAccountPeople();
  const loading = namesLoading || (me.data === undefined && me.isPending);
  return (personId: string): string => {
    const found = people.find((p) => p.personId === personId);
    if (found) return found.displayName;
    return loading ? 'Loading name…' : 'Participant';
  };
}
