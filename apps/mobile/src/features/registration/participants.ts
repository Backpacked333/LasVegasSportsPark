/**
 * The people the signed-in customer may act for (SCR-C-09, SCR-C-13; SPK-IAM-003): themselves
 * when they are an adult, and every person the API lists in `GET /v1/me` `authorities`. The
 * client does not decide authority: it shows the permissions the API reports, and the API checks
 * each command again (PARTICIPANT_AUTHORITY_REQUIRED, protected NOT_FOUND).
 *
 * Child data is minimized (§4.14): only the given name is shown, nothing is logged, and ids never
 * appear in a route.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { useApiRecords } from './queries';

export type GrantPermission = Schema<'GrantPermission'>;

export interface Participant {
  personId: string;
  /** "You" for the signed-in adult, otherwise the given name. */
  displayName: string;
  self: boolean;
  kind: 'adult' | 'child' | null;
  permissions: readonly GrantPermission[];
}

const SELF_PERMISSIONS: readonly GrantPermission[] = [
  'view',
  'register',
  'pay',
  'complete_forms',
  'receive_messages',
];

export function useMe() {
  const { session } = useApp();
  return useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
}

/**
 * Participants with their permissions. Subjects whose person record the API does not show are
 * left out: the app never implies a record it may not read exists.
 */
export function useParticipants() {
  const me = useMe();
  const subjects = (me.data?.authorities ?? []).filter((a) => a.permissions.includes('view'));
  const people = useApiRecords(
    '/people/{id}',
    subjects.map((s) => s.subjectPersonId),
    me.data !== undefined,
  );
  const person = me.data?.person ?? null;
  const participants: Participant[] = [];
  if (person && person.kind === 'adult') {
    participants.push({
      personId: person.id,
      displayName: `You (${person.givenName})`,
      self: true,
      kind: 'adult',
      permissions: SELF_PERMISSIONS,
    });
  }
  let namesLoading = false;
  for (const subject of subjects) {
    const record = people[subject.subjectPersonId];
    if (!record || record.loading) {
      namesLoading = true;
      continue;
    }
    if (!record.data) continue;
    participants.push({
      personId: subject.subjectPersonId,
      displayName: record.data.givenName,
      self: false,
      kind: record.data.kind,
      permissions: subject.permissions,
    });
  }
  return { me, participants, namesLoading, signedInPersonId: person?.id ?? null };
}

/** Names for the participants of basket lines, quotes and waitlist entries. */
export function useParticipantNames(personIds: readonly string[]) {
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  const others = personIds.filter((id) => id !== selfId);
  const people = useApiRecords('/people/{id}', others, me.data !== undefined);
  return (personId: string): string => {
    if (personId === selfId) return 'You';
    const record = people[personId];
    if (record?.data) return record.data.givenName;
    if (record?.loading || me.isPending) return 'Loading name…';
    return 'Participant';
  };
}
