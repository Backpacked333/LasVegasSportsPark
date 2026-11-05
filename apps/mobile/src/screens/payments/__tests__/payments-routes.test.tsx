/**
 * Route wiring of the stage-4 money screens (SPK-UX-001 native navigation, §4.14 opaque ids):
 * a payment attempt and an order under /payments (SCR-C-34), the player's contributions at
 * /team/contributions (SCR-C-25) and session packages at /session-packages (SCR-C-35), each
 * through the real router; a malformed id is "Link not available" and sends no request.
 */
import { renderRouter, screen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import {
  IDS,
  accountRoutes,
  installmentPlan,
  obligation,
  order,
  page,
} from '../../../features/money/testing/fixtures';
import {
  contributionRequest,
  packageEntitlement,
  pageOf,
  paymentDetail,
} from '../../../features/money/testing/list-fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';

function renderAt(initialUrl: string) {
  const app = createTestApp({
    routes: {
      ...accountRoutes({ child: false }),
      'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
      'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
      'GET /payments/{id}': { status: 200, body: paymentDetail() },
      'GET /orders/{id}': { status: 200, body: order() },
      'GET /obligations/{id}': { status: 200, body: obligation() },
      'GET /installment-plans/{id}': { status: 200, body: installmentPlan() },
      'GET /me/payments': page([]),
      'GET /me/contribution-requests': pageOf([contributionRequest()]),
      'GET /me/package-entitlements': pageOf([packageEntitlement()]),
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

describe('stage-4 money routes (SCR-C-25, SCR-C-34, SCR-C-35)', () => {
  it('opens a payment attempt by its opaque id', async () => {
    const { router } = renderAt(`/payments/attempt/${IDS.attempt}`);
    expect(await screen.findByLabelText('Payment received')).toBeOnTheScreen();
    expect(router.getPathname()).toBe(`/payments/attempt/${IDS.attempt}`);
  });

  it('opens an order by its opaque id', async () => {
    renderAt(`/payments/order/${IDS.order}`);
    expect(await screen.findByLabelText('Order total: $120.00')).toBeOnTheScreen();
  });

  it.each([
    ['/payments/attempt/not-an-id', '/payments/{id}'],
    ['/payments/order/not-an-id', '/orders/{id}'],
  ])('SCR-C-39: %s is "Link not available" and sends no request', async (url, route) => {
    const { app } = renderAt(url);
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === route)).toHaveLength(0);
  });

  it('/team/contributions opens the player list, not a team workspace', async () => {
    const { router, app } = renderAt('/team/contributions');
    expect(
      await screen.findByRole('header', { name: 'Team contributions asked of you' }),
    ).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/team/contributions');
    expect(app.fake.requests.filter((r) => r.route === '/team-entries/{id}')).toHaveLength(0);
  });

  it('/session-packages opens the packages list', async () => {
    renderAt('/session-packages');
    expect(await screen.findByRole('header', { name: 'Your session packages' })).toBeOnTheScreen();
    expect(await screen.findByLabelText('Package: Open skate 10-pack')).toBeOnTheScreen();
  });
});
