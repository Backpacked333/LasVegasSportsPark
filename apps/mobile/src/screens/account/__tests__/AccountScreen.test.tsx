/**
 * SCR-C-30 You (SPK-UX-002 as amended by PA-11, **Proposed**: "You: family, registrations,
 * payments, credits, forms, preferences, support, grouped by topic"; recovery required, §4.11),
 * and the navigation into SCR-C-31, SCR-C-36, SCR-C-17, SCR-C-01 and SCR-C-02.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react-native';
import { fireEvent, renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import { basket, IDS, line } from '../../../features/registration/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { AccountScreen } from '../AccountScreen';
import { apiError, CHILD, me, namesRoute, ok, page, person } from './fixtures';
import { openSupportDetails } from '../../../testing/ui-surfaces';

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

/** The hub's groups and their rows, in order (Package G rows only with their switch on). */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Family', ['Family and permissions', 'Invitations']],
  ['Bookings and plans', ['Waitlists']],
  ['Money', ['Credits and makeups']],
  ['Settings', ['Notifications and calendar', 'Account setup', 'Access after recovery']],
  ['Help', ['Support']],
];

const SECTION_TITLES = GROUPS.flatMap(([, rows]) => rows).filter((t) => t !== 'Legends mode');

/** The names of the rows (buttons and switches) inside a group's list, in order. */
function rowNames(group: string): string[] {
  const list = screen.getByLabelText(group);
  return within(list)
    .queryAllByRole(/^(button|switch)$/)
    .map((el) => String(el.props.accessibilityLabel).split(', ')[0] ?? '');
}

