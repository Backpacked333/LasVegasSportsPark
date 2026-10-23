import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationService, defineActions, OutboxDispatcher } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForPerson,
  createAccountFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

/** A downstream-style action used to prove the kernel path denies after revocation. */
const ProbeActions = defineActions({
  collectChild: {
    id: 'identity_test.collect_child',
    description: 'probe: collect a child',
    staffRoles: ['front_desk'],
    subjectPermission: 'collect',
  },
  viewChild: {
    id: 'identity_test.view_child',
    description: 'probe: view a child',
    staffRoles: ['front_desk'],
    subjectPermission: 'view',
  },
});

describe('relationships and access grants (SPK-IAM-001, SPK-IAM-003, SPK-IAM-006)', () => {
  let t: TestApp;
  let authority: RelationshipAuthority;
  let authorization: AuthorizationService;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    authority = t.app.get(RelationshipAuthority);
    authorization = t.app.get(AuthorizationService);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-AT-004: two guardians can both hold grants over one child, each with their own permissions', async () => {
    const people = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'register', 'pay'],
    });
    const second = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: second });
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const res = await t.http
      .post('/v1/relationships')
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: second,
        subjectPersonId: people.child.personId,
        kind: 'guardian',
        permissions: ['view', 'register', 'collect'],
      });
    expect(res.status).toBe(201);
    expect(res.body.relationship).toMatchObject({
      kind: 'guardian',
      status: 'active',
      source: 'staff',
    });
    expect(res.body.grants.map((g: { permission: string }) => g.permission).sort()).toEqual([
      'collect',
      'register',
      'view',
    ]);
    const org = t.organizationId;
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'pay'),
    ).toBe(true);
    expect(await authority.hasPermission(org, second, people.child.personId, 'pay')).toBe(false);
    expect(await authority.hasPermission(org, second, people.child.personId, 'collect')).toBe(true);
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'collect'),
    ).toBe(false);
    expect(
      (await authority.actorsWithPermission(org, people.child.personId, 'view')).sort(),
    ).toEqual([people.adult.personId, second].sort());
  });

  it('SPK-IAM-003: view does not imply collect, through the port and through the kernel authorization path', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const principal = {
      kind: 'customer' as const,
      organizationId: t.organizationId,
      accountId: people.adult.accountId,
      personId: people.adult.personId,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'test',
    };
    const target = {
      type: 'release',
      organizationId: t.organizationId,
      subjectPersonIds: [people.child.personId],
    };
    expect((await authorization.decide(principal, ProbeActions.viewChild, target)).allowed).toBe(
      true,
    );
    const collect = await authorization.decide(principal, ProbeActions.collectChild, target);
    expect(collect.allowed).toBe(false);
    await expect(
      authorization.require(principal, ProbeActions.collectChild, target),
    ).rejects.toMatchObject({
      code: 'PARTICIPANT_AUTHORITY_REQUIRED',
    });
  });

  it('a coach who is also a parent: staff authority only via staff membership, guardian authority only via grants', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const coach = await createStaffMemberFixture(t, {
      personId: people.adult.personId,
      roles: ['coach'],
    });
    const header = await authHeaderForPerson(t, people.adult.personId);
    const me = await t.http.get('/v1/me').set(header);
    expect(me.body.principal).toMatchObject({ kind: 'staff', staffRoles: ['coach'] });
    // coach role does not read arbitrary people; the guardian grant does, for their own child only
    const otherChild = await createPersonFixture(t, { kind: 'child' });
    expect((await t.http.get(`/v1/people/${otherChild}`).set(header)).status).toBe(404);
    expect((await t.http.get(`/v1/people/${people.child.personId}`).set(header)).status).toBe(200);
    // staff-only command stays denied for a coach-parent, even over their own child
    const createPerson = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'adult', givenName: 'A', familyName: 'B' });
    expect(createPerson.status).toBe(403);
    // ending the coach membership removes staff authority and leaves guardian authority intact
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const ended = await t.http
      .post(`/v1/staff-memberships/${coach.membershipId}/end`)
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'season over' });
    expect(ended.status).toBe(200);
    const after = await t.http.get('/v1/me').set(header);
    expect(after.body.principal).toMatchObject({ kind: 'customer', staffRoles: [] });
    expect(after.body.authorities).toEqual([
      { subjectPersonId: people.child.personId, permissions: ['view'] },
    ]);
  });

  it('self authority: an adult always, a child never for pay or collect', async () => {
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    for (const permission of [
      'view',
      'register',
      'pay',
      'receive_messages',
      'complete_forms',
      'collect',
    ] as const) {
      expect(await authority.hasPermission(t.organizationId, adult, adult, permission)).toBe(true);
    }
    expect(await authority.hasPermission(t.organizationId, child, child, 'view')).toBe(true);
    expect(await authority.hasPermission(t.organizationId, child, child, 'pay')).toBe(false);
    expect(await authority.hasPermission(t.organizationId, child, child, 'collect')).toBe(false);
    expect(await authority.hasPermission(t.organizationId, newId(), newId(), 'view')).toBe(false);
  });

  it('SPK-IAM-006: revocation denies on the very next check and enqueues identity.access_grant_revoked', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const org = t.organizationId;
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'collect'),
    ).toBe(true);
    const grantId = people.guardianGrants.collect as string;
    const res = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(await authHeaderForPerson(t, people.staff.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'court order received' });
    expect(res.status).toBe(404); // front_desk may not revoke: a protected denial reads as not-found (§4.10)
    const pm = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    const ok = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(await authHeaderForPerson(t, pm.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'court order received', expectedRevision: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      id: grantId,
      effective: false,
      revocationReason: 'court order received',
      revision: 2,
    });
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'collect'),
    ).toBe(false);
    expect(
      await authority.hasPermission(org, people.adult.personId, people.child.personId, 'view'),
    ).toBe(true);
    const event = await t.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('event_type', '=', 'identity.access_grant_revoked')
      .where('aggregate_id', '=', grantId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      grantId,
      actorPersonId: people.adult.personId,
      subjectPersonId: people.child.personId,
      permission: 'collect',
      reason: 'court order received',
    });
    expect(await t.app.get(OutboxDispatcher).runOnce()).toMatchObject({
      dispatched: expect.any(Number),
    });
    const again = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(await authHeaderForPerson(t, pm.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'twice' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_TRANSITION');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', grantId)
      .execute();
    expect(audit).toEqual([{ action: 'identity.revoke_access', reason: 'court order received' }]);
  });

  it('SPK-IAM-006: the grant holder may give up their own access; a stranger sees NOT_FOUND', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const stranger = await createOrganizationPeople(t);
    const grantId = people.guardianGrants.view as string;
    const foreign = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(await authHeaderForPerson(t, stranger.adult.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'not mine' });
    expect(foreign.status).toBe(404);
    const own = await t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'moving away' });
    expect(own.status).toBe(200);
    expect(
      await authority.hasPermission(
        t.organizationId,
        people.adult.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
  });

  it('SPK-IAM-001: self-service — an adult may become guardian only of a child they created', async () => {
    const people = await createOrganizationPeople(t);
    const header = await authHeaderForPerson(t, people.adult.personId);
    const created = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'Mine', familyName: 'Own', dateOfBirth: '2019-03-03' });
    const childId = created.body.id as string;
    const rel = await t.http
      .post('/v1/relationships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: people.adult.personId,
        subjectPersonId: childId,
        kind: 'guardian',
        permissions: ['view', 'register'],
      });
    expect(rel.status).toBe(201);
    expect(rel.body.relationship.source).toBe('self_service');
    expect((await t.http.get(`/v1/people/${childId}`).set(header)).status).toBe(200);
    // not over someone else's child
    const other = await createOrganizationPeople(t);
    const denied = await t.http
      .post('/v1/relationships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: people.adult.personId,
        subjectPersonId: other.child.personId,
        kind: 'guardian',
        permissions: ['view'],
      });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    // further grants on the self-service relationship, idempotently
    const grant = await t.http
      .post('/v1/access-grants')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ relationshipId: rel.body.relationship.id, permission: 'collect' });
    expect(grant.status).toBe(201);
    const same = await t.http
      .post('/v1/access-grants')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ relationshipId: rel.body.relationship.id, permission: 'collect' });
    expect(same.status).toBe(201);
    expect(same.body.id).toBe(grant.body.id);
    const duplicateRelationship = await t.http
      .post('/v1/relationships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: people.adult.personId,
        subjectPersonId: childId,
        kind: 'guardian',
        permissions: [],
      });
    expect(duplicateRelationship.status).toBe(409);
  });

  it('SPK-IAM-003: grants outside their effective window do not confer authority', async () => {
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    const now = t.clock.now();
    await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: child,
      kind: 'delegate',
      permissions: ['collect'],
      effectiveFrom: new Date(now.getTime() + 60_000),
      effectiveTo: new Date(now.getTime() + 120_000),
    });
    expect(await authority.hasPermission(t.organizationId, adult, child, 'collect')).toBe(false);
    t.clock.advance(60_000);
    expect(await authority.hasPermission(t.organizationId, adult, child, 'collect')).toBe(true);
    t.clock.advance(60_000);
    expect(await authority.hasPermission(t.organizationId, adult, child, 'collect')).toBe(false);
  });

  it('cross-organization relationships are refused by the service and the database', async () => {
    const people = await createOrganizationPeople(t);
    const { seedOrganization } = await import('@sportspark/db');
    const other = await seedOrganization(t.db);
    const foreignChild = await createPersonFixture(t, {
      kind: 'child',
      organizationId: other.organizationId,
    });
    const res = await t.http
      .post('/v1/relationships')
      .set(await authHeaderForPerson(t, people.staff.personId))
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: people.adult.personId,
        subjectPersonId: foreignChild,
        kind: 'guardian',
        permissions: ['view'],
      });
    expect(res.status).toBe(404);
  });
});
