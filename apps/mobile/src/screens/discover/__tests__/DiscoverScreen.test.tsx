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
import { illustrations } from '../../../artwork/manifest';
import { mePermissions } from '../../../testing/test-app';
import { openSheet, pickDate } from '../../../testing/ui';
import {
  openSupportDetails,
  pullToRefresh,
  mockFontScale,
  truncatedTexts,
} from '../../../testing/ui-surfaces';
import { Artwork } from '../../../ui/Artwork';
import {
  DiscoverScreen,
  exploreQuery,
  filterProblems,
  searchQuery,
  whenRange,
} from '../DiscoverScreen';

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
  it('SPK-CAT-004: lists published offerings with their registration window, never a paused one as closed', async () => {
    const app = createRegistrationTestApp({
      routes: { 'GET /offerings': page([offering(), PAUSED]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });

    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration open')).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration paused')).toBeOnTheScreen();
    expect(screen.queryByText('Registration closed')).toBeNull();
    expect(
      screen.getByText('Ages 8 to 10 · Nov 2 to Dec 14, 2026 · From $120.00'),
    ).toBeOnTheScreen();
    expect(
      within(screen.getByTestId(`offering-${IDS.offering}`)).getByText('7v7 · Field 2'),
    ).toBeOnTheScreen();
    // Signed in: the organization comes from the principal, not the query.
    expect(app.fake.requests.find((r) => r.route === '/offerings')?.query).toEqual({ limit: '50' });
  });

  it('shows the loading state first', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(screen.getByRole('progressbar')).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'No activities' })).toBeOnTheScreen();
  });

  it('filters by kind on the server and offers the way back from an empty filter', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': (req) =>
          fakeResponse(200, { items: req.query.kind ? [] : [offering()], nextCursor: null }),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Camps' }));
    expect(await screen.findByRole('header', { name: 'No camp activities' })).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query).toEqual({
      limit: '50',
      kind: 'camp',
    });
    expect(screen.getByRole('button', { name: 'Camps' })).toBeSelected();

    fireEvent.press(screen.getByRole('button', { name: 'Show all activities' }));
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    await app.settle();
  });

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

  it('opens an offering from an accessible row that reads title, details and status', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    const row = await screen.findByRole('button', {
      name: /^Autumn Youth Program, .*Registration open$/,
    });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/offering/${IDS.offering}`);
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

  it('CAT-01: filters by format and dates on the server, and checks dates before sending', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const sent = () => app.fake.requests.filter((r) => r.route === '/offerings');

    // The format, in its sheet.
    fireEvent.press(screen.getByRole('button', { name: 'Format' }));
    fireEvent.changeText(within(openSheet(screen)).getByLabelText('Format'), '7v7');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(sent().at(-1)?.query).toEqual({ limit: '50', format: '7v7' }));
    expect(screen.getByRole('button', { name: 'Format: 7v7' })).toBeSelected();

    // A range that ends before it starts cannot be applied: nothing is sent.
    fireEvent.press(screen.getByRole('button', { name: 'Pick dates' }));
    pickDate(screen, 'From', '2026-12-01');
    pickDate(screen, 'To', '2026-11-01');
    expect(screen.getByText('✕ Choose Tuesday 1 December 2026 or later.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(sent()).toHaveLength(2);

    pickDate(screen, 'To', '2027-01-31');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(sent().at(-1)?.query).toEqual({
        limit: '50',
        format: '7v7',
        from: '2026-12-01',
        to: '2027-01-31',
      }),
    );
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Pick dates, Dec 1, 2026 to Jan 31, 2027' }),
    ).toBeSelected();
    fireEvent.press(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(sent().at(-1)?.query).toEqual({ limit: '50' }));
    // Age bands wait on a decision: nothing filters by age, and no code is shown.
    expect(screen.queryByText(/DEC-003/)).toBeNull();
    expect(screen.queryByText(/Filtering by age/)).toBeNull();
  });

  it('"Show all activities" from an empty filtered list also empties the filter fields', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': (req) =>
          fakeResponse(200, { items: req.query.format ? [] : [offering()], nextCursor: null }),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Format' }));
    fireEvent.changeText(within(openSheet(screen)).getByLabelText('Format'), '11v11');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.press(screen.getByRole('button', { name: 'This month' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Show all activities' }));
    const sent = () => app.fake.requests.filter((r) => r.route === '/offerings');
    await waitFor(() => expect(sent().at(-1)?.query).toEqual({ limit: '50' }));
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    // The chips show the filter that is applied (none), not the old one.
    expect(screen.getByRole('button', { name: 'Format' })).not.toBeSelected();
    expect(screen.getByRole('button', { name: 'This month' })).not.toBeSelected();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Format' }));
    expect(within(openSheet(screen)).getByLabelText('Format').props.value).toBe('');
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

  it('SPK-SCHED-008: a registration opening time is shown in the facility time zone', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([
          offering({
            publicationState: 'published',
            registrationOpensAt: '2026-11-03T15:00:00.000Z',
          }),
        ]),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    // 15:00 UTC is 7:00 AM in Los Angeles (PST), the facility's zone, whatever the device's.
    expect(
      await screen.findByLabelText('Registration opens Tue, Nov 3, 7:00 AM PST'),
    ).toBeOnTheScreen();
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

  it('Explore: the category chips are Leagues, Classes, Camps, Trials and Coaching, each sent as its kind', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const row = screen.getByTestId('discover-categories');
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.props.accessibilityLabel),
    ).toEqual(['Leagues', 'Classes', 'Camps', 'Trials', 'Coaching']);
    const last = () => app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query;
    for (const [name, kind] of [
      ['Leagues', 'season'],
      ['Classes', 'term'],
      ['Trials', 'trial'],
      ['Coaching', 'private_coaching'],
    ] as const) {
      fireEvent.press(screen.getByRole('button', { name }));
      await waitFor(() => expect(last()).toEqual({ limit: '50', kind }));
    }
    // Pressing the chosen chip again clears it.
    fireEvent.press(screen.getByRole('button', { name: 'Coaching' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50' }));
    await app.settle();
  });

  it('Explore: a sport chip adds its word to the search (q), after the typed search', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const last = () => app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query;

    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50', q: 'futsal' }));
    expect(screen.getByRole('button', { name: 'Futsal' })).toBeSelected();

    const search = screen.getByLabelText('Search activities');
    fireEvent.changeText(search, 'camp');
    fireEvent(search, 'submitEditing');
    await waitFor(() => expect(last()).toEqual({ limit: '50', q: 'camp futsal' }));

    fireEvent.press(screen.getByRole('button', { name: 'Soccer' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50', q: 'camp soccer' }));
    fireEvent.press(screen.getByRole('button', { name: 'Soccer' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50', q: 'camp' }));
    expect(searchQuery({ search: '  ', sport: 'basketball' })).toBe('basketball');
    await app.settle();
  });

  it('Explore SPK-SCHED-008: "This week" and "This month" send today to Sunday and today to the month end, in the facility zone', async () => {
    // Saturday Oct 24, 2026 at 05:00 in Los Angeles (the offering's facility).
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const last = () => app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query;

    fireEvent.press(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() =>
      expect(last()).toEqual({ limit: '50', from: '2026-10-24', to: '2026-10-25' }),
    );
    expect(screen.getByRole('button', { name: 'This week' })).toBeSelected();

    fireEvent.press(screen.getByRole('button', { name: 'This month' }));
    await waitFor(() =>
      expect(last()).toEqual({ limit: '50', from: '2026-10-24', to: '2026-10-31' }),
    );
    expect(screen.getByRole('button', { name: 'This week' })).not.toBeSelected();

    fireEvent.press(screen.getByRole('button', { name: 'This month' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50' }));
    expect(whenRange('week', '2026-11-16')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(whenRange('month', '2027-02-10')).toEqual({ from: '2027-02-10', to: '2027-02-28' });
    await app.settle();
  });

  it('Explore: "Pick dates" applies a range from its sheet, and the sheet can clear it', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    const last = () => app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query;

    fireEvent.press(screen.getByRole('button', { name: 'Pick dates' }));
    expect(screen.getByRole('header', { name: 'Pick dates' })).toBeOnTheScreen();
    // Both dates are needed.
    pickDate(screen, 'From', '2026-11-02');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    pickDate(screen, 'To', '2026-11-08');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(last()).toEqual({ limit: '50', from: '2026-11-02', to: '2026-11-08' }),
    );
    expect(screen.queryByRole('header', { name: 'Pick dates' })).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Pick dates, Nov 2 to Nov 8, 2026' }));
    expect(screen.getByLabelText('From').props.value).toBe('2026-11-02');
    fireEvent.press(screen.getByRole('button', { name: 'Clear dates' }));
    await waitFor(() => expect(last()).toEqual({ limit: '50' }));
    expect(screen.getByRole('button', { name: 'Pick dates' })).not.toBeSelected();
    await app.settle();
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

  it('Explore SPK-UX-008: an empty result shows the search illustration and the way back', async () => {
    const app = createRegistrationTestApp({
      routes: {
        'GET /offerings': (req) =>
          fakeResponse(200, { items: req.query.q ? [] : [offering()], nextCursor: null }),
      },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Basketball' }));
    const empty = await screen.findByTestId('discover-empty');
    expect(
      within(empty).getByRole('header', { name: 'No activities match "basketball"' }),
    ).toBeOnTheScreen();
    expect(within(empty).UNSAFE_getByType(Artwork).props.source).toBe(
      illustrations['empty-search'],
    );
    // ADR-008: the answer comes right under the search, before the filter rows, so it is on the
    // first screen of a small phone.
    const order: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const { props, children } = node as { props?: { testID?: string }; children?: unknown };
      if (props?.testID === 'discover-empty' || props?.testID === 'discover-categories') {
        order.push(props.testID);
      }
      walk(children);
    };
    walk(screen.toJSON());
    expect(order).toEqual(['discover-empty', 'discover-categories']);
    expect(
      within(empty).getByText(
        'Nothing matching this filter is published right now. Show all activities to see everything.',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(within(empty).getByRole('button', { name: 'Show all activities' }));
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Basketball' })).not.toBeSelected();
    await app.settle();
  });

  it('SPK-UX-009 200% text: the activities, search and filters are whole, nothing cut short', async () => {
    const fontScale = mockFontScale(2);
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Basketball' })).toBeOnTheScreen();
    expect(truncatedTexts(screen)).toEqual([]);
    fontScale.mockRestore();
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

  it('Explore: the query holds only parameters the API accepts', () => {
    expect(
      exploreQuery(
        {
          kind: 'camp',
          sport: 'soccer',
          search: 'winter',
          filter: { format: '5v5', from: '2026-12-01', to: '2026-12-31' },
        },
        { signedIn: false, organizationSlug: 'example-park' },
      ),
    ).toEqual({
      limit: 50,
      kind: 'camp',
      format: '5v5',
      from: '2026-12-01',
      to: '2026-12-31',
      q: 'winter soccer',
      organization: 'example-park',
    });
  });
});
