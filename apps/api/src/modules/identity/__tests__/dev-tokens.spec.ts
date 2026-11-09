import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, OIDC_CONFIG_ENV, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { createAccountFixture, createOrganizationPeople } from '../testing/identity-fixtures';

describe('POST /v1/dev/tokens (local identity provider only, §5.2)', () => {
  describe('with AUTH_MODE=local outside production', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({ imports: [IdentityModule], principalResolver: 'module' });
    });
    afterAll(async () => {
      await t.close();
    });

    it('mints a token that the real resolver accepts, for active local accounts only', async () => {
      const people = await createOrganizationPeople(t);
      const res = await t.http.post('/v1/dev/tokens').send({ accountId: people.adult.accountId });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ accountId: people.adult.accountId });
      const me = await t.http.get('/v1/me').set('Authorization', `Bearer ${res.body.token}`);
      expect(me.status).toBe(200);
      expect(me.body.principal.personId).toBe(people.adult.personId);

      expect((await t.http.post('/v1/dev/tokens').send({ accountId: newId() })).status).toBe(404);
      const disabled = await createAccountFixture(t, { personId: null, status: 'disabled' });
      expect((await t.http.post('/v1/dev/tokens').send({ accountId: disabled.id })).status).toBe(
        404,
      );
      const foreign = await createAccountFixture(t, {
        personId: null,
        issuer: 'https://idp.example',
        subject: 'x',
      });
      expect((await t.http.post('/v1/dev/tokens').send({ accountId: foreign.id })).status).toBe(
        400,
      );
    });
  });

  describe('with a managed identity provider configured', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        imports: [IdentityModule],
        principalResolver: 'module',
        env: OIDC_CONFIG_ENV,
      });
    });
    afterAll(async () => {
      await t.close();
    });

    it('does not exist (NOT_FOUND)', async () => {
      const people = await createOrganizationPeople(t);
      const res = await t.http.post('/v1/dev/tokens').send({ accountId: people.adult.accountId });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      // §4.14: indistinguishable from an absent route even for a body that would not validate.
      const malformed = await t.http.post('/v1/dev/tokens').send({ accountId: 'x' });
      expect(malformed.status).toBe(404);
      expect(malformed.body.code).toBe('NOT_FOUND');
    });
  });
  describe('on a protected staging host (DEV_TOKENS_PASSCODE set)', () => {
    let t: TestApp;
    const PASSCODE = 'staging-passcode-for-tests-only';
    beforeAll(async () => {
      t = await createTestApp({
        imports: [IdentityModule],
        principalResolver: 'module',
        env: { DEV_TOKENS_PASSCODE: PASSCODE },
      });
    });
    afterAll(async () => {
      await t.close();
    });

    it('mints a token only with the right passcode; knowing an account id is not enough', async () => {
      const people = await createOrganizationPeople(t);
      const accountId = people.adult.accountId;
      const none = await t.http.post('/v1/dev/tokens').send({ accountId });
      expect(none.status).toBe(401);
      expect(none.body.code).toBe('AUTHENTICATION_REQUIRED');
      const wrong = await t.http.post('/v1/dev/tokens').send({ accountId, passcode: 'nope' });
      expect(wrong.status).toBe(401);
      expect(wrong.body.token).toBeUndefined();
      const right = await t.http.post('/v1/dev/tokens').send({ accountId, passcode: PASSCODE });
      expect(right.status).toBe(201);
      expect(right.body).toMatchObject({ accountId });
    });
  });

  describe('without a passcode (§4.14)', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({ imports: [IdentityModule], principalResolver: 'module' });
    });
    afterAll(async () => {
      await t.close();
    });

    it("§4.14: the route exists only on the developer's machine or private network, never for a host reached by name", async () => {
      const people = await createOrganizationPeople(t);
      const accountId = people.adult.accountId;
      // supertest connects over loopback with Host 127.0.0.1:<port>.
      expect((await t.http.post('/v1/dev/tokens').send({ accountId })).status).toBe(201);
      // The Android emulator reaches the developer's machine as 10.0.2.2, over loopback.
      expect(
        (await t.http.post('/v1/dev/tokens').set('Host', '10.0.2.2:3000').send({ accountId }))
          .status,
      ).toBe(201);
      // A host reached by a domain name (a staging host behind a proxy on the same machine).
      const named = await t.http
        .post('/v1/dev/tokens')
        .set('Host', 'staging.example.org')
        .send({ accountId });
      expect(named.status).toBe(404);
      expect(named.body.code).toBe('NOT_FOUND');
    });
  });
});
