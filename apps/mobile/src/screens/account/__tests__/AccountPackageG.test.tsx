/**
 * SCR-C-30 You: the conditional Package G rows (rentals and parties, memberships, class packs,
 * in-person receipts; §3.16, DEC-016) show only while their capability switch is on (PA-11
 * SPK-UX-011, **Proposed**: no entry point to a capability that is turned off) and open their
 * screens; those screens stay behind their switches at their own links, and the five destinations
 * stay five (SPK-UX-002).
 */
import type { CapabilityId } from '@sportspark/api-client';
import { render, screen, waitFor, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { DESTINATIONS } from '../../../navigation/destinations';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { AccountScreen } from '../AccountScreen';
import { me, ok } from './fixtures';

const ROWS = [
  ['bookings', 'Rentals and parties', 'Your bookings'],
  ['memberships', 'Memberships', "Your and your family's memberships"],
  ['session-packages', 'Class packs', 'Classes left and classes used'],
  ['pos-receipts', 'In-person receipts', 'Purchases at the facility desk'],
] as const;

describe('SCR-C-30 You: Package G rows (DEC-016, PA-11 SPK-UX-011)', () => {
  it('lists only the rows whose switch the API reports on, in their groups', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/permissions': mePermissions({ enabled: ['memberships', 'parties'] }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    const bookings = await screen.findByLabelText('Bookings and plans');
    // Rentals and parties: parties is on, so the row is offered.
    expect(
      await within(bookings).findByRole('button', { name: 'Rentals and parties, Your bookings' }),
    ).toHaveProp('accessibilityHint', 'Opens Rentals and parties');
    expect(
      within(bookings).getByRole('button', {
        name: "Memberships, Your and your family's memberships",
      }),
    ).toBeOnTheScreen();
    // Session packages and point of sale are off: no entry point.
    expect(screen.queryByTestId('account-conditional-session-packages')).toBeNull();
    expect(screen.queryByTestId('account-conditional-pos-receipts')).toBeNull();
    expect(screen.queryByText(/Turned off/)).toBeNull();
  });

  it('puts In-person receipts under Money and Class packs under Bookings and plans when on', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/permissions': mePermissions({
          enabled: ['rentals', 'memberships', 'session_packages', 'point_of_sale'],
        }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    const money = await screen.findByLabelText('Money');
    expect(
      await within(money).findByRole('button', {
        name: 'In-person receipts, Purchases at the facility desk',
      }),
    ).toBeOnTheScreen();
    const bookings = screen.getByLabelText('Bookings and plans');
    for (const [key, title, detail] of ROWS.slice(0, 3)) {
      expect(within(bookings).getByTestId(`account-conditional-${key}`)).toHaveProp(
        'accessibilityLabel',
        `${title}, ${detail}`,
      );
    }
  });

  it('holds the rows back until setup is finished, and reads no switches meanwhile', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Finish setting up' })).toBeOnTheScreen();
    for (const [key] of ROWS) {
      expect(screen.queryByTestId(`account-conditional-${key}`)).toBeNull();
    }
    expect(app.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(0);
  });

  it('a failed switch read offers no Package G row (the switches are not known to be on)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/permissions': { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } },
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    await screen.findByLabelText('Bookings and plans');
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true),
    );
    for (const [key] of ROWS) {
      expect(screen.queryByTestId(`account-conditional-${key}`)).toBeNull();
    }
  });
});

describe('Package G routes from You (SPK-UX-002)', () => {
  function renderApp(initialUrl = '/account', enabled: CapabilityId[] = []) {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/inbox': ok({ items: [], nextCursor: null }),
        'GET /me/permissions': mePermissions({ enabled }),
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

  it.each([
    ['Rentals and parties', 'rentals', '/bookings', 'screen-my-bookings'],
    ['Memberships', 'memberships', '/memberships', 'screen-my-memberships'],
    ['Class packs', 'session_packages', '/session-packages', 'screen-my-session-packages'],
    ['In-person receipts', 'point_of_sale', '/pos-receipts', 'screen-pos-receipts'],
  ] as const)('opens %s (switch %s on) at %s', async (title, capability, path, testID) => {
    const { router } = renderApp('/account', [capability]);
    fireEvent.press(await routerScreen.findByRole('button', { name: new RegExp(`^${title}, `) }));
    expect(router.getPathname()).toBe(path);
    expect(await routerScreen.findByTestId(testID)).toBeOnTheScreen();
    // Still five destinations; none of these is a tab.
    expect(DESTINATIONS).toHaveLength(5);
    expect(routerScreen.queryByTestId(`tab-${path.slice(1)}`)).toBeNull();
  });

  it.each([
    ['/bookings', 'screen-my-bookings', 'Rentals and parties turned off'],
    ['/memberships', 'screen-my-memberships', 'Memberships turned off'],
    ['/session-packages', 'screen-my-session-packages', 'Class packs turned off'],
    ['/pos-receipts', 'screen-pos-receipts', 'In-person receipts turned off'],
  ])(
    '%s stays behind its switch at its own link, turned off by default',
    async (path, testID, label) => {
      const { router } = renderApp(path);
      expect(router.getPathname()).toBe(path);
      expect(await routerScreen.findByTestId(testID)).toBeOnTheScreen();
      expect(await routerScreen.findByLabelText(label)).toBeOnTheScreen();
    },
  );

  it('the booking flow route opens for an offering id, behind its switches', async () => {
    const { router } = renderApp('/bookings/new/0192f1a0-0000-7000-8000-00000000e001');
    expect(await routerScreen.findByTestId('screen-booking-flow')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/bookings/new/0192f1a0-0000-7000-8000-00000000e001');
    expect(
      await routerScreen.findByLabelText('Book a rental or party turned off'),
    ).toBeOnTheScreen();
  });

  it('the booking flow refuses a malformed offering id as "Link not available" (SCR-C-39)', async () => {
    const { app } = renderApp('/bookings/new/not-an-id');
    expect((await routerScreen.findAllByLabelText('Link not available')).length).toBeGreaterThan(0);
    expect(app.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(0);
  });
});
