/**
 * The foundation test app (real providers, fake API, fixed clock, manual connectivity) with the
 * helpers the team screen tests share: idempotency keys per route, request bodies, settling until
 * nothing is in flight, and withholding an answer to produce an unknown outcome.
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

/**
 * Makes the next `times` requests of `method` to a URL matching `url` reach the fake API (recorded
 * like any other, so their idempotency keys can be compared) but never answer: the client gives up
 * at its timeout and the outcome is unknown (§4.9, SPK-UX-008), as when the network drops after
 * sending. Call it before rendering, with jest fake timers, and advance the client's timeout
 * (`DEFAULT_TIMEOUT_MS`) inside `act`.
 */
export function withholdAnswers(
  app: ReturnType<typeof createTeamsTestApp>,
  method: string,
  url: RegExp,
  times = 1,
) {
  const answer = app.services.fetch;
  if (!answer) throw new Error('The test app has no fake fetch.');
  let left = times;
  app.services.fetch = (input, init) => {
    if (left > 0 && (init.method ?? 'GET').toUpperCase() === method && url.test(input)) {
      left -= 1;
      void answer(input, init).catch(() => undefined);
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return answer(input, init);
  };
}

/** A mock of expo-router's `useRouter`, recording navigation for assertions. */
export function createRouterMock() {
  return { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
}
