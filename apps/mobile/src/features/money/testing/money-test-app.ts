/**
 * The foundation test app, tracked so each test can wait until no read or command is in flight
 * before the screen unmounts (`afterEach(settleApps)`): late answers then land inside `act`, and
 * no state update arrives after a test has finished.
 */
import { act, waitFor } from '@testing-library/react-native';
import { createTestApp, type TestAppOptions } from '../../../testing/test-app';

export type MoneyTestApp = ReturnType<typeof createTestApp>;

const created: MoneyTestApp[] = [];

export function createMoneyTestApp(options: TestAppOptions = {}): MoneyTestApp {
  const app = createTestApp(options);
  created.push(app);
  return app;
}

export async function settleApps(): Promise<void> {
  for (const app of created.splice(0)) {
    await waitFor(() =>
      expect(app.queryClient.isFetching() + app.queryClient.isMutating()).toBe(0),
    );
    // TanStack delivers observer updates on the next tick; let them land inside act.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
