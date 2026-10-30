/**
 * SCR-C-30 Account: the conditional Package G sections (rentals and parties, memberships, session
 * packages, point-of-sale receipts; §3.16, DEC-016) are listed and open their screens, a switch the
 * API reports off is marked "Turned off" (glyph and text), and the five destinations stay five
 * (SPK-UX-002).
 */
import { render, screen, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { DESTINATIONS } from '../../../navigation/destinations';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { AccountScreen } from '../AccountScreen';
import { me, ok } from './fixtures';

const SECTIONS = [
  ['bookings', 'Rentals and parties', 'Your bookings'],
  ['memberships', 'Memberships', "Your and your family's memberships"],
  ['session-packages', 'Session packages', 'Credits left and redemptions'],
  ['pos-receipts', 'Point-of-sale receipts', 'Purchases at the facility desk'],
] as const;

describe('SCR-C-30 Account: Package G sections (DEC-016)', () => {
  it('lists the four sections and marks the ones the API reports turned off', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/permissions': mePermissions({ enabled: ['memberships', 'parties'] }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    const list = await screen.findByLabelText('Bookings, memberships and packages');
    // Rentals and parties: parties is on, so the section is not turned off.
    expect(
      await within(list).findByRole('button', {
        name: 'Session packages, Credits left and redemptions, Turned off',
      }),
    ).toBeOnTheScreen();
    expect(
      within(list).getByRole('button', { name: 'Rentals and parties, Your bookings' }),
    ).toHaveProp('accessibilityHint', 'Opens Rentals and parties');
    expect(
      within(list).getByRole('button', { name: "Memberships, Your and your family's memberships" }),
    ).toBeOnTheScreen();
    expect(
      within(list).getByRole('button', {
        name: 'Point-of-sale receipts, Purchases at the facility desk, Turned off',
      }),
    ).toBeOnTheScreen();
    for (const [key] of SECTIONS) {
      expect(screen.getByTestId(`account-conditional-${key}`)).toBeOnTheScreen();
    }
  });

  it('holds the sections back until setup is finished, and reads no switches meanwhile', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<AccountScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId('account-conditional-memberships');
    expect(within(row).getByText('Available after you finish setting up')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Memberships/ })).toBeNull();
    expect(app.fake.requests.filter((r) => r.route === '/me/permissions')).toHaveLength(0);
  });

  it('a failed switch read leaves the sections open without a status (the screens show the error)', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/permissions': { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } },
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', { name: 'Rentals and parties, Your bookings' }),
    ).toBeOnTheScreen();
  });
});

describe('Package G routes from Account (SPK-UX-002)', () => {
  function renderApp(initialUrl = '/account') {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/inbox': ok({ items: [], nextCursor: null }),
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
    ['Rentals and parties', '/bookings', 'screen-my-bookings'],
    ['Memberships', '/memberships', 'screen-my-memberships'],
    ['Session packages', '/session-packages', 'screen-my-session-packages'],
    ['Point-of-sale receipts', '/pos-receipts', 'screen-pos-receipts'],
  ])('opens %s at %s, turned off by default', async (title, path, testID) => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name: new RegExp(`^${title}, `) }));
    expect(router.getPathname()).toBe(path);
    expect(await routerScreen.findByTestId(testID)).toBeOnTheScreen();
    expect(await routerScreen.findByLabelText(`${title} turned off`)).toBeOnTheScreen();
    // Still five destinations; none of these is a tab.
    expect(DESTINATIONS).toHaveLength(5);
    expect(routerScreen.queryByTestId(`tab-${path.slice(1)}`)).toBeNull();
  });

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
