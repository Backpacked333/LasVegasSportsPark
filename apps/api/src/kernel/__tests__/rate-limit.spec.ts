import { Controller, HttpCode, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  PRODUCTION_CONFIG_ENV,
  TEST_CONFIG_ENV,
  type TestApp,
} from '../../testing/test-app';
import { Public } from '../auth/public.decorator';
import { loadConfig } from '../config';
import {
  DEFAULT_RATE_LIMITS,
  MemoryRateLimiter,
  PostgresRateLimiter,
  RateLimited,
} from '../http/rate-limit';

@Controller('ratetest')
class RateLimitedTestController {
  @Public()
  @RateLimited('dev_tokens')
  @Post()
  @HttpCode(200)
  hit() {
    return { ok: true };
  }
}

describe('rate-limited recovery (§4.14)', () => {
  describe.each(['memory', 'postgres'] as const)('with the %s store', (store) => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({
        controllers: [RateLimitedTestController],
        clockStart: '2026-11-09T12:00:05.000Z',
        env: { RATE_LIMIT_STORE: store, RATE_LIMITS: 'dev_tokens=3/60' },
      });
    });
    afterAll(async () => {
      await t?.close();
    });

    it(`§4.14: past the limit one address gets 429 RATE_LIMITED with Retry-After until the window resets (${store})`, async () => {
      for (let i = 0; i < 3; i += 1) {
        expect((await t.http.post('/v1/ratetest')).status).toBe(200);
      }
      const refused = await t.http.post('/v1/ratetest');
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('RATE_LIMITED');
      expect(refused.body.details).toEqual({ retryAfterSeconds: 55 });
      expect(refused.headers['retry-after']).toBe('55');
      // The window resets with the clock (the next fixed minute).
      t.clock.advance(60_000);
      expect((await t.http.post('/v1/ratetest')).status).toBe(200);
    });
  });

  describe('the key behind a proxy (security review M-3)', () => {
    const hit = (t: TestApp, forwardedFor?: string) => {
      const request = t.http.post('/v1/ratetest');
      return forwardedFor ? request.set('X-Forwarded-For', forwardedFor) : request;
    };
    const app = (TRUST_PROXY?: string) =>
      createTestApp({
        controllers: [RateLimitedTestController],
        clockStart: '2026-11-09T12:00:05.000Z',
        env: { RATE_LIMITS: 'dev_tokens=2/60', ...(TRUST_PROXY ? { TRUST_PROXY } : {}) },
      });

    it('§4.14: with a hop count the limit keys on the address the proxy saw, never on one the caller wrote into X-Forwarded-For', async () => {
      const t = await app('1');
      try {
        // One visitor (203.0.113.9, as the proxy appended it) sending a different forged
        // address each time is still one visitor.
        expect((await hit(t, '198.51.100.1, 203.0.113.9')).status).toBe(200);
        expect((await hit(t, '198.51.100.2, 203.0.113.9')).status).toBe(200);
        expect((await hit(t, '198.51.100.3, 203.0.113.9')).status).toBe(429);
        // Another visitor behind the same proxy has a bucket of their own.
        expect((await hit(t, '198.51.100.3, 203.0.113.10')).status).toBe(200);
      } finally {
        await t.close();
      }
    });

    it('§4.14: with no proxy trusted the header is ignored, so it cannot be used to leave a bucket', async () => {
      for (const setting of [undefined, 'false']) {
        const t = await app(setting);
        try {
          expect((await hit(t, '198.51.100.1')).status).toBe(200);
          expect((await hit(t, '198.51.100.2')).status).toBe(200);
          expect((await hit(t, '198.51.100.3')).status).toBe(429);
        } finally {
          await t.close();
        }
      }
    });

    it('§4.14: `true` lets the caller choose the key, which is why production refuses it', async () => {
      const t = await app('true');
      try {
        for (let i = 1; i <= 4; i += 1) {
          expect((await hit(t, `198.51.100.${i}, 203.0.113.9`)).status).toBe(200);
        }
      } finally {
        await t.close();
      }
      const { TRUST_PROXY: _trust, ...production } = PRODUCTION_CONFIG_ENV;
      expect(() => loadConfig({ ...production, TRUST_PROXY: 'true' })).toThrow(
        /refused in production/,
      );
    });
  });

  it('SPK-SCHED-010: `public_views` is one of the named limits, with a default and a RATE_LIMITS override', () => {
    expect(DEFAULT_RATE_LIMITS.public_views).toEqual({ limit: 120, windowSeconds: 60 });
    expect(
      loadConfig({ ...TEST_CONFIG_ENV, RATE_LIMITS: 'public_views=30/60' }).RATE_LIMITS,
    ).toEqual({ public_views: { limit: 30, windowSeconds: 60 } });
  });

  it('§4.14: counts are per key and per window', async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { limit: 1, windowSeconds: 10 };
    const at = new Date('2026-11-09T12:00:00.000Z');
    expect((await limiter.consume('a', rule, at)).allowed).toBe(true);
    expect((await limiter.consume('a', rule, at)).allowed).toBe(false);
    expect((await limiter.consume('b', rule, at)).allowed).toBe(true);
    expect((await limiter.consume('a', rule, new Date(at.getTime() + 10_000))).allowed).toBe(true);
  });

  it.skipIf(!process.env['TEST_DATABASE_URL'])(
    '§4.14: concurrent requests on PostgreSQL never exceed the shared limit',
    async () => {
      const t = await createTestApp();
      try {
        const limiter = new PostgresRateLimiter(t.db);
        const rule = { limit: 5, windowSeconds: 60 };
        const at = new Date('2026-11-09T12:00:00.000Z');
        const decisions = await Promise.all(
          Array.from({ length: 20 }, () => limiter.consume('concurrent', rule, at)),
        );
        expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
      } finally {
        await t.close();
      }
    },
  );

  it('§4.14: RATE_LIMITS overrides name a known limit as <limit>/<seconds>', () => {
    expect(loadConfig({ ...TEST_CONFIG_ENV, RATE_LIMITS: 'claims=5/120' }).RATE_LIMITS).toEqual({
      claims: { limit: 5, windowSeconds: 120 },
    });
    expect(() => loadConfig({ ...TEST_CONFIG_ENV, RATE_LIMITS: 'logins=5/60' })).toThrow(
      /RATE_LIMITS entry "logins=5\/60"/,
    );
  });
});
