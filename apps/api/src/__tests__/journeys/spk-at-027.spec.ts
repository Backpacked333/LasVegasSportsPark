import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions, loadConfig, parseClientIdentity } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import { adult, post } from '../../modules/finance/__tests__/support';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing';

const CLIENT = 'X-Sportspark-Client';

/**
 * SPK-AT-027 (spec §6.1): "Old mobile app contacts updated API — supported behavior or clear
 * update requirement", over the assembled application. §4.13: the minimum supported app version
 * per platform is configuration (`CLIENT_MIN_VERSIONS`; the values are pending DEC-061, so the
 * ones below are fixture values); a build below it gets 426 CLIENT_UPDATE_REQUIRED (DEC-092) with
 * the minimum in `details`; a request without the client header (a browser, a server, a webhook)
 * is served as a supported client; liveness answers every build.
 */
describe('SPK-AT-027: old mobile app contacts updated API (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
      env: { CLIENT_MIN_VERSIONS: 'mobile-ios=1.3.0,mobile-android=1.2.0' },
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-AT-027 / §4.13: a supported build is served, an unsupported build gets 426 CLIENT_UPDATE_REQUIRED with the minimum version, and liveness answers every build', async () => {
    const parent = await adult(t);
    const me = (client?: string) => {
      const req = t.http.get('/v1/me').set(parent.header);
      return client ? req.set(CLIENT, client) : req;
    };

    // supported builds, and clients that send no header (web, servers)
    expect((await me('sportspark-mobile/1.3.0 (ios)')).status).toBe(200);
    expect((await me('sportspark-mobile/1.4.2 (ios)')).status).toBe(200);
    expect((await me('sportspark-mobile/1.2.0 (android)')).status).toBe(200);
    expect((await me('sportspark-staff/0.1.0 (web)')).status).toBe(200);
    expect((await me()).status).toBe(200);

    // an unsupported build: a clear, machine-readable update requirement
    const old = await me('sportspark-mobile/1.2.9 (ios)');
    expect(old.status, JSON.stringify(old.body)).toBe(426);
    expect(old.body).toMatchObject({
      code: 'CLIENT_UPDATE_REQUIRED',
      nextAction: 'update_app',
      correlationId: expect.any(String),
      details: {
        app: 'mobile',
        platform: 'ios',
        clientVersion: '1.2.9',
        minimumVersion: '1.3.0',
      },
    });
    // a pre-release of the minimum is older than the minimum
    expect((await me('sportspark-mobile/1.3.0-beta.2 (ios)')).status).toBe(426);
    expect((await me('sportspark-mobile/1.1.9 (android)')).body.details.minimumVersion).toBe(
      '1.2.0',
    );

    // liveness answers every build; an unauthenticated old client is asked to sign in first
    const health = await t.http.get('/v1/health').set(CLIENT, 'sportspark-mobile/0.9.0 (ios)');
    expect(health.status).toBe(200);
    const anonymous = await t.http.get('/v1/me').set(CLIENT, 'sportspark-mobile/0.9.0 (ios)');
    expect(anonymous.status).toBe(401);

    // a malformed header is a validation error naming the header
    const malformed = await me('mobile 1.3');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { header: 'X-Sportspark-Client' },
    });
  });

  it('SPK-AT-027 / §4.9: a command from an unsupported build is refused before it runs and before its idempotency key is claimed; the updated build retries with the same key', async () => {
    const parent = await adult(t);
    const idempotencyKey = `k-${newId()}`;
    const body = { ownerPersonId: parent.personId };
    const refused = await t.http
      .post('/v1/baskets')
      .set(parent.header)
      .set(CLIENT, 'sportspark-mobile/1.0.0 (android)')
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(refused.status, JSON.stringify(refused.body)).toBe(426);
    expect(
      await t.db
        .selectFrom('baskets')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('owner_person_id', '=', parent.personId)
        .execute(),
    ).toEqual([]);

    const updated = await t.http
      .post('/v1/baskets')
      .set(parent.header)
      .set(CLIENT, 'sportspark-mobile/1.2.0 (android)')
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    expect(updated.status, JSON.stringify(updated.body)).toBe(201);
    // the same command without the client header (the web) is unaffected
    expect((await post(t, '/v1/baskets', parent.header, body)).status).toBe(201);
  });

  it('SPK-AT-027: with no minimum configured (DEC-061 pending, the default) every build is supported, and a malformed minimum is refused at boot', () => {
    const defaults = loadConfig({ ...TEST_CONFIG_ENV });
    expect(defaults.CLIENT_MIN_VERSIONS).toEqual({});
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, CLIENT_MIN_VERSIONS: 'mobile-ios=1.3' })).toThrow(
      /CLIENT_MIN_VERSIONS/,
    );
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, CLIENT_MIN_VERSIONS: 'watch-ios=1.0.0' }),
    ).toThrow(/CLIENT_MIN_VERSIONS/);
    expect(parseClientIdentity('sportspark-mobile/1.2.3 (ios)')).toEqual({
      app: 'mobile',
      platform: 'ios',
      version: '1.2.3',
    });
    expect(parseClientIdentity('sportspark-mobile/latest (ios)')).toBeNull();
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});
