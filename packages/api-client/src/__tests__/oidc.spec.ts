import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OidcError,
  RefreshingSessionStore,
  base64Url,
  beginAuthorization,
  completeAuthorization,
  discoverOidc,
  endSessionUrl,
  refreshTokens,
  type OidcConfig,
  type OidcEndpoints,
  type OidcPlatform,
  type OidcTokens,
} from '../oidc';
import { MemorySessionStore, parseStoredSession, type Session } from '../session';

const ISSUER = 'https://identity.example.test';
const NOW = new Date('2026-11-09T12:00:00Z');

const config: OidcConfig = {
  issuer: ISSUER,
  clientId: 'staff-dashboard',
  redirectUri: 'https://staff.example.test/sign-in/callback',
};
const endpoints: OidcEndpoints = {
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  endSessionEndpoint: `${ISSUER}/logout`,
};

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function platform(
  handler: Handler,
): OidcPlatform & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      return handler(url, init);
    },
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: async (data) => new Uint8Array(createHash('sha256').update(data).digest()),
    now: () => NOW,
  };
}

/** An unsigned JWT: these functions read `nonce` and `exp` only; the API verifies signatures. */
const jwt = (claims: Record<string, unknown>) =>
  `${base64Url(Buffer.from('{"alg":"none"}'))}.${base64Url(Buffer.from(JSON.stringify(claims)))}.`;

