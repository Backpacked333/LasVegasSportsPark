import { staffFacilityScope } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import { buildPrincipal } from './principal-resolver.service';

describe('buildPrincipal (§4.8, §4.14)', () => {
  const account = {
    id: '0190a1b2-0000-7000-8000-00000000aaaa',
    organizationId: '0190a1b2-0000-7000-8000-00000000ffff',
    personId: '0190a1b2-0000-7000-8000-00000000bbbb',
  };

  it('a person without memberships in effect is a customer with no roles or facilities', () => {
    expect(buildPrincipal(account, [], 'sid')).toEqual({
      kind: 'customer',
      organizationId: account.organizationId,
      accountId: account.id,
      personId: account.personId,
      staffRoles: [],
      facilityIds: [],
      sessionId: 'sid',
      actorLabel: `customer:${account.id.slice(0, 8)}`,
    });
  });

  it('identity-05 (§2.1, §4.14): each role keeps its own facility scope; only an unscoped membership of that role makes it organization-wide', async () => {
    const f1 = '0190a1b2-0000-7000-8000-000000000001';
    const f2 = '0190a1b2-0000-7000-8000-000000000002';
    const scoped = buildPrincipal(
      account,
      [
        { roles: ['front_desk'], facilityIds: [f2] },
        { roles: ['coach', 'front_desk'], facilityIds: [f1] },
      ],
      null,
    );
    expect(scoped).toMatchObject({
      kind: 'staff',
      staffRoles: ['coach', 'front_desk'],
      // the union, kept for display
      facilityIds: [f1, f2],
      staffScopes: [
        { role: 'coach', facilityIds: [f1] },
        { role: 'front_desk', facilityIds: [f1, f2] },
      ],
      sessionId: null,
    });
    expect(staffFacilityScope(scoped, ['coach'])).toEqual([f1]);
    expect(staffFacilityScope(scoped, ['front_desk'])).toEqual([f1, f2]);

    // front_desk at F2 plus an organization-wide general_manager membership: front_desk stays at F2.
    const wide = buildPrincipal(
      account,
      [
        { roles: ['front_desk'], facilityIds: [f2] },
        { roles: ['general_manager'], facilityIds: [] },
      ],
      null,
    );
    expect(wide.facilityIds).toEqual([]);
    expect(wide.staffRoles).toEqual(['front_desk', 'general_manager']);
    expect(wide.staffScopes).toEqual([
      { role: 'front_desk', facilityIds: [f2] },
      { role: 'general_manager', facilityIds: [] },
    ]);
    expect(staffFacilityScope(wide, ['front_desk'])).toEqual([f2]);
    expect(staffFacilityScope(wide, ['general_manager'])).toBeNull();
    expect(staffFacilityScope(wide, ['front_desk', 'general_manager'])).toBeNull();
    expect(staffFacilityScope(wide, ['scheduler'])).toEqual([]);

    // the same role from a scoped and an unscoped membership is organization-wide
    const both = buildPrincipal(
      account,
      [
        { roles: ['scheduler'], facilityIds: [f1] },
        { roles: ['scheduler'], facilityIds: [] },
      ],
      null,
    );
    expect(both.staffScopes).toEqual([{ role: 'scheduler', facilityIds: [] }]);
  });

  it('the actor label never carries names (ids only) and an unlinked account has no person', () => {
    const principal = buildPrincipal({ ...account, personId: null }, [], null);
    expect(principal.personId).toBeNull();
    expect(principal.actorLabel).toMatch(/^customer:[0-9a-f]{8}$/);
    const staff = buildPrincipal(account, [{ roles: ['scheduler'], facilityIds: [] }], null);
    expect(staff.actorLabel).toBe(`staff:scheduler:${account.id.slice(0, 8)}`);
  });
});
