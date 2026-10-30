/**
 * Routes of the team screens SCR-C-21 to SCR-C-29 (app/team/*). Parameters are opaque record ids
 * only: no names, dates of birth or other child data ever appear in a route (§4.14).
 */
export const teamRoutes = {
  /** SCR-C-21, the Teams destination (app/(tabs)/teams.tsx). */
  teams: () => '/teams' as const,
  /** SCR-C-22 */
  workspace: (entryId: string) => `/team/${entryId}` as const,
  /** SCR-C-23 */
  roster: (entryId: string) => `/team/${entryId}/roster` as const,
  /** SCR-C-24 */
  availability: (entryId: string) => `/team/${entryId}/availability` as const,
  /** SCR-C-25, team totals and requests */
  contributions: (entryId: string) => `/team/${entryId}/contributions` as const,
  /** SCR-C-25, the contributions asked of the signed-in person or the people they pay for */
  myContributions: () => '/team/contributions' as const,
  /** SCR-C-25, a player's own contribution */
  contribution: (requestId: string) => `/team/contribution/${requestId}` as const,
  /** SCR-C-26 */
  rosterChange: (entryId: string) => `/team/${entryId}/roster-change` as const,
  /** SCR-C-27, create */
  newEntry: () => '/team/new' as const,
  /** SCR-C-27, renew from a prior season's entry */
  renewEntry: (priorEntryId: string) => `/team/new?renewFrom=${priorEntryId}` as const,
  /** SCR-C-28 */
  standings: (entryId: string) => `/team/${entryId}/standings` as const,
  /** SCR-C-28, one fixture's result revisions */
  result: (entryId: string, fixtureId: string) => `/team/${entryId}/results/${fixtureId}` as const,
  /** SCR-C-29 */
  dispute: (entryId: string, fixtureId: string) =>
    `/team/${entryId}/disputes/${fixtureId}` as const,
  /** SCR-C-28, a tournament pool's table (CMP-15) */
  pool: (entryId: string, poolId: string) => `/team/${entryId}/pools/${poolId}` as const,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * First value of a route parameter (Expo Router gives a string or an array), accepted only when it
 * is a record id: anything else is treated as a missing record ("not available").
 */
export function idParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && UUID.test(first) ? first.toLowerCase() : null;
}
