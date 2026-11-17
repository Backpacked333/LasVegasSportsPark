/**
 * PA-11 SPK-UX-002 (**Proposed**): a registration in progress (an open cart) is reachable from
 * every destination until it is checked out or abandoned: the header's Cart button shows only
 * while `GET /v1/me/baskets` lists a basket in progress, and opens that basket.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { basket, IDS, line } from '../../features/registration/testing/fixtures';
import { me, ok } from '../../screens/account/__tests__/fixtures';
import { createTestApp } from '../../testing/test-app';
import { DESTINATIONS } from '../destinations';
import { RootNavigator } from '../RootNavigator';

function renderApp(initialUrl: string, baskets: FakeHandler) {
  const app = createTestApp({
    routes: {
      'GET /me': ok(me({})),
      'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
      'GET /me/baskets': baskets,
    },
  });
  const TestRootLayout = () => (
    <app.wrapper>
      <RootNavigator />
    </app.wrapper>
  );
  const router = renderRouter(
    { appDir: 'app', overrides: { _layout: TestRootLayout } },
    { initialUrl },
  );
  return { app, router };
}

const page = (items: unknown[]) => ({ status: 200, body: { items, nextCursor: null } });

describe('Cart in the header (PA-11 SPK-UX-002)', () => {
  it.each(DESTINATIONS.map((d) => [d.title, d.name === 'index' ? '/' : `/${d.name}`] as const))(
    'from the %s header (%s), "Cart" opens the cart in progress',
    async (_title, path) => {
      const { router } = renderApp(path, page([basket({ lines: [line()] })]));
      const cart = await screen.findByTestId('header-cart');
      expect(cart).toHaveProp('accessibilityLabel', 'Cart');
      fireEvent.press(cart);
      expect(router.getPathname()).toBe(`/registration/basket/${IDS.basket}`);
    },
  );

  it('opens the newest basket still in progress (here held), not a fulfilled one', async () => {
    const held = '0192f1a0-0000-7000-8000-0000000000c1';
    const { router } = renderApp(
      '/',
      page([
        basket({ id: '0192f1a0-0000-7000-8000-0000000000c0', status: 'fulfilled' }),
        basket({ id: held, status: 'held', lines: [line({ basketId: held })] }),
      ]),
    );
    fireEvent.press(await screen.findByRole('button', { name: 'Cart' }));
    expect(router.getPathname()).toBe(`/registration/basket/${held}`);
  });

  it.each([
    ['no basket', page([])],
    ['an empty open basket', page([basket({ lines: [] })])],
    ['only a fulfilled basket', page([basket({ status: 'fulfilled', lines: [line()] })])],
    ['an abandoned basket', page([basket({ status: 'abandoned', lines: [line()] })])],
    [
      'a list that could not be read',
      { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } },
    ],
  ])('shows no Cart button with %s', async (_case, baskets) => {
    const { app } = renderApp('/discover', baskets);
    await screen.findByRole('button', { name: 'Facility pass' });
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/baskets')).toBe(true),
    );
    expect(screen.queryByRole('button', { name: 'Cart' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Notification inbox' })).toBeOnTheScreen();
  });
});
