import { Controller, HttpCode, Post } from '@nestjs/common';
import { parseClientIdentity as contractsParse, z } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal } from '../../testing/principals';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import { loadConfig } from '../config';
import { Idempotent } from '../http/idempotency.interceptor';
import { ZodBody } from '../http/zod-validation.pipe';

const CLIENT = 'X-Sportspark-Client';
const Body = z.object({ value: z.number().int() });

@Controller('client-compat-commands')
class ClientCompatCommandsController {
  static executions = 0;

  @Post()
  @HttpCode(201)
  @Idempotent()
  run(@ZodBody(Body) body: z.infer<typeof Body>): { executions: number; value: number } {
    ClientCompatCommandsController.executions += 1;
    return { executions: ClientCompatCommandsController.executions, value: body.value };
  }
}

describe('client compatibility gate (K-03, SPK-AT-027, §4.13)', () => {
  describe('with a configured minimum', () => {
    let t: TestApp;
    let auth: { Authorization: string };

    beforeAll(async () => {
      t = await createTestApp({
        controllers: [ClientCompatCommandsController],
        env: { CLIENT_MIN_VERSIONS: 'mobile-ios=2.0.0' },
      });
      auth = await t.authHeader(customerPrincipal(t.organizationId));
    });
    afterAll(async () => {
      await t?.close();
    });

    it('SPK-AT-027: a build below the configured minimum gets 426 CLIENT_UPDATE_REQUIRED with details.minimumVersion, and the updated build retries with the same Idempotency-Key', async () => {
      const before = ClientCompatCommandsController.executions;
      const old = await t.http
        .post('/v1/client-compat-commands')
        .set(auth)
        .set(CLIENT, 'sportspark-mobile/1.9.0 (ios)')
        .set('Idempotency-Key', 'client-compat-0001')
        .send({ value: 7 });
      expect(old.status).toBe(426);
      expect(old.body).toMatchObject({
        code: 'CLIENT_UPDATE_REQUIRED',
        nextAction: 'update_app',
        details: {
          app: 'mobile',
          platform: 'ios',
          clientVersion: '1.9.0',
          minimumVersion: '2.0.0',
        },
      });
      expect(ClientCompatCommandsController.executions).toBe(before);

      const updated = await t.http
        .post('/v1/client-compat-commands')
        .set(auth)
        .set(CLIENT, 'sportspark-mobile/2.0.0 (ios)')
        .set('Idempotency-Key', 'client-compat-0001')
        .send({ value: 7 });
      expect(updated.status).toBe(201);
      expect(updated.headers['idempotent-replayed']).toBeUndefined();
      expect(ClientCompatCommandsController.executions).toBe(before + 1);
      // another platform has no minimum
      const android = await t.http
        .get('/v1/health')
        .set(CLIENT, 'sportspark-mobile/0.1.0 (android)');
      expect(android.status).toBe(200);
    });
  });

  describe('without a configured minimum (the default, DEC-061 pending)', () => {
    let t: TestApp;
    let auth: { Authorization: string };

    beforeAll(async () => {
      t = await createTestApp({ controllers: [ClientCompatCommandsController] });
      auth = await t.authHeader(customerPrincipal(t.organizationId));
    });
    afterAll(async () => {
      await t?.close();
    });

    it('SPK-AT-027: without a configured minimum no build is refused; a request without the header is served; a malformed header gets VALIDATION_FAILED', async () => {
      const send = (key: string, client?: string) => {
        const request = t.http
          .post('/v1/client-compat-commands')
          .set(auth)
          .set('Idempotency-Key', key);
        return (client ? request.set(CLIENT, client) : request).send({ value: 1 });
      };
      expect((await send('client-compat-1001', 'sportspark-mobile/0.0.1 (ios)')).status).toBe(201);
      expect(
        (await send('client-compat-1002', 'sportspark-staff/0.1.0-alpha.1 (web)')).status,
      ).toBe(201);
      expect((await send('client-compat-1003')).status).toBe(201);
      const malformed = await send('client-compat-1004', 'SportsPark Mobile 1.0');
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { header: 'X-Sportspark-Client' },
      });
    });

    it('the header reading is defined once in packages/contracts', () => {
      expect(contractsParse('sportspark-staff/1.0.0-rc.1 (web)')).toEqual({
        app: 'staff',
        platform: 'web',
        version: '1.0.0-rc.1',
      });
      expect(contractsParse('sportspark-mobile/1 (ios)')).toBeNull();
    });

    it('CORS is off when no origin is configured (DEC-021 pending)', async () => {
      const preflight = await t.http
        .options('/v1/client-compat-commands')
        .set('Origin', 'https://staff.example.org')
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('CORS with configured origins (K-03)', () => {
    let t: TestApp;

    beforeAll(async () => {
      t = await createTestApp({
        env: { CORS_ALLOWED_ORIGINS: 'https://staff.example.org, http://localhost:5173' },
      });
    });
    afterAll(async () => {
      await t?.close();
    });

    it('answers a preflight from an allowed origin with the client headers, and nothing for any other origin', async () => {
      const allowed = await t.http
        .options('/v1/operations/0190e0f0-0000-7000-8000-000000000000')
        .set('Origin', 'https://staff.example.org')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'idempotency-key,x-sportspark-client');
      expect(allowed.status).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe('https://staff.example.org');
      const headers = String(allowed.headers['access-control-allow-headers']).toLowerCase();
      for (const header of [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-sportspark-client',
        'x-correlation-id',
        'x-export-token',
      ]) {
        expect(headers).toContain(header);
      }
      expect(allowed.headers['access-control-allow-methods']).toBe('GET,POST,PATCH,DELETE');
      expect(allowed.headers['access-control-max-age']).toBe('600');
      expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

      const health = await t.http.get('/v1/health').set('Origin', 'https://staff.example.org');
      expect(health.headers['access-control-allow-origin']).toBe('https://staff.example.org');
      expect(String(health.headers['access-control-expose-headers'])).toContain(
        'Idempotent-Replayed',
      );

      const other = await t.http
        .options('/v1/health')
        .set('Origin', 'https://elsewhere.example.org')
        .set('Access-Control-Request-Method', 'GET');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('production refuses a wildcard or plain-http origin, and a malformed origin refuses boot', () => {
      const production = {
        ...TEST_CONFIG_ENV,
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        DATABASE_URL: 'postgres://localhost/x',
      };
      expect(() => loadConfig({ ...production, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
        /CORS_ALLOWED_ORIGINS/,
      );
      expect(() =>
        loadConfig({ ...production, CORS_ALLOWED_ORIGINS: 'http://staff.example.org' }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
      expect(
        loadConfig({ ...production, CORS_ALLOWED_ORIGINS: 'https://staff.example.org' })
          .CORS_ALLOWED_ORIGINS,
      ).toEqual(['https://staff.example.org']);
      expect(() =>
        loadConfig({ ...TEST_CONFIG_ENV, CORS_ALLOWED_ORIGINS: 'https://staff.example.org/app' }),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
      expect(loadConfig({ ...TEST_CONFIG_ENV }).CORS_ALLOWED_ORIGINS).toBeUndefined();
    });
  });
});
