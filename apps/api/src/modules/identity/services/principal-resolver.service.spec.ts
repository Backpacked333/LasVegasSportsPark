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

  it('unions roles and facility scopes; an unscoped membership means the whole organization', () => {
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
      facilityIds: [f1, f2],
      sessionId: null,
    });
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
  });

  it('the actor label never carries names (ids only) and an unlinked account has no person', () => {
    const principal = buildPrincipal({ ...account, personId: null }, [], null);
    expect(principal.personId).toBeNull();
    expect(principal.actorLabel).toMatch(/^customer:[0-9a-f]{8}$/);
    const staff = buildPrincipal(account, [{ roles: ['scheduler'], facilityIds: [] }], null);
    expect(staff.actorLabel).toBe(`staff:scheduler:${account.id.slice(0, 8)}`);
  });
});
