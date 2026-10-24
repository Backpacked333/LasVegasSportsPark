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

export const PrincipalKind = z.enum(['anonymous', 'customer', 'staff', 'system']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const PrincipalSchema = z.object({
  kind: PrincipalKind,
  /** Organization context is derived from authenticated authorization, never from request input (§4.8). */
  organizationId: z.uuid().nullable(),
  accountId: z.uuid().nullable(),
  personId: z.uuid().nullable(),
  staffRoles: z.array(StaffRole),
  /** Facility ids this staff principal may operate in; empty means every facility in the organization. */
  facilityIds: z.array(z.uuid()),
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
