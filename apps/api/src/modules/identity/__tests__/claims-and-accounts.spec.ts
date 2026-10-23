import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { RelationshipAuthority } from '../services/relationship-authority.service';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createAccountFixture,
  createContactPointFixture,
  createOrganizationPeople,
  createPersonFixture,
  createStaffMemberFixture,
  tokenForAccount,
} from '../testing/identity-fixtures';

const key = () => `k-${newId()}`;

describe('claims and accounts (SPK-IAM-002, SPK-AT-025)', () => {
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

  it('SPK-IAM-002: a staff-created adult is claimed by a verified account without a second person', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const participant = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Walk',
      familyName: 'In',
    });
    const issued = await t.http
      .post(`/v1/people/${participant}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({
      subjectPersonId: participant,
      kind: 'self',
      status: 'pending',
    });

    const account = await createAccountFixture(t, { personId: null });
    const before = await t.db
      .selectFrom('persons')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    const accepted = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForAccount(t, account.id))
      .set('Idempotency-Key', key())
      .send();
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      accountId: account.id,
      personId: participant,
      relationship: null,
      grants: [],
    });
    const after = await t.db
      .selectFrom('persons')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
    const me = await t.http.get('/v1/me').set(await authHeaderForAccount(t, account.id));
    expect(me.body.principal.personId).toBe(participant);
    expect(me.body.person.givenName).toBe('Walk');
    const linked = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.account_linked')
      .where('aggregate_id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(linked.payload).toMatchObject({ via: 'claim', personId: participant });
    const reuse = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForAccount(t, account.id))
      .set('Idempotency-Key', key())
      .send();
    expect(reuse.status).toBe(409);
  });

  it('SPK-IAM-002: a guardian claim grants only the permissions staff wrote on it', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const child = await createPersonFixture(t, { kind: 'child' });
    const parent = await createPersonFixture(t, { kind: 'adult' });
    const parentAccount = await createAccountFixture(t, { personId: parent });
    await createContactPointFixture(t, {
      personId: parent,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
    const issued = await t.http
      .post(`/v1/people/${child}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'guardian',
        requestedPermissions: ['view', 'register'],
        recipientContact: { kind: 'email', value: 'Parent@example.test' },
      });
    expect(issued.status).toBe(201);
    const wrongContact = await createPersonFixture(t, { kind: 'adult' });
    const wrongAccount = await createAccountFixture(t, { personId: wrongContact });
    const denied = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForAccount(t, wrongAccount.id))
      .set('Idempotency-Key', key())
      .send();
    expect(denied.status).toBe(403);
    const accepted = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForAccount(t, parentAccount.id))
      .set('Idempotency-Key', key())
      .send();
    expect(accepted.status).toBe(200);
    expect(accepted.body.relationship).toMatchObject({
      kind: 'guardian',
      source: 'claim',
      subjectPersonId: child,
    });
    expect(accepted.body.grants.map((g: { permission: string }) => g.permission).sort()).toEqual([
      'register',
      'view',
    ]);
    expect(await authority.hasPermission(t.organizationId, parent, child, 'collect')).toBe(false);
    expect(await authority.hasPermission(t.organizationId, parent, child, 'view')).toBe(true);
  });

  it('SPK-IAM-002: self-claim validation — wrong token, expired, already-linked account, child subject', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    expect(
      (
        await t.http
          .post(`/v1/people/${child}/claims`)
          .set(staff)
          .set('Idempotency-Key', key())
          .send({ kind: 'self' })
      ).status,
    ).toBe(400);
    const issued = await t.http
      .post(`/v1/people/${adult}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self', expiresInHours: 1 });
    const unknown = await t.http
      .post(`/v1/claims/${'x'.repeat(32)}/accept`)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send();
    expect(unknown.status).toBe(404);
    // an account already representing another person cannot absorb a second person
    const conflict = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send();
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('RESOURCE_CONFLICT');
    const candidates = await t.db
      .selectFrom('duplicate_candidates')
      .selectAll()
      .where('person_a_id', 'in', [adult, people.adult.personId])
      .where('person_b_id', 'in', [adult, people.adult.personId])
      .execute();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.reasons).toEqual(['claim_by_account_with_existing_person']);
    t.clock.advance(3600_000 + 1);
    const fresh = await createAccountFixture(t, { personId: null });
    const expired = await t.http
      .post(`/v1/claims/${issued.body.token}/accept`)
      .set(await authHeaderForAccount(t, fresh.id))
      .set('Idempotency-Key', key())
      .send();
    expect(expired.status).toBe(409);
    expect(expired.body.details).toMatchObject({ from: 'expired' });
  });

  it('SPK-IAM-002: a stranger cannot issue claims; front desk can', async () => {
    const people = await createOrganizationPeople(t);
    const res = await t.http
      .post(`/v1/people/${people.child.personId}/claims`)
      .set(await authHeaderForPerson(t, people.adult.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'guardian', requestedPermissions: ['view'] });
    expect(res.status).toBe(404);
  });

  it('SPK-AT-025: account recovery re-links the account and restores only verified prior access', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'pay'] });
    const admin = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const grantsBefore = await t.db
      .selectFrom('access_grants')
      .select(['id', 'revoked_at'])
      .where('actor_person_id', '=', people.adult.personId)
      .orderBy('id')
      .execute();
    const oldToken = await tokenForAccount(t, people.adult.accountId);
    const relinked = await t.http
      .post(`/v1/accounts/${people.adult.accountId}/relink`)
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `recovered-${newId()}`,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(relinked.status).toBe(200);
    expect(relinked.body).toMatchObject({
      id: people.adult.accountId,
      personId: people.adult.personId,
      revision: 2,
    });
    // the old provider identity no longer resolves; the new one has exactly the prior authority
    expect((await t.http.get('/v1/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(
      401,
    );
    const me = await t.http
      .get('/v1/me')
      .set(await authHeaderForAccount(t, people.adult.accountId));
    expect(me.status).toBe(200);
    expect(me.body.authorities).toEqual([
      { subjectPersonId: people.child.personId, permissions: ['pay', 'view'] },
    ]);
    const grantsAfter = await t.db
      .selectFrom('access_grants')
      .select(['id', 'revoked_at'])
      .where('actor_person_id', '=', people.adult.personId)
      .orderBy('id')
      .execute();
    expect(grantsAfter).toEqual(grantsBefore);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', people.adult.accountId)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['identity.account_relinked']);
    const stale = await t.http
      .post(`/v1/accounts/${people.adult.accountId}/relink`)
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `again-${newId()}`,
        reason: 'x',
        expectedRevision: 1,
      });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
  });

  it('SPK-IAM-002: provisioning accounts is restricted and enforces one active account per person', async () => {
    const people = await createOrganizationPeople(t);
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const header = await authHeaderForPerson(t, admin.personId);
    const forbidden = await t.http
      .post('/v1/accounts')
      .set(await authHeaderForPerson(t, people.staff.personId))
      .set('Idempotency-Key', key())
      .send({ issuer: 'https://idp.example', subject: 'abc' });
    expect(forbidden.status).toBe(403);
    const created = await t.http
      .post('/v1/accounts')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ issuer: 'https://idp.example', subject: 'abc', personId: people.child.personId });
    expect(created.status).toBe(201);
    const duplicateIdentity = await t.http
      .post('/v1/accounts')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ issuer: 'https://idp.example', subject: 'abc' });
    expect(duplicateIdentity.status).toBe(409);
    const secondForPerson = await t.http
      .post('/v1/accounts')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ issuer: 'https://idp.example', subject: 'def', personId: people.adult.personId });
    expect(secondForPerson.status).toBe(409);
    expect(secondForPerson.body.message).toMatch(/already has an active account/);
    const { seedOrganization } = await import('@sportspark/db');
    const other = await seedOrganization(t.db);
    const foreignPerson = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const crossOrg = await t.http
      .post('/v1/accounts')
      .set(header)
      .set('Idempotency-Key', key())
      .send({ issuer: 'https://idp.example', subject: 'ghi', personId: foreignPerson });
    expect(crossOrg.status).toBe(404);
  });
});
