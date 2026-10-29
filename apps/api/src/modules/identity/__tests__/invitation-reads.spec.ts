import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import {
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('invitation reads and decline (ID-03; SPK-IAM-004, §4.6, §4.10)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  async function adultWithAccount(givenName?: string) {
    const personId = await createPersonFixture(t, { kind: 'adult', givenName });
    await createAccountFixture(t, { personId });
    return { personId, header: await authHeaderForPerson(t, personId) };
  }

  async function invite(
    header: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ id: string; token: string }> {
    const res = await t.http
      .post('/v1/invitations')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ relationshipKind: 'delegate', expiresInHours: 24, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, token: res.body.token as string };
  }

  it('SPK-IAM-004: a recipient reads sender, scope, permissions and expiry before accepting', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    await t.db
      .updateTable('persons')
      .set({ given_name: 'Maria', family_name: 'Lopez' })
      .where('id', '=', family.adult.personId)
      .execute();
    await t.db
      .updateTable('persons')
      .set({ given_name: 'Leo', family_name: 'Lopez' })
      .where('id', '=', family.child.personId)
      .execute();
    const sitter = await adultWithAccount();
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view', 'collect'],
    });
    const read = await t.http.get(`/v1/me/invitations/${invitation.id}`).set(sitter.header);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: invitation.id,
      inviter: { personId: family.adult.personId, displayName: 'Maria Lopez' },
      subjects: [{ personId: family.child.personId, displayName: 'Leo Lopez' }],
      requestedPermissions: ['view', 'collect'],
      relationshipKind: 'delegate',
      status: 'pending',
      effectiveStatus: 'pending',
      expiresAt: new Date(t.clock.now().getTime() + 24 * 3600_000).toISOString(),
      declinedAt: null,
    });
    // the token is never returned again
    expect(read.body).not.toHaveProperty('token');
    // the inviter reads it too; anyone else gets a protected NOT_FOUND
    expect((await t.http.get(`/v1/me/invitations/${invitation.id}`).set(parent)).status).toBe(200);
    const stranger = await adultWithAccount();
    const hidden = await t.http.get(`/v1/me/invitations/${invitation.id}`).set(stranger.header);
    expect(hidden.status).toBe(404);
    expect((await t.http.get(`/v1/me/invitations/${newId()}`).set(stranger.header)).status).toBe(
      404,
    );
    // received and sent lists
    const received = await t.http.get('/v1/me/invitations').set(sitter.header);
    expect(received.body.items.map((i: { id: string }) => i.id)).toEqual([invitation.id]);
    const sent = await t.http.get('/v1/me/invitations?direction=sent').set(parent);
    expect(sent.body.items.map((i: { id: string }) => i.id)).toContain(invitation.id);
    expect((await t.http.get('/v1/me/invitations').set(stranger.header)).body.items).toEqual([]);
  });

  it('an invitation sent to a verified contact is received by the person holding it, and its expiry reads before any write', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const recipient = await adultWithAccount();
    const email = `grandma-${newId()}@example.test`;
    await createContactPointFixture(t, {
      personId: recipient.personId,
      kind: 'email',
      value: email,
      verified: true,
    });
    const unverifiedHolder = await adultWithAccount();
    await createContactPointFixture(t, {
      personId: unverifiedHolder.personId,
      kind: 'email',
      value: email,
      isPrimary: false,
    });
    const invitation = await invite(parent, {
      recipientContact: { kind: 'email', value: email.toUpperCase() },
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
      expiresInHours: 1,
    });
    const received = await t.http.get('/v1/me/invitations?status=pending').set(recipient.header);
    expect(received.body.items.map((i: { id: string }) => i.id)).toEqual([invitation.id]);
    expect(
      (await t.http.get('/v1/me/invitations').set(unverifiedHolder.header)).body.items,
    ).toEqual([]);
    t.clock.advance(2 * 3600_000);
    {
      const later = await t.http.get(`/v1/me/invitations/${invitation.id}`).set(recipient.header);
      expect(later.body).toMatchObject({ status: 'pending', effectiveStatus: 'expired' });
      const expired = await t.http.get('/v1/me/invitations?status=expired').set(recipient.header);
      expect(expired.body.items.map((i: { id: string }) => i.id)).toEqual([invitation.id]);
      expect(
        (await t.http.get('/v1/me/invitations?status=pending').set(recipient.header)).body.items,
      ).toEqual([]);
      const row = await t.db
        .selectFrom('invitations')
        .select(['status', 'revision'])
        .where('id', '=', invitation.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'pending', revision: 1 });
    }
  });

  it('§4.10 / SPK-IAM-004: an invitation naming a person is not readable by another holder of its contact', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const addressee = await adultWithAccount();
    const sharedEmail = `family-${newId()}@example.test`;
    await createContactPointFixture(t, {
      personId: addressee.personId,
      kind: 'email',
      value: sharedEmail,
      verified: true,
    });
    // a second person holds the same address, verified but not primary (a shared family inbox)
    const other = await adultWithAccount();
    await createContactPointFixture(t, {
      personId: other.personId,
      kind: 'email',
      value: sharedEmail,
      verified: true,
      isPrimary: false,
    });
    const invitation = await invite(parent, {
      recipientPersonId: addressee.personId,
      recipientContact: { kind: 'email', value: sharedEmail },
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
    });
    const otherList = await t.http.get('/v1/me/invitations').set(other.header);
    expect(otherList.status).toBe(200);
    expect(otherList.body.items).toEqual([]);
    const otherRead = await t.http.get(`/v1/me/invitations/${invitation.id}`).set(other.header);
    expect(otherRead.status).toBe(404);
    expect(otherRead.body.code).toBe('NOT_FOUND');
    // the named person still reads it
    const mine = await t.http.get('/v1/me/invitations').set(addressee.header);
    expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([invitation.id]);
    expect(
      (await t.http.get(`/v1/me/invitations/${invitation.id}`).set(addressee.header)).status,
    ).toBe(200);
  });

  it('§4.9: a decline made against a stale read is refused with STALE_REVISION', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const sitter = await adultWithAccount();
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
    });
    const stale = await t.http
      .post(`/v1/invitations/${invitation.id}/decline`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token, expectedRevision: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const row = await t.db
      .selectFrom('invitations')
      .select(['status', 'revision'])
      .where('id', '=', invitation.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'pending', revision: 1 });
    const current = await t.http
      .post(`/v1/invitations/${invitation.id}/decline`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token, expectedRevision: 1 });
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ status: 'declined', revision: 2 });
  });

  it('SPK-IAM-004: a declined invitation can no longer be accepted', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view', 'collect'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const sitter = await adultWithAccount();
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
    });
    // the decline needs the accept proof: the token, and being the recipient
    const wrongToken = await t.http
      .post(`/v1/invitations/${invitation.id}/decline`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: 'x'.repeat(43) });
    expect(wrongToken.status).toBe(404);
    const stranger = await adultWithAccount();
    const notMine = await t.http
      .post(`/v1/invitations/${invitation.id}/decline`)
      .set(stranger.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token });
    expect(notMine.status).toBe(404);
    const declined = await t.http
      .post(`/v1/invitations/${invitation.id}/decline`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token, reason: 'I cannot help this term' });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'declined', revision: 2 });
    expect(declined.body.declinedAt).toBe(t.clock.now().toISOString());
    const row = await t.db
      .selectFrom('invitations')
      .select(['declined_by_person_id', 'decline_reason'])
      .where('id', '=', invitation.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      declined_by_person_id: sitter.personId,
      decline_reason: 'I cannot help this term',
    });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', invitation.id)
      .where('event_type', '=', 'identity.invitation_declined')
      .execute();
    expect(events.map((e) => e.payload)).toEqual([
      { invitationId: invitation.id, declinedByPersonId: sitter.personId },
    ]);
    const accept = await t.http
      .post(`/v1/invitations/${invitation.id}/accept`)
      .set(sitter.header)
      .set('Idempotency-Key', key())
      .send({ token: invitation.token });
    expect(accept.status).toBe(409);
    expect(accept.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'declined' },
    });
    const declinedList = await t.http.get('/v1/me/invitations?status=declined').set(sitter.header);
    expect(declinedList.body.items.map((i: { id: string }) => i.id)).toEqual([invitation.id]);
  });

  it('declining an invitation past its expiry records the expiry and answers INVALID_TRANSITION', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const sitter = await adultWithAccount();
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
      expiresInHours: 1,
    });
    t.clock.advance(2 * 3600_000);
    {
      const res = await t.http
        .post(`/v1/invitations/${invitation.id}/decline`)
        .set(sitter.header)
        .set('Idempotency-Key', key())
        .send({ token: invitation.token });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION', details: { from: 'expired' } });
      const row = await t.db
        .selectFrom('invitations')
        .select('status')
        .where('id', '=', invitation.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('expired');
      const expiredEvents = await t.db
        .selectFrom('outbox_events')
        .select('payload')
        .where('aggregate_id', '=', invitation.id)
        .where('event_type', '=', 'identity.invitation_expired')
        .execute();
      expect(expiredEvents.map((e) => e.payload)).toEqual([
        { invitationId: invitation.id, via: 'acceptance_attempt' },
      ]);
    }
  });

  it('staff list invitations covering a person with identity.read_invitations; a coach cannot', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const sitter = await adultWithAccount();
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
    });
    const desk = await authHeaderForPerson(t, family.staff.personId);
    const list = await t.http
      .get(`/v1/invitations?scopePersonId=${family.child.personId}`)
      .set(desk);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      id: invitation.id,
      subjects: [{ personId: family.child.personId }],
    });
    expect(list.body.items[0]).not.toHaveProperty('token');
    const coach = await createStaffMemberFixture(t, { roles: ['coach'] });
    const denied = await t.http
      .get('/v1/invitations')
      .set(await authHeaderForPerson(t, coach.personId));
    expect(denied.status).toBe(403);
  });

  it('the database rejects a declined invitation without who declined and when, and a decliner from another organization', async () => {
    const family = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const parent = await authHeaderForPerson(t, family.adult.personId);
    const sitter = await adultWithAccount();
    const invitation = await invite(parent, {
      recipientPersonId: sitter.personId,
      scope: { type: 'person', personId: family.child.personId },
      requestedPermissions: ['view'],
    });
    const fail = (patch: Record<string, unknown>) =>
      t.db
        .updateTable('invitations')
        .set(patch)
        .where('id', '=', invitation.id)
        .execute()
        .then(
          () => 'accepted by the database',
          (e: Error) => e.message,
        );
    expect(await fail({ status: 'declined' })).toMatch(/invitations_declined_check/);
    expect(
      await fail({ declined_at: t.clock.now(), declined_by_person_id: sitter.personId }),
    ).toMatch(/invitations_declined_check/);
    expect(await fail({ decline_reason: 'not declined' })).toMatch(
      /invitations_decline_reason_check/,
    );
    expect(await fail({ status: 'withdrawn' })).toMatch(/invitations_status_check/);
    const other = await seedOrganization(t.db);
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    expect(
      await fail({
        status: 'declined',
        declined_at: t.clock.now(),
        declined_by_person_id: foreign,
      }),
    ).toMatch(/invitations_declined_by_fk/);
    // a well-formed decline is accepted
    expect(
      await fail({
        status: 'declined',
        declined_at: t.clock.now(),
        declined_by_person_id: sitter.personId,
      }),
    ).toBe('accepted by the database');
  });
});
