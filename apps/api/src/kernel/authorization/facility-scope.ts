import { staffFacilityScope, type Principal } from '@sportspark/contracts';
import type { ActionDefinition } from './actions';

/**
 * Facility narrowing for list queries (§4.3, §4.14 least privilege), matching the facility check
 * `AuthorizationService.decide` applies to one record: only the roles that hold `action` count, so
 * a role scoped to one facility never lists another facility where the person holds only some
 * other role (identity-05). Returns `null` when the list is not narrowed (not a staff principal, or
 * a role holding the action is organization-wide); otherwise the covered facility ids, which are
 * empty when the staff principal holds none of the action's roles (it then sees no facility's rows).
 */
export function listFacilityScope(
  principal: Principal,
  action: ActionDefinition,
): readonly string[] | null {
  if (principal.kind !== 'staff') return null;
  return staffFacilityScope(principal, action.staffRoles);
}
