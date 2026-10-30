/**
 * Book a session with a session package credit (SCR-C-35 next to credits; Package G ENR-11,
 * SPK-COND-002, §3.16 "reservation, redemption", §4.9, SPK-SCHED-008, SPK-UX-008; DEC-016,
 * DEC-074): offered only on a redeemable package while `session_packages` is on; eligible
 * activities and upcoming sessions in the facility zone; `POST /session-bookings` with
 * `packageEntitlementId` and one idempotency key per intent; the last session taken by someone
 * else, an ineligible session, the switch turned off meanwhile, and no answer.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  inDays,
  offering,
  offeringSession,
  sessionBooking,
} from '../../../features/money/testing/fixtures';
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
import { MySessionPackagesScreen } from '../MySessionPackagesScreen';

jest.mock('../../../features/today/device-time-zone', () => ({ deviceTimeZone: () => 'UTC' }));

const ZONE = 'America/Los_Angeles';
const FACILITY = { id: IDS.facility, name: 'North Rink', timezone: ZONE };
const UPCOMING = offeringSession(IDS.session, 2);
const PAST = offeringSession(IDS.sessionPast, -2, { title: 'Week 1' });
const BOOKED = sessionBooking({
  kind: 'session',
  makeupEntitlementId: null,
  participantPersonId: IDS.child,
  scheduledStart: UPCOMING.scheduledStart,
  scheduledEnd: UPCOMING.scheduledEnd,
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
    'GET /me/package-entitlements': pageOf([packageEntitlement()]),
    'GET /offerings/{id}': (req) =>
      fakeResponse(
        200,
        req.params.id === IDS.offering
          ? offering({ name: 'Open skate', facility: FACILITY })
          : packageOffering(ZONE),
      ),
    'GET /offerings/{id}/sessions': { status: 200, body: [PAST, UPCOMING] },
    'POST /session-bookings': { status: 201, body: BOOKED },
    ...overrides,
  };
}

function renderPackages(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<MySessionPackagesScreen />, { wrapper: app.wrapper });
  return app;
}

const bookings = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/session-bookings');

async function chooseSession() {
  const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
  fireEvent.press(within(card).getByRole('button', { name: 'Book a session with this package' }));
  fireEvent.press(await screen.findByRole('radio', { name: /^Open skate/ }));
  fireEvent.press(await screen.findByRole('radio', { name: /^Week 4/ }));
}

async function book() {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Book with this package' }));
  });
}

describe('Book a session with a package (SCR-C-35, ENR-11)', () => {
  afterEach(settleApps);

  it('ENR-11: books an upcoming eligible session with one package credit, times in the facility zone', async () => {
    const app = renderPackages();
    await chooseSession();
    // Only upcoming scheduled sessions are offered, in the facility's zone (SPK-SCHED-008).
    expect(screen.queryByRole('radio', { name: /^Week 1/ })).toBeNull();
    expect(
      screen.getByRole('radio', {
        name: new RegExp(`^Week 4.*${formatInstantIn(UPCOMING.scheduledStart, ZONE)}`),
      }),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Session')).toHaveProp('accessibilityRole', 'radiogroup');
    await book();
    expect(await screen.findByTestId('package-booking-status')).toHaveProp(
      'accessibilityLabel',
      'Booked',
    );
    expect(
      screen.getByLabelText(
        `Session: ${formatInstantIn(UPCOMING.scheduledStart, ZONE)} to ${formatInstantIn(UPCOMING.scheduledEnd, ZONE)}`,
      ),
    ).toBeOnTheScreen();
    const sent = bookings(app);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      offeringId: IDS.offering,
      sessionId: IDS.session,
      participantPersonId: IDS.child,
      packageEntitlementId: LIST_IDS.package,
    });
    expect(sent[0]?.headers['idempotency-key']).toMatch(/^key-/);
    // The package is read again so its sessions left follow the API.
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/me/package-entitlements').length,
      ).toBeGreaterThan(1),
    );
  });

  it('DEC-016, DEC-074: no booking is offered while the switch is off; the package stays listed', async () => {
    renderPackages({ 'GET /me/permissions': mePermissions() });
    const card = await screen.findByTestId(`package-${LIST_IDS.package}`);
    await screen.findByTestId('state-turned-off');
    expect(
      within(card).queryByRole('button', { name: 'Book a session with this package' }),
    ).toBeNull();
  });

  it('a package with no session left, or past its expiry, offers no booking', async () => {
    renderPackages({
      'GET /me/package-entitlements': pageOf([
        packageEntitlement({ status: 'exhausted', remainingCredits: 0, redeemedCount: 10 }),
        packageEntitlement({ id: LIST_IDS.packageB, expiresAt: inDays(-1) }),
      ]),
    });
    await screen.findByTestId(`package-${LIST_IDS.package}`);
    await screen.findByTestId(`package-${LIST_IDS.packageB}`);
    expect(screen.queryByRole('button', { name: 'Book a session with this package' })).toBeNull();
  });

  it('SPK-COND-002: the last session taken at the same time reads "Not available: no sessions left"', async () => {
    renderPackages({
      'POST /session-bookings': () =>
        fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', {
            message: 'This package has no credit left.',
            details: { code: 'PACKAGE_CREDITS_EXHAUSTED', remainingCredits: 0 },
          }),
        ),
    });
    await chooseSession();
    await book();
    expect(await screen.findByTestId('package-booking-refused')).toHaveProp(
      'accessibilityLabel',
      'Not available: no sessions left on this package',
    );
    expect(screen.getByRole('button', { name: 'Book with this package' })).toBeDisabled();
  });

  it('ELIGIBILITY_FAILED: a session the package does not cover shows the API reasons and code', async () => {
    renderPackages({
      'POST /session-bookings': () =>
        fakeResponse(
          422,
          apiErrorBody('ELIGIBILITY_FAILED', {
            message: 'This session is not covered by the package.',
            details: {
              reasons: [
                {
                  code: 'package_not_applicable',
                  severity: 'blocking',
                  message: 'The package applies only to the offerings and programs it names.',
                },
              ],
            },
          }),
        ),
    });
    await chooseSession();
    await book();
    const refused = await screen.findByTestId('package-booking-ineligible');
    expect(
      within(refused).getByText('The package applies only to the offerings and programs it names.'),
    ).toBeOnTheScreen();
    expect(within(refused).getByText('Error code: ELIGIBILITY_FAILED')).toBeOnTheScreen();
  });

  it('DEC-016: a booking refused with CAPABILITY_DISABLED shows the turned-off state, not "not available"', async () => {
    renderPackages({
      'POST /session-bookings': () =>
        fakeResponse(403, capabilityDisabledBody('session_packages', ['DEC-016', 'DEC-074'])),
    });
    await chooseSession();
    await book();
    expect(await screen.findByLabelText('Session packages turned off')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Not available')).toBeNull();
  });

  it('§4.10: a booking the API refuses for this account reads "Not available"', async () => {
    renderPackages({
      'POST /session-bookings': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
    });
    await chooseSession();
    await book();
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('§4.9: no answer keeps the intent; "Check again" re-sends under the same key', async () => {
    let calls = 0;
    const app = renderPackages({
      'POST /session-bookings': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('Network request failed');
        return fakeResponse(201, BOOKED);
      },
    });
    await chooseSession();
    await book();
    expect(await screen.findByTestId('command-no-answer')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByTestId('package-booking-status')).toHaveProp(
      'accessibilityLabel',
      'Booked',
    );
    const keys = bookings(app).map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('§4.15: offline, booking is disabled and says it needs a connection', async () => {
    const app = renderPackages();
    await chooseSession();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Book with this package' })).toBeDisabled();
    expect(screen.getByText('Needs a connection.')).toBeOnTheScreen();
    expect(bookings(app)).toHaveLength(0);
  });

  it('"Not now" closes the form without booking', async () => {
    const app = renderPackages();
    await chooseSession();
    fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(
      await screen.findByRole('button', { name: 'Book a session with this package' }),
    ).toBeOnTheScreen();
    expect(bookings(app)).toHaveLength(0);
  });
});
