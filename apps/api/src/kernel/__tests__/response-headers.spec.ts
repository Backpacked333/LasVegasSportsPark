import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';

describe('security response headers (R3-SECURITY-04, §4.14)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { TRUST_PROXY: 'loopback' } });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§4.14: every answer forbids caching, sniffing, framing, script and referrers', async () => {
    const res = await t.http.get('/v1/health');
    expect(res.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    expect(res.headers['x-powered-by']).toBeUndefined();
    // Plain http (no trusted proxy saying https): no Strict-Transport-Security.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('§4.14 encrypted transport: an https request (through a trusted proxy) gets Strict-Transport-Security', async () => {
    const res = await t.http.get('/v1/health').set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});
