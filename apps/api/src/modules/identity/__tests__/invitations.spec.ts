import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyStoreContains } from '../../../testing/idempotency-store';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
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

  it('§4.14 / SPK-IAM-004: the invitation token never rests in the idempotency store; a replay withholds it', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const sitter = await invitedAdult();
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const body = {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'delegate',
      requestedPermissions: ['view'],
      expiresInHours: 24,
    };
    const idempotencyKey = key();
    const created = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(created.status).toBe(201);
    expect(await idempotencyStoreContains(t.db, created.body.token as string)).toBe(false);
    const replay = await t.http
      .post('/v1/invitations')
      .set(parent)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      details: { resourceId: created.body.id },
    });
    const invitations = await t.db
      .selectFrom('invitations')
      .select('id')
      .where('recipient_person_id', '=', sitter.personId)
      .execute();
    expect(invitations).toHaveLength(1);
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

  const invite = (header: Record<string, string>, body: Record<string, unknown>) =>
    t.http.post('/v1/invitations').set(header).set('Idempotency-Key', key()).send(body);
  const accept = (header: Record<string, string>, invitation: { id: string; token: string }) =>
    t.http
      .post(`/v1/invitations/${invitation.id}/accept`)
      .set(header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token });

  it('SPK-IAM-001/SPK-IAM-003: a pickup delegate cannot invite, cannot mint a guardian relationship, and an invitee cannot re-delegate', async () => {
    const people = await createOrganizationPeople(t);
    const org = t.organizationId;
    const delegate = await invitedAdult();
    await createRelationshipFixture(t, {
      actorPersonId: delegate.personId,
      subjectPersonId: people.child.personId,
      kind: 'delegate',
      permissions: ['view', 'collect'],
    });
    const stranger = await invitedAdult();
    for (const relationshipKind of ['guardian', 'delegate']) {
      const res = await invite(delegate.header, {
        recipientPersonId: stranger.personId,
        scope: { type: 'person', personId: people.child.personId },
        relationshipKind,
        requestedPermissions: ['view', 'collect'],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    }
    expect(
      await authority.hasPermission(org, stranger.personId, people.child.personId, 'view'),
    ).toBe(false);
    // a guardian may invite a delegate, and that delegate cannot hand the access on
    const sitter = await invitedAdult();
    const created = await invite(await authHeaderForPerson(t, people.adult.personId), {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'delegate',
      requestedPermissions: ['view', 'collect'],
    });
    expect(created.status).toBe(201);
    expect((await accept(sitter.header, created.body)).status).toBe(200);
    const onward = await invite(sitter.header, {
      recipientPersonId: stranger.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'guardian',
      requestedPermissions: ['view'],
    });
    expect(onward.status).toBe(403);
    expect(
      await authority.hasPermission(org, stranger.personId, people.child.personId, 'collect'),
    ).toBe(false);
  });

  it('SPK-IAM-004: acceptance drops permissions once the inviter is no longer a guardian', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const sitter = await invitedAdult();
    const created = await invite(await authHeaderForPerson(t, people.adult.personId), {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'delegate',
      requestedPermissions: ['view', 'collect'],
    });
    expect(created.status).toBe(201);
    // the inviter's guardianship ends; they keep the same permissions only as a delegate
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revoked_by: JSON.stringify({ kind: 'system' }),
        revocation_reason: 'guardianship ended',
      })
      .where('relationship_id', '=', people.relationshipId)
      .execute();
    await t.db
      .updateTable('relationships')
      .set({ status: 'ended', ended_at: t.clock.now(), ended_reason: 'court order' })
      .where('id', '=', people.relationshipId)
      .execute();
    await createRelationshipFixture(t, {
      actorPersonId: people.adult.personId,
      subjectPersonId: people.child.personId,
      kind: 'delegate',
      permissions: ['view', 'collect'],
    });
    const accepted = await accept(sitter.header, created.body);
    expect(accepted.status).toBe(200);
    expect([...accepted.body.droppedPermissions].sort()).toEqual(['collect', 'view']);
    expect(accepted.body.grants).toEqual([]);
    expect(accepted.body.relationships).toEqual([]);
    expect(
      await authority.hasPermission(
        t.organizationId,
        sitter.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
  });

  it('SPK-IAM-004: a household invitation never covers children added after issue', async () => {
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const org = t.organizationId;
    // the parent holds only a carpool delegate's view over another family's child
    const carpoolChild = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: people.adult.personId,
      subjectPersonId: carpoolChild,
      kind: 'delegate',
      permissions: ['view'],
    });
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const household = await t.http
      .post('/v1/households')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ name: 'Home' });
    await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: people.child.personId })
      .expect(201);
    const spouse = await invitedAdult();
    const created = await invite(await authHeaderForPerson(t, people.staff.personId), {
      recipientPersonId: spouse.personId,
      scope: { type: 'household', householdId: household.body.id },
      relationshipKind: 'guardian',
      requestedPermissions: ['view', 'collect'],
    });
    expect(created.status).toBe(201);
    const snapshot = await t.db
      .selectFrom('invitation_subjects')
      .select('person_id')
      .where('invitation_id', '=', created.body.id)
      .execute();
    expect(snapshot.map((r) => r.person_id)).toEqual([people.child.personId]);
    // the carpool child joins the household after the invitation was issued
    await t.http
      .post(`/v1/households/${household.body.id}/members`)
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ personId: carpoolChild })
      .expect(201);
    const accepted = await accept(spouse.header, created.body);
    expect(accepted.status).toBe(200);
    expect(
      accepted.body.relationships.map((r: { subjectPersonId: string }) => r.subjectPersonId),
    ).toEqual([people.child.personId]);
    expect(await authority.hasPermission(org, spouse.personId, carpoolChild, 'collect')).toBe(
      false,
    );
    expect(await authority.hasPermission(org, spouse.personId, carpoolChild, 'view')).toBe(false);
    expect(
      await authority.hasPermission(org, spouse.personId, people.child.personId, 'collect'),
    ).toBe(true);
  });

  it("SPK-IAM-004: a staff invitation drops its grants when the inviter's staff membership has ended", async () => {
    const people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    const grandparent = await invitedAdult();
    const created = await invite(await authHeaderForPerson(t, people.staff.personId), {
      recipientPersonId: grandparent.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'caregiver',
      requestedPermissions: ['view', 'collect'],
    });
    expect(created.status).toBe(201);
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const ended = await t.http
      .post(`/v1/staff-memberships/${people.staff.membershipId}/end`)
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({ reason: 'left the organization' });
    expect(ended.status).toBe(200);
    const accepted = await accept(grandparent.header, created.body);
    expect(accepted.status).toBe(200);
    expect([...accepted.body.droppedPermissions].sort()).toEqual(['collect', 'view']);
    expect(accepted.body.grants).toEqual([]);
    expect(
      await authority.hasPermission(
        t.organizationId,
        grandparent.personId,
        people.child.personId,
        'collect',
      ),
    ).toBe(false);
  });

  it("§4.10: invitation errors never tell a customer whether another household's person or household exists", async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, people.adult.personId);
    const outcome = async (body: Record<string, unknown>) => {
      const res = await invite(parent, {
        relationshipKind: 'delegate',
        requestedPermissions: ['view'],
        ...body,
      });
      return { status: res.status, code: res.body.code, message: res.body.message };
    };
    // a child, an inactive adult and a missing person read the same as recipients
    const recipients = [];
    for (const recipientPersonId of [
      await createPersonFixture(t, { kind: 'child' }),
      await createPersonFixture(t, { kind: 'adult', status: 'inactive' }),
      newId(),
    ]) {
      recipients.push(
        await outcome({
          recipientPersonId,
          scope: { type: 'person', personId: people.child.personId },
        }),
      );
    }
    expect(recipients).toEqual(
      Array(3).fill({
        status: 404,
        code: 'NOT_FOUND',
        message: 'The requested person was not found.',
      }),
    );
    // another family's person reads the same as a missing one
    const other = await createOrganizationPeople(t);
    const sitter = await invitedAdult();
    const personScopes = [];
    for (const personId of [other.child.personId, newId()]) {
      personScopes.push(
        await outcome({ recipientPersonId: sitter.personId, scope: { type: 'person', personId } }),
      );
    }
    expect(personScopes[0]).toEqual(personScopes[1]);
    // an empty household, a household holding another family's child, and a missing one
    const otherHeader = await authHeaderForPerson(t, other.adult.personId);
    const emptyHousehold = await t.http
      .post('/v1/households')
      .set(otherHeader)
      .set('Idempotency-Key', key())
      .send({ name: 'Empty' });
    const fullHousehold = await t.http
      .post('/v1/households')
      .set(otherHeader)
      .set('Idempotency-Key', key())
      .send({ name: 'Full' });
    await t.http
      .post(`/v1/households/${fullHousehold.body.id}/members`)
      .set(otherHeader)
      .set('Idempotency-Key', key())
      .send({ personId: other.child.personId })
      .expect(201);
    const households = [];
    for (const householdId of [emptyHousehold.body.id, fullHousehold.body.id, newId()]) {
      households.push(
        await outcome({
          recipientPersonId: sitter.personId,
          scope: { type: 'household', householdId },
        }),
      );
    }
    expect(households).toEqual(
      Array(3).fill({
        status: 404,
        code: 'NOT_FOUND',
        message: 'The requested household was not found.',
      }),
    );
    // a member of an empty household still learns that it has no children
    const own = await t.http
      .post('/v1/households')
      .set(parent)
      .set('Idempotency-Key', key())
      .send({ name: 'Mine' });
    const ownEmpty = await outcome({
      recipientPersonId: sitter.personId,
      scope: { type: 'household', householdId: own.body.id },
    });
    expect(ownEmpty).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it("SPK-IAM acceptance example 3: a coach who is also a parent invites as a parent, and acceptance re-checks the parent's grants", async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    await createStaffMemberFixture(t, { personId: people.adult.personId, roles: ['coach'] });
    const sitter = await invitedAdult();
    const created = await invite(await authHeaderForPerson(t, people.adult.personId), {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: people.child.personId },
      relationshipKind: 'delegate',
      requestedPermissions: ['view', 'collect'],
    });
    expect(created.status).toBe(201);
    const row = await t.db
      .selectFrom('invitations')
      .select('invited_by')
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.invited_by).toMatchObject({ kind: 'staff', basis: 'delegated' });
    // the coach-parent loses view before the sitter accepts: the coach role does not make up for it
    await t.db
      .updateTable('access_grants')
      .set({
        revoked_at: t.clock.now(),
        revoked_by: JSON.stringify({ kind: 'system' }),
        revocation_reason: 'test',
      })
      .where('id', '=', people.guardianGrants.view as string)
      .execute();
    const accepted = await accept(sitter.header, created.body);
    expect(accepted.status).toBe(200);
    expect(accepted.body.droppedPermissions).toEqual(['view']);
    expect(accepted.body.invitation.grantedPermissions).toEqual(['collect']);
    expect(
      await authority.hasPermission(
        t.organizationId,
        sitter.personId,
        people.child.personId,
        'view',
      ),
    ).toBe(false);
  });
});
