import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing/test-app';
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
        env: { AUTH_MODE: 'oidc' },
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
    });
  });
});
