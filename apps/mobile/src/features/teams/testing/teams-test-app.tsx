/**
 * The foundation test app (real providers, fake API, fixed clock, manual connectivity) with the
 * helpers the team screen tests share: idempotency keys per route, request bodies, settling until
 * nothing is in flight, and withholding or dropping an answer to produce an unknown outcome: a
 * timeout (`withholdAnswers`) or a connection lost after sending (`dropAnswers`).
 */
import { act, waitFor } from '@testing-library/react-native';
import { createTestApp, type TestAppOptions } from '../../../testing/test-app';

/** A lost connection after the request was sent (`kind: 'network'`), see testing/test-app. */
export { dropAnswers } from '../../../testing/test-app';

export function createTeamsTestApp(options: TestAppOptions = {}) {
  const app = createTestApp(options);
  const requestsTo = (method: string, route: string) =>
    app.fake.requests.filter((r) => r.method === method && r.route === route);
  /** Idempotency keys of the requests to one route, in order. */
  const keysOf = (method: string, route: string) =>
    requestsTo(method, route).map((r) => r.headers['idempotency-key']);
  /** Bodies of the requests to one route, in order. */
  const bodiesOf = (method: string, route: string) => requestsTo(method, route).map((r) => r.body);
  // Every change of a query's or a command's state (a fetch started, an answer stored, ...).
  let stateChanges = 0;
  const count = (event: { type: string }) => {
    if (event.type === 'updated') stateChanges += 1;
  };
  app.queryClient.getQueryCache().subscribe(count);
  app.queryClient.getMutationCache().subscribe(count);
  const idle = () => app.queryClient.isFetching() + app.queryClient.isMutating() === 0;
  /**
   * Waits until no query or command is in flight and the screen shows it, so no update lands
   * after the test and what the test presses next is in the state the cache is in.
   *
   * An idle cache is not yet an idle screen. TanStack Query stores an answer at once but hands it
   * to the components watching the query in a timer task of its own (`notifyManager`, a zero
   * timeout), and only then does React render it. Until that task has run the cache says "nothing
   * in flight" while the screen still shows the read as running: a button that is busy during the
   * read is still disabled, and a press on it does nothing. So after the cache is idle this lets
   * the pending timer tasks run and React render (inside `act`), and repeats until a whole pass
   * went by without any query or command changing state: a render may itself start a read.
   */
  const settle = async () => {
    for (;;) {
      await waitFor(() => expect(idle()).toBe(true));
      const seen = stateChanges;
      await act(async () => {
        await pendingTimerTasks();
      });
      if (idle() && stateChanges === seen) return;
    }
  };
  return { ...app, requestsTo, keysOf, bodiesOf, settle };
}

/**
 * Resolves after the timer tasks that are due now have run: with real timers a zero timeout set
 * after them (timers of one delay run in the order they were set); with Jest's fake timers, which
 * a real timeout would never leave, the due timers are run without moving the clock.
 */
function pendingTimerTasks(): Promise<void> {
  const fake =
    (setTimeout as { _isMockFunction?: boolean })._isMockFunction === true ||
    Object.prototype.hasOwnProperty.call(setTimeout, 'clock');
  if (fake) {
    jest.advanceTimersByTime(0);
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
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
