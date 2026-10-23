import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type ActionId,
  type AuthorizationDecision,
  type AuthorizationTarget,
  type Principal,
} from '@sportspark/contracts';
import { RELATIONSHIP_AUTHORITY_PORT, TEAM_AUTHORITY_PORT } from '../tokens';
import { actionRegistry, type ActionDefinition } from './actions';
import type { RelationshipAuthorityPort, TeamAuthorityPort } from './authorization.port';

export interface AuthorizationTargetInput extends Omit<AuthorizationTarget, 'id'> {
  id?: string | null;
  teamEntryId?: string | null;
}

/**
 * Single authorization path for every command and query (§4.14 object-level authorization).
 * Order of evaluation: system principal → organization scope → facility scope → staff role →
 * self → relationship permission → team role → deny. A denial on a protected record is reported
 * as not-found so record existence is not revealed across households (§4.10).
 */
@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(RELATIONSHIP_AUTHORITY_PORT) private readonly relationships: RelationshipAuthorityPort,
    @Inject(TEAM_AUTHORITY_PORT) private readonly teams: TeamAuthorityPort,
  ) {}

  async decide(
    principal: Principal,
    action: ActionId | ActionDefinition,
    target: AuthorizationTargetInput,
  ): Promise<AuthorizationDecision> {
    const definition = typeof action === 'string' ? actionRegistry.get(action) : action;
    const protectedRecord = target.protected ?? false;
    if (!definition) {
      return { allowed: false, reason: `unknown action ${String(action)}`, protectedRecord };
    }
    if (principal.kind === 'anonymous') {
      return { allowed: false, reason: 'authentication required', protectedRecord };
    }
    if (principal.organizationId !== target.organizationId) {
      return { allowed: false, reason: 'organization scope mismatch', protectedRecord };
    }
    if (principal.kind === 'system') {
      return { allowed: true, basis: 'system' };
    }
    if (principal.kind === 'staff') {
      const facilityOk =
        !target.facilityId ||
        principal.facilityIds.length === 0 ||
        principal.facilityIds.includes(target.facilityId);
      const roleOk = definition.staffRoles.some((r) => principal.staffRoles.includes(r));
      if (roleOk && facilityOk) {
        return { allowed: true, basis: `staff role` };
      }
      if (roleOk && !facilityOk) {
        return { allowed: false, reason: 'facility scope mismatch', protectedRecord };
      }
    }
    const subjects = target.subjectPersonIds ?? [];
    if (principal.personId) {
      if (
        definition.allowSelf &&
        subjects.length > 0 &&
        subjects.every((s) => s === principal.personId)
      ) {
        return { allowed: true, basis: 'self' };
      }
      if (definition.subjectPermission && subjects.length > 0) {
        let all = true;
        for (const subject of subjects) {
          const ok =
            subject === principal.personId ||
            (await this.relationships.hasPermission(
              target.organizationId,
              principal.personId,
              subject,
              definition.subjectPermission,
            ));
          if (!ok) {
            all = false;
            break;
          }
        }
        if (all) return { allowed: true, basis: `relationship:${definition.subjectPermission}` };
      }
      if (definition.teamRole && target.teamEntryId) {
        const ok = await this.teams.hasTeamRole(
          target.organizationId,
          principal.personId,
          target.teamEntryId,
          definition.teamRole,
        );
        if (ok) return { allowed: true, basis: `team_role:${definition.teamRole}` };
      }
    }
    return { allowed: false, reason: 'no applicable authority', protectedRecord };
  }

  /** Throws ACCESS_DENIED (or NOT_FOUND for protected records) unless allowed. */
  async require(
    principal: Principal,
    action: ActionId | ActionDefinition,
    target: AuthorizationTargetInput,
  ): Promise<void> {
    const decision = await this.decide(principal, action, target);
    if (decision.allowed) return;
    if (decision.protectedRecord) throw errors.protectedNotFound(target.type);
    if (principal.kind === 'anonymous') throw errors.authenticationRequired();
    if (
      decision.reason === 'no applicable authority' &&
      (target.subjectPersonIds?.length ?? 0) > 0
    ) {
      throw errors.participantAuthorityRequired();
    }
    throw errors.accessDenied(undefined, {
      action: typeof action === 'string' ? action : action.id,
    });
  }
}
