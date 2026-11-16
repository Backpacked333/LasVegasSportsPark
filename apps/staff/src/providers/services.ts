/**
 * Everything the dashboard needs from the outside world, injected once at the root so tests use
 * deterministic doubles (memory session store, manual connectivity, fake fetch, fixed clock).
 */
import type { FetchLike, KeyGenerator, SessionStore } from '@sportspark/api-client';
import { defaultKeyGenerator } from '@sportspark/api-client';
import { readConfig, type StaffConfig } from '../config/config';
import { browserConnectivity, type ConnectivitySource } from '../connectivity/sources';
import { BrowserSessionStore } from '../session/browser-session-store';
import { consoleCrashReporter, type CrashReporter } from './crash-report';
import { browserPreferences, type PreferenceStore } from './preferences';

export interface StaffServices {
  config: StaffConfig;
  sessionStore: SessionStore;
  connectivity: ConnectivitySource;
  fetch?: FetchLike;
  generateKey: KeyGenerator;
  now: () => Date;
  /** Where unexpected client failures are reported (console when absent). */
  crashReporter?: CrashReporter;
  /** Display preferences of this browser (theme, sidebar); in memory when absent. */
  preferences?: PreferenceStore;
}

export function createBrowserServices(): StaffServices {
  return {
    config: readConfig(),
    sessionStore: new BrowserSessionStore(),
    connectivity: browserConnectivity,
    generateKey: defaultKeyGenerator,
    now: () => new Date(),
    crashReporter: consoleCrashReporter,
    preferences: browserPreferences(),
  };
}
