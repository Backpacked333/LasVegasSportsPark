import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

interface GrantViewBody {
  grantId: string;
  permission: string;
  status: string;
  underReview: boolean;
  source: string;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

describe('authority reads (ID-04; SPK-IAM-001, SPK-IAM-003, SPK-IAM-005, SPK-IAM-006)', () => {
  let t: TestApp;
  let authority: RelationshipAuthority;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    authority = t.app.get(RelationshipAuthority);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-IAM-006: a holder sees each grant id, source, dates and state and revokes it by id', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view', 'pay'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const now = t.clock.now();
    const scheduledChild = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: family.adult.personId,
      subjectPersonId: scheduledChild,
      permissions: ['view'],
      effectiveFrom: new Date(now.getTime() + 86_400_000),
    });
    const held = await t.http.get('/v1/me/access-grants').set(parent);
    expect(held.status).toBe(200);
    const byId = new Map<string, GrantViewBody>(
      held.body.items.map((g: GrantViewBody) => [g.grantId, g]),
    );
    expect(byId.get(family.guardianGrants.pay as string)).toMatchObject({
      permission: 'pay',
      source: 'staff',
      status: 'effective',
      underReview: false,
      effectiveFrom: now.toISOString(),
      effectiveTo: null,
      revision: 1,
    });
    expect(
      held.body.items
        .filter((g: GrantViewBody) => g.status === 'scheduled')
        .map((g: GrantViewBody) => g.permission),
    ).toEqual(['view']);
    // effective in the list is exactly what the authority port answers
    for (const grant of held.body.items as Array<GrantViewBody & { subjectPersonId: string }>) {
      expect(grant.status === 'effective').toBe(
        await authority.hasPermission(
          t.organizationId,
          family.adult.personId,
          grant.subjectPersonId,
          grant.permission as 'view',
        ),
      );
    }
    const pay = byId.get(family.guardianGrants.pay as string) as GrantViewBody;
    const revoked = await t.http
      .post(`/v1/access-grants/${pay.grantId}/revoke`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ reason: 'the other parent pays now', expectedRevision: pay.revision });
    expect(revoked.status).toBe(200);
    const after = await t.http.get('/v1/me/access-grants?direction=held').set(parent);
    const revokedView = after.body.items.find((g: GrantViewBody) => g.grantId === pay.grantId);
    expect(revokedView).toMatchObject({ status: 'revoked', revision: 2 });
    expect(revokedView.revokedAt).toBe(t.clock.now().toISOString());
    // the child sees the grants held over them (over_me); the parent holds none over themselves
    const child = await createAccountFixture(t, { personId: family.child.personId });
    const childHeader = {
      Authorization: `Bearer ${await t.identityProvider.mint({ subject: child.subject, sessionId: newId() })}`,
    };
    const overMe = await t.http.get('/v1/me/access-grants?direction=over_me').set(childHeader);
    expect(overMe.body.items.map((g: GrantViewBody) => g.grantId).sort()).toEqual(
      [family.guardianGrants.view, family.guardianGrants.pay].sort(),
    );
    expect(
      (await t.http.get('/v1/me/access-grants?direction=over_me').set(parent)).body.items,
    ).toEqual([]);
    // paging
    const first = await t.http.get('/v1/me/access-grants?limit=1').set(parent);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
  });

  it('SPK-IAM-005: a grant suspended by an access review reads as under review', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const supportHeader = await authHeaderForPerson(t, support.personId);
    const opened = await t.http
      .post('/v1/access-reviews')
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: family.child.personId, reason: 'custody order pending' });
    expect(opened.status).toBe(201);
    const restricted = await t.http
      .post(`/v1/access-reviews/${opened.body.id}/decisions`)
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({ kind: 'restrict', grantIds: [family.guardianGrants.collect] });
    expect(restricted.status).toBe(201);
    const held = await t.http.get('/v1/me/access-grants').set(parent);
    const collect = held.body.items.find(
      (g: GrantViewBody) => g.grantId === family.guardianGrants.collect,
    );
    const view = held.body.items.find(
      (g: GrantViewBody) => g.grantId === family.guardianGrants.view,
    );
    expect(collect).toMatchObject({ status: 'suspended', underReview: true });
    expect(view).toMatchObject({ status: 'effective', underReview: false });
    // staff read the same state on the person's authority
    const desk = await authHeaderForPerson(t, family.staff.personId);
    const staffView = await t.http.get(`/v1/people/${family.child.personId}/authority`).set(desk);
    expect(
      staffView.body.grants.find((g: GrantViewBody) => g.grantId === family.guardianGrants.collect),
    ).toMatchObject({ status: 'suspended', underReview: true });
  });

  it("staff read a person's relationships, grants, households, pending invitations and claim status; customers cannot", async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const desk = await authHeaderForPerson(t, family.staff.personId);
    const household = await t.http
      .post('/v1/households')
      .set(desk)
      .set('Idempotency-Key', key())
      .send({ name: 'Rivera household' });
    expect(household.status).toBe(201);
    for (const personId of [family.adult.personId, family.child.personId]) {
      const added = await t.http
        .post(`/v1/households/${household.body.id}/members`)
        .set(desk)
        .set('Idempotency-Key', key())
        .send({ personId });
      expect(added.status).toBe(201);
    }
    const claim = await t.http
      .post(`/v1/people/${family.child.personId}/claims`)
      .set(desk)
      .set('Idempotency-Key', key())
      .send({
        kind: 'guardian',
        requestedPermissions: ['view'],
        recipientContact: { kind: 'email', value: 'second.parent@example.test' },
      });
    expect(claim.status).toBe(201);
    const sitter = await createPersonFixture(t, { kind: 'adult' });
    const invitation = await t.http
      .post('/v1/invitations')
      .set(desk)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter,
        scope: { type: 'person', personId: family.child.personId },
        relationshipKind: 'caregiver',
        requestedPermissions: ['view'],
        expiresInHours: 48,
      });
    expect(invitation.status).toBe(201);
    const res = await t.http.get(`/v1/people/${family.child.personId}/authority`).set(desk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      personId: family.child.personId,
      accountLinked: false,
      households: [{ id: household.body.id, name: 'Rivera household', memberCount: 2 }],
      relationships: [{ id: family.relationshipId, kind: 'guardian', status: 'active' }],
      grants: [{ grantId: family.guardianGrants.view, status: 'effective' }],
      pendingInvitations: [
        {
          id: invitation.body.id,
          effectiveStatus: 'pending',
          subjects: [{ personId: family.child.personId }],
        },
      ],
      claims: [
        {
          id: claim.body.id,
          kind: 'guardian',
          status: 'pending',
          effectiveStatus: 'pending',
          recipientHint: 's***@example.test',
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(claim.body.token);
    expect(JSON.stringify(res.body)).not.toContain(invitation.body.token);
    expect(JSON.stringify(res.body)).not.toContain('second.parent');
    const adult = await t.http.get(`/v1/people/${family.adult.personId}/authority`).set(desk);
    expect(adult.body.accountLinked).toBe(true);
    // a guardian holding view, a coach and an unknown id all read as not found (§4.10)
    const parent = await authHeaderForPerson(t, family.adult.personId);
    expect(
      (await t.http.get(`/v1/people/${family.child.personId}/authority`).set(parent)).status,
    ).toBe(404);
    const coach = await createStaffMemberFixture(t, { roles: ['coach'] });
    expect(
      (
        await t.http
          .get(`/v1/people/${family.child.personId}/authority`)
          .set(await authHeaderForPerson(t, coach.personId))
      ).status,
    ).toBe(404);
    expect((await t.http.get(`/v1/people/${newId()}/authority`).set(desk)).status).toBe(404);
  });

  it('my households list myself and the members I hold view over, and only count the others', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const created = await t.http
      .post('/v1/households')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ name: 'Home' });
    expect(created.status).toBe(201);
    const added = await t.http
      .post(`/v1/households/${created.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: family.child.personId, label: 'daughter' });
    expect(added.status).toBe(201);
    // another adult in the household whom the parent holds no grant over
    const roommate = await createPersonFixture(t, { kind: 'adult', givenName: 'Roommate' });
    await t.db
      .insertInto('household_memberships')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        household_id: created.body.id,
        person_id: roommate,
        label: null,
        added_by: json({ kind: 'system' }),
      })
      .execute();
    const res = await t.http.get('/v1/me/households').set(parent);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: created.body.id,
      name: 'Home',
      otherMemberCount: 1,
    });
    expect(
      res.body.items[0].members.map(
        (m: { personId: string; isSelf: boolean; label: string | null }) => [
          m.personId,
          m.isSelf,
          m.label,
        ],
      ),
    ).toEqual([
      [family.adult.personId, true, null],
      [family.child.personId, false, 'daughter'],
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Roommate');
  });
});
