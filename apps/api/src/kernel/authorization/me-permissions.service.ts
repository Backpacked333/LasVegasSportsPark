import { Inject, Injectable } from '@nestjs/common';
import {
  CAPABILITIES,
  errors,
  staffFacilityScope,
  type MePermissions,
  type NavigationAreaId,
  type Principal,
} from '@sportspark/contracts';
import { CapabilityService } from '../capabilities/capability.service';
import type { Clock } from '../clock';
import { CLOCK } from '../tokens';
import { actionRegistry } from './actions';
import { areaOfAction, NAVIGATION_AREAS } from './navigation-areas';

/**
 * GET /v1/me/permissions (K-05, SPK-UX-005 visibility by permission, §4.14 least privilege).
 * Computed from the action registry and the principal alone: which actions the held staff roles
 * allow outright and in which facilities (a role scoped to one facility reports that facility,
 * identity-05), which actions are allowed per record through self, relationship or team
 * authority, and which of the fourteen areas show. The only database read is the organization's
 * capability switches (K-12): an area whose held actions all belong to disabled capabilities is
 * hidden. Clients still meet ACCESS_DENIED on a record: this is a view of roles, not of records.
 */
@Injectable()
export class MePermissionsService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly capabilities: CapabilityService,
  ) {}

  async describe(principal: Principal): Promise<MePermissions> {
    if (principal.kind === 'anonymous' || !principal.organizationId) {
      throw errors.authenticationRequired();
    }
    const switches = await this.capabilities.list(principal.organizationId);
    const enabled = new Set(switches.filter((c) => c.enabled).map((c) => c.capability));
    const actions: MePermissions['actions'] = [];
    const conditionalActions: MePermissions['conditionalActions'] = [];
    const usable = new Map<string, boolean>();
    for (const action of actionRegistry.list()) {
      const held =
        principal.kind === 'staff'
          ? action.staffRoles.filter((role) => principal.staffRoles.includes(role))
          : [];
      if (held.length > 0) {
        const scope = staffFacilityScope(principal, held);
        if (scope === null || scope.length > 0) {
          actions.push({ id: action.id, facilityIds: scope === null ? null : [...scope] });
          usable.set(action.id, !action.capability || enabled.has(action.capability));
          continue;
        }
      }
      if (
        principal.personId &&
        principal.kind !== 'system' &&
        (action.allowSelf || action.subjectPermission || action.teamRole)
      ) {
        conditionalActions.push({
          id: action.id,
          self: action.allowSelf === true,
          subjectPermission: action.subjectPermission ?? null,
          teamRole: action.teamRole ?? null,
        });
      }
    }
    const byArea = new Map<NavigationAreaId, string[]>(NAVIGATION_AREAS.map((a) => [a, []]));
    for (const action of actions) {
      const area = areaOfAction(action.id);
      if (area) byArea.get(area)?.push(action.id);
    }
    return {
      evaluatedAt: this.clock.now().toISOString(),
      principalKind: principal.kind,
      staffRoles: [...principal.staffRoles],
      actions,
      conditionalActions,
      areas: NAVIGATION_AREAS.map((id) => {
        const actionIds = byArea.get(id) ?? [];
        return { id, visible: actionIds.some((a) => usable.get(a) === true), actionIds };
      }),
      capabilities: switches.map((c) => ({
        id: c.capability,
        enabled: c.enabled,
        enforcement: CAPABILITIES[c.capability].enforcement,
      })),
    };
  }
}
