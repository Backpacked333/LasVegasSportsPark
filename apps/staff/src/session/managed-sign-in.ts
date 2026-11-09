/**
 * Managed staff sign-in in the browser (§4.13, §4.14 verified identity and multifactor for
 * privileged staff; DEC-018): the OpenID Connect authorization code flow with PKCE from
 * `@sportspark/api-client`. The password and any second factor are entered on the identity
 * provider's own page, never here.
 *
 * What is kept while the person is at the provider (the state, the PKCE verifier, the nonce and
 * where to return inside the dashboard) lives in `sessionStorage` and is removed the moment the
 * answer is read, so one answer completes one sign-in. Nothing secret is put in a URL.
 */
import {
  beginAuthorization,
  completeAuthorization,
  discoverOidc,
  endSessionUrl,
  refreshTokens,
  type OidcConfig,
  type OidcEndpoints,
  type OidcPlatform,
  type OidcTokens,
  type PendingAuthorization,
} from '@sportspark/api-client';
import type { StaffAuthConfig } from '../config/config';

export const PENDING_SIGN_IN_KEY = 'sportspark.staff.sign-in';
export const SIGN_IN_CALLBACK_PATH = '/sign-in/callback';

export interface ManagedSignIn {
  /** Sends the browser to the identity provider; `returnTo` is a path inside the dashboard. */
  start(returnTo: string): Promise<void>;
  /** Completes the sign-in from the address the provider returned the person to. */
  complete(callbackUrl: string): Promise<{ tokens: OidcTokens; returnTo: string }>;
  /** A new bearer token from the refresh token (`RefreshingSessionStore`). */
  renew(refreshToken: string): Promise<OidcTokens>;
  /**
   * Ends the provider's own session too, when the provider publishes a way to (a shared desk
   * device must not sign the next person in as the last one). Resolves false when it has none.
   */
  signOut(): Promise<boolean>;
}

export interface ManagedSignInEnvironment {
  platform: OidcPlatform;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** The site's origin, e.g. `https://staff.example.org`. */
  origin: string;
  /** Leaves the dashboard for another address. */
  leave(url: string): void;
}

/** A path inside this site only: never another origin, never a protocol-relative address. */
export function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) && !value.startsWith('/sign-in')
    ? value
    : '/today';
}

interface StoredPending extends PendingAuthorization {
  returnTo: string;
}

export function createManagedSignIn(
  auth: StaffAuthConfig,
  env: ManagedSignInEnvironment,
): ManagedSignIn {
  const config: OidcConfig = { ...auth, redirectUri: `${env.origin}${SIGN_IN_CALLBACK_PATH}` };
  let discovery: Promise<OidcEndpoints> | null = null;
  const endpoints = (): Promise<OidcEndpoints> => {
    // A failed discovery is not remembered: the next attempt asks the provider again.
    discovery ??= discoverOidc(config, env.platform).catch((error: unknown) => {
      discovery = null;
      throw error;
    });
    return discovery;
  };

  return {
    async start(returnTo) {
      const { url, pending } = await beginAuthorization(config, await endpoints(), env.platform);
      const stored: StoredPending = { ...pending, returnTo: safeReturnPath(returnTo) };
      env.storage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify(stored));
      env.leave(url);
    },
    async complete(callbackUrl) {
      const raw = env.storage.getItem(PENDING_SIGN_IN_KEY);
      env.storage.removeItem(PENDING_SIGN_IN_KEY);
      let pending: StoredPending | null;
      try {
        pending = raw ? (JSON.parse(raw) as StoredPending) : null;
      } catch {
        pending = null;
      }
      // No sign-in was started in this tab: an empty state can match nothing.
      const usable: PendingAuthorization =
        pending && typeof pending.state === 'string' && pending.state.length > 0
          ? pending
          : { state: '\u0000', codeVerifier: '', nonce: '', redirectUri: config.redirectUri };
      const tokens = await completeAuthorization(
        config,
        await endpoints(),
        env.platform,
        usable,
        callbackUrl,
      );
      return { tokens, returnTo: safeReturnPath(pending?.returnTo) };
    },
    async renew(refreshToken) {
      return refreshTokens(config, await endpoints(), env.platform, refreshToken);
    },
    async signOut() {
      let url: string | null;
      try {
        url = endSessionUrl(config, await endpoints(), `${env.origin}/sign-in`);
      } catch {
        url = null;
      }
      if (!url) return false;
      env.leave(url);
      return true;
    },
  };
}

/** The browser's network, randomness and hashing behind `OidcPlatform`. */
export function browserOidcPlatform(now: () => Date = () => new Date()): OidcPlatform {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (data) =>
      new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource)),
    now,
  };
}
