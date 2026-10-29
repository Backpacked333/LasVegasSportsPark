/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001, SPK-CAT-004, SPK-SCHED-008, SPK-UX-001, §4.14): the
 * public catalog with each offering's registration window state in the facility's zone, the
 * SPK-UX-008 states, signed-out discovery, kind, format and date filters (CAT-01), Package G kinds
 * only while their switch is on, accessible rows, and "In progress" from the API's own lists.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
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
      screen.getByText(
        'Program · 7v7 · Ages 8 to 10 · Nov 2, 2026 to Dec 14, 2026 · Field 2 · From $120.00',
      ),
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

    fireEvent.press(screen.getByRole('radio', { name: 'Camp' }));
    expect(await screen.findByRole('header', { name: 'No camp activities' })).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/offerings').at(-1)?.query).toEqual({
      limit: '50',
      kind: 'camp',
    });
    expect(screen.getByRole('radio', { name: 'Camp' })).toBeChecked();

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
    expect(
      screen.getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-7/),
    ).toBeOnTheScreen();
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
    // Signed out: no account lists are read.
    expect(app.fake.requests.every((r) => r.route === '/offerings')).toBe(true);
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
        name: 'Your basket, 2 registrations, In your basket. No place is held yet.',
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
    fireEvent.press(within(card).getByRole('button', { name: /^Your basket/ }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    fireEvent.press(within(card).getByRole('button', { name: 'Your waitlists' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/registration/waitlists');
    expect(app.fake.requests.find((r) => r.route === '/me/waitlist-entries')?.query).toEqual({
      status: 'offered',
      limit: '20',
    });
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
    expect(await within(card).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('CAT-01: filters by format and dates on the server, and checks dates before sending', async () => {
    const app = createRegistrationTestApp({ routes: { 'GET /offerings': page([offering()]) } });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    fireEvent.changeText(screen.getByLabelText('Format'), '7v7');
    fireEvent.changeText(screen.getByLabelText('Ending on or after (YYYY-MM-DD)'), '2026-12-01');
    fireEvent.changeText(screen.getByLabelText('Starting on or before (YYYY-MM-DD)'), '2026-11-01');
    fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByText('✕ The end date must not be before the start date.')).toBeOnTheScreen();
    const sent = () => app.fake.requests.filter((r) => r.route === '/offerings');
    expect(sent()).toHaveLength(1);

    fireEvent.changeText(screen.getByLabelText('Starting on or before (YYYY-MM-DD)'), '2027-01-31');
    fireEvent.press(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() =>
      expect(sent().at(-1)?.query).toEqual({
        limit: '50',
        format: '7v7',
        from: '2026-12-01',
        to: '2027-01-31',
      }),
    );
    expect(await screen.findByText('Autumn Youth Program')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(sent().at(-1)?.query).toEqual({ limit: '50' }));
    // Age bands wait on a decision; nothing filters by age.
    expect(
      screen.getByText(/Filtering by age is not available yet: it depends on DEC-003/),
    ).toBeOnTheScreen();
  });

  it('a filter date that is not a real date is a field message', () => {
    expect(filterProblems({ format: '', from: '2026-02-30', to: '' }).from).toMatch(/YYYY-MM-DD/);
    expect(filterProblems({ format: '', from: '2026-02-28', to: '2026-03-01' })).toEqual({});
  });

  it('DEC-016: Package G kinds get a filter only while their switch is on', async () => {
    const off = createRegistrationTestApp({ routes: { 'GET /offerings': page([]) } });
    const first = render(<DiscoverScreen />, { wrapper: off.wrapper });
    expect(await screen.findByRole('radio', { name: 'Camp' })).toBeOnTheScreen();
    await off.settle();
    expect(screen.queryByRole('radio', { name: 'Rental' })).toBeNull();
    expect(screen.getByText(/listed only where the facility has turned them on/)).toBeOnTheScreen();
    first.unmount();

    const on = createRegistrationTestApp({
      routes: {
        'GET /offerings': page([]),
        'GET /me/permissions': mePermissions({ enabled: ['rentals', 'memberships'] }),
      },
    });
    render(<DiscoverScreen />, { wrapper: on.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: 'Rental' }));
    expect(screen.getByRole('radio', { name: 'Membership' })).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: 'Party' })).toBeNull();
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
    expect(screen.getByText('Showing information from 15 minutes ago.')).toBeOnTheScreen();
    expect(screen.getByText('Needs a connection: Registration.')).toBeOnTheScreen();
    expect(screen.getByText('Autumn Youth Program')).toBeOnTheScreen();
  });
});
