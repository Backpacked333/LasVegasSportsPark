import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  scopeCoversFacility,
  staffFacilityScope,
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
 * Order of evaluation: organization scope → system principal → staff role within its facility
 * scope (the scope of the roles that hold the action, `staffFacilityScope`) → self →
 * relationship permission → team role → deny. A staff role held outside its facility scope
 * grants nothing, but it does not take away the person's own self, relationship or
 * team authority (SPK-IAM-001/003: a coach who is also a parent receives each permission only in
 * its proper scope); when none of those allows, the denial says 'facility scope mismatch'.
 * A denial on a protected record is reported as not-found so record existence is not revealed
 * across households (§4.10).
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
    let denial = 'no applicable authority';
    if (principal.kind === 'staff') {
      // §2.1, §4.3, §4.14: the facility check uses the scope of the roles that hold this action,
      // never the union of every role's facilities (identity-05).
      const held = definition.staffRoles.filter((r) => principal.staffRoles.includes(r));
      const roleOk = held.length > 0;
      const facilityOk =
        !target.facilityId ||
        scopeCoversFacility(staffFacilityScope(principal, held), target.facilityId);
      if (roleOk && facilityOk) {
        return { allowed: true, basis: `staff role` };
      }
      // Fall through: the person's own authority below is still evaluated (SPK-IAM-001/003).
      if (roleOk) denial = 'facility scope mismatch';
    }
    const subjects = target.subjectPersonIds ?? [];
    if (principal.personId) {
      const personId = principal.personId;
      const allSelf = subjects.length > 0 && subjects.every((s) => s === personId);
      if (definition.allowSelf && allSelf) {
        // Self authority is decided by the relationship port when the action names a permission:
        // an adult holds it, a child does not hold pay/collect over themselves (SPK-IAM-003).
        if (!definition.subjectPermission) return { allowed: true, basis: 'self' };
        const selfOk = await this.relationships.hasPermission(
          target.organizationId,
          personId,
          personId,
          definition.subjectPermission,
        );
        if (selfOk) return { allowed: true, basis: 'self' };
      }
      if (definition.subjectPermission && subjects.length > 0) {
        let all = true;
        for (const subject of subjects) {
          const ok = await this.relationships.hasPermission(
            target.organizationId,
            personId,
            subject,
            definition.subjectPermission,
          );
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
    return { allowed: false, reason: denial, protectedRecord };
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
