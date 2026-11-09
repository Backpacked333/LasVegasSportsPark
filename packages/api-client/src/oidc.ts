/**
 * Managed sign-in for both clients (spec §4.13, §4.14 verified identity, §5.2; DEC-018): the
 * OpenID Connect authorization code flow with PKCE, the flow for applications that cannot keep a
 * secret. It names no vendor. Any provider that publishes `/.well-known/openid-configuration`
 * works, and the API verifies the resulting bearer token against the same issuer
 * (`OidcJwksIdentityProvider`).
 *
 * The password, the second factor and account recovery are entered on the provider's own pages,
 * never in these applications. This module only builds the request, checks the answer and
 * exchanges the code. Everything that touches the platform (network, random bytes, hashing, the
 * clock) is injected, so the staff dashboard, the customer app and the tests share one
 * implementation.
 */
import type { Session, SessionStore } from './session';

export interface OidcConfig {
  /** The provider's issuer, exactly as the API's `AUTH_ISSUER` (https; no trailing slash needed). */
  issuer: string;
  /** This application's public client id at the provider. There is no client secret. */
  clientId: string;
  /** Where the provider sends the person back. Must be registered at the provider. */
  redirectUri: string;
  /** Default `openid email profile offline_access` (the last one asks for a refresh token). */
  scope?: string;
  /** Some providers issue an access token for an API only when asked for its audience. */
  audience?: string;
  /** Which token the API accepts as the bearer token. Default `access_token`. */
  bearer?: 'access_token' | 'id_token';
}

export interface OidcPlatform {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  now(): Date;
}

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Where to end the provider's own session on sign-out, when the provider has one. */
  endSessionEndpoint: string | null;
}

/** What must be kept between leaving for the provider and coming back. Never put in a URL. */
export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface OidcTokens {
  bearerToken: string;
  /** ISO instant the bearer token stops being accepted, when the provider states it. */
  expiresAt: string | null;
  refreshToken: string | null;
}

export type OidcErrorCode =
  /** The provider could not be reached or answered something unusable: try again later. */
  | 'provider_unavailable'
  /** The person cancelled or the provider refused: `access_denied` and similar. */
  | 'sign_in_refused'
  /** The answer does not belong to the request this application started. */
  | 'response_mismatch'
  /** The refresh token is no longer accepted: the person signs in again. */
  | 'session_ended';

export class OidcError extends Error {
  override readonly name = 'OidcError';
  constructor(
    readonly code: OidcErrorCode,
    message: string,
    /** The provider's own error code (`access_denied`, `invalid_grant`), when it sent one. */
    readonly providerError: string | null = null,
  ) {
    super(message);
  }
}

const DEFAULT_SCOPE = 'openid email profile offline_access';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding (RFC 7636 appendix A), with no dependency on `btoa` or `Buffer`. */
export function base64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += ALPHABET[c & 63];
  }
  return out;
}

