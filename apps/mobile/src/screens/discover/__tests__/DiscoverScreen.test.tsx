/**
 * SCR-C-07 Discover (SPK-UX-002, SPK-CAT-001, SPK-CAT-004, §4.14): the public catalog with each
 * offering's registration window state, the SPK-UX-008 states, signed-out discovery, filters and
 * accessible rows.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { IDS, offering, page } from '../../../features/registration/testing/fixtures';
import { DiscoverScreen } from '../DiscoverScreen';

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
    expect(app.fake.requests[0]?.query).toEqual({ limit: '50' });
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
    expect(app.fake.requests.at(-1)?.query).toEqual({ limit: '50', kind: 'camp' });
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
    expect(app.fake.requests[0]?.query).toEqual({ limit: '50', organization: 'example-park' });
    expect(app.fake.requests[0]?.headers.authorization).toBeUndefined();
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
    fireEvent.press(await screen.findByRole('button', { name: 'Show more activities' }));
    expect(await screen.findByText('Winter Camp')).toBeOnTheScreen();
    expect(app.fake.requests.at(-1)?.query).toEqual({ limit: '50', cursor: 'cursor-2' });
    expect(screen.queryByRole('button', { name: 'Show more activities' })).toBeNull();
  });

  it('SPK-UX-001: offers to continue a registration in progress on this device', async () => {
    const app = createRegistrationTestApp({
      progress: { basketId: IDS.basket },
      routes: { 'GET /offerings': page([]) },
    });
    render(<DiscoverScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue your registration' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
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
