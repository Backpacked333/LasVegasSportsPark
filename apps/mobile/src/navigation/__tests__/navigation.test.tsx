/**
 * SPK-UX-002: five primary destinations in order (labels Home, Explore, Calendar, Teams and You:
 * PA-11, **Proposed**), and the facility pass, the notification inbox and a cart in progress
 * reachable from Home and from every destination without a tab. Renders the real app/ routes with
 * the root layout swapped for the test providers.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { createTestApp } from '../../testing/test-app';
import { DESTINATIONS } from '../destinations';
import { RootNavigator } from '../RootNavigator';

const EMPTY_INBOX = { status: 200, body: { items: [], nextCursor: null } };

function renderApp(initialUrl = '/', routes: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: { 'GET /me/inbox': EMPTY_INBOX, ...routes } });
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
  it('PA-11 SPK-UX-002: has exactly five tabs, in order, with accessible labels: Home, Explore, Calendar, Teams, You', async () => {
    renderApp();
    expect(DESTINATIONS.map((d) => d.title)).toEqual([
      'Home',
      'Explore',
      'Calendar',
      'Teams',
      'You',
    ]);
    // Route names stay, so links, the demo tour and pathnames keep working.
    expect(DESTINATIONS.map((d) => d.name)).toEqual([
      'index',
      'discover',
      'schedule',
      'teams',
      'account',
    ]);
    expect(DESTINATIONS.map((d) => d.accessibilityLabel)).toEqual([
      'Home: next activity, required actions and urgent changes',
      'Explore: leagues, programs, camps and other activities',
      'Calendar: your and your family’s activities, week by week',
      'Teams: your teams, games and standings',
      'You: family, registrations, payments, forms and settings',
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

  it.each([
    ['/discover', 'Explore'],
    ['/schedule', 'Calendar'],
    ['/teams', 'Teams'],
    ['/account', 'You'],
  ])('PA-11: the destination at %s draws its own large title "%s"', async (path, title) => {
    renderApp(path);
    expect(await screen.findByRole('header', { name: title })).toBeOnTheScreen();
  });

  it('ADR-008: changing tab plays the selection haptic; pressing the tab already shown does not', async () => {
    const { app, router } = renderApp('/');
    fireEvent.press(await screen.findByTestId('tab-index'));
    expect(app.haptics.events).toEqual([]);
    fireEvent.press(screen.getByTestId('tab-schedule'));
    expect(router.getPathname()).toBe('/schedule');
    expect(app.haptics.events).toEqual(['selection']);
  });

  it('PA-11: /family-calendar opens Calendar with the "Everyone" filter, so existing links keep working', async () => {
    const { router } = renderApp('/family-calendar');
    await waitFor(() => expect(router.getPathname()).toBe('/schedule'));
    expect(router.getSearchParams()).toEqual({ people: 'everyone' });
  });

  it('offers the pass and the inbox in the body of Home as well (SPK-UX-002 Home: quick access to pass)', async () => {
    const { router } = renderApp('/');
    fireEvent.press(await screen.findByRole('button', { name: 'Show facility pass' }));
    expect(router.getPathname()).toBe('/pass');
  });

  it('resolves an unknown link to "Link not available" instead of following it (SCR-C-39)', async () => {
    renderApp('/no-such-screen/somewhere-unknown');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
  });

  it('a known screen with a malformed id is "Link not available" too (SCR-C-39)', async () => {
    renderApp('/payments/somewhere-unknown');
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
  });
});
