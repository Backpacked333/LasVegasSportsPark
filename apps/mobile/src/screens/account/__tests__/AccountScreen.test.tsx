/**
 * SCR-C-30 Account (SPK-UX-002 "Account: Family, enrollments, payments, credits, forms,
 * preferences, support"), and the navigation into SCR-C-31, SCR-C-36, SCR-C-01 and SCR-C-02.
 */
import { act, render, screen, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';
import { AccountScreen } from '../AccountScreen';
import { apiError, CHILD, me, ok, peopleRoute, person } from './fixtures';

const SECTION_TITLES = [
  'Family and permissions',
  'Enrollments and participation',
  'Payments and obligations',
  'Credits and makeup sessions',
  'Forms and acknowledgments',
  'Preferences',
  'Support',
];

describe('SCR-C-30 AccountScreen', () => {
  it('SPK-UX-002: lists the hub sections in order; built ones open, the others say "Not available yet"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Alex Morgan, Signed in, Linked')).toBeOnTheScreen();
    const ids = [
      'SCR-C-31',
      'SCR-C-32',
      'SCR-C-34',
      'SCR-C-35',
      'SCR-C-13',
      'SCR-C-36',
      'SCR-C-38',
    ];
    ids.forEach((id, index) => {
      const row = screen.getByTestId(`account-section-${id}`);
      expect(row.props.accessibilityLabel).toMatch(new RegExp(`^${SECTION_TITLES[index]}`));
    });
    const family = screen.getByRole('button', {
      name: 'Family and permissions, You may act for 1 person',
    });
    expect(family).toHaveProp('accessibilityHint', 'Opens Family and permissions');
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Payments and obligations, Not available yet')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Payments and obligations/ })).toBeNull();
    expect(
      screen.getByText(
        /Account deletion and data requests is not available yet: it depends on DEC-059/,
      ),
    ).toBeOnTheScreen();
  });

  it('empty (new account): asks to finish setting up and holds back sections that need a linked record', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({ person: null })) } });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText(
        'Your account, Signed in. Your account is not linked to a person yet., Setup not finished',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Finish setting up' })).toBeOnTheScreen();
    const family = screen.getByTestId('account-section-SCR-C-31');
    expect(within(family).getByText('Available after you finish setting up')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Family and permissions/ })).toBeNull();
  });

  it('offline: keeps the cached hub on screen with its age', async () => {
    const app = createTestApp({ routes: { 'GET /me': ok(me({})) } });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Updated just now')).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getAllByLabelText('You are offline').length).toBeGreaterThan(0);
    expect(screen.getByText('Showing information from just now.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Alex Morgan, Signed in, Linked')).toBeOnTheScreen();
  });

  it('shows an error loading the account with its code and "Try again"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});

describe('SCR-C-30 navigation into the account screens', () => {
  function renderApp(initialUrl = '/account') {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
        'GET /people/{id}': peopleRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
        'GET /me/communication-preferences': ok({ personId: CHILD, preferences: [] }),
        'GET /me/calendar-feeds': ok({ feeds: [] }),
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

  it('opens Family and permissions from Account', async () => {
    const { router } = renderApp();
    fireEvent.press(
      await routerScreen.findByRole('button', {
        name: 'Family and permissions, You may act for 1 person',
      }),
    );
    expect(router.getPathname()).toBe('/family');
    expect(await routerScreen.findByTestId('person-access-0')).toBeOnTheScreen();
  });

  it('opens Preferences from Account', async () => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name: 'Preferences' }));
    expect(router.getPathname()).toBe('/preferences');
    expect(
      await routerScreen.findByRole('header', { name: 'Essential notices' }),
    ).toBeOnTheScreen();
  });

  it.each([
    [/^Account setup/, '/onboarding'],
    [/^Access after recovery/, '/recovery'],
  ])('opens %s from Account (%s)', async (name, path) => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name }));
    expect(router.getPathname()).toBe(path);
  });
});
