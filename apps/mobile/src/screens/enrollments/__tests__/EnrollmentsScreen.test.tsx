/**
 * SCR-C-32 Enrollments and participation (SPK-REG-003, SPK-REG-010, SPK-YOUTH-003, SPK-UX-004,
 * SPK-UX-008, SPK-UX-009): each participant's enrollments as independent records with their own
 * states, current and history, the person chosen in the screen (never in the route), and every
 * SPK-UX-008 state the list defines.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  enrollment,
  offering,
  page,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { EnrollmentsScreen } from '../EnrollmentsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const CURRENT = enrollment();
const AWAITING = enrollment({
  id: IDS.enrollmentB,
  placementRequestId: IDS.placement,
  offeringId: IDS.offeringB,
});
const TRANSFERRED = enrollment({
  id: IDS.enrollmentC,
  offeringId: IDS.offeringClosed,
  status: 'transferred',
  transferredToEnrollmentId: IDS.enrollment,
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /enrollments': page([CURRENT, AWAITING, TRANSFERRED]),
    'GET /offerings/{id}': (req: { params: Record<string, string> }) => {
      if (req.params.id === IDS.offering) return fakeResponse(200, offering());
      if (req.params.id === IDS.offeringB)
        return fakeResponse(200, offering({ id: IDS.offeringB, name: 'Spring U10 League' }));
      // Closed and archived offerings are not readable by customers (protected NOT_FOUND).
      return fakeResponse(404, apiErrorBody('NOT_FOUND'));
    },
    'GET /placement-requests/{id}': {
      status: 200,
      body: { id: IDS.placement, status: 'unassigned' },
    },
    ...overrides,
  };
}

describe('SCR-C-32 EnrollmentsScreen', () => {
  afterEach(settleApps);

  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-UX-008: a family member whose name read failed (offline, 5xx) stays in the picker, with the code shown', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /people/{id}': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    const group = await screen.findByLabelText('Show enrollments for');
    expect(await within(group).findByRole('radio', { name: 'Family member' })).toBeOnTheScreen();
    expect(screen.getByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
  });

  it('SPK-REG-003: lists current enrollments and history as separate records with their own states', async () => {
    const app = createTestApp({ routes: routes() });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Current' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'History' })).toBeOnTheScreen();
    expect(await screen.findByLabelText('Confirmed')).toBeOnTheScreen();
    // SPK-UX-004: awaiting placement never reads as plain "Confirmed".
    expect(
      await screen.findByLabelText('Confirmed in Spring U10 League. Awaiting placement.'),
    ).toBeOnTheScreen();
    // A transfer names where the participation moved; the closed season is not readable.
    expect(await screen.findByLabelText('Transferred to Autumn U10 League')).toBeOnTheScreen();
    expect(screen.getByText('Activity no longer listed')).toBeOnTheScreen();
  });

  it('asks for the first participant by id in the query and lets the customer switch people (radio group)', async () => {
    const app = createTestApp({ routes: routes() });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });

    // The group is a container (not one accessibility element), so the radios stay focusable.
    const group = await screen.findByLabelText('Show enrollments for');
    expect(group).toHaveProp('accessibilityRole', 'radiogroup');
    const you = within(group).getByRole('radio', { name: 'You' });
    const sam = await within(group).findByRole('radio', { name: 'Sam' });
    expect(you).toBeChecked();
    expect(app.fake.requests.find((r) => r.route === '/enrollments')?.query).toEqual({
      participantPersonId: IDS.self,
      limit: '50',
    });

    fireEvent.press(sam);
    expect(sam).toBeChecked();
    await screen.findByRole('header', { name: 'Current' });
    const last = app.fake.requests.filter((r) => r.route === '/enrollments').at(-1);
    expect(last?.query.participantPersonId).toBe(IDS.child);
  });

  it('SPK-UX-009: each row is a button whose label reads activity, kind, dates and status', async () => {
    const app = createTestApp({ routes: routes() });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByRole('button', {
      name: 'Autumn U10 League, Youth program. Sep 5, 2026 to Nov 28, 2026, Confirmed',
    });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${IDS.enrollment}`);
  });

  it('SPK-YOUTH-003: a trial is labelled as a trial, distinct from a paid enrollment', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /enrollments': page([enrollment({ intent: 'trial' })]) }),
    });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Trial \(not a paid enrollment\)/)).toBeOnTheScreen();
  });

  it('shows the empty state with the way to find activities', async () => {
    const app = createTestApp({ routes: routes({ 'GET /enrollments': page([]) }) });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No enrollments yet' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open Discover' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/discover');
  });

  it('shows the API error code, reference and recovery action', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              message: 'Enrollment records are currently unavailable.',
              nextAction: 'retry_later',
              correlationId: 'corr-32',
            }),
          ),
      }),
    });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText('Enrollment records are currently unavailable.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-32/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.10: a person the API does not let this account see reads "Not available", nothing more', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /enrollments': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) }),
    });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('§4.15: keeps the loaded list offline, says how old it is and what needs a connection', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Confirmed')).toBeOnTheScreen();

    now = new Date('2026-10-24T12:05:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByText('Showing information from 5 minutes ago.')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Needs a connection: canceling a registration, transferring a registration.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Confirmed')).toBeOnTheScreen();
  });

  it('says so when nobody is linked yet, and sends no enrollment request', async () => {
    const app = createTestApp({
      routes: { ...routes(), ...accountRoutes({ child: false, person: false }) },
    });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Nobody to show yet' })).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/enrollments')).toBe(false);
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTestApp({ session: null, routes: routes() });
    render(<EnrollmentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
