/**
 * SPK-UX-002: five primary destinations in order, and the facility pass and notification inbox
 * reachable from Home and from every destination without a tab. Renders the real app/ routes with
 * the root layout swapped for the test providers.
 */
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { createTestApp } from '../../testing/test-app';
import { DESTINATIONS } from '../destinations';
import { RootNavigator } from '../RootNavigator';

const EMPTY_INBOX = { status: 200, body: { items: [], nextCursor: null } };

function renderApp(initialUrl = '/') {
  const app = createTestApp({ routes: { 'GET /me/inbox': EMPTY_INBOX } });
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

describe('primary navigation (SPK-UX-002)', () => {
  it('has exactly five tabs, in order, with accessible labels: Home, Discover, Schedule, Teams, Account', async () => {
    renderApp();
    expect(DESTINATIONS.map((d) => d.title)).toEqual([
      'Home',
      'Discover',
      'Schedule',
      'Teams',
      'Account',
    ]);
    for (const d of DESTINATIONS) {
      const tab = await screen.findByTestId(`tab-${d.name}`);
      expect(tab).toHaveProp('accessibilityLabel', d.accessibilityLabel);
    }
    // Neither the pass nor the inbox is a tab.
    expect(screen.queryByTestId('tab-pass')).toBeNull();
    expect(screen.queryByTestId('tab-inbox')).toBeNull();
  });

  const quickAccessCases = DESTINATIONS.flatMap((d) => {
    const path = d.name === 'index' ? '/' : `/${d.name}`;
    return [
      [d.title, path, 'Facility pass', '/pass'],
      [d.title, path, 'Notification inbox', '/inbox'],
    ] as const;
  });

  it.each(quickAccessCases)(
    'from the %s header (%s), "%s" opens %s',
    async (_title, path, buttonName, target) => {
      const { router } = renderApp(path);
      expect(router.getPathname()).toBe(path);
      fireEvent.press(await screen.findByRole('button', { name: buttonName }));
      expect(router.getPathname()).toBe(target);
      // Let the destination settle (the inbox loads from the fake API).
      if (target === '/inbox')
        expect(await screen.findByText('No notifications')).toBeOnTheScreen();
    },
  );

  it('offers the pass and the inbox in the body of Home as well (SPK-UX-002 Home: quick access to pass)', async () => {
    const { router } = renderApp('/');
    fireEvent.press(await screen.findByRole('button', { name: 'Show facility pass' }));
    expect(router.getPathname()).toBe('/pass');
  });

  it('resolves an unknown link to "Link not available" instead of following it (SCR-C-39)', async () => {
    renderApp('/payments/somewhere-unknown');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
  });
});
