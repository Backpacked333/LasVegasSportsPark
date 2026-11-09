/**
 * Managed customer sign-in on the device (SPK-UX-001, §4.13, §4.14 verified identity; DEC-018):
 * the OpenID Connect authorization code flow with PKCE from `@sportspark/api-client`, shown in the
 * operating system's sign-in browser (expo-web-browser: ASWebAuthenticationSession on iOS, a
 * Custom Tab on Android). The password is entered on the identity provider's page, never in this
 * app, and the app never sees the provider's cookies.
 *
 * The state, the PKCE verifier and the nonce stay in memory for the one attempt they belong to.
 * The provider returns to `sportspark://sign-in`; the sign-in browser hands that address straight
 * back to this module, and the link filter (`links/link-targets.ts`) opens nothing from it but the
 * sign-in screen, without its query.
 *
 * Not verified on a device: fresh installation, backgrounding during sign-in, and the Android
 * return path are §6.2 native acceptance scenarios (native-acceptance-matrix.md).
 */
import {
  beginAuthorization,
  completeAuthorization,
  discoverOidc,
  refreshTokens,
  type OidcConfig,
  type OidcEndpoints,
  type OidcPlatform,
  type OidcTokens,
} from '@sportspark/api-client';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import type { AuthConfig } from '../config/app-config';

/** Where the identity provider returns the person. Must be registered at the provider. */
export const SIGN_IN_REDIRECT_URI = 'sportspark://sign-in';

export interface ManagedSignIn {
  /** Opens the sign-in browser. Resolves `null` when the person closed it without signing in. */
  signIn(): Promise<OidcTokens | null>;
  /** A new bearer token from the refresh token (`RefreshingSessionStore`). */
  renew(refreshToken: string): Promise<OidcTokens>;
}

export type AuthSessionResult = { type: 'success'; url: string } | { type: 'closed' };

export interface ManagedSignInEnvironment {
  platform: OidcPlatform;
  /** Shows `url` in the system sign-in browser until it reaches `redirectUri` or is closed. */
  openAuthSession(url: string, redirectUri: string): Promise<AuthSessionResult>;
}

export function createManagedSignIn(
  auth: AuthConfig,
  env: ManagedSignInEnvironment,
): ManagedSignIn {
  const config: OidcConfig = { ...auth, redirectUri: SIGN_IN_REDIRECT_URI };
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
    async signIn() {
      const found = await endpoints();
      const { url, pending } = await beginAuthorization(config, found, env.platform);
      const result = await env.openAuthSession(url, SIGN_IN_REDIRECT_URI);
      if (result.type !== 'success') return null;
      return completeAuthorization(config, found, env.platform, pending, result.url);
    },
    async renew(refreshToken) {
      return refreshTokens(config, await endpoints(), env.platform, refreshToken);
    },
  };
}

/** The device's network, secure randomness and hashing behind `OidcPlatform`. */
export function deviceOidcPlatform(now: () => Date = () => new Date()): OidcPlatform {
  return {
    fetch: (input, init) => fetch(input, init),
    randomBytes: (length) => Crypto.getRandomBytes(length),
    sha256: async (data) =>
      new Uint8Array(
        await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as BufferSource),
      ),
    now,
  };
}

/**
 * The system sign-in browser. `preferEphemeralSession` (iOS): the provider's cookies are not kept
 * after the browser closes, so signing out of the app is not undone by a remembered provider
 * session on a shared phone.
 */
export async function openDeviceAuthSession(
  url: string,
  redirectUri: string,
): Promise<AuthSessionResult> {
  const result = await WebBrowser.openAuthSessionAsync(url, redirectUri, {
    preferEphemeralSession: true,
  });
  return result.type === 'success' ? { type: 'success', url: result.url } : { type: 'closed' };
}
