/**
 * Session packages (SCR-C-35 next to credits; Package G ENR-11, SPK-COND-002; DEC-016, DEC-074):
 * the account's packages with sessions left, expiry as the API states it in the facility's time
 * zone when the offering states it, and the redemption history with reversals; the turned-off
 * state that keeps existing packages listed; and the SPK-UX-008 states.
 */
import {
  apiErrorBody,
  fakePermissions,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { IDS, accountRoutes, inDays } from '../../../features/money/testing/fixtures';
import {
  LIST_IDS,
  packageEntitlement,
  packageOffering,
  pageOf,
} from '../../../features/money/testing/list-fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { formatInstantIn } from '../../../features/money/time-zone';
import { mePermissions } from '../../../testing/test-app';
import { MySessionPackagesScreen, PACKAGES_STILL_AVAILABLE } from '../MySessionPackagesScreen';

// The device zone is fixed so the fallback wording is deterministic on any machine.
jest.mock('../../../features/today/device-time-zone', () => ({ deviceTimeZone: () => 'UTC' }));

const ZONE = 'America/Los_Angeles';

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
    'GET /me/package-entitlements': pageOf([packageEntitlement()]),
    'GET /offerings/{id}': { status: 200, body: packageOffering(ZONE) },
    ...overrides,
  };
}

function renderPackages(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<MySessionPackagesScreen />, { wrapper: app.wrapper });
  return app;
}

