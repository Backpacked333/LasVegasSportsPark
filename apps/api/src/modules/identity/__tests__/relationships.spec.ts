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
    // not over someone else's child, which reads exactly like a missing record (§4.10)
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
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('NOT_FOUND');
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

  /** An adult customer creates a child record and becomes its self-service guardian. */
  async function selfServiceFamily(permissions: string[]) {
    const parent = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: parent });
    const header = await authHeaderForPerson(t, parent);
    const created = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'Self', familyName: 'Made', dateOfBirth: '2018-02-02' });
    expect(created.status).toBe(201);
    const rel = await t.http
      .post('/v1/relationships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: parent,
        subjectPersonId: created.body.id,
        kind: 'guardian',
        permissions,
      });
    expect(rel.status).toBe(201);
    const grants = Object.fromEntries(
      (rel.body.grants as Array<{ permission: string; id: string }>).map((g) => [
        g.permission,
        g.id,
      ]),
    );
    return {
      parent,
      header,
      childId: created.body.id as string,
      relationshipId: rel.body.relationship.id as string,
      grants,
    };
  }

  const grantRequest = (header: Record<string, string>, body: Record<string, unknown>) =>
    t.http.post('/v1/access-grants').set(header).set('Idempotency-Key', key()).send(body);
  const revokeRequest = (header: Record<string, string>, grantId: string, reason = 'test') =>
    t.http
      .post(`/v1/access-grants/${grantId}/revoke`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ reason });

  it('SPK-IAM-005/SPK-IAM-006: a restricted or staff-revoked creator cannot re-grant themselves access', async () => {
    const family = await selfServiceFamily(['view', 'collect']);
    const org = t.organizationId;
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const sh = await authHeaderForPerson(t, support.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(sh)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: family.childId, reason: 'custody dispute' });
    expect(opened.status).toBe(201);
    const decide = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${opened.body.id}/decisions`)
        .set(sh)
        .set('Idempotency-Key', key())
        .send(body);
    expect((await decide({ kind: 'restrict', actorPersonId: family.parent })).status).toBe(201);
    expect(await authority.hasPermission(org, family.parent, family.childId, 'collect')).toBe(
      false,
    );
    // a new permission is refused while restricted
    const pay = await grantRequest(family.header, {
      relationshipId: family.relationshipId,
      permission: 'pay',
    });
    expect(pay.status).toBe(403);
    expect(pay.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    expect(await authority.hasPermission(org, family.parent, family.childId, 'pay')).toBe(false);
    // revoking the suspended grant and granting it again does not clear the suspension
    expect((await revokeRequest(family.header, family.grants.collect as string)).status).toBe(200);
    const regrant = await grantRequest(family.header, {
      relationshipId: family.relationshipId,
      permission: 'collect',
    });
    expect(regrant.status).toBe(403);
    expect(await authority.hasPermission(org, family.parent, family.childId, 'collect')).toBe(
      false,
    );
    expect((await t.http.get(`/v1/people/${family.childId}`).set(family.header)).status).toBe(404);
    // once the restriction is lifted and the review closed, self-service additions work again
    expect((await decide({ kind: 'lift' })).status).toBe(201);
    expect((await decide({ kind: 'close' })).status).toBe(201);
    const payAfter = await grantRequest(family.header, {
      relationshipId: family.relationshipId,
      permission: 'pay',
    });
    expect(payAfter.status).toBe(201);
    expect(payAfter.body.effective).toBe(true);
    // the holder gave collect up themselves, so they may take it back
    expect(
      (
        await grantRequest(family.header, {
          relationshipId: family.relationshipId,
          permission: 'collect',
        })
      ).status,
    ).toBe(201);
    // a staff revocation holds against the creator
    const pm = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    const ph = await authHeaderForPerson(t, pm.personId);
    expect((await revokeRequest(ph, payAfter.body.id, 'court order')).status).toBe(200);
    const payAgain = await grantRequest(family.header, {
      relationshipId: family.relationshipId,
      permission: 'pay',
    });
    expect(payAgain.status).toBe(403);
    expect(await authority.hasPermission(org, family.parent, family.childId, 'pay')).toBe(false);
    // staff restore access deliberately through the staff path
    const restored = await grantRequest(sh, {
      relationshipId: family.relationshipId,
      permission: 'pay',
    });
    expect(restored.status).toBe(201);
    expect(restored.body.source).toBe('staff');
    expect(await authority.hasPermission(org, family.parent, family.childId, 'pay')).toBe(true);
  });

  it('SPK-IAM-005/SPK-IAM-006: the creator-guardian may revoke only delegates they invited, and only while in good standing', async () => {
    const family = await selfServiceFamily(['view', 'collect']);
    const org = t.organizationId;
    const frontDesk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const fh = await authHeaderForPerson(t, frontDesk.personId);
    const staffRelationship = async (kind: string) => {
      const personId = await createPersonFixture(t, { kind: 'adult' });
      const res = await t.http
        .post('/v1/relationships')
        .set(fh)
        .set('Idempotency-Key', key())
        .send({
          actorPersonId: personId,
          subjectPersonId: family.childId,
          kind,
          permissions: ['view', 'collect'],
        });
      expect(res.status).toBe(201);
      const grants = res.body.grants as Array<{ permission: string; id: string }>;
      return {
        personId,
        collect: grants.find((g) => g.permission === 'collect')?.id as string,
        view: grants.find((g) => g.permission === 'view')?.id as string,
      };
    };
    const secondGuardian = await staffRelationship('guardian');
    const staffDelegate = await staffRelationship('delegate');
    // a delegate the creator invited
    const delegate = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: delegate });
    const invitation = await t.http
      .post('/v1/invitations')
      .set(family.header)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: delegate,
        scope: { type: 'person', personId: family.childId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view', 'collect'],
      });
    expect(invitation.status).toBe(201);
    const accepted = await t.http
      .post(`/v1/invitations/${invitation.body.id}/accept`)
      .set(await authHeaderForPerson(t, delegate))
      .set('Idempotency-Key', key())
      .send({ token: invitation.body.token });
    expect(accepted.status).toBe(200);
    const invited = Object.fromEntries(
      (accepted.body.grants as Array<{ permission: string; id: string }>).map((g) => [
        g.permission,
        g.id,
      ]),
    );

    // in good standing: never another guardian's grant, never a staff-established grant
    expect((await revokeRequest(family.header, secondGuardian.collect)).status).toBe(404);
    expect((await revokeRequest(family.header, staffDelegate.collect)).status).toBe(404);
    expect(
      await authority.hasPermission(org, secondGuardian.personId, family.childId, 'collect'),
    ).toBe(true);
    expect(
      await authority.hasPermission(org, staffDelegate.personId, family.childId, 'collect'),
    ).toBe(true);
    // a delegate from the creator's own invitation may be removed
    const removed = await revokeRequest(family.header, invited.view as string);
    expect(removed.status).toBe(200);
    expect(await authority.hasPermission(org, delegate, family.childId, 'view')).toBe(false);

    // a review-restricted creator removes nobody
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const sh = await authHeaderForPerson(t, support.personId);
    const review = await t.http
      .post('/v1/access-reviews')
      .set(sh)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: family.childId, reason: 'dispute' });
    const decide = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/access-reviews/${review.body.id}/decisions`)
        .set(sh)
        .set('Idempotency-Key', key())
        .send(body);
    expect((await decide({ kind: 'restrict', actorPersonId: family.parent })).status).toBe(201);
    expect((await revokeRequest(family.header, invited.collect as string)).status).toBe(404);
    expect(await authority.hasPermission(org, delegate, family.childId, 'collect')).toBe(true);
    expect((await decide({ kind: 'lift' })).status).toBe(201);

    // a creator whose own access staff revoked removes nobody
    const pm = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    const ph = await authHeaderForPerson(t, pm.personId);
    expect((await revokeRequest(ph, family.grants.view as string, 'court order')).status).toBe(200);
    expect((await revokeRequest(family.header, invited.collect as string)).status).toBe(404);
    expect(await authority.hasPermission(org, delegate, family.childId, 'collect')).toBe(true);

    // a creator who never became guardian removes nobody
    const creator = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: creator });
    const ch = await authHeaderForPerson(t, creator);
    const child = await t.http.post('/v1/people').set(ch).set('Idempotency-Key', key()).send({
      kind: 'child',
      givenName: 'Never',
      familyName: 'Guarded',
      dateOfBirth: '2019-01-01',
    });
    expect(child.status).toBe(201);
    const helper = await createPersonFixture(t, { kind: 'adult' });
    const helperGrants = await createRelationshipFixture(t, {
      actorPersonId: helper,
      subjectPersonId: child.body.id,
      kind: 'delegate',
      permissions: ['collect'],
      source: 'invitation',
    });
    expect((await revokeRequest(ch, helperGrants.grantIds.collect as string)).status).toBe(404);
    expect(await authority.hasPermission(org, helper, child.body.id, 'collect')).toBe(true);
  });

  it('SPK-IAM-003: a grant added later does not outlive a time-bounded relationship', async () => {
    const start = t.clock.now();
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const fh = await authHeaderForPerson(t, people.staff.personId);
    const delegate = await createPersonFixture(t, { kind: 'adult' });
    const relEnd = new Date(start.getTime() + 24 * 3600_000).toISOString();
    const rel = await t.http
      .post('/v1/relationships')
      .set(fh)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: delegate,
        subjectPersonId: people.child.personId,
        kind: 'delegate',
        permissions: ['view'],
        effectiveTo: relEnd,
      });
    expect(rel.status).toBe(201);
    const added = await grantRequest(fh, {
      relationshipId: rel.body.relationship.id,
      permission: 'collect',
    });
    expect(added.status).toBe(201);
    expect(added.body.effectiveTo).toBe(relEnd);
    const org = t.organizationId;
    try {
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'collect')).toBe(
        true,
      );
      t.clock.advance(2 * 24 * 3600_000);
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'view')).toBe(
        false,
      );
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'collect')).toBe(
        false,
      );
      expect(
        await authority.actorsWithPermission(org, people.child.personId, 'collect'),
      ).not.toContain(delegate);
      expect(await authority.authoritiesOf(org, delegate)).toEqual([]);
      // the relationship has ended by date: nothing more can be granted on it
      const late = await grantRequest(fh, {
        relationshipId: rel.body.relationship.id,
        permission: 'pay',
      });
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
    } finally {
      t.clock.set(start);
    }
  });

  it('SPK-IAM-003: a grant on a future-dated relationship is not effective before the relationship starts', async () => {
    const start = t.clock.now();
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const fh = await authHeaderForPerson(t, people.staff.personId);
    const delegate = await createPersonFixture(t, { kind: 'adult' });
    const relFrom = new Date(start.getTime() + 7 * 24 * 3600_000).toISOString();
    const relTo = new Date(start.getTime() + 8 * 24 * 3600_000).toISOString();
    const rel = await t.http
      .post('/v1/relationships')
      .set(fh)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: delegate,
        subjectPersonId: people.child.personId,
        kind: 'delegate',
        permissions: ['view'],
        effectiveFrom: relFrom,
        effectiveTo: relTo,
      });
    expect(rel.status).toBe(201);
    const added = await grantRequest(fh, {
      relationshipId: rel.body.relationship.id,
      permission: 'collect',
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      effectiveFrom: relFrom,
      effectiveTo: relTo,
      effective: false,
    });
    const org = t.organizationId;
    try {
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'collect')).toBe(
        false,
      );
      t.clock.set(new Date(new Date(relFrom).getTime() + 3600_000));
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'collect')).toBe(
        true,
      );
      t.clock.set(new Date(new Date(relTo).getTime() + 1));
      expect(await authority.hasPermission(org, delegate, people.child.personId, 'collect')).toBe(
        false,
      );
    } finally {
      t.clock.set(start);
    }
  });

  it("SPK-IAM-003: a grant whose explicit dates exceed its relationship's window is rejected", async () => {
    const now = t.clock.now();
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const fh = await authHeaderForPerson(t, people.staff.personId);
    const delegate = await createPersonFixture(t, { kind: 'adult' });
    const rel = await t.http
      .post('/v1/relationships')
      .set(fh)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: delegate,
        subjectPersonId: people.child.personId,
        kind: 'delegate',
        permissions: [],
        effectiveFrom: new Date(now.getTime() + 3600_000).toISOString(),
        effectiveTo: new Date(now.getTime() + 2 * 3600_000).toISOString(),
      });
    expect(rel.status).toBe(201);
    for (const window of [
      { effectiveTo: new Date(now.getTime() + 3 * 3600_000).toISOString() },
      { effectiveFrom: now.toISOString() },
    ]) {
      const res = await grantRequest(fh, {
        relationshipId: rel.body.relationship.id,
        permission: 'collect',
        ...window,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it("SPK-IAM-003: authority ignores a grant row that lies outside its relationship's dates", async () => {
    const start = t.clock.now();
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    const fixture = await createRelationshipFixture(t, {
      actorPersonId: adult,
      subjectPersonId: child,
      kind: 'delegate',
      permissions: ['collect'],
      effectiveTo: new Date(start.getTime() + 3600_000),
    });
    // a grant row written outside the relationship window (fixtures, imports and merges can)
    await t.db
      .updateTable('access_grants')
      .set({ effective_to: null })
      .where('id', '=', fixture.grantIds.collect as string)
      .execute();
    try {
      expect(await authority.hasPermission(t.organizationId, adult, child, 'collect')).toBe(true);
      t.clock.advance(2 * 3600_000);
      expect(await authority.hasPermission(t.organizationId, adult, child, 'collect')).toBe(false);
    } finally {
      t.clock.set(start);
    }
  });

  it("§4.10: POST /relationships tells a stranger nothing about another household's person", async () => {
    const stranger = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: stranger });
    const header = await authHeaderForPerson(t, stranger);
    const active = await createPersonFixture(t, { kind: 'child' });
    const inactive = await createPersonFixture(t, { kind: 'child', status: 'inactive' });
    const merged = await createPersonFixture(t, { kind: 'child' });
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: active })
      .where('id', '=', merged)
      .execute();
    const outcome = async (body: Record<string, unknown>) => {
      const res = await t.http
        .post('/v1/relationships')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ kind: 'guardian', permissions: ['view'], ...body });
      return { status: res.status, code: res.body.code, message: res.body.message };
    };
    const subjects = [];
    for (const subjectPersonId of [active, inactive, merged, newId()]) {
      subjects.push(await outcome({ actorPersonId: stranger, subjectPersonId }));
    }
    expect(subjects).toEqual(
      Array(4).fill({
        status: 404,
        code: 'NOT_FOUND',
        message: 'The requested person was not found.',
      }),
    );
    // naming another actor is refused on the input alone, whatever that person's state
    const own = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'Own', familyName: 'Record', dateOfBirth: '2017-07-07' });
    const inactiveAdult = await createPersonFixture(t, { kind: 'adult', status: 'inactive' });
    const actors = [];
    for (const actorPersonId of [
      await createPersonFixture(t, { kind: 'adult' }),
      inactiveAdult,
      newId(),
    ]) {
      actors.push(await outcome({ actorPersonId, subjectPersonId: own.body.id }));
    }
    expect(new Set(actors.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(actors[0]).toMatchObject({ status: 403, code: 'PARTICIPANT_AUTHORITY_REQUIRED' });
    // claims and access reviews: a denial reads exactly like a missing person
    const claim = async (personId: string) => {
      const res = await t.http
        .post(`/v1/people/${personId}/claims`)
        .set(header)
        .set('Idempotency-Key', key())
        .send({
          kind: 'guardian',
          requestedPermissions: ['view'],
          recipientContact: { kind: 'email', value: 'probe@example.test' },
        });
      return { status: res.status, message: res.body.message };
    };
    expect(await claim(active)).toEqual(await claim(newId()));
    const review = async (subjectPersonId: string) => {
      const res = await t.http
        .post('/v1/access-reviews')
        .set(header)
        .set('Idempotency-Key', key())
        .send({ subjectPersonId, reason: 'probe' });
      return { status: res.status, message: res.body.message };
    };
    expect(await review(active)).toEqual(await review(newId()));
    expect(await review(active)).toEqual({
      status: 404,
      message: 'The requested person was not found.',
    });
  });

  it('SPK-IAM acceptance example 3: a coach who is also a parent receives each permission only in its proper scope', async () => {
    const people = await createOrganizationPeople(t);
    await createStaffMemberFixture(t, { personId: people.adult.personId, roles: ['coach'] });
    const parent = people.adult.personId;
    const header = await authHeaderForPerson(t, parent);
    expect((await t.http.get('/v1/me').set(header)).body.principal.kind).toBe('staff');
    // parent-side flows work as they do for any parent
    const child = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'child', givenName: 'Coach', familyName: 'Kid', dateOfBirth: '2017-04-04' });
    expect(child.status).toBe(201);
    const row = await t.db
      .selectFrom('persons')
      .select(['source', 'created_by_person_id'])
      .where('id', '=', child.body.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ source: 'self_service', created_by_person_id: parent });
    const rel = await t.http
      .post('/v1/relationships')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        actorPersonId: parent,
        subjectPersonId: child.body.id,
        kind: 'guardian',
        permissions: ['view'],
      });
    expect(rel.status).toBe(201);
    expect(rel.body.relationship.source).toBe('self_service');
    const grant = await grantRequest(header, {
      relationshipId: rel.body.relationship.id,
      permission: 'collect',
    });
    expect(grant.status).toBe(201);
    expect(grant.body.source).toBe('self_service');
    const household = await t.http
      .post('/v1/households')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ name: 'Coach home' });
    expect(household.status).toBe(201);
    expect(household.body.members).toEqual([{ personId: parent, label: null }]);
    const coGuardian = await createPersonFixture(t, { kind: 'adult' });
    const invite = await t.http
      .post('/v1/invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: coGuardian,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'guardian',
        requestedPermissions: ['view'],
      });
    expect(invite.status).toBe(201);
    // as creator-guardian, they may remove a delegate they invited over the child they created
    const sitter = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: sitter });
    const sitterInvite = await t.http
      .post('/v1/invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter,
        scope: { type: 'person', personId: child.body.id },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
      });
    expect(sitterInvite.status).toBe(201);
    const sitterAccepted = await t.http
      .post(`/v1/invitations/${sitterInvite.body.id}/accept`)
      .set(await authHeaderForPerson(t, sitter))
      .set('Idempotency-Key', key())
      .send({ token: sitterInvite.body.token });
    expect(sitterAccepted.status).toBe(200);
    expect((await revokeRequest(header, sitterAccepted.body.grants[0].id)).status).toBe(200);
    // the coach role adds no staff authority, and staff kind alone adds nothing either
    const adult = await t.http
      .post('/v1/people')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'adult', givenName: 'Not', familyName: 'Allowed' });
    expect(adult.status).toBe(403);
    const strangerFamily = await createOrganizationPeople(t);
    const strangerHousehold = await t.http
      .post('/v1/households')
      .set(await authHeaderForPerson(t, strangerFamily.adult.personId))
      .set('Idempotency-Key', key())
      .send({ name: 'Elsewhere' });
    expect(strangerHousehold.status).toBe(201);
    const intoStranger = await t.http
      .post(`/v1/households/${strangerHousehold.body.id}/members`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ personId: child.body.id });
    expect(intoStranger.status).toBe(404);
    const verified = await t.http
      .post(`/v1/people/${parent}/contact-points`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ kind: 'email', value: 'coach-parent@example.test', verified: true });
    expect(verified.status).toBe(403);
    const status = await t.http
      .patch(`/v1/people/${people.child.personId}`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ status: 'inactive', expectedRevision: 1 });
    expect(status.status).toBe(403);
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
