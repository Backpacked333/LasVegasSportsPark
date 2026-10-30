/**
 * Reads shared by the team screens (SCR-C-21 to SCR-C-29, SPK-CAP-001, SPK-CAP-002, SPK-UX-005).
 *
 * Presentation versus authorization: the API authorizes every read and command (§4.10, §4.11).
 * Which sections a screen shows follows what the workspace (`GET /v1/team-entries/{id}`, CMP-02)
 * says about its viewer: `viewer.actingAsCaptain`, the management lists it fills only for those
 * who may manage (`pendingInvitations` is null otherwise), and `viewer.availableActions`, the
 * action ids the kernel allows this viewer on the entry in its current state. A tool is offered
 * only when its action is listed; the API still answers a refused command ACCESS_DENIED or
 * NOT_FOUND, which is rendered "not available".
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

export type Workspace = Schema<'TeamEntryWorkspace'>;
export type Me = Schema<'Me'>;

export type MyTeamEntry = Schema<'MyTeamEntry'>;

/** Query key prefix of every team workspace, for invalidation after a command. */
export const WORKSPACE_KEY = ['api', '/team-entries/{id}'] as const;
/** Query key prefix of the signed-in person's teams (SCR-C-21), refreshed after a team command. */
export const MY_TEAMS_KEY = ['api', '/me/team-entries'] as const;

/**
 * Workspace action ids (`viewer.availableActions`, CMP-02) the screens offer a tool for. The ids
 * are the API's (`competition.actions.ts`); the client never infers one from a role.
 */
export const TEAM_ACTIONS = {
  invite: 'competition.invite_player',
  revokeInvitation: 'competition.revoke_team_invitation',
  decideJoinRequest: 'competition.decide_join_request',
  manageRoster: 'competition.manage_roster',
  handoverRole: 'competition.handover_team_role',
  requestAvailability: 'competition.request_availability',
  renew: 'competition.renew_team_entry',
} as const;
export type TeamActionId = (typeof TEAM_ACTIONS)[keyof typeof TEAM_ACTIONS];

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

/**
 * `GET /v1/me/team-entries` (CMP-02, SCR-C-21): the live teams the signed-in person and the people
 * they may view are on, each with the next game, its venue and readiness counts.
 */
export function useMyTeamEntries() {
  const signedIn = useSignedIn();
  return useApiQuery({ path: '/me/team-entries', enabled: signedIn });
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
  /**
   * The management view: the API says the viewer acts as captain, or it filled the lists only
   * managers see (`pendingInvitations` is null for everyone else).
   */
  captainView: boolean;
  /**
   * The API says the viewer acts as captain (`viewer.actingAsCaptain`): the captain, or a
   * co-captain only when the rule set lets co-captains act as captain. A co-captain who may not
   * still gets the management view (the API fills its lists for co-captains), but not what the API
   * allows the captain only, such as contacting the operating team about the team (SUP-01).
   */
  actingAsCaptain: boolean;
  /** This person is on the effective roster. */
  onRoster: boolean;
  /** The kernel allows this action on the entry now (`viewer.availableActions`). */
  can: (action: TeamActionId) => boolean;
}

function effective(record: { effectiveFrom: string; effectiveTo: string | null }, now: Date) {
  return (
    new Date(record.effectiveFrom) <= now &&
    (record.effectiveTo === null || new Date(record.effectiveTo) > now)
  );
}

/** The management view (`Viewer.captainView`) from the workspace alone. */
export function hasManagementView(workspace: Workspace): boolean {
  return workspace.viewer.actingAsCaptain || workspace.pendingInvitations !== null;
}

/**
 * Shown when the management view is on but the API does not list the action now. The API names
 * no reason (a season that ended, an entry not approved yet, a co-captain the rule set does not
 * let act as captain), so neither does the app.
 */
export function notAvailableNow(what: string): string {
  return `${what} is not available for this team now.`;
}

export function viewerOf(workspace: Workspace, personId: string | null, now: Date): Viewer {
  const allowed = new Set(workspace.viewer.availableActions);
  const can = (action: TeamActionId) => allowed.has(action);
  const actingAsCaptain = workspace.viewer.actingAsCaptain;
  const captainView = hasManagementView(workspace);
  if (!personId) return { personId: null, captainView, actingAsCaptain, onRoster: false, can };
  const onRoster = workspace.roster.some(
    (m) =>
      m.personId === personId &&
      (m.status === 'active' || m.status === 'guest' || m.status === 'substitute') &&
      effective(m, now),
  );
  return { personId, captainView, actingAsCaptain, onRoster, can };
}

/** Current captain and co-captain role records (effective now), captain first. */
export function currentLeaders(workspace: Workspace, now: Date) {
  return workspace.roles
    .filter((r) => (r.role === 'captain' || r.role === 'co_captain') && effective(r, now))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === 'captain' ? -1 : 1));
}

/** Display names of roster rows by person id (the workspace already shows them to this viewer). */
export function rosterNames(workspace: Workspace): Map<string, string> {
  return new Map(workspace.roster.map((m) => [m.personId, m.displayName]));
}
