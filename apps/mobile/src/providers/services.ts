/**
 * Everything the app needs from the outside world, injected once at the root so tests replace it
 * with deterministic doubles (memory session store, manual connectivity, fake fetch, fixed clock).
 */
import type { FetchLike, KeyGenerator, SessionStore } from '@sportspark/api-client';
import { randomUUID } from 'expo-crypto';
import { readAppConfig, type AppConfig } from '../config/app-config';
import { SecureSessionStore } from '../session/secure-session-store';
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
}

export function createDeviceServices(): AppServices {
  return {
    config: readAppConfig(),
    sessionStore: new SecureSessionStore(),
    connectivity: expoNetworkSource,
    appState: reactNativeAppStateSource,
    generateKey: randomUUID,
    now: () => new Date(),
  };
}
