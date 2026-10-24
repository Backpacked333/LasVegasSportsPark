/**
 * Reads shared by the team screens (SCR-C-21 to SCR-C-29, SPK-CAP-001, SPK-CAP-002).
 *
 * Presentation versus authorization: the API authorizes every read and command (§4.10, §4.11).
 * The workspace has no "available actions" list, so which sections a screen shows (captain tools
 * or the reduced player view) follows the API's own role records for the signed-in person
 * (`roles` in `GET /v1/team-entries/{id}`). That only decides layout: a captain tool shown to
 * someone the API refuses is answered ACCESS_DENIED or NOT_FOUND and rendered "not available".
 * (Reported: the workspace should state the viewer's permitted actions.)
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

export type Workspace = Schema<'TeamEntryWorkspace'>;
export type Me = Schema<'Me'>;

/** Query key prefix of every team workspace, for invalidation after a command. */
export const WORKSPACE_KEY = ['api', '/team-entries/{id}'] as const;

export function useSignedIn(): boolean {
  return useApp().session.status === 'signed_in';
}

/** `GET /v1/me`: the signed-in person and the authorities they hold over others. */
export function useMe() {
  const signedIn = useSignedIn();
  return useApiQuery({ path: '/me', enabled: signedIn, staleTime: 60_000 });
}

/**
 * The signed-in person's id for layout decisions, whether it is still loading (so a screen does
 * not flash the player view before the captain view), and why it could not be read. A failed or
 * paused read is reported, never turned into "not your team" (SPK-UX-008): screens wait for it.
 */
export function useViewerPerson(): {
  personId: string | null;
  loading: boolean;
  /** The read failed and nothing is cached. */
  error: ApiError | null;
  /** The read is waiting for a connection and nothing is cached. */
  paused: boolean;
  refetch: () => void;
} {
  const me = useMe();
  const missing = me.data === undefined;
  return {
    personId: me.data?.person?.id ?? null,
    loading: missing && me.error === null && me.fetchStatus === 'fetching',
    error: missing ? me.error : null,
    paused: missing && me.error === null && me.fetchStatus === 'paused',
    refetch: () => void me.refetch(),
  };
}

/** `GET /v1/team-entries/{id}`: the captain workspace (reduced for roster players). */
export function useWorkspace(entryId: string | null) {
  const signedIn = useSignedIn();
  return useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: entryId ?? '' } },
    enabled: signedIn && entryId !== null,
  });
}

export interface Viewer {
  personId: string | null;
  /** The API's role records name this person captain or co-captain now. */
  captainView: boolean;
  /** This person is on the effective roster. */
  onRoster: boolean;
}

function effective(record: { effectiveFrom: string; effectiveTo: string | null }, now: Date) {
  return (
    new Date(record.effectiveFrom) <= now &&
    (record.effectiveTo === null || new Date(record.effectiveTo) > now)
  );
}

export function viewerOf(workspace: Workspace, personId: string | null, now: Date): Viewer {
  if (!personId) return { personId: null, captainView: false, onRoster: false };
  const captainView = workspace.roles.some(
    (r) =>
      r.personId === personId &&
      (r.role === 'captain' || r.role === 'co_captain') &&
      effective(r, now),
  );
  const onRoster = workspace.roster.some(
    (m) =>
      m.personId === personId &&
      (m.status === 'active' || m.status === 'guest' || m.status === 'substitute') &&
      effective(m, now),
  );
  return { personId, captainView, onRoster };
}

/** Display names of roster rows by person id (the workspace already shows them to this viewer). */
export function rosterNames(workspace: Workspace): Map<string, string> {
  return new Map(workspace.roster.map((m) => [m.personId, m.displayName]));
}

/**
 * Children on this roster over whom the signed-in person holds `register` (from `GET /v1/me`
 * authorities): the people they may answer availability for (SPK-CAP-003, SPK-IAM-003). The API
 * re-checks the authority on every command.
 */
export function respondableChildren(workspace: Workspace, me: Me | undefined, now: Date) {
  if (!me) return [];
  const register = new Set(
    me.authorities.filter((a) => a.permissions.includes('register')).map((a) => a.subjectPersonId),
  );
  return workspace.roster.filter(
    (m) =>
      m.personKind === 'child' &&
      register.has(m.personId) &&
      (m.status === 'active' || m.status === 'guest' || m.status === 'substitute') &&
      effective(m, now),
  );
}
