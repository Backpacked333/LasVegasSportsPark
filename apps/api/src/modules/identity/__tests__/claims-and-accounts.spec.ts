import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { idempotencyStoreContains } from '../../../testing/idempotency-store';
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

  it('§4.14 / SPK-IAM-002: the claim token never rests in the idempotency store; a replay withholds it', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const participant = await createPersonFixture(t, { kind: 'adult' });
    const idempotencyKey = key();
    const issued = await t.http
      .post(`/v1/people/${participant}/claims`)
      .set(staff)
      .set('Idempotency-Key', idempotencyKey)
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    expect(await idempotencyStoreContains(t.db, issued.body.token as string)).toBe(false);
    const replay = await t.http
      .post(`/v1/people/${participant}/claims`)
      .set(staff)
      .set('Idempotency-Key', idempotencyKey)
      .send({ kind: 'self' });
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({
      code: 'IDEMPOTENCY_SECRET_WITHHELD',
      details: { resourceId: issued.body.id },
    });
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
      .send({
        kind: 'guardian',
        requestedPermissions: ['view'],
        recipientContact: { kind: 'email', value: 'stranger@example.test' },
      });
    expect(res.status).toBe(404);
  });

  it('SPK-IAM-002: a self claim cannot carry an unverifiable recipient', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const parent = await createPersonFixture(t, { kind: 'adult' });
    const child = await createPersonFixture(t, { kind: 'child' });
    await createContactPointFixture(t, {
      personId: parent,
      kind: 'email',
      value: `parent-${newId()}@example.test`,
      verified: true,
    });
    const bound = await t.http
      .post(`/v1/people/${parent}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self', recipientContact: { kind: 'email', value: 'parent@example.test' } });
    expect(bound.status).toBe(400);
    expect(bound.body.code).toBe('VALIDATION_FAILED');

    // A self claim stored with a recipient (issued before this rule) fails closed: an account
    // without a person holds no verified contact point, so it can never take over the person.
    const issued = await t.http
      .post(`/v1/people/${parent}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    expect(issued.body.recipientContact).toBeNull();
    await t.db
      .updateTable('claims')
      .set({ recipient_contact_kind: 'email', recipient_contact_value: 'parent@example.test' })
      .where('id', '=', issued.body.id)
      .execute();
    const stranger = await createAccountFixture(t, { personId: null });
    const takeover = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, stranger.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(takeover.status).toBe(403);
    const account = await t.db
      .selectFrom('accounts')
      .select('person_id')
      .where('id', '=', stranger.id)
      .executeTakeFirstOrThrow();
    expect(account.person_id).toBeNull();
    expect(await authority.hasPermission(t.organizationId, parent, child, 'view')).toBe(false);
  });

  it('SPK-IAM-002: a guardian claim requires a recipient and refuses other accounts', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const child = await createPersonFixture(t, { kind: 'child' });
    const unbound = await t.http
      .post(`/v1/people/${child}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'guardian', requestedPermissions: ['view', 'collect'] });
    expect(unbound.status).toBe(400);
    expect(unbound.body.code).toBe('VALIDATION_FAILED');
    const email = `guardian-${newId()}@example.test`;
    const issued = await t.http
      .post(`/v1/people/${child}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({
        kind: 'guardian',
        requestedPermissions: ['view', 'collect'],
        recipientContact: { kind: 'email', value: email },
      });
    expect(issued.status).toBe(201);
    expect(issued.body.recipientContact).toEqual({ kind: 'email', value: email });
    const strangerPerson = await createPersonFixture(t, { kind: 'adult' });
    const stranger = await createAccountFixture(t, { personId: strangerPerson });
    const denied = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, stranger.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(denied.status).toBe(403);
    expect(await authority.hasPermission(t.organizationId, strangerPerson, child, 'collect')).toBe(
      false,
    );
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    const guardianAccount = await createAccountFixture(t, { personId: guardian });
    await createContactPointFixture(t, {
      personId: guardian,
      kind: 'email',
      value: email,
      verified: true,
    });
    const accepted = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, guardianAccount.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status).toBe(200);
    expect(await authority.hasPermission(t.organizationId, guardian, child, 'collect')).toBe(true);
  });

  it('SPK-IAM-002: a revoked claim cannot be accepted', async () => {
    const people = await createOrganizationPeople(t);
    const staff = await authHeaderForPerson(t, people.staff.personId);
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const issued = await t.http
      .post(`/v1/people/${adult}/claims`)
      .set(staff)
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    const revoke = (header: Record<string, string>, body: Record<string, unknown>) =>
      t.http
        .post(`/v1/claims/${issued.body.id}/revoke`)
        .set(header)
        .set('Idempotency-Key', key())
        .send(body);
    // a customer may not revoke, and a denial reads like a missing claim (§4.10)
    const byCustomer = await revoke(await authHeaderForPerson(t, people.adult.personId), {
      reason: 'not mine',
    });
    expect(byCustomer.status).toBe(404);
    expect((await revoke(staff, {})).status).toBe(400);
    const stale = await revoke(staff, {
      reason: 'token sent to the wrong family',
      expectedRevision: 2,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const revoked = await revoke(staff, {
      reason: 'token sent to the wrong family',
      expectedRevision: 1,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ id: issued.body.id, status: 'revoked', revision: 2 });
    expect(revoked.body.revokedAt).not.toBeNull();
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason'])
      .where('target_id', '=', issued.body.id)
      .where('action', '=', 'identity.revoke_claim')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('token sent to the wrong family');
    const event = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'identity.claim_revoked')
      .where('aggregate_id', '=', issued.body.id)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ claimId: issued.body.id, subjectPersonId: adult });

    const account = await createAccountFixture(t, { personId: null });
    const accepted = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, account.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe('INVALID_TRANSITION');
    // a second revoke is an invalid transition, never a second audit entry
    expect((await revoke(staff, { reason: 'again' })).status).toBe(409);
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

  /** A staff membership written directly, for a person who may have no account yet. */
  const addMembership = async (
    personId: string,
    roles: string[],
    effectiveFrom: Date = t.clock.now(),
  ): Promise<void> => {
    await t.db
      .insertInto('staff_memberships')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        person_id: personId,
        roles: roles as never,
        facility_ids: [],
        effective_from: effectiveFrom,
        effective_to: null,
        ended_at: null,
        ended_reason: null,
        created_by: json({ kind: 'system' }),
      })
      .execute();
  };
  const relinkBody = (subject: string, expectedRevision = 1) => ({
    issuer: t.config.AUTH_ISSUER,
    subject,
    reason: 'lost phone',
    expectedRevision,
  });

  it('SPK-AT-025 / §4.14: support cannot recover a staff login onto another identity; a system administrator can', async () => {
    const gm = await createStaffMemberFixture(t, {
      roles: ['general_manager', 'system_administrator'],
    });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const supportHeader = await authHeaderForPerson(t, support.personId);
    const before = await t.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', gm.accountId)
      .executeTakeFirstOrThrow();
    const oldToken = await tokenForAccount(t, gm.accountId);

    const attacker = `attacker-${newId()}`;
    const refused = await t.http
      .post(`/v1/accounts/${gm.accountId}/relink`)
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send(relinkBody(attacker));
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('ACCESS_DENIED');
    const after = await t.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', gm.accountId)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    // the attacker identity resolves to nobody; the staff member keeps their own login
    const attackerToken = await t.identityProvider.mint({ subject: attacker, sessionId: newId() });
    expect(
      (await t.http.get('/v1/me').set('Authorization', `Bearer ${attackerToken}`)).status,
    ).toBe(401);
    expect((await t.http.get('/v1/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(
      200,
    );

    // a membership scheduled to start later protects the login too
    const future = await createPersonFixture(t, { kind: 'adult' });
    const futureAccount = await createAccountFixture(t, { personId: future });
    await addMembership(
      future,
      ['finance_operator'],
      new Date(t.clock.now().getTime() + 86_400_000),
    );
    const futureRefused = await t.http
      .post(`/v1/accounts/${futureAccount.id}/relink`)
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send(relinkBody(`attacker-${newId()}`));
    expect(futureRefused.status).toBe(403);

    // the authority that assigns staff roles may recover a staff login; the trail names both identities
    const recovered = `recovered-${newId()}`;
    const ok = await t.http
      .post(`/v1/accounts/${gm.accountId}/relink`)
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send(relinkBody(recovered));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['details'])
      .where('target_id', '=', gm.accountId)
      .where('action', '=', 'identity.manage_account')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      operation: 'relink',
      previousSubject: before.subject,
      subject: recovered,
    });
  });

  it('SPK-AT-025 / §4.14: support and front desk cannot provision or self-claim the login of a staff person', async () => {
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const desk = await createStaffMemberFixture(t, { roles: ['front_desk'] });
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    const sysadminPerson = await createPersonFixture(t, { kind: 'adult' });
    await addMembership(sysadminPerson, ['system_administrator']);

    const provisioned = await t.http
      .post('/v1/accounts')
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `attacker-${newId()}`,
        personId: sysadminPerson,
      });
    expect(provisioned.status, JSON.stringify(provisioned.body)).toBe(403);
    const claim = await t.http
      .post(`/v1/people/${sysadminPerson}/claims`)
      .set(await authHeaderForPerson(t, desk.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(claim.status, JSON.stringify(claim.body)).toBe(403);
    expect(
      await t.db
        .selectFrom('accounts')
        .select('id')
        .where('person_id', '=', sysadminPerson)
        .execute(),
    ).toEqual([]);
    expect(
      await t.db
        .selectFrom('claims')
        .select('id')
        .where('subject_person_id', '=', sysadminPerson)
        .execute(),
    ).toEqual([]);
    // a system administrator may provision it
    const byAdmin = await t.http
      .post('/v1/accounts')
      .set(await authHeaderForPerson(t, admin.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `staff-${newId()}`,
        personId: sysadminPerson,
      });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(201);

    // a self claim issued before the person became staff cannot be accepted afterwards
    const walkIn = await createPersonFixture(t, { kind: 'adult' });
    const issued = await t.http
      .post(`/v1/people/${walkIn}/claims`)
      .set(await authHeaderForPerson(t, desk.personId))
      .set('Idempotency-Key', key())
      .send({ kind: 'self' });
    expect(issued.status).toBe(201);
    await addMembership(walkIn, ['general_manager']);
    const claimant = await createAccountFixture(t, { personId: null });
    const accepted = await t.http
      .post('/v1/claims/accept')
      .set(await authHeaderForAccount(t, claimant.id))
      .set('Idempotency-Key', key())
      .send({ token: issued.body.token });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(403);
    const stillUnlinked = await t.db
      .selectFrom('accounts')
      .select('person_id')
      .where('id', '=', claimant.id)
      .executeTakeFirstOrThrow();
    expect(stillUnlinked.person_id).toBeNull();
  });

  it('SPK-AT-025: recovery does not re-activate a disabled account', async () => {
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const person = await createPersonFixture(t, { kind: 'adult' });
    const disabled = await createAccountFixture(t, { personId: person, status: 'disabled' });
    const res = await t.http
      .post(`/v1/accounts/${disabled.id}/relink`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send(relinkBody(`recovered-${newId()}`));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    const row = await t.db
      .selectFrom('accounts')
      .select(['status', 'subject', 'revision'])
      .where('id', '=', disabled.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'disabled', subject: disabled.subject, revision: 1 });
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
