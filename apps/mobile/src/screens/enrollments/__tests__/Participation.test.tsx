/**
 * SCR-C-32 Enrollments and participation, the stage-3 reads (SPK-REG-001, SPK-REG-003,
 * SPK-YOUTH-003, SPK-UX-004, SPK-UX-008; ENR-01, ENR-02, FIN-01): the offering an enrollment
 * carries (also a closed season), "Registration pending: <reason>", "Confirmed: <team>", a pending
 * enrollment whose checkout needs recovery, and the person's applications, trial participations
 * and session bookings as records with their own states, each section with its own error state.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
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
import {
  PIDS,
  application,
  enrollmentOffering,
  sessionBooking,
  trial,
} from './participation-fixtures';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const EMPTY = page([]);

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /enrollments': page([]),
    'GET /offerings/{id}': (req: { params: Record<string, string> }) =>
      req.params.id === IDS.offeringB
        ? fakeResponse(
            200,
            offering({
              id: IDS.offeringB,
              name: 'Spring U10 League',
              facility: { id: IDS.facility, name: 'North fields', timezone: 'America/Los_Angeles' },
            }),
          )
        : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    'GET /me/applications': EMPTY,
    'GET /me/trial-participations': EMPTY,
    'GET /me/registration-checkouts': EMPTY,
    'GET /session-bookings': { status: 200, body: [] },
    ...overrides,
  };
}

/** Renders the screen and switches to the child (the second person in the picker). */
async function renderForChild(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<EnrollmentsScreen />, { wrapper: app.wrapper });
  const group = await screen.findByLabelText('Show enrollments for');
  fireEvent.press(await within(group).findByRole('radio', { name: 'Sam' }));
  return app;
}

