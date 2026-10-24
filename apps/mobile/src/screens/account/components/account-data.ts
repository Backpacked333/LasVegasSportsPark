/**
 * Account data shared by SCR-C-01, SCR-C-02, SCR-C-17, SCR-C-30, SCR-C-31 and SCR-C-36: who is
 * signed in and what they may do (`GET /v1/me`), one person's name (`GET /v1/people/{id}`), the six
 * action-specific permissions (SPK-IAM-003) and date wording.
 *
 * The client never decides authorization: `authorities` is the API's statement of the permissions
 * this person holds over others right now (never inferred from household membership, §4.5). A
 * person the viewer may not read is "not available", with no hint that a record exists (§4.10).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery, type ApiQueryResult } from '../../../api/useApiQuery';
import { useApp } from '../../../providers/AppProviders';

export type GrantPermission = Schema<'GrantPermission'>;
/**
 * The OpenAPI document marks the `Person` component itself as nullable (the `.nullable()` of
 * `MeResponse.person` leaked into the shared component; reported), so the non-null form is named.
 */
export type Person = NonNullable<Schema<'Person'>>;

/** `GET /v1/me`; `person` is `null` while the account is not linked to a person yet. */
export type MeData = Schema<'Me'>;
export type Authority = MeData['authorities'][number];

export const ME_QUERY_KEY = ['api', '/me'] as const;

export function useMe(): ApiQueryResult<'/me'> {
  const { session } = useApp();
  return useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
}

/** The six permissions in the order of SPK-IAM-003, each with the words the customer sees. */
export const GRANT_PERMISSIONS: readonly {
  permission: GrantPermission;
  label: string;
  detail: string;
}[] = [
  { permission: 'view', label: 'View', detail: 'See schedules, registrations and records' },
  { permission: 'register', label: 'Register', detail: 'Register for activities and teams' },
  { permission: 'pay', label: 'Pay', detail: 'Pay for registrations and balances' },
  {
    permission: 'receive_messages',
    label: 'Receive messages',
    detail: 'Receive operational messages about this person',
  },
  {
    permission: 'complete_forms',
    label: 'Complete forms',
    detail: 'Sign forms and acknowledgments',
  },
  { permission: 'collect', label: 'Collect', detail: 'Collect from supervised sessions (pickup)' },
];

export function permissionLabel(permission: GrantPermission): string {
  return GRANT_PERMISSIONS.find((g) => g.permission === permission)?.label ?? permission;
}

/** "View, Register and Pay" in the SPK-IAM-003 order. */
export function listPermissions(permissions: readonly GrantPermission[]): string {
  const labels = GRANT_PERMISSIONS.filter((g) => permissions.includes(g.permission)).map(
    (g) => g.label,
  );
  if (labels.length === 0) return 'None';
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function personDisplayName(person: Pick<Person, 'givenName' | 'familyName'>): string {
  return `${person.givenName} ${person.familyName}`.trim();
}

export type PersonNameState =
  | { status: 'loading' }
  | { status: 'ready'; name: string; kind: Person['kind'] }
  /** NOT_FOUND or ACCESS_DENIED: the viewer may not read this person (e.g. a collect-only delegate). */
  | { status: 'unavailable' }
  | { status: 'error'; code: string };

/** One person's display name; the id never appears on screen or in a log. */
export function usePersonName(personId: string): PersonNameState {
  const person = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  if (person.data) {
    return { status: 'ready', name: personDisplayName(person.data), kind: person.data.kind };
  }
  if (person.error) {
    if (person.error.isNotFound || person.error.isPermissionRestriction) {
      return { status: 'unavailable' };
    }
    return { status: 'error', code: person.error.code };
  }
  return { status: 'loading' };
}

export function personNameText(state: PersonNameState): string {
  switch (state.status) {
    case 'ready':
      return state.name;
    case 'loading':
      return 'Loading name…';
    case 'unavailable':
      return 'Name not available to you';
    case 'error':
      return `Name could not be loaded (${state.code})`;
  }
}

/**
 * A date and time with its time zone, e.g. "Oct 27, 2026, 12:00 PM UTC". Invitations, claims and
 * feeds belong to the organization, not to one facility, so the device time zone is used and named.
 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
