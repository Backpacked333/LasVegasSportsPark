/**
 * Everything the dashboard needs from the outside world, injected once at the root so tests use
 * deterministic doubles (memory session store, manual connectivity, fake fetch, fixed clock).
 */
import type { FetchLike, KeyGenerator, SessionStore } from '@sportspark/api-client';
import { defaultKeyGenerator } from '@sportspark/api-client';
import { readConfig, type StaffConfig } from '../config/config';
import { browserConnectivity, type ConnectivitySource } from '../connectivity/sources';
import { BrowserSessionStore } from '../session/browser-session-store';

export interface StaffServices {
  config: StaffConfig;
  sessionStore: SessionStore;
  connectivity: ConnectivitySource;
  fetch?: FetchLike;
  generateKey: KeyGenerator;
  now: () => Date;
}

export function createBrowserServices(): StaffServices {
  return {
    config: readConfig(),
    sessionStore: new BrowserSessionStore(),
    connectivity: browserConnectivity,
    generateKey: defaultKeyGenerator,
    now: () => new Date(),
  };
}