function decodeBase64Url(value: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** The claims of a JWT, unverified: used only for `nonce` and `exp`; the API verifies signatures. */
function unverifiedClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  const bytes = decodeBase64Url(part.replace(/=+$/, ''));
  if (!bytes) return null;
  try {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    // Only `nonce` and `exp` are read, both ASCII, so the bytes are not decoded as UTF-8.
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const trimSlash = (value: string) => value.replace(/\/+$/, '');

function requireHttps(url: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OidcError('provider_unavailable', `The identity provider's ${what} is not a URL.`);
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new OidcError('provider_unavailable', `The identity provider's ${what} must use https.`);
  }
  return url;
}

/**
 * Reads the provider's published configuration. The document must name the configured issuer
 * (OpenID Connect Discovery §4.3), so a document served from somewhere else is refused.
 */
export async function discoverOidc(
  config: OidcConfig,
  platform: OidcPlatform,
): Promise<OidcEndpoints> {
  const issuer = trimSlash(requireHttps(config.issuer, 'issuer'));
  let document: Record<string, unknown>;
  try {
    const response = await platform.fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(String(response.status));
    document = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OidcError('provider_unavailable', 'The identity provider could not be reached.');
  }
  if (typeof document['issuer'] !== 'string' || trimSlash(document['issuer']) !== issuer) {
    throw new OidcError(
      'response_mismatch',
      'The identity provider answered for a different issuer.',
    );
  }
  const authorization = document['authorization_endpoint'];
  const token = document['token_endpoint'];
  const end = document['end_session_endpoint'];
  if (typeof authorization !== 'string' || typeof token !== 'string') {
    throw new OidcError('provider_unavailable', 'The identity provider does not offer sign-in.');
  }
  return {
    authorizationEndpoint: requireHttps(authorization, 'authorization endpoint'),
    tokenEndpoint: requireHttps(token, 'token endpoint'),
    endSessionEndpoint: typeof end === 'string' ? requireHttps(end, 'sign-out endpoint') : null,
  };
}

/** Builds the address to send the person to, and what to keep until they come back. */
export async function beginAuthorization(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  platform: OidcPlatform,
): Promise<{ url: string; pending: PendingAuthorization }> {
  const pending: PendingAuthorization = {
    state: base64Url(platform.randomBytes(24)),
    codeVerifier: base64Url(platform.randomBytes(48)),
    nonce: base64Url(platform.randomBytes(24)),
    redirectUri: config.redirectUri,
  };
  const challenge = base64Url(
    await platform.sha256(Uint8Array.from(pending.codeVerifier, (c) => c.charCodeAt(0))),
  );
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope ?? DEFAULT_SCOPE);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.audience) url.searchParams.set('audience', config.audience);
  return { url: url.toString(), pending };
}

function tokensFrom(
  config: OidcConfig,
  platform: OidcPlatform,
  body: Record<string, unknown>,
  previousRefreshToken: string | null,
): OidcTokens {
  const use = config.bearer ?? 'access_token';
  const bearer = body[use];
  if (typeof bearer !== 'string' || bearer.length === 0) {
    throw new OidcError('provider_unavailable', `The identity provider sent no ${use}.`);
  }
  let expiresAt: string | null = null;
  const claims = unverifiedClaims(bearer);
  if (claims && typeof claims['exp'] === 'number') {
    expiresAt = new Date(claims['exp'] * 1000).toISOString();
  } else if (use === 'access_token' && typeof body['expires_in'] === 'number') {
    expiresAt = new Date(platform.now().getTime() + body['expires_in'] * 1000).toISOString();
  }
  const refresh = body['refresh_token'];
  return {
    bearerToken: bearer,
    expiresAt,
    // A provider that does not rotate refresh tokens omits it from the refresh answer.
    refreshToken:
      typeof refresh === 'string' && refresh.length > 0 ? refresh : previousRefreshToken,
  };
}

async function tokenRequest(
  endpoints: OidcEndpoints,
  platform: OidcPlatform,
  form: Record<string, string>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string | null }> {
  let response: Response;
  try {
    response = await platform.fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new OidcError('provider_unavailable', 'The identity provider could not be reached.');
  }
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (response.ok && body) return { ok: true, body };
  if (response.status >= 500 || (!body && response.ok)) {
    throw new OidcError('provider_unavailable', 'The identity provider is not available.');
  }
  return { ok: false, error: typeof body?.['error'] === 'string' ? body['error'] : null };
}

/**
 * Checks the address the provider sent the person back to and exchanges its code for tokens. The
 * `state` must be the one this application created (the answer belongs to this request), and when
 * the provider returns an ID token its `nonce` must match too.
 */
