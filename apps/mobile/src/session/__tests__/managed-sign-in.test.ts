/**
 * Managed customer sign-in on the device (SPK-UX-001, §4.13, §4.14, DEC-018): the flow between
 * the app, the system sign-in browser and the identity provider, with the browser and the network
 * replaced by doubles. Behaviour on a device is §6.2 native acceptance, not claimed here.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { OidcPlatform } from '@sportspark/api-client';
import { readAuthConfig } from '../../config/app-config';
import {
  SIGN_IN_REDIRECT_URI,
  createManagedSignIn,
  type AuthSessionResult,
} from '../managed-sign-in';

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const ISSUER = 'https://identity.example.test';
const auth = { issuer: ISSUER, clientId: 'customer-app' };

function rig(
  browser: (url: string) => AuthSessionResult | Promise<AuthSessionResult>,
  tokenAnswer: () => Response = () =>
    Response.json({ access_token: 'bearer-1', refresh_token: 'refresh-1', expires_in: 3600 }),
) {
  const requests: Array<{ url: string; body: string }> = [];
  const opened: Array<{ url: string; redirectUri: string }> = [];
  const platform: OidcPlatform = {
    fetch: async (url, init) => {
      requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
        });
      }
      return tokenAnswer();
    },
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
    now: () => new Date('2026-11-09T12:00:00Z'),
  };
  const signIn = createManagedSignIn(auth, {
    platform,
    openAuthSession: async (url, redirectUri) => {
      opened.push({ url, redirectUri });
      return browser(url);
    },
  });
  return { signIn, requests, opened };
}

const answer = (url: string, code = 'the-code') =>
  `${SIGN_IN_REDIRECT_URI}?code=${code}&state=${new URL(url).searchParams.get('state')}`;

describe('managed customer sign-in', () => {
  it('reads the provider from the app config, and names none unless both the issuer and the client id are set', () => {
    expect(readAuthConfig(null)).toBeNull();
    expect(readAuthConfig({ issuer: ISSUER, clientId: null })).toBeNull();
    expect(
      readAuthConfig({
        issuer: ` ${ISSUER} `,
        clientId: 'customer-app',
        audience: 'sportspark-api',
        scope: null,
        bearer: 'id_token',
      }),
    ).toEqual({
      issuer: ISSUER,
      clientId: 'customer-app',
      audience: 'sportspark-api',
      bearer: 'id_token',
    });
  });

  it('opens the provider in the sign-in browser with the app as return address, then exchanges the code with the verifier it kept', async () => {
    const { signIn, requests, opened } = rig((url) => ({ type: 'success', url: answer(url) }));
    const tokens = await signIn.signIn();
    expect(tokens).toMatchObject({ bearerToken: 'bearer-1', refreshToken: 'refresh-1' });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.redirectUri).toBe('sportspark://sign-in');
    const authorize = new URL(opened[0]?.url as string);
    expect(authorize.searchParams.get('redirect_uri')).toBe('sportspark://sign-in');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const exchange = new URLSearchParams(requests.find((r) => r.url.endsWith('/token'))?.body);
    expect(exchange.get('code')).toBe('the-code');
    expect(
      createHash('sha256')
        .update(exchange.get('code_verifier') as string)
        .digest('base64url'),
    ).toBe(authorize.searchParams.get('code_challenge'));
  });

  it('closing the browser signs nobody in and asks the provider for nothing more', async () => {
    const { signIn, requests } = rig(() => ({ type: 'closed' }));
    expect(await signIn.signIn()).toBeNull();
    expect(requests.some((r) => r.url.endsWith('/token'))).toBe(false);
  });

  it('an answer carrying another attempt’s state is refused before any code is exchanged', async () => {
    const { signIn, requests } = rig(() => ({
      type: 'success',
      url: `${SIGN_IN_REDIRECT_URI}?code=stolen&state=someone-elses`,
    }));
    await expect(signIn.signIn()).rejects.toMatchObject({ code: 'response_mismatch' });
    expect(requests.some((r) => r.url.endsWith('/token'))).toBe(false);
  });

  it('each attempt has its own state and verifier, and renewing asks the token endpoint', async () => {
    const { signIn, opened } = rig((url) => ({ type: 'success', url: answer(url) }));
    await signIn.signIn();
    await signIn.signIn();
    const [a, b] = opened.map((o) => new URL(o.url).searchParams);
    expect(a?.get('state')).not.toBe(b?.get('state'));
    expect(a?.get('code_challenge')).not.toBe(b?.get('code_challenge'));
    expect(await signIn.renew('refresh-1')).toMatchObject({ bearerToken: 'bearer-1' });
  });
});