describe('SCR-C-30 AccountScreen', () => {
  it('PA-11 SPK-UX-002: groups the hub rows by topic, in order, and every one opens its screen', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({ authorities: [{ subjectPersonId: CHILD, permissions: ['view'] }] })),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': page([]),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('you-hub')).toBeOnTheScreen();
    // The groups are headers, in order, and each lists its rows in order.
    // Handoff M 2f first (the account holder's name heads the family card), then "More".
    expect(screen.getAllByRole('header').map((h) => String(h.props.children))).toEqual([
      'Alex Morgan',
      ...GROUPS.map(([group]) => group),
    ]);
    for (const [group, rows] of GROUPS) expect(rowNames(group)).toEqual(rows);
    const family = screen.getByRole('button', {
      name: 'Family and permissions, You may act for 1 person',
    });
    expect(family).toHaveProp('accessibilityHint', 'Opens Family and permissions');
    for (const title of [
      'Waitlists',
      'Credits and makeups',
      'Notifications and calendar',
      'Support',
    ]) {
      expect(screen.getByRole('button', { name: title })).toHaveProp(
        'accessibilityHint',
        `Opens ${title}`,
      );
    }
    expect(screen.queryByLabelText(/Not available yet/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Invitations, Open invitations you received' }),
    ).toBeOnTheScreen();
    // Account deletion and data requests (DEC-059) are not offered, and not shown.
    expect(screen.queryByLabelText(/Account deletion/)).toBeNull();
    expect(screen.queryByText(/DEC-059/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeOnTheScreen();
  });

  it('SPK-IAM-005: the Family row counts a person whose every grant is paused, as Family lists them, never "No family members yet"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': page([
          {
            grantId: 'grant-view-paused',
            relationshipId: '0192f1a0-0000-7000-8000-00000000d100',
            relationshipKind: 'guardian',
            actorPersonId: '0192f1a0-0000-7000-8000-00000000a001',
            actorDisplayName: 'Alex Morgan',
            subjectPersonId: CHILD,
            subjectDisplayName: 'Sam Morgan',
            permission: 'view',
            source: 'claim',
            effectiveFrom: '2026-09-01T10:00:00.000Z',
            effectiveTo: null,
            revokedAt: null,
            status: 'suspended',
            underReview: true,
            revision: 2,
          },
        ]),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'Family and permissions, 1 person with permissions under review, paused or starting later',
      }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('No family members yet')).toBeNull();
    const read = app.fake.requests.find((r) => r.route === '/me/access-grants');
    expect(read?.query).toEqual({ direction: 'held', limit: '100' });
  });

  it('the Family row says "No family members yet" only once the grants read confirms it, and stays neutral when that read fails', async () => {
    const empty = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': page([]),
      },
    });
    const first = render(<AccountScreen />, { wrapper: empty.wrapper });
    expect(
      await screen.findByRole('button', { name: 'Family and permissions, No family members yet' }),
    ).toBeOnTheScreen();
    first.unmount();

    const failing = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': () =>
          apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
      },
    });
    render(<AccountScreen />, { wrapper: failing.wrapper });
    await waitFor(() =>
      expect(failing.fake.requests.some((r) => r.route === '/me/access-grants')).toBe(true),
    );
    expect(
      await screen.findByRole('button', {
        name: 'Family and permissions, People you manage and their permissions',
      }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('No family members yet')).toBeNull();
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
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Notifications and calendar' })).toBeOnTheScreen();
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
    expect(screen.getByTestId('you-hub')).toBeOnTheScreen();
  });

  it('Legends mode (SPK-UX-009): the switch sits under Settings, signed in, and turns the hub dark at once', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': ok(me({})),
        'GET /me/registration-checkouts': page([]),
        'GET /me/access-grants': page([]),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    await screen.findByTestId('you-hub');
    // Once, in Settings, described as the app's appearance.
    expect(screen.getAllByRole('switch', { name: 'Legends mode' })).toHaveLength(1);
    const toggle = screen.getByRole('switch', { name: 'Legends mode' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveProp(
      'accessibilityHint',
      'Appearance: night green with floodlight accents',
    );
    fireEvent.press(toggle);
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    expect(app.themeStore.read()).toBe('legends');
    // The hub is still there, with the same names.
    for (const title of SECTION_TITLES) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}`) })).toBeOnTheScreen();
    }
  });

  it('Legends mode is offered signed out too: it is a preference of the device, not of the account', async () => {
    const app = createTestApp({ session: null });
    render(<AccountScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Appearance' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('shows an error loading the account with its code and "Try again"', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': () =>
          apiError(500, 'INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
      },
    });
    render(<AccountScreen />, { wrapper: app.wrapper });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    // The display preference stays on offer while the account cannot be read.
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeOnTheScreen();
  });
});

describe('SCR-C-30 navigation into the account screens', () => {
  function renderApp(initialUrl = '/account', extra: Record<string, FakeHandler> = {}) {
    const app = createTestApp({
      routes: {
        ...extra,
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
        'GET /acknowledgments': ok([]),
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

  it('opens Notifications and calendar (SCR-C-36 Preferences) from You', async () => {
    const { router } = renderApp();
    fireEvent.press(
      await routerScreen.findByRole('button', { name: 'Notifications and calendar' }),
    );
    expect(router.getPathname()).toBe('/preferences');
    expect(
      await routerScreen.findByRole('header', { name: 'Essential notices' }),
    ).toBeOnTheScreen();
  });

  it('PA-11 SPK-UX-002: shows Cart under "Bookings and plans" only while a registration is in progress, and opens it', async () => {
    const done = renderApp('/account', {
      'GET /me/baskets': page([basket({ status: 'fulfilled', lines: [line()] })]),
    });
    await routerScreen.findByTestId('you-hub');
    await waitFor(() =>
      expect(done.app.fake.requests.some((r) => r.route === '/me/baskets')).toBe(true),
    );
    expect(routerScreen.queryByTestId('account-cart')).toBeNull();
    done.router.unmount();

    const { router } = renderApp('/account', {
      'GET /me/baskets': page([basket({ lines: [line()] })]),
    });
    const cart = await routerScreen.findByRole('button', {
      name: 'Cart, The registration you started',
    });
    expect(rowNames('Bookings and plans')).toEqual(['Waitlists', 'Cart']);
    fireEvent.press(cart);
    expect(router.getPathname()).toBe(`/registration/basket/${IDS.basket}`);
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

  it('opens Forms and waivers from You (SCR-C-13 signed forms)', async () => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name: 'Forms' }));
    expect(router.getPathname()).toBe('/forms');
    expect((await routerScreen.findAllByRole('header', { name: 'No forms signed' })).length).toBe(
      2,
    );
  });

  it.each([
    ['Account setup, Your participant record and verified email or phone', '/onboarding'],
    [
      'Access after recovery, What this account may access, and what recovery restores',
      '/recovery',
    ],
    [/^Registrations/, '/enrollments'],
    ['Waitlists', '/registration/waitlists'],
    ['Payments & receipts', '/payments'],
    ['Credits and makeups', '/credits'],
    ['Support', '/support'],
  ])('opens "%s" from You (%s)', async (name, path) => {
    const { router } = renderApp();
    fireEvent.press(await routerScreen.findByRole('button', { name }));
    expect(router.getPathname()).toBe(path);
  });
});
