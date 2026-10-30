/**
 * Test harness for screens and components: real providers with deterministic services (memory
 * session store, manual connectivity, fake fetch from @sportspark/api-client/testing, fixed clock).
 *
 *   const app = createTestApp({ routes: { 'GET /me/inbox': { status: 200, body: page } } });
 *   render(<InboxScreen />, { wrapper: app.wrapper });
 */
import type { Session } from '@sportspark/api-client';
import { MemorySessionStore } from '@sportspark/api-client';
import {
  createFakeFetch,
  fakePermissions,
  sequentialKeys,
  type FakeHandler,
  type FakePermissionsOptions,
} from '@sportspark/api-client/testing';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AppConfig } from '../config/app-config';
import { createManualSources, type Reachability } from '../connectivity/sources';
import { AppProviders } from '../providers/AppProviders';
import type { AppServices } from '../providers/services';

export const TEST_NOW = new Date('2026-10-24T12:00:00.000Z');
export const TEST_SESSION: Session = {
  token: 'test-token',
  expiresAt: null,
  accountId: '0192f1a0-0000-7000-8000-0000000000aa',
};

/**
 * `GET /v1/me/permissions` for a customer (K-05, K-12): no staff areas, no outright actions, and
 * every capability switch off, as the API starts (DEC-016). Override per test, e.g.
 * `routes: { 'GET /me/permissions': mePermissions({ enabled: ['memberships'] }) }`.
 */
export function mePermissions(options: FakePermissionsOptions = {}) {
  return {
    status: 200,
    body: fakePermissions({ principalKind: 'customer', areas: [], ...options }),
  };
}

export interface TestAppOptions {
  routes?: Record<string, FakeHandler>;
  /** `null` for a signed-out app. */
  session?: Session | null;
  reachable?: Reachability;
  config?: Partial<AppConfig>;
  now?: () => Date;
}

export function createTestApp(options: TestAppOptions = {}) {
  // A default for the permissions read (only screens that need it read it).
  const fake = createFakeFetch({ 'GET /me/permissions': mePermissions(), ...options.routes });
  // TanStack's managers are process-wide: start every test from the state it asks for.
  onlineManager.setOnline(options.reachable !== false);
  focusManager.setFocused(undefined);
  const sources = createManualSources(options.reachable ?? true);
  const sessionStore = new MemorySessionStore(
    options.session === undefined ? TEST_SESSION : options.session,
  );
  const services: AppServices = {
    config: {
      apiBaseUrl: 'http://api.test/v1',
      appVersion: '0.1.0',
      platform: 'ios',
      staleDataThresholdMs: null,
      ...options.config,
    },
    sessionStore,
    connectivity: sources.connectivity,
    appState: sources.appState,
    fetch: fake.fetch,
    generateKey: sequentialKeys(),
    now: options.now ?? (() => TEST_NOW),
  };
  // No retries and no cache time in tests: each assertion sees the API's first answer.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <AppProviders services={services} queryClient={queryClient}>
        {children}
      </AppProviders>
    );
  }
  return { services, fake, sources, sessionStore, queryClient, wrapper };
}
