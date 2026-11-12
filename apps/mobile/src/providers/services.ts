/**
 * Everything the app needs from the outside world, injected once at the root so tests replace it
 * with deterministic doubles (memory session store, manual connectivity, fake fetch, fixed clock).
 */
import {
  RefreshingSessionStore,
  type FetchLike,
  type KeyGenerator,
  type SessionStore,
} from '@sportspark/api-client';
import { randomUUID } from 'expo-crypto';
import { readAppConfig, type AppConfig } from '../config/app-config';
import {
  createManagedSignIn,
  deviceOidcPlatform,
  openDeviceAuthSession,
  type ManagedSignIn,
} from '../session/managed-sign-in';
import { SecureSessionStore } from '../session/secure-session-store';
import { consoleCrashReporter, type CrashReporter } from './crash-report';
import {
  expoNetworkSource,
  reactNativeAppStateSource,
  type AppStateSource,
  type ConnectivitySource,
} from '../connectivity/sources';

export interface AppServices {
  config: AppConfig;
  sessionStore: SessionStore;
  connectivity: ConnectivitySource;
  appState: AppStateSource;
  /** Defaults to the platform fetch. */
  fetch?: FetchLike;
  /** Secure random idempotency keys (React Native has no `crypto.randomUUID`). */
  generateKey: KeyGenerator;
  now: () => Date;
  /** Where unexpected failures are reported (console when absent). */
  crashReporter?: CrashReporter;
  /** Managed sign-in at the identity provider; absent when the build names no provider (DEC-018). */
  managedSignIn?: ManagedSignIn | null;
}

export function createDeviceServices(): AppServices {
  const config = readAppConfig();
  const now = () => new Date();
  const managedSignIn = config.auth
    ? createManagedSignIn(config.auth, {
        platform: deviceOidcPlatform(now),
        openAuthSession: openDeviceAuthSession,
      })
    : null;
  const stored = new SecureSessionStore();
  return {
    config,
    // §4.13: with managed sign-in the bearer token is renewed shortly before it expires.
    sessionStore: managedSignIn
      ? new RefreshingSessionStore(stored, (token) => managedSignIn.renew(token), now)
      : stored,
    connectivity: expoNetworkSource,
    appState: reactNativeAppStateSource,
    generateKey: randomUUID,
    now,
    crashReporter: consoleCrashReporter,
    managedSignIn,
  };
}
