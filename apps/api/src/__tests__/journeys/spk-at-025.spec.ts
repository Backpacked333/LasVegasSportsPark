import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import {
  authHeaderForAccount,
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
  tokenForAccount,
} from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing';

const key = () => `k-${newId()}`;

/**
 * SPK-AT-025 (spec §6.1): "Customer account recovered — only verified prior access restored", over
 * the assembled application (every domain module, the identity module's principal resolver).
 * Recovery moves the login, never the authority, and it cannot be used by a role that does not
 * assign staff roles to take over a staff login (§4.14 least privilege). Verification evidence,
 * rate limits and a second approver are pending (DEC-018, DEC-091).
 */
describe('SPK-AT-025: customer account recovered (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-AT-025: a recovered customer login carries exactly the prior grants, and the old identity stops working', async () => {
    const people = await createOrganizationPeople(t, { guardianPermissions: ['view', 'pay'] });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const oldToken = await tokenForAccount(t, people.adult.accountId);
    const before = await t.http.get('/v1/me').set('Authorization', `Bearer ${oldToken}`);
    expect(before.status).toBe(200);

    const relinked = await t.http
      .post(`/v1/accounts/${people.adult.accountId}/relink`)
      .set(await authHeaderForPerson(t, support.personId))
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: `recovered-${newId()}`,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(relinked.status, JSON.stringify(relinked.body)).toBe(200);
    expect((await t.http.get('/v1/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(
      401,
    );
    const after = await t.http
      .get('/v1/me')
      .set(await authHeaderForAccount(t, people.adult.accountId));
    expect(after.status).toBe(200);
    expect(after.body.principal.personId).toBe(people.adult.personId);
    expect(after.body.authorities).toEqual(before.body.authorities);
    expect(after.body.authorities).toEqual([
      { subjectPersonId: people.child.personId, permissions: ['pay', 'view'] },
    ]);
  });

  it('SPK-AT-025 / §4.14: support cannot recover a general manager login onto an identity it holds, so it cannot raise its own roles', async () => {
    const gm = await createStaffMemberFixture(t, {
      roles: ['general_manager', 'system_administrator'],
    });
    const support = await createStaffMemberFixture(t, { roles: ['support_operator'] });
    const supportHeader = await authHeaderForPerson(t, support.personId);
    const attacker = `attacker-${newId()}`;

    const relink = await t.http
      .post(`/v1/accounts/${gm.accountId}/relink`)
      .set(supportHeader)
      .set('Idempotency-Key', key())
      .send({
        issuer: t.config.AUTH_ISSUER,
        subject: attacker,
        reason: 'lost phone',
        expectedRevision: 1,
      });
    expect(relink.status, JSON.stringify(relink.body)).toBe(403);
    expect(relink.body.code).toBe('ACCESS_DENIED');

    const attackerToken = await t.identityProvider.mint({ subject: attacker, sessionId: newId() });
    expect(
      (await t.http.get('/v1/me').set('Authorization', `Bearer ${attackerToken}`)).status,
    ).toBe(401);
    const escalate = await t.http
      .post('/v1/staff-memberships')
      .set('Authorization', `Bearer ${attackerToken}`)
      .set('Idempotency-Key', key())
      .send({ personId: support.personId, roles: ['general_manager'], reason: 'escalate' });
    expect(escalate.status).toBe(401);
    const supportMe = await t.http.get('/v1/me').set(supportHeader);
    expect(supportMe.body.principal.staffRoles).toEqual(['support_operator']);
    // the general manager keeps their own login
    expect(
      (await t.http.get('/v1/me').set(await authHeaderForAccount(t, gm.accountId))).body.principal
        .staffRoles,
    ).toEqual(expect.arrayContaining(['general_manager', 'system_administrator']));
  });
});
