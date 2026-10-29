/**
 * My rentals and parties (Package G; SPK-COND-003, ENR-13, DEC-016, DEC-076, DEC-077,
 * SPK-UX-008): the caller's bookings from `GET /v1/me/bookings` in cursor pages, each with its
 * facility-local time and status (a paid booking waiting for staff is not "Confirmed"), still
 * readable while the switches are off; errors with their code, "not available", empty.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createRouterMock } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { booking, G, ok, page, switchesOn } from '../../../features/package-g/__tests__/fixtures';
import { MyBookingsScreen } from '../MyBookingsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const PARTY = booking({
  id: G.bookingB,
  kind: 'party',
  offeringId: G.party,
  offeringName: 'Birthday party',
  status: 'awaiting_staff',
  outstanding: ['staffing'],
  firstStart: '2026-10-31T20:00:00.000Z',
  lastEnd: '2026-10-31T22:00:00.000Z',
  occurrences: [
    {
      start: '2026-10-31T20:00:00.000Z',
      end: '2026-10-31T22:00:00.000Z',
      eventId: G.event,
      resources: [{ id: G.room, name: 'Party room' }],
    },
  ],
  guestCount: 12,
});

const HELD_ROW =
  'Court rental, Rental. Sat, Oct 24, 10:00 AM to 11:00 AM PDT, Held for you: pay to confirm';
const PARTY_ROW =
  'Birthday party, Party. Sat, Oct 31, 1:00 PM to 3:00 PM PDT, Paid: staff still being arranged';

const listRequests = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.route === '/me/bookings');

describe('Package G MyBookingsScreen (SPK-COND-003)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  it('ENR-13: lists my bookings with facility-local times and statuses, and opens one', async () => {
    const app = createTestApp({
      routes: {
        ...switchesOn('rentals'),
        'GET /me/bookings': ok(page([booking(), PARTY])),
      },
    });
    render(<MyBookingsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: HELD_ROW })).toBeOnTheScreen();
    // SPK-COND-003: paid but not staffed reads differently from confirmed.
    expect(screen.getByRole('button', { name: PARTY_ROW })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Rentals and parties' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Your rentals and parties')).toBeOnTheScreen();
    expect(screen.queryByTestId('state-turned-off')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: HELD_ROW }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/bookings/${G.booking}`);
    expect(listRequests(app)[0]?.query).toEqual({ limit: '20' });
    expect(screen.getByRole('button', { name: 'Find a rental or party' })).toBeOnTheScreen();
  });

  it('§4.5: "Load more bookings" asks for the next page with the API cursor and keeps the first', async () => {
    const app = createTestApp({
      routes: {
        ...switchesOn('parties'),
        'GET /me/bookings': (req) =>
          fakeResponse(200, req.query.cursor ? page([PARTY]) : page([booking()], 'cursor-2')),
      },
    });
    render(<MyBookingsScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Load more bookings' }));
    expect(await screen.findByRole('button', { name: PARTY_ROW })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: HELD_ROW })).toBeOnTheScreen();
    expect(listRequests(app)[1]?.query).toEqual({ limit: '20', cursor: 'cursor-2' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more bookings' })).toBeNull(),
    );
  });

  it('DEC-016: turned off by default, naming DEC-076 and DEC-077, while existing bookings stay listed', async () => {
    const app = createTestApp({ routes: { 'GET /me/bookings': ok(page([booking()])) } });
    render(<MyBookingsScreen />, { wrapper: app.wrapper });
    const off = await screen.findByTestId('state-turned-off');
    expect(within(off).getByLabelText('Rentals and parties turned off')).toBeOnTheScreen();
    expect(within(off).getByText(/DEC-076/)).toBeOnTheScreen();
    expect(within(off).getByText(/DEC-077/)).toBeOnTheScreen();
    expect(
      within(off).getByText('Bookings you already made stay available here.'),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: HELD_ROW })).toBeOnTheScreen();
    // Nothing new is offered while both switches are off.
    expect(screen.queryByRole('button', { name: 'Find a rental or party' })).toBeNull();
  });

  it('shows the API error code with "Try again", then the list', async () => {
    let calls = 0;
    const app = createTestApp({
      routes: {
        ...switchesOn('rentals'),
        'GET /me/bookings': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-b1' }))
            : fakeResponse(200, page([booking()]));
        },
      },
    });
    render(<MyBookingsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-b1/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: HELD_ROW })).toBeOnTheScreen();
  });

  it('a refused read is "not available"; no bookings is the empty state pointing to Discover', async () => {
    const denied = createTestApp({
      routes: {
        ...switchesOn('rentals'),
        'GET /me/bookings': { status: 403, body: apiErrorBody('ACCESS_DENIED') },
      },
    });
    const { unmount } = render(<MyBookingsScreen />, { wrapper: denied.wrapper });
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    unmount();

    const empty = createTestApp({
      routes: { ...switchesOn('rentals'), 'GET /me/bookings': ok(page([])) },
    });
    render(<MyBookingsScreen />, { wrapper: empty.wrapper });
    expect(
      await screen.findByRole('header', { name: 'No rentals or parties yet' }),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open Discover' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/discover');
  });

  it('without a session it asks to sign in and reads nothing', async () => {
    const app = createTestApp({ session: null });
    render(<MyBookingsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
