import type { GrantPermission, TeamRole } from './actions';

/**
 * Relationship authority (identity module): does `actorPersonId` currently hold `permission`
 * over `subjectPersonId`? Must evaluate effective dates and revocations (SPK-IAM-003/006).
 * The implementation also decides self (actor === subject): an active adult holds every
 * permission over themselves; a child never holds pay or collect over themselves. It must read
 * through the active transaction (`currentTransaction()`), never a second connection.
 */
export interface RelationshipAuthorityPort {
  hasPermission(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermission,
  ): Promise<boolean>;
  /**
   * The people other than the actor over whom the actor holds `permission` now (K-05, IF-01),
   * with the same effectivity rule as `hasPermission`, read through `currentTransaction()`.
   * Customer "my ..." lists start from these subjects (`AuthorizationService.customerSubjects`).
   */
  subjectsWithPermission(
    organizationId: string,
    actorPersonId: string,
    permission: GrantPermission,
  ): Promise<string[]>;
}

/** Team authority (competition module): does the person hold the role on the season team entry? */
export interface TeamAuthorityPort {
  hasTeamRole(
    organizationId: string,
    personId: string,
    teamEntryId: string,
    role: TeamRole,
  ): Promise<boolean>;
}

/**
 * Fallback when no identity module is registered: a person holds every permission over
 * themselves and nothing over anyone else. The identity module refines self for children.
 */
export const denyAllRelationshipAuthority: RelationshipAuthorityPort = {
  hasPermission: async (_organizationId, actorPersonId, subjectPersonId) =>
    actorPersonId === subjectPersonId,
  // Nobody holds anything over anyone else: me-lists show only the principal's own records.
  subjectsWithPermission: async () => [],
};

export const denyAllTeamAuthority: TeamAuthorityPort = {
  hasTeamRole: async () => false,
};
