/**
 * SCR-C-09 trial and pickup intents (SPK-REG-001, SPK-YOUTH-003, SPK-PLACE-004, SPK-COND-001;
 * DEC-016, DEC-074, DEC-082): one participant in one session with `POST /trial-participations` or
 * `POST /session-bookings`, only when nothing is owed (a free offering, or a package credit while
 * its switch is on); "Booked" only for what the API confirmed, a pending booking read as pending;
 * a priced single session is not started in the app; turned off, API errors and one key per intent.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  IDS,
  eligible,
  familyRoutes,
  inMinutes,
  offering,
  offeringSession,
  optionsHandler,
  packageEntitlement,
  page,
  sessionBooking,
  trialParticipation,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { mePermissions } from '../../../testing/test-app';
import { RegistrationIntentScreen } from '../RegistrationIntentScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const SESSION = offeringSession();
const PAST = offeringSession({
  id: '0192f1a0-0000-7000-8000-0000000000e9',
  sequence: 0,
  scheduledStart: '2026-10-20T17:00:00.000Z',
  scheduledEnd: '2026-10-20T18:00:00.000Z',
});
const PRICE = {
  priceRuleId: IDS.priceRule,
  basePriceMinor: 1500,
  currency: 'USD',
  chargeLines: [],
};
const SESSION_LABEL = 'Session 1. Sat, Oct 31, 10:00 AM PDT';

function intentOptions(intent: 'trial' | 'pickup') {
  return optionsHandler({
    availableIntents: [intent],
    participants: [IDS.parent, IDS.childA, IDS.childB].map((personId) => ({
      personId,
      intents: [{ intent, eligibility: eligible() }],
    })),
  });
}

function routes(
  kind: 'trial' | 'pickup',
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /offerings/{id}': {
      status: 200,
      body: offering({
        kind,
        name: kind === 'trial' ? 'Try soccer' : 'Friday pickup',
        price: null,
      }),
    },
    'GET /offerings/{id}/registration-options': intentOptions(kind),
    'GET /offerings/{id}/sessions': { status: 200, body: [PAST, SESSION] },
    ...overrides,
  };
}

function renderChooser(app: ReturnType<typeof createRegistrationTestApp>) {
  render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
}

const sent = (app: ReturnType<typeof createRegistrationTestApp>, route: string) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === route);

describe('SCR-C-09 trial and pickup intents', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-YOUTH-003: books a trial in an upcoming session with the follow-up consent, and reads the seat the API confirmed', async () => {
    const bookingId = '0192f1a0-0000-7000-8000-0000000000e2';
    const app = createRegistrationTestApp({
      routes: routes('trial', {
        'POST /trial-participations': {
          status: 201,
          body: trialParticipation({
            sessionId: SESSION.id,
            sessionBookingId: bookingId,
            followUpConsent: true,
          }),
        },
        'GET /session-bookings/{id}': {
          status: 200,
          body: sessionBooking({ id: bookingId, kind: 'trial' }),
        },
      }),
    });
    renderChooser(app);
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Trial/ })).toBeChecked());
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    // Only upcoming sessions, in the facility's zone (SPK-SCHED-008).
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    expect(screen.queryByRole('radio', { name: /Oct 20/ })).toBeNull();
    fireEvent.press(
      screen.getByRole('checkbox', {
        name: 'Staff may use what they learn in this trial to offer a place afterwards',
      }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the trial' }));
    });
    expect(await screen.findByLabelText('Trial booked')).toBeOnTheScreen();
    const [trial] = sent(app, '/trial-participations');
    expect(trial?.body).toEqual({
      offeringId: IDS.offering,
      participantPersonId: IDS.childA,
      sessionId: SESSION.id,
      followUpConsent: true,
    });
    expect(trial?.headers['idempotency-key']).toMatch(/^key-/);
    fireEvent.press(screen.getByRole('button', { name: 'See your registrations' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/enrollments');
  });

  it('SPK-PAY-007: a trial seat the API left pending reads "Booking pending" with its hold expiry, never booked', async () => {
    const bookingId = '0192f1a0-0000-7000-8000-0000000000e2';
    const app = createRegistrationTestApp({
      routes: routes('trial', {
        'POST /trial-participations': {
          status: 201,
          body: trialParticipation({ sessionId: SESSION.id, sessionBookingId: bookingId }),
        },
        'GET /session-bookings/{id}': {
          status: 200,
          body: sessionBooking({
            id: bookingId,
            kind: 'trial',
            status: 'pending',
            confirmedAt: null,
            expiresAt: inMinutes(15),
          }),
        },
      }),
    });
    renderChooser(app);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the trial' }));
    });
    expect(
      await screen.findByLabelText(
        'Booking pending: a payment is needed. The place is held until Sat, Oct 24, 5:15 AM PDT.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Trial booked')).toBeNull();
  });

  it('a priced trial session is not started in the app; a trial without a session is recorded for the front desk', async () => {
    const app = createRegistrationTestApp({
      routes: routes('trial', {
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'trial', name: 'Try soccer', price: PRICE }),
        },
        'POST /trial-participations': { status: 201, body: trialParticipation() },
      }),
    });
    renderChooser(app);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    expect(
      screen.getByText(/Paying for a trial session is not available in the app yet/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Book the trial' })).toBeDisabled();

    fireEvent.press(
      screen.getByRole('radio', {
        name: 'No session yet. The front desk arranges the time of the trial with you.',
      }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the trial' }));
    });
    expect(
      await screen.findByLabelText('Trial recorded. The front desk arranges the session.'),
    ).toBeOnTheScreen();
    expect(sent(app, '/trial-participations')[0]?.body).toEqual({
      offeringId: IDS.offering,
      participantPersonId: IDS.childA,
      followUpConsent: false,
    });
  });

  it('SPK-PLACE-004: books a free pickup session while its switch is on and reads "Session booked"', async () => {
    const app = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
        'POST /session-bookings': { status: 201, body: sessionBooking() },
      }),
    });
    renderChooser(app);
    const pickup = await screen.findByRole('radio', { name: /^Pickup session/ });
    await waitFor(() => expect(pickup).toBeChecked());
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    // The only way to pay is "No charge": it is used without asking.
    expect(screen.getByRole('radio', { name: 'No charge' })).toBeChecked();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the session' }));
    });
    expect(await screen.findByLabelText('Session booked')).toBeOnTheScreen();
    expect(sent(app, '/session-bookings')[0]?.body).toEqual({
      offeringId: IDS.offering,
      sessionId: SESSION.id,
      participantPersonId: IDS.childA,
    });
  });

  it('SPK-COND-001, DEC-074: a priced pickup session uses a package credit while session packages are on; a pending answer is never booked', async () => {
    const app = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'pickup', name: 'Friday pickup', price: PRICE }),
        },
        'GET /me/permissions': mePermissions({
          enabled: ['pickup_sessions', 'session_packages'],
        }),
        'GET /me/package-entitlements': page([
          packageEntitlement(),
          // Another participant's package, and one for other offerings: never offered here.
          packageEntitlement({
            id: '0192f1a0-0000-7000-8000-0000000000ea',
            participantPersonId: IDS.childB,
          }),
          packageEntitlement({
            id: '0192f1a0-0000-7000-8000-0000000000eb',
            appliesTo: { offeringIds: [IDS.offering2], programIds: [] },
          }),
        ]),
        'POST /session-bookings': {
          status: 201,
          body: sessionBooking({
            status: 'pending',
            confirmedAt: null,
            entitlementBasis: 'package',
            packageEntitlementId: '0192f1a0-0000-7000-8000-0000000000e4',
            expiresAt: inMinutes(15),
          }),
        },
      }),
    });
    renderChooser(app);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    const credit = await screen.findByRole('radio', {
      name: 'Use a credit from Ten pickup sessions. 7 of 10 left',
    });
    expect(credit).toBeChecked();
    expect(screen.queryByRole('radio', { name: 'No charge' })).toBeNull();
    expect(screen.getAllByRole('radio', { name: /^Use a credit/ })).toHaveLength(1);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the session' }));
    });
    expect(
      await screen.findByLabelText(
        /^Booking pending: a payment is needed\. The place is held until/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Session booked')).toBeNull();
    expect(sent(app, '/session-bookings')[0]?.body).toEqual({
      offeringId: IDS.offering,
      sessionId: SESSION.id,
      participantPersonId: IDS.childA,
      packageEntitlementId: '0192f1a0-0000-7000-8000-0000000000e4',
    });
    expect(app.fake.requests.find((r) => r.route === '/me/package-entitlements')?.query).toEqual({
      status: 'active',
      limit: '50',
    });
  });

  it('a priced pickup session without a credit is not started in the app (no customer payment command)', async () => {
    const app = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'pickup', name: 'Friday pickup', price: PRICE }),
        },
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
      }),
    });
    renderChooser(app);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    expect(
      screen.getByText(/Paying for a single session is not available in the app yet/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Book the session' })).toBeDisabled();
    // Packages are off: their list is not even read.
    expect(app.fake.requests.some((r) => r.route === '/me/package-entitlements')).toBe(false);
  });

  it('DEC-082: pickup sessions turned off are not offered; a booking refused with CAPABILITY_DISABLED reads turned off', async () => {
    const off = createRegistrationTestApp({ routes: routes('pickup') });
    const first = render(<RegistrationIntentScreen offeringId={IDS.offering} />, {
      wrapper: off.wrapper,
    });
    const pickup = await screen.findByRole('radio', {
      name: 'Pickup session. Book a place in one pickup session. Pickup sessions turned off (DEC-016, DEC-082).',
    });
    expect(pickup).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Book the session' })).toBeNull();
    first.unmount();

    const refused = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
        'POST /session-bookings': () =>
          fakeResponse(403, capabilityDisabledBody('pickup_sessions', ['DEC-016', 'DEC-082'])),
      }),
    });
    renderChooser(refused);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the session' }));
    });
    expect(await screen.findByLabelText('Pickup sessions turned off')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Session booked')).toBeNull();
  });

  it('SPK-UX-008: a full session shows the API code; retrying the same booking reuses its key', async () => {
    let calls = 0;
    const app = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
        'POST /session-bookings': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('Network request failed');
          return fakeResponse(
            409,
            apiErrorBody('CAPACITY_UNAVAILABLE', {
              message: 'This session is full.',
              nextAction: 'join_waitlist_or_choose_alternative',
            }),
          );
        },
      }),
    });
    renderChooser(app);
    fireEvent.press(await screen.findByRole('radio', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('radio', { name: SESSION_LABEL }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Book the session' }));
    });
    expect(await screen.findByText(/This may already have gone through/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByText(/Error code: CAPACITY_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByText('This session is full.')).toBeOnTheScreen();
    const keys = sent(app, '/session-bookings').map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('SPK-IAM-003: a person the account may only view is not available to book; the sessions read error shows its code', async () => {
    const app = createRegistrationTestApp({
      routes: routes('pickup', {
        'GET /me/permissions': mePermissions({ enabled: ['pickup_sessions'] }),
        'GET /offerings/{id}/sessions': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    renderChooser(app);
    const viewOnly = await screen.findByRole('radio', { name: /^Cy\. Not available/ });
    expect(viewOnly).toBeDisabled();
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Book the session' })).toBeDisabled();
  });
});