describe('SCR-C-32 participation records (stage-3 reads)', () => {
  afterEach(settleApps);

  beforeEach(() => mockRouter.push.mockClear());

  it('ENR-02: a closed season is named from the enrollment itself, with its dates, without a public read', async () => {
    const app = await renderForChild({
      'GET /enrollments': page([
        enrollment({
          offeringId: IDS.offeringClosed,
          status: 'completed',
          offering: enrollmentOffering(),
          pendingReason: null,
        }),
      ]),
    });
    expect(
      await screen.findByRole('button', {
        name: 'Spring U10 League 2026, Youth program. Mar 7, 2026 to May 30, 2026, Completed',
      }),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Activity no longer listed')).toBeNull();
    expect(
      app.fake.requests.some(
        (r) => r.route === '/offerings/{id}' && r.params.id === IDS.offeringClosed,
      ),
    ).toBe(false);
  });

  it('SPK-UX-004: a pending enrollment names what it waits for ("Registration pending: <reason>")', async () => {
    await renderForChild({
      'GET /enrollments': page([
        enrollment({ status: 'pending', pendingReason: 'approval', confirmedAt: null }),
        enrollment({
          id: IDS.enrollmentB,
          status: 'pending',
          pendingReason: 'forms',
          confirmedAt: null,
        }),
      ]),
    });
    expect(
      await screen.findByLabelText('Registration pending: awaiting approval'),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Registration pending: a required form is not signed'),
    ).toBeOnTheScreen();
  });

  it('SPK-PLACE-003: a placed enrollment reads "Confirmed: <team>" with the team the API names', async () => {
    await renderForChild({
      'GET /enrollments': page([enrollment({ placementRequestId: IDS.placement })]),
      'GET /placement-requests/{id}': {
        status: 200,
        body: { id: IDS.placement, status: 'assigned', assignedTeamName: 'Blue Comets' },
      },
    });
    expect(await screen.findByLabelText('Confirmed: Blue Comets')).toBeOnTheScreen();
  });

  it('§4.11: a pending enrollment whose checkout the API lists as recovery_required is labelled so', async () => {
    await renderForChild({
      'GET /enrollments': page([
        enrollment({ status: 'pending', pendingReason: 'payment', basketId: PIDS.basket }),
      ]),
      'GET /me/registration-checkouts': page([
        {
          id: PIDS.checkout,
          basketId: PIDS.basket,
          status: 'recovery_required',
          enrollmentIds: [],
        },
      ]),
    });
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Registration pending: payment not finished')).toBeNull();
  });

  it('SPK-REG-001: the person’s applications keep their own state; another person’s are not shown', async () => {
    await renderForChild({
      'GET /me/applications': page([
        application(),
        application({
          id: '0192f1a0-0000-7000-8000-00000000a102',
          status: 'declined',
          decisionReason: 'The team is full for this age.',
        }),
        application({ id: '0192f1a0-0000-7000-8000-00000000a103', participantPersonId: IDS.self }),
      ]),
    });
    const section = await screen.findByTestId('applications');
    expect(
      await within(section).findByLabelText('Spring U10 League, Youth program, Awaiting approval'),
    ).toBeOnTheScreen();
    expect(
      within(section).getByLabelText(
        'Spring U10 League, Youth program, Not approved: The team is full for this age.',
      ),
    ).toBeOnTheScreen();
    expect(within(section).getAllByLabelText(/^Spring U10 League, /)).toHaveLength(2);
  });

  it('SPK-YOUTH-003: trials are listed as trials, never as enrollments, in the facility time zone', async () => {
    await renderForChild({
      'GET /me/trial-participations': page([
        trial(),
        trial({
          id: '0192f1a0-0000-7000-8000-00000000a202',
          status: 'converted',
          convertedEnrollmentId: IDS.enrollmentB,
        }),
      ]),
    });
    const section = await screen.findByTestId('trials');
    // 01:00 UTC on Nov 3 is 5:00 PM on Nov 2 in Los Angeles (PST), the offering's facility zone.
    expect(
      await within(section).findByLabelText(
        'Spring U10 League, Trial on Mon, Nov 2, 5:00 PM PST. A trial is not an enrollment., Trial booked',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(within(section).getByRole('button', { name: /Registered after the trial$/ }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${IDS.enrollmentB}`);
  });

  it('session bookings (pickup, trial, makeup) are their own records and open their session', async () => {
    const app = await renderForChild({
      'GET /session-bookings': { status: 200, body: [sessionBooking({ kind: 'makeup' })] },
    });
    const row = await screen.findByRole('button', {
      name: 'Spring U10 League, Makeup session. Mon, Nov 2, 5:00 PM PST, Booked',
    });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/sessions/${IDS.session}?bookingId=${PIDS.booking}`,
    );
    expect(app.fake.requests.filter((r) => r.route === '/session-bookings').at(-1)?.query).toEqual({
      participantPersonId: IDS.child,
    });
  });

  it('SPK-UX-008: a section that cannot be read shows its own code and retry; one the API does not show is absent', async () => {
    await renderForChild({
      'GET /me/applications': () =>
        fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      'GET /me/trial-participations': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
    });
    const section = await screen.findByTestId('applications');
    expect(
      await within(section).findByText(/Error code: INTEGRATION_UNAVAILABLE/),
    ).toBeOnTheScreen();
    expect(within(section).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByTestId('trials')).toBeNull();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('household lists page with the API cursor until the person’s records appear ("Load more applications")', async () => {
    const app = await renderForChild({
      'GET /me/applications': (req) =>
        req.query.cursor
          ? fakeResponse(200, { items: [application()], nextCursor: null })
          : fakeResponse(200, {
              items: [
                application({
                  id: '0192f1a0-0000-7000-8000-00000000a109',
                  participantPersonId: IDS.self,
                }),
              ],
              nextCursor: 'c-2',
            }),
    });
    const section = await screen.findByTestId('applications');
    expect(within(section).getByText('None among those loaded so far.')).toBeOnTheScreen();
    fireEvent.press(within(section).getByRole('button', { name: 'Load more applications' }));
    expect(
      await screen.findByLabelText('Spring U10 League, Youth program, Awaiting approval'),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/me/applications').at(-1)?.query).toEqual(
        { limit: '50', cursor: 'c-2' },
      ),
    );
  });
});
