import type { GrantPermission, TeamRole } from './actions';

/**
 * Relationship authority (identity module): does `actorPersonId` currently hold `permission`
 * over `subjectPersonId`? Must evaluate effective dates and revocations (SPK-IAM-003/006).
 */
export interface RelationshipAuthorityPort {
  hasPermission(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermission,
  ): Promise<boolean>;
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

export const denyAllRelationshipAuthority: RelationshipAuthorityPort = {
  hasPermission: async () => false,
};

export const denyAllTeamAuthority: TeamAuthorityPort = {
  hasTeamRole: async () => false,
};
