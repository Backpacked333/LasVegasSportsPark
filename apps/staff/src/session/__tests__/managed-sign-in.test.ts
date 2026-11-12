import { createHash, randomBytes } from 'node:crypto';
import type { OidcPlatform } from '@sportspark/api-client';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../config/config';
import {
  PENDING_SIGN_IN_KEY,
  createManagedSignIn,
  safeReturnPath,
  type ManagedSignInEnvironment,
} from '../managed-sign-in';

const ISSUER = 'https://identity.example.test';
const ORIGIN = 'https://staff.example.test';

function environment(tokenAnswer: () => Response = () => new Response('{}', { status: 500 })) {
  const values = new Map<string, string>();
  const left: string[] = [];
  const requests: string[] = [];
  const platform: OidcPlatform = {
    fetch: async (url) => {
      requests.push(url);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          end_session_endpoint: `${ISSUER}/logout`,
        });
      }
      return tokenAnswer();
    },
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
    now: () => new Date('2026-11-09T12:00:00Z'),
  };
  const env: ManagedSignInEnvironment = {
    platform,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    },
    origin: ORIGIN,
    leave: (url) => void left.push(url),
  };
  return { env, values, left, requests };
}

const auth = { issuer: ISSUER, clientId: 'staff-dashboard' };

describe('managed staff sign-in in the browser (§4.13, §4.14, DEC-018)', () => {
  it('reads the provider from the build environment, and names none when it is not set', () => {
    const base = { VITE_API_BASE_URL: '/v1' } as ImportMetaEnv;
    expect(readConfig(base).auth).toBeNull();
    expect(readConfig({ ...base, VITE_AUTH_ISSUER: ISSUER } as ImportMetaEnv).auth).toBeNull();
    expect(
      readConfig({
        ...base,
        VITE_AUTH_ISSUER: ` ${ISSUER} `,
        VITE_AUTH_CLIENT_ID: 'staff-dashboard',
        VITE_AUTH_AUDIENCE: 'sportspark-api',
        VITE_AUTH_BEARER: 'id_token',
        VITE_ORGANIZATION_SLUG: 'the-park',
      } as ImportMetaEnv),
    ).toMatchObject({
      auth: {
        issuer: ISSUER,
        clientId: 'staff-dashboard',
        audience: 'sportspark-api',
        bearer: 'id_token',
      },
      organizationSlug: 'the-park',
    });
  });

  it('a return path stays inside this site: no other origin, no protocol-relative address, no loop to sign-in', () => {
    expect(safeReturnPath('/finance/refunds?status=open')).toBe('/finance/refunds?status=open');
    for (const hostile of [
      'https://elsewhere.example.test/',
      '//elsewhere.example.test/',
      'javascript:alert(1)',
      '/sign-in/callback',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(safeReturnPath(hostile)).toBe('/today');
    }
  });

  it('starting keeps the verifier in the tab only and sends the browser to the provider with this site as the return address', async () => {
    const { env, values, left } = environment();
    await createManagedSignIn(auth, env).start('/schedule');
    expect(left).toHaveLength(1);
    const url = new URL(left[0] as string);
    expect(url.origin).toBe(ISSUER);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/sign-in/callback`);
    const stored = JSON.parse(values.get(PENDING_SIGN_IN_KEY) as string);
    expect(stored).toMatchObject({ returnTo: '/schedule', state: url.searchParams.get('state') });
    expect(left[0]).not.toContain(stored.codeVerifier);
  });

  it('completing spends the stored request once: a second answer, or an answer with nothing started, is refused without asking the provider', async () => {
    const { env, values, left, requests } = environment(() =>
      Response.json({ access_token: 'bearer-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    );
    const signIn = createManagedSignIn(auth, env);
    await signIn.start('/people');
    const state = new URL(left[0] as string).searchParams.get('state');
    const callback = `${ORIGIN}/sign-in/callback?code=abc&state=${state}`;

    const done = await signIn.complete(callback);
    expect(done).toMatchObject({
      returnTo: '/people',
      tokens: { bearerToken: 'bearer-1', refreshToken: 'refresh-1' },
    });
    expect(values.has(PENDING_SIGN_IN_KEY)).toBe(false);

    const tokenRequests = requests.filter((r) => r.endsWith('/token')).length;
    await expect(signIn.complete(callback)).rejects.toMatchObject({ code: 'response_mismatch' });
    await expect(
      signIn.complete(`${ORIGIN}/sign-in/callback?code=abc&state=`),
    ).rejects.toMatchObject({ code: 'response_mismatch' });
    expect(requests.filter((r) => r.endsWith('/token'))).toHaveLength(tokenRequests);
  });

  it('signing out leaves for the provider sign-out with this site as the way back, and renewing asks the token endpoint', async () => {
    const { env, left } = environment(() => Response.json({ access_token: 'bearer-2' }));
    const signIn = createManagedSignIn(auth, env);
    expect(await signIn.signOut()).toBe(true);
    const url = new URL(left[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/logout`);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/sign-in`);
    expect(await signIn.renew('refresh-1')).toMatchObject({
      bearerToken: 'bearer-2',
      refreshToken: 'refresh-1',
    });
  });
});
