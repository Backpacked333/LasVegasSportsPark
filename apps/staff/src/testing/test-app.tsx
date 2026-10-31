/**
 * Test harness for staff screens: real providers and routes with deterministic services (memory
 * session store, manual connectivity, fake fetch from @sportspark/api-client/testing, fixed clock).
 *
 *   const app = createTestApp({ routes: { 'GET /today': { status: 200, body: feed } } });
 *   render(app.at('/today'));
 *
 * Defaults: `GET /me` (a general manager in two facilities), `GET /me/permissions` (every area
 * visible, every capability off) and `GET /today` (no issues).
 */
import { MemorySessionStore, type Session } from '@sportspark/api-client';
import {
  createFakeFetch,
  fakePermissions,
  sequentialKeys,
  type FakeHandler,
  type FakePermissionsOptions,
} from '@sportspark/api-client/testing';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { AppRoutes } from '../App';
import type { StaffConfig } from '../config/config';
import { createManualConnectivity } from '../connectivity/sources';
import { AppProviders } from '../providers/AppProviders';
import type { StaffServices } from '../providers/services';

export const TEST_NOW = new Date('2026-10-24T12:00:00.000Z');
export const TEST_SESSION: Session = {
  token: 'staff-token',
  expiresAt: null,
  accountId: '0192f1a0-0000-7000-8000-0000000000cc',
};

export const FACILITY_A = '0192f1a0-0000-7000-8000-00000000fa01';
export const FACILITY_B = '0192f1a0-0000-7000-8000-00000000fa02';

export function staffMe(facilityIds: string[] = [FACILITY_A, FACILITY_B], kind = 'staff') {
  return {
    status: 200,
    body: {
      principal: {
        kind,
        organizationId: '0192f1a0-0000-7000-8000-0000000000aa',
        accountId: TEST_SESSION.accountId,
        personId: '0192f1a0-0000-7000-8000-0000000000dd',
        staffRoles: kind === 'staff' ? ['general_manager'] : [],
        facilityIds,
      },
      person: null,
      staffMemberships: [],
      authorities: [],
    },
  };
}

export function todayFeed(items: unknown[] = [], facilities = [FACILITY_A, FACILITY_B]) {
  return {
    status: 200,
    body: {
      generatedAt: TEST_NOW.toISOString(),
      facilities: facilities.map((id, i) => ({
        facilityId: id,
        name: `North Park ${i + 1}`,
        timezone: 'America/Los_Angeles',
        localDate: '2026-10-24',
        window: { start: TEST_NOW.toISOString(), end: TEST_NOW.toISOString() },
        activities: { total: 0, published: 0, canceled: 0, visible: true },
      })),
      items,
      sources: [],
    },
  };
}

/**
 * `GET /v1/me/permissions` (K-05, K-12): by default every navigation area is visible and every
 * capability switch is off, as the API starts (DEC-016). Override per test, e.g.
 * `routes: { 'GET /me/permissions': mePermissions({ enabled: ['rentals'] }) }`.
 */
export function mePermissions(options: FakePermissionsOptions = {}) {
  return { status: 200, body: fakePermissions(options) };
}

export interface TestAppOptions {
  routes?: Record<string, FakeHandler>;
  session?: Session | null;
  online?: boolean;
  config?: Partial<StaffConfig>;
  now?: () => Date;
}

export function createTestApp(options: TestAppOptions = {}) {
  const fake = createFakeFetch({
    'GET /me': staffMe(),
    'GET /me/permissions': mePermissions(),
    'GET /today': todayFeed(),
    ...options.routes,
  });
  onlineManager.setOnline(options.online !== false);
  const connectivity = createManualConnectivity(options.online !== false);
  const sessionStore = new MemorySessionStore(
    options.session === undefined ? TEST_SESSION : options.session,
  );
  const services: StaffServices = {
    config: {
      apiBaseUrl: '/v1',
      appVersion: '0.1.0',
      staleDataThresholdMs: null,
      ...options.config,
    },
    sessionStore,
    connectivity: connectivity.source,
    fetch: fake.fetch,
    generateKey: sequentialKeys(),
    now: options.now ?? (() => TEST_NOW),
  };
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
  /** The whole dashboard at a path. */
  function at(path: string) {
    return (
      <AppProviders services={services} queryClient={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>
    );
  }
  return { services, fake, connectivity, sessionStore, queryClient, wrapper, at };
}
