import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('invitations (SPK-IAM-004)', () => {
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

  async function invitedAdult() {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId });
    return { personId, accountId: account.id, header: await authHeaderForPerson(t, personId) };
  }

  it('records inviter, recipient, scope, permissions and expiry; accepting grants exactly the requested scope', async () => {
    const people = await createOrganizationPeople(t, {
      guardianPermissions: ['view', 'collect', 'pay'],
    });
    const sitter = await invitedAdult();
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const created = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view', 'collect'],
        expiresInHours: 24,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      invitedByPersonId: people.adult.personId,
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'delegate',
      requestedPermissions: ['view', 'collect'],
      status: 'pending',
      expiresAt: new Date(t.clock.now().getTime() + 24 * 3600_000).toISOString(),
    });
    expect(typeof created.body.token).toBe('string');
    const stored = await t.db
      .selectFrom('invitations')
      .select('token_hash')
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(created.body.token);

    const accepted = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.invitation).toMatchObject({
      status: 'accepted',
      acceptedByPersonId: sitter.personId,
      grantedPermissions: ['view', 'collect'],
    });
    expect(accepted.body.droppedPermissions).toEqual([]);
    expect(accepted.body.grants.map((g: { permission: string }) => g.permission).sort()).toEqual([
      'collect',
      'view',
    ]);
    const org = t.organizationId;
    expect(
      await authority.hasPermission(org, sitter.personId, people.child.personId, 'collect'),
    ).toBe(true);
    expect(await authority.hasPermission(org, sitter.personId, people.child.personId, 'pay')).toBe(
      false,
    );
    const replay = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('INVALID_TRANSITION');
  });

  it('acceptance by the wrong person is denied as not-found; a wrong token is not-found', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const intended = await invitedAdult();
    const impostor = await invitedAdult();
    const created = await t.http
      .post('/v1/invitations')
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: intended.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
      });
    const wrongPerson = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(impostor.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(wrongPerson.status).toBe(404);
    const wrongToken = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(intended.header)
      .set('Idempotency-Key', key())
      .send({ token: 'not-the-token-at-all-xxxxxxxx' });
    expect(wrongToken.status).toBe(404);
    expect(
      await authority.hasPermission(
        t.organizationId,
        impostor.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
    expect(
      await authority.hasPermission(
        t.organizationId,
        intended.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
  });

  it('an expired invitation cannot be accepted and is marked expired', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const sitter = await invitedAdult();
    const created = await t.http
      .post('/v1/invitations')
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
        expiresInHours: 1,
      });
    t.clock.advance(3600_000 + 1);
    const res = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'expired' } });
    const row = await t.db
      .selectFrom('invitations')
      .select('status')
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
    expect(
      await authority.hasPermission(
        t.organizationId,
        sitter.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
  });

  it('a revoked invitation cannot be accepted; only staff or the inviter may revoke', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const sitter = await invitedAdult();
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const created = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
      });
    const byRecipient = await t.http
      .post(`/v1/invitations/${created.body.id}/revoke`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ reason: 'nope' });
    expect(byRecipient.status).toBe(404);
    const revoked = await t.http
      .post(`/v1/invitations/${created.body.id}/revoke`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ reason: 'changed my mind' });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked' });
    const res = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ from: 'revoked' });
  });

  it('a customer can only delegate permissions they hold, and acceptance drops what they lost meanwhile', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const sitter = await invitedAdult();
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const tooMuch = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view', 'pay'],
      });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');

    const created = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'delegate',
        requestedPermissions: ['view', 'collect'],
      });
    expect(created.status).toBe(201);
    // the parent loses collect before the sitter accepts
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revoked_by: JSON.stringify({ kind: 'system' }),
        revocation_reason: 'test',
      })
      .where('id', '=', people.guardianGrants.collect as string)
      .execute();
    const accepted = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.droppedPermissions).toEqual(['collect']);
    expect(accepted.body.invitation.grantedPermissions).toEqual(['view']);
    expect(
      await authority.hasPermission(
        t.organizationId,
        sitter.personId,
        people.child.personId,
        'collect',
      ),
    ).toBe(false);
    expect(
      await authority.hasPermission(
        t.organizationId,
        sitter.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(true);
  });

  it('staff invitations by contact point require the acceptor to hold that verified contact', async () => {
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const grandparent = await invitedAdult();
    const created = await t.http
      .post('/v1/invitations')
      .set(await authHeaderForPerson(t, people.staff.personId))
      .set('Idempotency-Key', key())
      .send({
        recipientContact: { kind: 'email', value: 'Grandma@Example.test' },
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind: 'caregiver',
        requestedPermissions: ['view', 'collect'],
      });
    expect(created.status).toBe(201);
    expect(created.body.recipientContact).toEqual({ kind: 'email', value: 'grandma@example.test' });
    const unverified = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(grandparent.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(unverified.status).toBe(403);
    await createContactPointFixture(t, {
      personId: grandparent.personId,
      kind: 'email',
      value: 'grandma@example.test',
      verified: true,
    });
    const accepted = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(grandparent.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.relationships[0]).toMatchObject({
      kind: 'caregiver',
      source: 'invitation',
    });
    expect(
      await authority.hasPermission(
        t.organizationId,
        grandparent.personId,
        people.child.personId,
        'collect',
      ),
    ).toBe(true);
  });

  it("household scope covers the household's child members, each needing the inviter's authority", async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const secondChild = await createPersonFixture(t, { kind: 'child' });
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const household = await t.http
      .post('/v1/households')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ name: 'Home' });
    expect(household.status).toBe(201);
    await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: people.child.personId, label: 'child' })
      .expect(201);
    // the parent holds no authority over secondChild: membership must not change that
    const noAuthority = await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: secondChild });
    expect(noAuthority.status).toBe(404);
    const sitter = await invitedAdult();
    const created = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({
        recipientPersonId: sitter.personId,
        scope: { type: 'household', householdId: household.body.id },
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
      });
    expect(created.status).toBe(201);
    const accepted = await t.http
      .post(`/v1/invitations/${created.body.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: created.body.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.relationships).toHaveLength(1);
    expect(accepted.body.relationships[0].subjectPersonId).toBe(people.child.personId);
  });
});
