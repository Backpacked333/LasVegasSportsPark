/**
 * The foundation test app (real providers, fake API, fixed clock, manual connectivity) with the
 * helpers the team screen tests share: idempotency keys per route, request bodies, and settling
 * until nothing is in flight.
 */
import { waitFor } from '@testing-library/react-native';
import { createTestApp, type TestAppOptions } from '../../../testing/test-app';

export function createTeamsTestApp(options: TestAppOptions = {}) {
  const app = createTestApp(options);
  const requestsTo = (method: string, route: string) =>
    app.fake.requests.filter((r) => r.method === method && r.route === route);
  /** Idempotency keys of the requests to one route, in order. */
  const keysOf = (method: string, route: string) =>
    requestsTo(method, route).map((r) => r.headers['idempotency-key']);
  /** Bodies of the requests to one route, in order. */
  const bodiesOf = (method: string, route: string) => requestsTo(method, route).map((r) => r.body);
  /** Waits until no query or command is in flight, so no update lands after the test. */
  const settle = () =>
    waitFor(() => expect(app.queryClient.isFetching() + app.queryClient.isMutating()).toBe(0));
  return { ...app, requestsTo, keysOf, bodiesOf, settle };
}

/** A mock of expo-router's `useRouter`, recording navigation for assertions. */
export function createRouterMock() {
  return { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
}
