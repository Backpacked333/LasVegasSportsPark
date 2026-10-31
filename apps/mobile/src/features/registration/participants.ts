/**
 * The people the signed-in customer may act for (SCR-C-09, SCR-C-13; SPK-IAM-003): themselves
 * when they are an adult, and every person the API lists in `GET /v1/me` `authorities`. The
 * client does not decide authority: it shows the permissions the API reports, and the API checks
 * each command again (PARTICIPANT_AUTHORITY_REQUIRED, protected NOT_FOUND).
 *
 * Child data is minimized (§4.14): names come from the names-only `GET /v1/person-names` (ID-02;
 * no date of birth, contact point or household), only the given name is shown, nothing is logged,
 * and ids never appear in a route. A person the API leaves out of that answer is "not available".
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { usePersonNames } from '../../api/person-names';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

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
 * Participants with their permissions. Subjects whose name the API does not give are left out:
 * the app never implies a record it may not read exists. A names read that failed is reported in
 * `namesError` (with `retryNames`) so the screen shows its code and "Try again".
 */
export function useParticipants() {
  const me = useMe();
  const subjects = (me.data?.authorities ?? []).filter((a) => a.permissions.includes('view'));
  const names = usePersonNames(me.data ? subjects.map((s) => s.subjectPersonId) : []);
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
  let namesError: ApiError | null = null;
  let retryNames: (() => void) | null = null;
  for (const subject of subjects) {
    const entry = names.get(subject.subjectPersonId);
    if (!entry || entry.state === 'loading') {
      namesLoading = true;
      continue;
    }
    if (entry.state === 'error') {
      namesError = namesError ?? entry.error;
      retryNames = retryNames ?? entry.retry;
      continue;
    }
    if (entry.state !== 'ready') continue;
    participants.push({
      personId: subject.subjectPersonId,
      displayName: entry.name.givenName,
      self: false,
      kind: entry.name.kind,
      permissions: subject.permissions,
    });
  }
  return {
    me,
    participants,
    namesLoading,
    namesError,
    retryNames,
    signedInPersonId: person?.id ?? null,
  };
}

/** Names for the participants of basket lines, quotes and waitlist entries (`GET /v1/person-names`). */
export function useParticipantNames(personIds: readonly string[]) {
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  const others = me.data ? personIds.filter((id) => id !== selfId) : [];
  const names = usePersonNames(others);
  return (personId: string): string => {
    if (personId === selfId) return 'You';
    const entry = names.get(personId);
    if (entry?.state === 'ready') return entry.name.givenName;
    if (me.isPending || !entry || entry.state === 'loading') return 'Loading name…';
    // Left out by the API (the account may not view them) or not readable now.
    return 'Name not available';
  };
}
