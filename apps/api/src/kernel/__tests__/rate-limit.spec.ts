import { Controller, HttpCode, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import { Public } from '../auth/public.decorator';
import { loadConfig } from '../config';
import { MemoryRateLimiter, PostgresRateLimiter, RateLimited } from '../http/rate-limit';

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
