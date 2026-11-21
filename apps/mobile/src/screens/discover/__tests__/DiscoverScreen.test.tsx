/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001, SPK-CAT-004, SPK-SCHED-008, SPK-UX-001, §4.14): the
 * public catalog with each offering's registration window state in the facility's zone, the
 * SPK-UX-008 states, signed-out discovery, kind, format and date filters (CAT-01), Package G kinds
 * only while their switch is on, accessible rows, and "In progress" from the API's own lists.
 * Explore v2 (ADR-008, PA-11): category, sport and "When" chips, the date-range sheet, picture
 * cards, the search illustration when nothing matches, and pull to refresh.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import {
  familyRoutes,
  IDS,
  basket,
  checkout,
  myWaitlistEntry,
  offering,
  page,
  payment,
} from '../../../features/registration/testing/fixtures';
import { mePermissions } from '../../../testing/test-app';
import { openSupportDetails, pullToRefresh } from '../../../testing/ui-surfaces';
import { DiscoverScreen, filterProblems } from '../DiscoverScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const PAUSED = offering({
  id: IDS.offering2,
  name: 'Winter Camp',
  kind: 'camp',
  publicationState: 'registration_paused',
  price: null,
});

/**
 * `GET /me/registration-checkouts` as the API answers it (money-reads.service myCheckouts): newest
 * first, the `status` filter, cursor pages of `limit`. Twenty-five newer checkouts of other
 * baskets come before this basket's checkout in recovery (R3-SCREEN-STATES-04).
 */