export async function completeAuthorization(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  platform: OidcPlatform,
  pending: PendingAuthorization,
  callbackUrl: string,
): Promise<OidcTokens> {
  let params: URLSearchParams;
  try {
    params = new URL(callbackUrl).searchParams;
  } catch {
    throw new OidcError('response_mismatch', 'The sign-in answer could not be read.');
  }
  if (params.get('state') !== pending.state) {
    throw new OidcError(
      'response_mismatch',
      'The sign-in answer does not belong to this sign-in. Start again.',
    );
  }
  const refused = params.get('error');
  if (refused) {
    throw new OidcError('sign_in_refused', 'Sign-in was cancelled or refused.', refused);
  }
  const code = params.get('code');
  if (!code) throw new OidcError('response_mismatch', 'The sign-in answer carried no code.');
  const result = await tokenRequest(endpoints, platform, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    client_id: config.clientId,
    code_verifier: pending.codeVerifier,
  });
  if (!result.ok) {
    throw new OidcError('sign_in_refused', 'The identity provider refused the code.', result.error);
  }
  const idToken = result.body['id_token'];
  if (typeof idToken === 'string') {
    const nonce = unverifiedClaims(idToken)?.['nonce'];
    if (nonce !== pending.nonce) {
      throw new OidcError(
        'response_mismatch',
        'The sign-in answer does not belong to this sign-in. Start again.',
      );
    }
  }
  return tokensFrom(config, platform, result.body, null);
}

/** Exchanges a refresh token for a new bearer token. `session_ended` means sign in again. */
export async function refreshTokens(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  platform: OidcPlatform,
  refreshToken: string,
): Promise<OidcTokens> {
  const result = await tokenRequest(endpoints, platform, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  if (!result.ok) {
    throw new OidcError('session_ended', 'The session ended. Sign in again.', result.error);
  }
  return tokensFrom(config, platform, result.body, refreshToken);
}

/** The provider's sign-out address, or null when the provider publishes none. */
export function endSessionUrl(
  config: OidcConfig,
  endpoints: OidcEndpoints,
  postLogoutRedirectUri: string,
): string | null {
  if (!endpoints.endSessionEndpoint) return null;
  const url = new URL(endpoints.endSessionEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  return url.toString();
}

/** How long before expiry a token is renewed, so a request never leaves with a token about to lapse. */
export const REFRESH_AHEAD_MS = 60_000;

/**
 * A `SessionStore` that renews the bearer token shortly before it expires (§4.13 session expiry),
 * so a person at a desk or beside a field is not signed out every time a short-lived token lapses.
 * The API client reads the store before every request, which is where renewal happens: one
 * renewal at a time, shared by every request waiting on it. When the provider no longer accepts
 * the refresh token the stored session is cleared, the request goes out unsigned, and the API's
 * AUTHENTICATION_REQUIRED answer sends the person to sign in. A provider outage leaves the
 * session as it is: the request proceeds and the API decides.
 */
export class RefreshingSessionStore implements SessionStore {
  private renewing: Promise<Session | null> | null = null;

  constructor(
    private readonly inner: SessionStore,
    private readonly renew: (refreshToken: string) => Promise<OidcTokens>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<Session | null> {
    const session = await this.inner.load();
    if (!session?.refreshToken || !session.expiresAt) return session;
    const expires = Date.parse(session.expiresAt);
    if (Number.isNaN(expires) || expires - this.now().getTime() > REFRESH_AHEAD_MS) return session;
    this.renewing ??= this.renewSession(session).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewSession(session: Session): Promise<Session | null> {
    try {
      const tokens = await this.renew(session.refreshToken as string);
      const next: Session = {
        token: tokens.bearerToken,
        expiresAt: tokens.expiresAt,
        accountId: session.accountId,
        refreshToken: tokens.refreshToken,
      };
      await this.inner.save(next);
      return next;
    } catch (error) {
      if (error instanceof OidcError && error.code === 'session_ended') {
        await this.inner.clear();
        return null;
      }
      return session;
    }
  }

  save(session: Session): Promise<void> {
    return this.inner.save(session);
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }
}
