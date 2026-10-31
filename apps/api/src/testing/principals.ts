import { newId, type Principal, type StaffRole } from '@sportspark/contracts';

export function staffPrincipal(
  organizationId: string,
  staffRoles: StaffRole[],
  overrides: Partial<Principal> = {},
): Principal {
  return {
    kind: 'staff',
    organizationId,
    accountId: newId(),
    personId: newId(),
    staffRoles,
    facilityIds: [],
    sessionId: newId(),
    actorLabel: `staff:${staffRoles.join('+') || 'none'}`,
    ...overrides,
  };
}

export function customerPrincipal(
  organizationId: string,
  overrides: Partial<Principal> = {},
): Principal {
  const personId = overrides.personId ?? newId();
  return {
    kind: 'customer',
    organizationId,
    accountId: newId(),
    personId,
    staffRoles: [],
    facilityIds: [],
    sessionId: newId(),
    actorLabel: `customer:${personId.slice(0, 8)}`,
    ...overrides,
  };
}
