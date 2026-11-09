import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type CryptoKey,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OIDC_CONFIG_ENV, TEST_CONFIG_ENV } from '../../testing/test-app';
import { OidcJwksIdentityProvider } from '../auth/oidc-jwks.identity-provider';
import { loadConfig, type AppConfig } from '../config';

const ISSUER = 'https://identity.example.test';
const AUDIENCE = 'sportspark-api';

interface Key {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

async function key(kid: string, alg: 'RS256' | 'ES256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

function config(env: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...TEST_CONFIG_ENV, ...OIDC_CONFIG_ENV, ...env });
}

async function token(
  signer: Key,
  alg: 'RS256' | 'ES256',
  claims: Record<string, unknown> = {},
  overrides: { issuer?: string; audience?: string; expiresIn?: number; subject?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: signer.kid })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? 'user-123')
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (overrides.expiresIn ?? 600))
    .sign(signer.privateKey);
}

describe('managed identity behind IdentityProviderPort (§5.2, DEC-018, SPK-IAM-002)', () => {
  let rsa: Key;
  let ec: Key;
  let stranger: Key;
  let jwks: JSONWebKeySet;

  beforeAll(async () => {
    rsa = await key('rsa-1', 'RS256');
    ec = await key('ec-1', 'ES256');
    stranger = await key('rsa-1', 'RS256'); // same kid, different key: a forged token
    jwks = { keys: [rsa.publicJwk, ec.publicJwk] as JSONWebKeySet['keys'] };
  });

  it('SPK-IAM-002: a token the configured issuer signed for this audience verifies to (issuer, subject)', async () => {
    const provider = new OidcJwksIdentityProvider(config(), createLocalJWKSet(jwks));
    for (const [signer, alg] of [
      [rsa, 'RS256'],
      [ec, 'ES256'],
    ] as const) {
      const identity = await provider.verify(
        await token(signer, alg, { session_id: 'session-9', role: 'authenticated', aal: 'aal1' }),
      );
      expect(identity.issuer).toBe(ISSUER);
      expect(identity.subject).toBe('user-123');
      // Providers name the session `session_id` or `sid`; either is the session id.
      expect(identity.sessionId).toBe('session-9');
      expect(identity.claims).toEqual({ role: 'authenticated', aal: 'aal1' });
      expect(identity.expiresAt.getTime()).toBeGreaterThan(identity.issuedAt.getTime());
    }
    const withSid = await provider.verify(await token(rsa, 'RS256', { sid: 'oidc-session' }));
    expect(withSid.sessionId).toBe('oidc-session');
  });

  it('§4.14: wrong issuer, wrong audience, an expired token, a forged signature and an unknown key are 401', async () => {
    const provider = new OidcJwksIdentityProvider(config(), createLocalJWKSet(jwks));
    const unknownKid = await key('rotated-away', 'RS256');
    const cases = [
      await token(rsa, 'RS256', {}, { issuer: 'https://someone-else.example.test' }),
      await token(rsa, 'RS256', {}, { audience: 'another-api' }),
      await token(rsa, 'RS256', {}, { expiresIn: -3600 }),
      await token(stranger, 'RS256'),
      await token(unknownKid, 'RS256'),
      'not-a-token',
    ];
    for (const bad of cases) {
      await expect(provider.verify(bad)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    }
  });

  it('§4.14: only the configured asymmetric algorithms are accepted (no algorithm substitution)', async () => {
    const rsaOnly = new OidcJwksIdentityProvider(
      config({ AUTH_ALLOWED_ALGS: 'RS256' }),
      createLocalJWKSet(jwks),
    );
    await expect(rsaOnly.verify(await token(ec, 'ES256'))).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    // A symmetric token signed with a guessable secret is never accepted.
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'rsa-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('x'.repeat(64)));
    await expect(rsaOnly.verify(hs)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(() => config({ AUTH_ALLOWED_ALGS: 'HS256' })).toThrow(/AUTH_ALLOWED_ALGS/);
  });

  it('§4.14: a token within the clock tolerance after expiry still verifies; beyond it, it does not', async () => {
    const provider = new OidcJwksIdentityProvider(
      config({ AUTH_CLOCK_SKEW_SECONDS: '60' }),
      createLocalJWKSet(jwks),
    );
    await expect(
      provider.verify(await token(rsa, 'RS256', {}, { expiresIn: -30 })),
    ).resolves.toMatchObject({ subject: 'user-123' });
    await expect(
      provider.verify(await token(rsa, 'RS256', {}, { expiresIn: -120 })),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  describe('the remote key set', () => {
    let server: Server;
    let url: string;
    let fetches = 0;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        fetches += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(jwks));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('§5.2: keys are fetched from AUTH_JWKS_URL and reused across requests', async () => {
      const provider = new OidcJwksIdentityProvider(config({ AUTH_JWKS_URL: url }));
      await expect(provider.verify(await token(rsa, 'RS256'))).resolves.toMatchObject({
        subject: 'user-123',
      });
      await expect(provider.verify(await token(ec, 'ES256'))).resolves.toMatchObject({
        subject: 'user-123',
      });
      expect(fetches).toBe(1);
    });

    it('§4.10, §4.12: an unreachable key set is INTEGRATION_UNAVAILABLE (retry later), not a sign-out', async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const port = (closed.address() as AddressInfo).port;
      await new Promise((resolve) => closed.close(resolve));
      const provider = new OidcJwksIdentityProvider(
        config({ AUTH_JWKS_URL: `http://127.0.0.1:${port}/jwks.json` }),
      );
      await expect(provider.verify(await token(rsa, 'RS256'))).rejects.toMatchObject({
        code: 'INTEGRATION_UNAVAILABLE',
      });
    });
  });
});
