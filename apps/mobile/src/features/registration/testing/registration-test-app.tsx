/**
 * The foundation test app (real providers, fake API, fixed clock, manual connectivity) plus an
 * in-memory registration progress store, for the SCR-C-07 to SCR-C-16 screen tests. The API's
 * own lists (`/me/baskets`, `/me/registration-checkouts`, `/me/waitlist-entries`) answer empty
 * pages unless a test gives them.
 */
import { waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { createTestApp, TEST_SESSION, type TestAppOptions } from '../../../testing/test-app';
import {
  memoryProgressBackend,
  RegistrationProgressProvider,
  RegistrationProgressStore,
  type RegistrationProgress,
} from '../progress';

const EMPTY_PAGE = { status: 200, body: { items: [], nextCursor: null } };

/** The customer's own registration lists, empty unless a test gives them. */
export const EMPTY_LIST_ROUTES = {
  'GET /me/baskets': EMPTY_PAGE,
  'GET /me/registration-checkouts': EMPTY_PAGE,
  'GET /me/waitlist-entries': EMPTY_PAGE,
} as const;

export function createRegistrationTestApp(
  options: TestAppOptions & { progress?: Partial<RegistrationProgress> } = {},
) {
  const app = createTestApp({
    ...options,
    routes: { ...EMPTY_LIST_ROUTES, ...options.routes },
  });
  const backend = memoryProgressBackend(
    options.progress
      ? JSON.stringify({
          accountId: TEST_SESSION.accountId,
          pendingCheckoutQuoteId: null,
          ...options.progress,
        })
      : null,
  );
  const progressStore = new RegistrationProgressStore(backend);
  const AppWrapper = app.wrapper;
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <AppWrapper>
        <RegistrationProgressProvider store={progressStore}>
          {children}
        </RegistrationProgressProvider>
      </AppWrapper>
    );
  }
  /** Idempotency keys of the requests to one route, in order. */
  const keysOf = (method: string, route: string) =>
    app.fake.requests
      .filter((r) => r.method === method && r.route === route)
      .map((r) => r.headers['idempotency-key']);
  /** Waits until no query or command is in flight, so no update lands after the test. */
  const settle = () =>
    waitFor(() => expect(app.queryClient.isFetching() + app.queryClient.isMutating()).toBe(0));
  return { ...app, wrapper, progressStore, progressBackend: backend, keysOf, settle };
}

/** A mock of expo-router's `useRouter`, recording navigation for assertions. */
export function createRouterMock() {
  return { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
}
