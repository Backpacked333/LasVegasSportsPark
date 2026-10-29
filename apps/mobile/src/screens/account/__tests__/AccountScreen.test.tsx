/**
 * SCR-C-30 Account (SPK-UX-002 "Account: Family, enrollments, payments, credits, forms,
 * preferences, support"; recovery required, §4.11), and the navigation into SCR-C-31, SCR-C-36,
 * SCR-C-17, SCR-C-01 and SCR-C-02.
 */
import { act, render, screen, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { createTestApp } from '../../../testing/test-app';
import { AccountScreen } from '../AccountScreen';
import { apiError, CHILD, me, namesRoute, ok, page, person } from './fixtures';

const CHECKOUT = '0192f1a0-0000-7000-8000-00000000f501';

function recoveryCheckout() {
  return {
    id: CHECKOUT,
    quoteId: '0192f1a0-0000-7000-8000-00000000f502',
    orderId: '0192f1a0-0000-7000-8000-00000000f503',
    basketId: '0192f1a0-0000-7000-8000-00000000f504',
    payerPersonId: '0192f1a0-0000-7000-8000-00000000a001',
    status: 'recovery_required',
    paymentKind: 'provider',
    payment: null,
    receipt: null,
    holdIds: [],
    enrollmentIds: [],
    operationId: '0192f1a0-0000-7000-8000-00000000f505',
    failure: null,
    recovery: null,
    nextAction: 'await_reconciliation',
    revision: 3,
    createdAt: '2026-10-24T11:00:00.000Z',
    updatedAt: '2026-10-24T11:30:00.000Z',
    completedAt: null,
  };
}

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
  it('SPK-UX-002: lists the hub sections in order; built ones open, forms say "Not available yet"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
        'GET /me/registration-checkouts': page([]),
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
    for (const title of [
      'Enrollments and participation',
      'Payments and obligations',
      'Credits and makeup sessions',
      'Support',
    ]) {
      expect(screen.getByRole('button', { name: title })).toHaveProp(
        'accessibilityHint',
        `Opens ${title}`,
      );
    }
    // Forms are signed within a registration (SCR-C-13): there is no list to open.
    expect(screen.getByLabelText('Forms and acknowledgments, Not available yet')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Forms and acknowledgments/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Invitations, Open invitations you received' }),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Account deletion and data requests is not available yet: it depends on DEC-059/,
      ),
    ).toBeOnTheScreen();
  });

  it('recovery required (§4.11): a registration whose payment was received but not completed is pinned first with "Do not pay again"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': page([recoveryCheckout()]),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`account-recovery-${CHECKOUT}`);
    expect(row.props.accessibilityLabel).toMatch(
      /^Do not pay again, Payment received\. Last update .*, Payment received\. We are completing your registration\.$/,
    );
    expect(row).toHaveProp('accessibilityHint', 'Opens the registration outcome');
    const read = app.fake.requests.find((r) => r.route === '/me/registration-checkouts');
    expect(read?.query).toEqual({ status: 'recovery_required', limit: '10' });
  });

  it('a failed recovery read shows its code and "Try again"; the hub stays usable', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': () =>
          apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Preferences' })).toBeOnTheScreen();
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
    expect(screen.queryByRole('button', { name: /^Invitations/ })).toBeNull();
    // Nothing to pin before the account is linked to a person.
    expect(app.fake.requests.some((r) => r.route === '/me/registration-checkouts')).toBe(false);
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
        'GET /person-names': namesRoute([person(CHILD, 'Sam', 'Morgan', 'child')]),
        'GET /me/communication-preferences': ok({ personId: CHILD, preferences: [] }),
        'GET /me/calendar-feeds': ok({ feeds: [] }),
        'GET /me/push-devices': ok({ devices: [] }),
        'GET /me/inbox': ok({ items: [], nextCursor: null }),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': page([]),
        'GET /me/households': ok({ items: [] }),
        'GET /me/invitations': page([]),
        'GET /me/team-invitations': page([]),
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

  it('opens Invitations from Account (SCR-C-17)', async () => {
    const { router } = renderApp();
    fireEvent.press(
      await routerScreen.findByRole('button', {
        name: 'Invitations, Open invitations you received',
      }),
    );
    expect(router.getPathname()).toBe('/invitations');
    expect(
      await routerScreen.findByRole('header', { name: 'No open invitations' }),
    ).toBeOnTheScreen();
  });

  it.each([
    [/^Account setup/, '/onboarding'],
    [/^Access after recovery/, '/recovery'],
    [/^Enrollments and participation/, '/enrollments'],
    [/^Payments and obligations/, '/payments'],
    [/^Credits and makeup sessions/, '/credits'],
    [/^Support/, '/support'],
  ])('opens %s from Account (%s)', async (name, path) => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name }));
    expect(router.getPathname()).toBe(path);
  });
});
