import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { PrincipalResolver } from '../services/principal-resolver.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
  tokenForAccount,
} from '../testing/identity-fixtures';

describe('PRINCIPAL_RESOLVER_IMPL (SPK-IAM-001, §4.8, §4.14)', () => {
  let t: TestApp;
  let resolver: PrincipalResolver;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    resolver = t.app.get(PrincipalResolver);
  });
  afterAll(async () => {
    await t.close();
  });

  const identity = (subject: string, issuer = t.config.AUTH_ISSUER) => ({
    issuer,
    subject,
    sessionId: 'sess-1',
    issuedAt: t.clock.now(),
    expiresAt: new Date(t.clock.now().getTime() + 60_000),
    claims: {},
  });

  it('maps account → person → staff memberships into a staff principal without child data', async () => {
    const people = await createOrganizationPeople(t, {
      staffRoles: ['front_desk', 'coach'],
      staffFacilityIds: [t.facilityId],
    });
    const principal = await resolver.resolve(identity(people.staff.accountId));
    expect(principal).toMatchObject({
      kind: 'staff',
      organizationId: t.organizationId,
      accountId: people.staff.accountId,
      personId: people.staff.personId,
      staffRoles: ['coach', 'front_desk'],
      facilityIds: [t.facilityId],
      sessionId: 'sess-1',
    });
    expect(principal?.actorLabel).not.toMatch(/Adult|Child|Family/);
  });

  it('resolves a customer with no staff membership, and null for unknown, disabled or foreign-issuer subjects', async () => {
    const people = await createOrganizationPeople(t);
    const customer = await resolver.resolve(identity(people.adult.accountId));
    expect(customer).toMatchObject({
      kind: 'customer',
      personId: people.adult.personId,
      staffRoles: [],
    });

    expect(await resolver.resolve(identity(newId()))).toBeNull();
    const disabled = await createAccountFixture(t, { personId: null, status: 'disabled' });
    expect(await resolver.resolve(identity(disabled.subject))).toBeNull();
    expect(
      await resolver.resolve(identity(people.adult.accountId, 'https://other-idp')),
    ).toBeNull();
  });

  it('staff authority is time-bounded: memberships outside their effective window do not count', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const now = t.clock.now();
    const future = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['scheduler'],
      effectiveFrom: new Date(now.getTime() + 3600_000),
    });
    expect(await resolver.resolve(identity(future.accountId))).toMatchObject({
      kind: 'customer',
      staffRoles: [],
    });
    t.clock.advance(3600_000 + 1);
    expect(await resolver.resolve(identity(future.accountId))).toMatchObject({
      kind: 'staff',
      staffRoles: ['scheduler'],
    });
    await t.db
      .updateTable('staff_memberships')
      .set({ effective_to: t.clock.now() })
      .where('id', '=', future.membershipId)
      .execute();
    expect(await resolver.resolve(identity(future.accountId))).toMatchObject({ kind: 'customer' });
  });

  it('an account linked to an inactive person cannot act', async () => {
    const person = await createPersonFixture(t, { kind: 'adult', status: 'inactive' });
    const account = await createAccountFixture(t, { personId: person });
    expect(await resolver.resolve(identity(account.subject))).toBeNull();
  });

  it('identity-05 (§2.1, §4.14): a membership without facility scope widens only its own roles, never a scoped role', async () => {
    const person = await createPersonFixture(t, { kind: 'adult' });
    const scoped = await createStaffMemberFixture(t, {
      personId: person,
      roles: ['front_desk'],
      facilityIds: [t.facilityId],
    });
    expect((await resolver.resolve(identity(scoped.accountId)))?.facilityIds).toEqual([
      t.facilityId,
    ]);
    await createStaffMemberFixture(t, { personId: person, roles: ['general_manager'] });
    const principal = await resolver.resolve(identity(scoped.accountId));
    // the union (display) is the whole organization, but front_desk keeps its facility
    expect(principal?.facilityIds).toEqual([]);
    expect(principal?.staffScopes).toEqual([
      { role: 'front_desk', facilityIds: [t.facilityId] },
      { role: 'general_manager', facilityIds: [] },
    ]);
  });

  it('GET /v1/me reports the principal, person, memberships and current authorities', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'register'] });
    const me = await t.http.get('/v1/me').set(await authHeaderForPerson(t, people.adult.personId));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      principal: { kind: 'customer', personId: people.adult.personId, staffRoles: [] },
      person: { id: people.adult.personId, kind: 'adult' },
      staffMemberships: [],
      authorities: [{ subjectPersonId: people.child.personId, permissions: ['register', 'view'] }],
    });
    const staffMe = await t.http
      .get('/v1/me')
      .set(await authHeaderForPerson(t, people.staff.personId));
    expect(staffMe.body.principal.kind).toBe('staff');
    expect(staffMe.body.staffMemberships).toHaveLength(1);
  });

  it('an unlinked account authenticates but has no person and no authorities', async () => {
    const account = await createAccountFixture(t, { personId: null });
    const me = await t.http.get('/v1/me').set(await authHeaderForAccount(t, account.id));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      principal: { kind: 'customer', personId: null },
      person: null,
    });
  });

  it("cross-organization: a token from another organization never sees this organization's people", async () => {
    const other = await seedOrganization(t.db);
    const foreignStaff = await createStaffMemberFixture(t, {
      roles: ['system_administrator'],
      organizationId: other.organizationId,
    });
    const people = await createOrganizationPeople(t);
    const token = await tokenForAccount(t, foreignStaff.accountId);
    const res = await t.http
      .get(`/v1/people/${people.child.personId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('touches last_login_at at most once per hour', async () => {
    const account = await createAccountFixture(t, { personId: null });
    await resolver.resolve(identity(account.subject));
    const first = await t.db
      .selectFrom('accounts')
      .select('last_login_at')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(first.last_login_at).not.toBeNull();
    t.clock.advance(60_000);
    await resolver.resolve(identity(account.subject));
    const second = await t.db
      .selectFrom('accounts')
      .select('last_login_at')
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(new Date(second.last_login_at as Date).getTime()).toBe(
      new Date(first.last_login_at as Date).getTime(),
    );
  });
});
