/**
 * SCR-C-16 Waitlist status and offer (SPK-REG-008, SPK-AT-006, POL-006): entry status, position
 * and offer history; an open offer with its server expiry and informational countdown; accept
 * consumes the offer once (expected revision, one key) and hands off to the held basket; decline,
 * leave, forms, the device list of waitlists, and the SPK-UX-008 states.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  inMinutes,
  offer,
  offering,
  waitlistEntry,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { WaitlistScreen } from '../WaitlistScreen';
import { WaitlistsScreen } from '../WaitlistsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const OFFERED = waitlistEntry({
  status: 'offered',
  position: null,
  offers: [
    offer({
      id: '0192f1a0-0000-7000-8000-0000000000f1',
      status: 'expired',
      offeredAt: '2026-10-20T12:00:00.000Z',
      expiresAt: '2026-10-21T12:00:00.000Z',
    }),
    offer(),
  ],
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /waitlist-entries/{id}': { status: 200, body: waitlistEntry() },
    'GET /offerings/{id}': { status: 200, body: offering() },
    ...overrides,
  };
}

function renderEntry(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp(options);
  render(<WaitlistScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-16 WaitlistScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-008: shows the participant, offering, position, and leaving sends the entry revision', async () => {
    const app = renderEntry({
      routes: routes({
        'POST /waitlist-entries/{id}/withdraw': {
          status: 200,
          body: waitlistEntry({ status: 'withdrawn', position: null }),
        },
      }),
    });
    expect(
      await screen.findByLabelText('Waitlisted for Autumn Youth Program. Position 3.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Waitlist for Ada' })).toBeOnTheScreen();
    const leave = screen.getByRole('button', { name: 'Leave the waitlist' });
    await act(async () => {
      fireEvent.press(leave);
    });
    expect(
      app.fake.requests.find((r) => r.route === '/waitlist-entries/{id}/withdraw')?.body,
    ).toEqual({ expectedRevision: 2 });
  });

  it('SPK-REG-008: an open offer shows the server expiry; accepting consumes it once and opens the held basket', async () => {
    const held = basket({ status: 'held', holdExpiresAt: inMinutes(120) });
    const app = renderEntry({
      routes: routes({
        'GET /waitlist-entries/{id}': { status: 200, body: OFFERED },
        'POST /waitlist-offers/{id}/accept': (req: FakeRequest) =>
          fakeResponse(200, {
            offer: offer({ id: req.params.id, status: 'accepted' }),
            entry: waitlistEntry({ status: 'accepted' }),
            basket: held,
            sessionBooking: null,
          }),
      }),
    });
    expect(
      (await screen.findAllByLabelText(/^Place offered\. Accept by .+\.$/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Countdown: about 2 hours left')).toBeOnTheScreen();
    const accept = screen.getByRole('button', { name: 'Accept the place' });
    await act(async () => {
      fireEvent.press(accept);
    });
    const sent = app.fake.requests.find((r) => r.route === '/waitlist-offers/{id}/accept');
    expect(sent?.params.id).toBe(IDS.offer);
    expect(sent?.body).toEqual({ expectedRevision: 4 });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    expect(app.progressStore.snapshot().basketId).toBe(IDS.basket);
  });

  it("lists the offer history with each offer's outcome", async () => {
    renderEntry({
      routes: routes({ 'GET /waitlist-entries/{id}': { status: 200, body: OFFERED } }),
    });
    expect(await screen.findByRole('header', { name: 'Offer history' })).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Offer expired').length).toBeGreaterThan(0);
  });

  it('stale: an offer that already lapsed is explained with the API code', async () => {
    renderEntry({
      routes: routes({
        'GET /waitlist-entries/{id}': { status: 200, body: OFFERED },
        'POST /waitlist-offers/{id}/accept': () =>
          fakeResponse(
            409,
            apiErrorBody('CAPACITY_UNAVAILABLE', {
              message: 'This offer has expired; its place was released.',
              nextAction: 'join_waitlist_or_choose_alternative',
            }),
          ),
      }),
    });
    const accept = await screen.findByRole('button', { name: 'Accept the place' });
    await act(async () => {
      fireEvent.press(accept);
    });
    expect(
      await screen.findByText('This offer has expired; its place was released.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: CAPACITY_UNAVAILABLE/)).toBeOnTheScreen();
  });

  it("MISSING_ACKNOWLEDGMENT opens the offer's required forms", async () => {
    renderEntry({
      routes: routes({
        'GET /waitlist-entries/{id}': { status: 200, body: OFFERED },
        'POST /waitlist-offers/{id}/accept': () =>
          fakeResponse(
            422,
            apiErrorBody('MISSING_ACKNOWLEDGMENT', { nextAction: 'complete_acknowledgment' }),
          ),
      }),
    });
    const accept = await screen.findByRole('button', { name: 'Accept the place' });
    await act(async () => {
      fireEvent.press(accept);
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Complete required forms' }));
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/registration/forms?waitlistEntryId=${IDS.entry}`,
    );
  });

  it('declines with the offer revision', async () => {
    const app = renderEntry({
      routes: routes({
        'GET /waitlist-entries/{id}': { status: 200, body: OFFERED },
        'POST /waitlist-offers/{id}/decline': { status: 200, body: offer({ status: 'declined' }) },
      }),
    });
    const decline = await screen.findByRole('button', { name: 'Decline the offer' });
    await act(async () => {
      fireEvent.press(decline);
    });
    expect(
      app.fake.requests.find((r) => r.route === '/waitlist-offers/{id}/decline')?.body,
    ).toEqual({
      expectedRevision: 4,
    });
  });

  it('offline: the offer stays with its expiry and accepting is disabled', async () => {
    const app = renderEntry({
      routes: routes({ 'GET /waitlist-entries/{id}': { status: 200, body: OFFERED } }),
    });
    expect(await screen.findByRole('button', { name: 'Accept the place' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Accept the place' })).toBeDisabled();
    expect(screen.getByText('Accepting needs a connection.')).toBeOnTheScreen();
  });

  it('§4.10: an entry the account may not see reads not available', async () => {
    renderEntry({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });
});

describe('SCR-C-16 WaitlistsScreen', () => {
  it('empty: explains that waitlists joined here appear here', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<WaitlistsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No waitlists' })).toBeOnTheScreen();
  });

  it('lists remembered entries with their status; one no longer shown reads not available', async () => {
    const gone = '0192f1a0-0000-7000-8000-0000000000f9';
    const app = createRegistrationTestApp({
      progress: { waitlistEntryIds: [IDS.entry, gone] },
      routes: routes({
        'GET /waitlist-entries/{id}': (req: FakeRequest) =>
          req.params.id === IDS.entry
            ? fakeResponse(200, waitlistEntry())
            : fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(<WaitlistsScreen />, { wrapper: app.wrapper });
    const row = await screen.findByRole('button', {
      name: 'Ada: Autumn Youth Program, Waitlisted for Autumn Youth Program. Position 3.',
    });
    expect(await screen.findByLabelText(/^Waitlist entry not available/)).toBeOnTheScreen();
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/waitlist/${IDS.entry}`);
  });
});
