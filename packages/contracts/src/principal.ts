import { z } from './zod';

/**
 * Staff roles (specification §2.1). A person may hold several; access depends on the specific
 * action and scope, never the label alone. Customer-side roles (guardian, captain, payer, pickup
 * delegate) are relationships and grants owned by the identity module, not principal roles.
 */
export const StaffRole = z.enum([
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'coach',
  'official',
]);
export type StaffRole = z.infer<typeof StaffRole>;

/**
 * One staff role and the facilities it may be exercised in (§2.1 staff assignment scope, §4.3,
 * §4.14 least privilege). Empty `facilityIds` means every facility in the organization.
 */
export const StaffScopeSchema = z.object({
  role: StaffRole,
  facilityIds: z.array(z.uuid()),
});
export type StaffScope = z.infer<typeof StaffScopeSchema>;

export const PrincipalKind = z.enum(['anonymous', 'customer', 'staff', 'system']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const PrincipalSchema = z.object({
  kind: PrincipalKind,
  /** Organization context is derived from authenticated authorization, never from request input (§4.8). */
  organizationId: z.uuid().nullable(),
  accountId: z.uuid().nullable(),
  personId: z.uuid().nullable(),
  staffRoles: z.array(StaffRole),
  /**
   * Facility ids this staff principal may operate in through any role; empty means every facility
   * in the organization. When `staffScopes` is present this is their union, kept for display: a
   * facility check must use `staffFacilityScope` with the action's roles, so a role scoped to one
   * facility never acts at another one where only a different role is held (identity-05).
   */
  facilityIds: z.array(z.uuid()),
  /**
   * Per-role facility scope from the staff memberships in effect (§2.1, §4.14). Absent for
   * principals built without memberships (anonymous, customer, system, test helpers): every held
   * role then shares `facilityIds`.
   */
  staffScopes: z.array(StaffScopeSchema).optional(),
  /** Session identifier used for audit correlation and revocation. */
  sessionId: z.string().nullable(),
  /** Human-readable actor label stored in audit snapshots (never contains child information). */
  actorLabel: z.string(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const ANONYMOUS_PRINCIPAL: Principal = {
  kind: 'anonymous',
  organizationId: null,
  accountId: null,
  personId: null,
  staffRoles: [],
  facilityIds: [],
  sessionId: null,
  actorLabel: 'anonymous',
};

export function systemPrincipal(organizationId: string, label = 'system'): Principal {
  return {
    kind: 'system',
    organizationId,
    accountId: null,
    personId: null,
    staffRoles: [],
    facilityIds: [],
    sessionId: null,
    actorLabel: label,
  };
}

export function hasStaffRole(principal: Principal, ...roles: StaffRole[]): boolean {
  return principal.kind === 'staff' && roles.some((r) => principal.staffRoles.includes(r));
}

/**
 * The facilities in which `principal` may act through any of `roles` (an action's `staffRoles`):
 * `null` means every facility of the organization, `[]` means none (no such role is held). A role
 * is organization-wide only when one of its memberships is unscoped; otherwise its scope is the
 * union of the facilities of the memberships that hold it (§2.1, §4.3, §4.14 least privilege).
 * List queries that narrow by facility use this rather than `principal.facilityIds`.
 */
export function staffFacilityScope(
  principal: Principal,
  roles: readonly StaffRole[],
): readonly string[] | null {
  if (principal.kind !== 'staff') return [];
  const held = roles.filter((r) => principal.staffRoles.includes(r));
  if (held.length === 0) return [];
  if (!principal.staffScopes) {
    return principal.facilityIds.length === 0 ? null : principal.facilityIds;
  }
  const facilities = new Set<string>();
  for (const role of held) {
    // A held role without a scope entry contributes nothing (fail closed).
    for (const scope of principal.staffScopes.filter((s) => s.role === role)) {
      if (scope.facilityIds.length === 0) return null;
      for (const facility of scope.facilityIds) facilities.add(facility);
    }
  }
  return [...facilities].sort();
}

/** Whether a scope from `staffFacilityScope` covers `facilityId`. */
export function scopeCoversFacility(scope: readonly string[] | null, facilityId: string): boolean {
  return scope === null || scope.includes(facilityId);
}

/**
 * Action identifiers are `<module>.<verb>` strings. Modules declare theirs as constants so the
 * permission matrix (docs/package-a/permission-matrix.md) can be generated from code.
 */
export type ActionId = `${string}.${string}`;

export interface AuthorizationTarget {
  type: string;
  id: string | null;
  organizationId: string;
  facilityId?: string | null;
  /** Persons whose private data this target concerns (participants, payers). */
  subjectPersonIds?: readonly string[];
  /** Whether the record is protected (customer-private) — denied access must look like not-found. */
  protected?: boolean;
}

export type AuthorizationDecision =
  { allowed: true; basis: string } | { allowed: false; reason: string; protectedRecord: boolean };