function checkoutsBehindNewerOnes(options: { failRecoveryPage?: () => boolean } = {}): FakeHandler {
  const other = (n: number) => `0192f1a0-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
  const all = [
    ...Array.from({ length: 25 }, (_, n) =>
      checkout({ id: other(n), basketId: other(500 + n), quoteId: other(900 + n) }),
    ),
    checkout({ status: 'recovery_required' }),
  ];
  return (req: FakeRequest) => {
    if (req.query.status && options.failRecoveryPage?.()) {
      return fakeResponse(
        503,
        apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
      );
    }
    const matching = req.query.status ? all.filter((c) => c.status === req.query.status) : all;
    const start = req.query.cursor ? Number(req.query.cursor) : 0;
    const end = start + Number(req.query.limit ?? 50);
    return fakeResponse(200, {
      items: matching.slice(start, end),
      nextCursor: end < matching.length ? String(end) : null,
    });
  };
}

describe('SCR-C-07 DiscoverScreen', () => {
  it('shows the API error code and a retry when the catalog is unavailable', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              message: 'The catalog is unavailable.',
              nextAction: 'retry_later',
              correlationId: 'corr-7',
            }),
          ),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('The catalog is unavailable.')).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText('Error code: INTEGRATION_UNAVAILABLE')).toBeOnTheScreen();
    expect(screen.getByText('Reference: corr-7')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('shows NOT_FOUND as not available, without naming the error', async () => {
    const app = createRegistrationTestApp({ routes: {} });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('asks a signed-out visitor to sign in when no organization is configured, and sends nothing', async () => {
    const app = createRegistrationTestApp({
      session: null,
      routes: { 'GET /offerings': page([]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'Sign in to see activities' }),
    ).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('§4.14: a signed-out visitor browses the configured organization without a token', async () => {
    const app = createRegistrationTestApp({
      session: null,
      config: { organizationSlug: 'example-park' },
      routes: { 'GET /offerings': page([offering()]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const read = app.fake.requests.find((r) => r.route === '/offerings');
    expect(read?.query).toEqual({ limit: '50', organization: 'example-park' });
    expect(read?.headers.authorization).toBeUndefined();
    // Signed out: no account lists are read. The only other read is the organization's public
    // directory (SPK-SCHED-010), which needs no token either.
    const others = app.fake.requests.filter((r) => r.route !== '/offerings');
    expect(others.every((r) => r.path === '/public/example-park/directory')).toBe(true);
    expect(others.every((r) => r.headers.authorization === undefined)).toBe(true);
    // Nothing is public here, so no public link is offered.
    expect(screen.queryByTestId('public-links')).toBeNull();
  });

  it('loads the next page with the cursor', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': (req) =>
          req.query.cursor
            ? fakeResponse(200, { items: [PAUSED], nextCursor: null })
            : fakeResponse(200, { items: [offering()], nextCursor: 'cursor-2' }),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Load more activities' }));
    expect(await screen.findByText('Winter Camp')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query).toEqual({
      limit: '50',
      cursor: 'cursor-2',
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more activities' })).toBeNull(),
    );
  });

  it('SPK-UX-001, SPK-AT-023: after a reinstall, the API lists what is in progress: recovery first, then baskets and offers', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([]),
        ...familyRoutes(),
        'GET /me/registration-checkouts': page([
          checkout({ status: 'recovery_required', basketId: IDS.lineA }),
          checkout({ id: IDS.quote2, status: 'completed' }),
        ]),
        'GET /me/baskets': page([basket(), basket({ id: IDS.lineB, status: 'fulfilled' })]),
        'GET /me/waitlist-entries': page([
          myWaitlistEntry({
            status: 'offered',
            openOffer: { id: IDS.offer, status: 'offered', expiresAt: '2026-10-24T14:00:00.000Z' },
          }),
        ]),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('discover-resume');
    const recovery = await within(card).findByRole('button', {
      name: 'Payment and registration, Payment received. We are completing your registration.',
    });
    expect(
      within(card).getByRole('button', {
        name: 'Your cart, 2 registrations, In your cart. No spots are saved yet.',
      }),
    ).toBeOnTheScreen();
    expect(
      await within(card).findByRole('button', {
        name: /^Ada: Autumn Youth Program, Place offered\. Accept by .+\.$/,
      }),
    ).toBeOnTheScreen();
    // Finished checkouts and fulfilled baskets are not in progress.
    expect(within(card).getAllByRole('button')).toHaveLength(4);
    fireEvent.press(recovery);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    fireEvent.press(
      within(card).getByRole('button', {
        name: 'Your cart, 2 registrations, In your cart. No spots are saved yet.',
      }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    fireEvent.press(within(card).getByRole('button', { name: 'Your waitlists' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/registration/waitlists');
    expect(app.fake.requests.find((r) => r.route === '/me/waitlist-entries')?.query).toEqual({
      status: 'offered',
      limit: '20',
    });
  });

  it('R3-SCREEN-STATES-04 §4.11: a checkout in recovery behind twenty newer checkouts has its row, and its basket is not listed as "Payment processing"', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([]),
        ...familyRoutes(),
        'GET /me/registration-checkouts': checkoutsBehindNewerOnes(),
        'GET /me/baskets': page([basket({ status: 'checking_out' })]),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('discover-resume');
    const row = await within(card).findByRole('button', {
      name: 'Payment and registration, Payment received. We are completing your registration.',
    });
    expect(within(card).queryByRole('button', { name: /^Your cart/ })).toBeNull();
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    const reads = app.fake.requests.filter((r) => r.route === '/me/registration-checkouts');
    expect(reads.some((r) => r.query.status === 'recovery_required')).toBe(true);
  });

  it('R3-SCREEN-STATES-04: a failed read of the checkouts in recovery shows its code with "Try again", and "Nothing in progress" is not claimed', async () => {
    let fail = true;
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([]),
        ...familyRoutes(),
        'GET /me/registration-checkouts': checkoutsBehindNewerOnes({
          failRecoveryPage: () => fail,
        }),
        'GET /me/baskets': page([]),
        'GET /me/waitlist-entries': page([]),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('discover-resume');
    await openSupportDetails(within(card));
    expect(await within(card).findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(within(card).queryByText('Nothing in progress right now.')).toBeNull();
    fail = false;
    fireEvent.press(within(card).getByRole('button', { name: 'Try again' }));
    expect(
      await within(card).findByRole('button', {
        name: 'Payment and registration, Payment received. We are completing your registration.',
      }),
    ).toBeOnTheScreen();
    await app.settle();
  });

  it('SPK-PAY-007: a checkout request whose answer never arrived comes first, until the API lists it', async () => {
    const app = createRegistrationTestApp({
      progress: { pendingCheckoutQuoteId: IDS.quote },
      routes: { 'GET /offerings': page([]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Check your payment and registration' }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/checkout/${IDS.quote}`);
    await app.settle();
    expect(screen.queryByText('Nothing in progress right now.')).toBeNull();
  });

  it('SPK-PAY-007: once the API lists that checkout, its own row says what is known about it', async () => {
    const app = createRegistrationTestApp({
      progress: { pendingCheckoutQuoteId: IDS.quote },
      routes: {
        'GET /offerings': page([]),
        'GET /me/registration-checkouts': page([
          checkout({ status: 'awaiting_payment', payment: payment({ status: 'unknown' }) }),
        ]),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'Payment and registration, Payment outcome being confirmed. Do not pay again.',
      }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Check your payment and registration' }),
    ).toBeNull();
  });

  it('SPK-UX-008: a list in progress that cannot be read shows its code with a retry; the catalog still shows', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([offering()]),
        'GET /me/baskets': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { message: 'Baskets failed.' })),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const card = screen.getByTestId('discover-resume');
    await openSupportDetails(within(card));
    expect(await within(card).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('a filter date that is not a real date is a field message', () => {
    expect(filterProblems({ format: '', from: '2026-02-30', to: '' }).from).toMatch(/YYYY-MM-DD/);
    expect(filterProblems({ format: '', from: '2026-02-28', to: '2026-03-01' })).toEqual({});
  });

  it('DEC-016: Package G kinds get a filter only while their switch is on', async () => {
    const off = createRegistrationTestApp({ routes: { 'GET /offerings': page([]) } });
    const first = render(<DiscoverScreen />, { wrapper: off.wrapper });
    expect(await screen.findByRole('button', { name: 'Camps' })).toBeOnTheScreen();
    await off.settle();
    expect(screen.queryByRole('button', { name: 'Rentals' })).toBeNull();
    // PA-11: a capability that is off has no entry point and no note about it.
    expect(screen.queryByText(/DEC-016/)).toBeNull();
    expect(screen.queryByText(/listed only where the facility has turned them on/)).toBeNull();
    first.unmount();

    const on = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([]),
        'GET /me/permissions': mePermissions({ enabled: ['rentals', 'memberships'] }),
      },
    });
    render(<DiscoverScreen />, { wrapper: on.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Rentals' }));
    expect(screen.getByRole('button', { name: 'Memberships' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Parties' })).toBeNull();
    await waitFor(() =>
      expect(on.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query).toEqual({
        limit: '50',
        kind: 'rental',
      }),
    );
  });

  it('§4.15: keeps the list when offline and says how old it is', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createRegistrationTestApp({
      now: () => now,
      routes: { 'GET /offerings': page([offering()]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    now = new Date('2026-10-24T12:15:00.000Z');
    act(() => app.sources.setReachable(false));
    // ADR-008: under the app's offline banner the section says its own age and needs on one quiet line.
    expect(
      screen.getByText(
        'Showing information from 15 minutes ago. Needs a connection: Registration.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText('Autumn Youth Program')).toBeOnTheScreen();
  });

  it('Explore: the search waits for a pause in typing before it is sent', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const sent = () => app.fake.requests.filter((r) => r.route === '/offerings');
    fireEvent.changeText(screen.getByLabelText('Search activities'), 'cam');
    fireEvent.changeText(screen.getByLabelText('Search activities'), 'camp');
    // Nothing yet: the search is sent once typing pauses, with what was typed last.
    expect(sent()).toHaveLength(1);
    await waitFor(() => expect(sent().at(-1)?.query).toEqual({ limit: '50', q: 'camp' }));
    expect(sent()).toHaveLength(2);
    await app.settle();
  });

  it('Explore: pull to refresh reads the catalog again', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const sent = () => app.fake.requests.filter((r) => r.route === '/offerings');
    expect(sent()).toHaveLength(1);
    await pullToRefresh(screen);
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent().at(-1)?.query).toEqual({ limit: '50' });
    await app.settle();
  });
});