describe('managed sign-in: authorization code with PKCE (§4.13, §4.14, DEC-018)', () => {
  it('base64url matches the platform encoding for every remainder length', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('discovery reads the endpoints and refuses a document that names another issuer', async () => {
    const good = platform(() =>
      json({
        issuer: `${ISSUER}/`,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      }),
    );
    expect(await discoverOidc(config, good)).toEqual({ ...endpoints, endSessionEndpoint: null });
    expect(good.calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);

    const other = platform(() =>
      json({
        issuer: 'https://elsewhere.example.test',
        authorization_endpoint: 'https://elsewhere.example.test/authorize',
        token_endpoint: 'https://elsewhere.example.test/token',
      }),
    );
    await expect(discoverOidc(config, other)).rejects.toMatchObject({ code: 'response_mismatch' });
  });

  it('discovery refuses plain http, and reports an unreachable provider as unavailable', async () => {
    const insecure = platform(() =>
      json({
        issuer: ISSUER,
        authorization_endpoint: 'http://identity.example.test/authorize',
        token_endpoint: `${ISSUER}/token`,
      }),
    );
    await expect(discoverOidc(config, insecure)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    await expect(
      discoverOidc({ ...config, issuer: 'http://identity.example.test' }, insecure),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    const down = platform(() => {
      throw new TypeError('network');
    });
    await expect(discoverOidc(config, down)).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    const failing = platform(() => json({}, 503));
    await expect(discoverOidc(config, failing)).rejects.toBeInstanceOf(OidcError);
  });

  it('the request carries an S256 challenge of a fresh verifier and no secret', async () => {
    const p = platform(() => json({}));
    const first = await beginAuthorization({ ...config, audience: 'sportspark-api' }, endpoints, p);
    const second = await beginAuthorization(config, endpoints, p);
    const url = new URL(first.url);
    expect(`${url.origin}${url.pathname}`).toBe(endpoints.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'staff-dashboard',
      redirect_uri: config.redirectUri,
      scope: 'openid email profile offline_access',
      state: first.pending.state,
      nonce: first.pending.nonce,
      code_challenge_method: 'S256',
      audience: 'sportspark-api',
    });
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(first.pending.codeVerifier).digest('base64url'),
    );
    expect(first.url).not.toContain(first.pending.codeVerifier);
    expect(first.pending.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(second.pending.state).not.toBe(first.pending.state);
    expect(second.pending.codeVerifier).not.toBe(first.pending.codeVerifier);
    expect(new URL(second.url).searchParams.has('audience')).toBe(false);
  });

  it('the code is exchanged with the verifier; the bearer token, its expiry and the refresh token come back', async () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 3600;
    const p = platform(() => json({}));
    const { pending } = await beginAuthorization(config, endpoints, p);
    const access = jwt({ sub: 'user-1', exp });
    const exchange = platform(() =>
      json({
        access_token: access,
        id_token: jwt({ sub: 'user-1', nonce: pending.nonce }),
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );
    const tokens = await completeAuthorization(
      config,
      endpoints,
      exchange,
      pending,
      `${config.redirectUri}?code=the-code&state=${pending.state}`,
    );
    expect(tokens).toEqual({
      bearerToken: access,
      expiresAt: new Date(exp * 1000).toISOString(),
      refreshToken: 'refresh-1',
    });
    expect(exchange.calls[0]?.url).toBe(endpoints.tokenEndpoint);
    expect(Object.fromEntries(new URLSearchParams(exchange.calls[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: config.redirectUri,
      client_id: 'staff-dashboard',
      code_verifier: pending.codeVerifier,
    });
  });

  it('an opaque access token takes its expiry from expires_in; `bearer: id_token` selects the ID token', async () => {
    const p = platform(() => json({}));
    const { pending } = await beginAuthorization(config, endpoints, p);
    const idToken = jwt({ sub: 'u', nonce: pending.nonce, exp: 1_800_000_000 });
    const answer = () => json({ access_token: 'opaque', id_token: idToken, expires_in: 600 });
    const callback = `${config.redirectUri}?code=c&state=${pending.state}`;
    expect(
      await completeAuthorization(config, endpoints, platform(answer), pending, callback),
    ).toEqual({
      bearerToken: 'opaque',
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      refreshToken: null,
    });
    expect(
      await completeAuthorization(
        { ...config, bearer: 'id_token' },
        endpoints,
        platform(answer),
        pending,
        callback,
      ),
    ).toMatchObject({ bearerToken: idToken, expiresAt: new Date(1_800_000_000_000).toISOString() });
  });

  it('an answer for another request is refused before any code is exchanged: wrong state, wrong nonce', async () => {
    const p = platform(() => json({}));
    const { pending } = await beginAuthorization(config, endpoints, p);
    const never = platform(() => json({ access_token: 'x' }));
    await expect(
      completeAuthorization(
        config,
        endpoints,
        never,
        pending,
        `${config.redirectUri}?code=c&state=someone-elses`,
      ),
    ).rejects.toMatchObject({ code: 'response_mismatch' });
    await expect(
      completeAuthorization(config, endpoints, never, pending, `${config.redirectUri}?code=c`),
    ).rejects.toMatchObject({ code: 'response_mismatch' });
    expect(never.calls).toEqual([]);

    const replayed = platform(() =>
      json({ access_token: 'x', id_token: jwt({ nonce: 'another-nonce' }) }),
    );
    await expect(
      completeAuthorization(
        config,
        endpoints,
        replayed,
        pending,
        `${config.redirectUri}?code=c&state=${pending.state}`,
      ),
    ).rejects.toMatchObject({ code: 'response_mismatch' });
  });

  it('a cancelled sign-in and a refused code are reported with the provider code; an outage as unavailable', async () => {
    const p = platform(() => json({}));
    const { pending } = await beginAuthorization(config, endpoints, p);
    const callback = `${config.redirectUri}?code=c&state=${pending.state}`;
    await expect(
      completeAuthorization(
        config,
        endpoints,
        p,
        pending,
        `${config.redirectUri}?error=access_denied&state=${pending.state}`,
      ),
    ).rejects.toMatchObject({ code: 'sign_in_refused', providerError: 'access_denied' });
    await expect(
      completeAuthorization(
        config,
        endpoints,
        platform(() => json({ error: 'invalid_grant' }, 400)),
        pending,
        callback,
      ),
    ).rejects.toMatchObject({ code: 'sign_in_refused', providerError: 'invalid_grant' });
    await expect(
      completeAuthorization(
        config,
        endpoints,
        platform(() => json({}, 503)),
        pending,
        callback,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(
      completeAuthorization(
        config,
        endpoints,
        platform(() => json({ token_type: 'Bearer' })),
        pending,
        callback,
      ),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('refresh keeps the old refresh token when the provider does not rotate it, and reports an ended session', async () => {
    const kept = await refreshTokens(
      config,
      endpoints,
      platform(() => json({ access_token: 'next', expires_in: 60 })),
      'refresh-1',
    );
    expect(kept).toMatchObject({ bearerToken: 'next', refreshToken: 'refresh-1' });
    const rotated = platform(() => json({ access_token: 'next', refresh_token: 'refresh-2' }));
    expect(await refreshTokens(config, endpoints, rotated, 'refresh-1')).toMatchObject({
      refreshToken: 'refresh-2',
    });
    expect(Object.fromEntries(new URLSearchParams(rotated.calls[0]?.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'staff-dashboard',
    });
    await expect(
      refreshTokens(
        config,
        endpoints,
        platform(() => json({ error: 'invalid_grant' }, 400)),
        'refresh-1',
      ),
    ).rejects.toMatchObject({ code: 'session_ended', providerError: 'invalid_grant' });
  });

  it('the sign-out address names the client and where to return, when the provider has one', () => {
    const url = new URL(endSessionUrl(config, endpoints, 'https://staff.example.test/') as string);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'staff-dashboard',
      post_logout_redirect_uri: 'https://staff.example.test/',
    });
    expect(endSessionUrl(config, { ...endpoints, endSessionEndpoint: null }, 'x')).toBeNull();
  });
});

describe('RefreshingSessionStore (§4.13 session expiry)', () => {
  const session = (expiresInMs: number, refreshToken: string | null = 'refresh-1'): Session => ({
    token: 'old',
    expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
    accountId: 'account-1',
    refreshToken,
  });
  const next: OidcTokens = {
    bearerToken: 'new',
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    refreshToken: 'refresh-2',
  };

  it('leaves a session with time left, and one without a refresh token, untouched', async () => {
    let renewals = 0;
    const renew = async () => {
      renewals += 1;
      return next;
    };
    const fresh = new RefreshingSessionStore(
      new MemorySessionStore(session(600_000)),
      renew,
      () => NOW,
    );
    expect((await fresh.load())?.token).toBe('old');
    const noRefresh = new RefreshingSessionStore(
      new MemorySessionStore(session(1_000, null)),
      renew,
      () => NOW,
    );
    expect((await noRefresh.load())?.token).toBe('old');
    expect(renewals).toBe(0);
  });

  it('renews once for every request waiting, saves the new tokens and keeps the account', async () => {
    let renewals = 0;
    const inner = new MemorySessionStore(session(30_000));
    const store = new RefreshingSessionStore(
      inner,
      async (refreshToken) => {
        renewals += 1;
        expect(refreshToken).toBe('refresh-1');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return next;
      },
      () => NOW,
    );
    const loaded = await Promise.all([store.load(), store.load(), store.load()]);
    expect(renewals).toBe(1);
    expect(loaded.map((s) => s?.token)).toEqual(['new', 'new', 'new']);
    expect(await inner.load()).toEqual({
      token: 'new',
      expiresAt: next.expiresAt,
      accountId: 'account-1',
      refreshToken: 'refresh-2',
    });
  });

  it('clears the session when the provider ends it, and keeps it through a provider outage', async () => {
    const ended = new MemorySessionStore(session(-1_000));
    const store = new RefreshingSessionStore(
      ended,
      async () => {
        throw new OidcError('session_ended', 'ended', 'invalid_grant');
      },
      () => NOW,
    );
    expect(await store.load()).toBeNull();
    expect(await ended.load()).toBeNull();

    const outage = new MemorySessionStore(session(10_000));
    const during = new RefreshingSessionStore(
      outage,
      async () => {
        throw new OidcError('provider_unavailable', 'down');
      },
      () => NOW,
    );
    expect((await during.load())?.token).toBe('old');
    expect((await outage.load())?.refreshToken).toBe('refresh-1');
  });

  it('a stored session keeps its refresh token through serialization, and a corrupt one is dropped', () => {
    const stored = JSON.stringify(session(1_000));
    expect(parseStoredSession(stored)?.refreshToken).toBe('refresh-1');
    expect(parseStoredSession(JSON.stringify({ token: 't', refreshToken: 5 }))).toEqual({
      token: 't',
      expiresAt: null,
      accountId: null,
    });
  });
});
