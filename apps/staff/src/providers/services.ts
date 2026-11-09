/**
 * Everything the dashboard needs from the outside world, injected once at the root so tests use
 * deterministic doubles (memory session store, manual connectivity, fake fetch, fixed clock).
 */
import type { FetchLike, KeyGenerator, SessionStore } from '@sportspark/api-client';
import { RefreshingSessionStore, defaultKeyGenerator } from '@sportspark/api-client';
import { readConfig, type StaffConfig } from '../config/config';
import { browserConnectivity, type ConnectivitySource } from '../connectivity/sources';
import { BrowserSessionStore } from '../session/browser-session-store';
import {
  browserOidcPlatform,
  createManagedSignIn,
  type ManagedSignIn,
} from '../session/managed-sign-in';
import { consoleCrashReporter, type CrashReporter } from './crash-report';

export interface StaffServices {
  config: StaffConfig;
  sessionStore: SessionStore;
  connectivity: ConnectivitySource;
  fetch?: FetchLike;
  generateKey: KeyGenerator;
  now: () => Date;
  /** Where unexpected client failures are reported (console when absent). */
  crashReporter?: CrashReporter;
  /** Managed sign-in at the identity provider; absent when the build names no provider (DEC-018). */
  managedSignIn?: ManagedSignIn | null;
}

export function createBrowserServices(): StaffServices {
  const config = readConfig();
  const now = () => new Date();
  const managedSignIn = config.auth
    ? createManagedSignIn(config.auth, {
        platform: browserOidcPlatform(now),
        storage: window.sessionStorage,
        origin: window.location.origin,
        leave: (url) => window.location.assign(url),
      })
    : null;
  const stored = new BrowserSessionStore();
  return {
    config,
    // §4.13: with managed sign-in the bearer token is renewed shortly before it expires.
    sessionStore: managedSignIn
      ? new RefreshingSessionStore(stored, (token) => managedSignIn.renew(token), now)
      : stored,
    connectivity: browserConnectivity,
    generateKey: defaultKeyGenerator,
    now,
    crashReporter: consoleCrashReporter,
    managedSignIn,
  };
}