describe('Session packages (SCR-C-35, Package G)', () => {
  afterEach(settleApps);

  it('ENR-11: a package shows sessions left, whose it is, expiry and purchase in the facility zone', async () => {
    renderPackages();
    const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
    expect(within(card).getByLabelText('7 sessions left')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Package: Open skate 10-pack')).toBeOnTheScreen();
    expect(await within(card).findByLabelText('For: Sam')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Sessions: 7 left, 3 used, of 10')).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText(`Expiry: Expires ${formatInstantIn(inDays(60), ZONE)}`),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(`Bought: ${formatInstantIn(inDays(-20), ZONE)}`),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Can be used for: 1 eligible activity or program'),
    ).toBeOnTheScreen();
    expect(within(card).queryByText(/device's time zone/)).toBeNull();
    expect(screen.getByRole('header', { name: 'Your session packages' })).toBeOnTheScreen();
  });

  it('SPK-COND-002: the redemption history lists bookings and reversals with their reason, newest first', async () => {
    renderPackages();
    const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
    // The facility zone has arrived (the offering read), so every date below is in it.
    await within(card).findByLabelText(`Expiry: Expires ${formatInstantIn(inDays(60), ZONE)}`);
    const history = within(card).getByLabelText('Redemption history');
    const lines = within(history).getAllByText(/^(Session booked|Booking reversed)/);
    expect(lines.map((line) => line.props.children)).toEqual([
      `Booking reversed, session returned on ${formatInstantIn(inDays(-5), ZONE)}: Session canceled by the facility`,
      `Session booked on ${formatInstantIn(inDays(-10), ZONE)}`,
    ]);
  });

  it('SPK-SCHED-008: without the facility zone, dates are in the device zone and say so', async () => {
    renderPackages({ 'GET /offerings/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) });
    const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
    expect(
      await within(card).findByText(
        "Dates are in this device's time zone (UTC): the facility's time zone is not available for this package.",
      ),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(`Expiry: Expires ${formatInstantIn(inDays(60), 'UTC')}`),
    ).toBeOnTheScreen();
  });

  it('POL-039: a package without an expiry says so and claims no rule; a revoked one names its reason', async () => {
    renderPackages({
      'GET /me/package-entitlements': pageOf([
        packageEntitlement({
          expiresAt: null,
          redemptions: [],
          redeemedCount: 0,
          remainingCredits: 10,
        }),
        packageEntitlement({
          id: LIST_IDS.packageB,
          status: 'revoked',
          revokedAt: inDays(-1),
          revokedReason: 'Bought twice by mistake',
          participantPersonId: IDS.self,
        }),
      ]),
    });
    const open = await screen.findByTestId(`package-${LIST_IDS.package}`);
    expect(within(open).getByLabelText('Expiry: No expiry set for this package')).toBeOnTheScreen();
    expect(within(open).getByText('Not used yet.')).toBeOnTheScreen();
    const revoked = screen.getByTestId(`package-${LIST_IDS.packageB}`);
    expect(within(revoked).getByLabelText('Revoked')).toBeOnTheScreen();
    expect(
      within(revoked).getByLabelText(/^Revoked: .*\. Bought twice by mistake$/),
    ).toBeOnTheScreen();
    expect(await within(revoked).findByLabelText('For: You')).toBeOnTheScreen();
  });

  it('DEC-016, DEC-074: turned off by default, naming the decisions, and packages already held stay listed', async () => {
    renderPackages({ 'GET /me/permissions': mePermissions() });
    const state = await screen.findByTestId('state-turned-off');
    expect(within(state).getByLabelText('Session packages turned off')).toBeOnTheScreen();
    expect(within(state).getByText(/\(DEC-016, DEC-074\)/)).toBeOnTheScreen();
    expect(within(state).getByText(PACKAGES_STILL_AVAILABLE)).toBeOnTheScreen();
    expect(await screen.findByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
  });

  it('turned on: no turned-off state', async () => {
    renderPackages();
    await screen.findByTestId(`package-${LIST_IDS.package}`);
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
  });

  it('shows the empty state when the account holds no package', async () => {
    renderPackages({ 'GET /me/package-entitlements': pageOf([]) });
    expect(await screen.findByRole('header', { name: 'No session packages' })).toBeOnTheScreen();
  });

  it('shows the API error code and reference with "Try again"', async () => {
    let calls = 0;
    renderPackages({
      'GET /me/package-entitlements': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-pkg' }))
          : fakeResponse(200, { items: [packageEntitlement()], nextCursor: null });
      },
    });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-pkg/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
  });

  it('§4.10: a refused read is "not available"', async () => {
    renderPackages({
      'GET /me/package-entitlements': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/Open skate/)).toBeNull();
  });

  it('packages already held stay listed while the permissions read fails (503), with its code and "Try again"', async () => {
    let calls = 0;
    renderPackages({
      'GET /me/permissions': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-perm' }))
          : fakeResponse(
              200,
              fakePermissions({ principalKind: 'customer', enabled: ['session_packages'] }),
            );
      },
    });
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-perm/),
    ).toBeOnTheScreen();
    // The API serves the packages whatever the switch says: they follow their own read.
    const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
    expect(within(card).getByLabelText('7 sessions left')).toBeOnTheScreen();
    // While the switch is unknown nothing new is offered.
    expect(
      within(card).queryByRole('button', { name: 'Book a session with this package' }),
    ).toBeNull();
    expect(calls).toBe(1);
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await within(card).findByRole('button', { name: 'Book a session with this package' }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/INTEGRATION_UNAVAILABLE/)).toBeNull();
    expect(screen.getByTestId(`package-${LIST_IDS.package}`)).toBe(card);
  });

  it('packages stay listed while the permissions read is still loading', async () => {
    let answer: (response: ReturnType<typeof fakeResponse>) => void = () => undefined;
    renderPackages({
      'GET /me/permissions': () =>
        new Promise<ReturnType<typeof fakeResponse>>((resolve) => {
          answer = resolve;
        }),
    });
    expect(await screen.findByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Loading whether session packages is turned on'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
    await act(async () => {
      answer(fakeResponse(200, fakePermissions({ principalKind: 'customer' })));
    });
    expect(await screen.findByTestId('state-turned-off')).toBeOnTheScreen();
    expect(screen.getByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
  });

  it('§4.5: more packages load with the API cursor', async () => {
    const app = renderPackages({
      'GET /me/package-entitlements': (req) =>
        fakeResponse(
          200,
          req.query.cursor === 'p2'
            ? { items: [packageEntitlement({ id: LIST_IDS.packageB })], nextCursor: null }
            : { items: [packageEntitlement()], nextCursor: 'p2' },
        ),
    });
    await screen.findByTestId(`package-${LIST_IDS.package}`);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Load more session packages' }));
    });
    expect(await screen.findByTestId(`package-${LIST_IDS.packageB}`)).toBeOnTheScreen();
    expect(
      app.fake.requests.filter((r) => r.route === '/me/package-entitlements').at(-1)?.query,
    ).toEqual({ limit: '20', cursor: 'p2' });
  });

  it('without a session it asks to sign in and reads nothing', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<MySessionPackagesScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/me/package-entitlements')).toHaveLength(0);
  });
});
