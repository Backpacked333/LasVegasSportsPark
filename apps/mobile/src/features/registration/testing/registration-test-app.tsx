/**
 * The foundation test app (real providers, fake API, fixed clock, manual connectivity) plus an
 * in-memory registration progress store, for the SCR-C-07 to SCR-C-16 screen tests.
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

export function createRegistrationTestApp(
  options: TestAppOptions & { progress?: Partial<RegistrationProgress> } = {},
) {
  const app = createTestApp(options);
  const backend = memoryProgressBackend(
    options.progress
      ? JSON.stringify({
          accountId: TEST_SESSION.accountId,
          basketId: null,
          quoteId: null,
          checkoutId: null,
          waitlistEntryIds: [],
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
