/**
 * SCR-C-25 the player's own contribution requests (SPK-PAY-004, SPK-PAY-007, SPK-CAP-002,
 * SPK-AT-022): `GET /v1/me/contribution-requests` lists only what was asked of this person or of
 * someone this account pays for, each line with its amount and status and the team's description,
 * a payment on its way shown on its line only, with the SPK-UX-008 states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  paymentAttempt,
} from '../../../features/money/testing/fixtures';
import {
  LIST_IDS,
  contributionRequest,
  pageOf,
} from '../../../features/money/testing/list-fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { MyContributionsScreen } from '../MyContributionsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const CHILD_LINE = contributionRequest({
  id: LIST_IDS.contributionChild,
  requestedPersonId: IDS.child,
  amountMinor: 5000,
  status: 'paid',
  paidAt: '2026-10-23T12:00:00.000Z',
});

function renderList(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({
    routes: {
      ...accountRoutes(),
      'GET /me/contribution-requests': pageOf([contributionRequest(), CHILD_LINE]),
      'GET /me/payments': pageOf([]),
      ...overrides,
    },
  });
  render(<MyContributionsScreen />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-25 MyContributionsScreen', () => {
  afterEach(settleApps);
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-PAY-004: lists the contributions asked of you and of the people you pay for, each with its own status', async () => {
    const app = renderList();
    expect(
      await screen.findByRole('button', {
        name: 'Fall 2026 team fee, Your contribution: $75.00, Requested',
      }),
    ).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', {
        name: 'Fall 2026 team fee, Contribution for Sam: $50.00, Paid on Oct 23, 2026',
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'Team contributions asked of you' }),
    ).toBeOnTheScreen();
    // The scope is the API's own: the app sends no person id.
    expect(app.fake.requests.find((r) => r.route === '/me/contribution-requests')?.query).toEqual({
      limit: '20',
    });
  });

  it('opens a line by its opaque id', async () => {
    renderList();
    fireEvent.press(await screen.findByTestId(`my-contribution-${LIST_IDS.contribution}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/contribution/${LIST_IDS.contribution}`);
  });

  it('SPK-PAY-007: a payment on its way is shown on its own line only, never as paid', async () => {
    renderList({
      'GET /me/payments': pageOf([
        paymentAttempt({
          id: LIST_IDS.attemptContribution,
          purpose: 'contribution',
          status: 'unknown',
          obligationId: null,
          orderId: null,
          contributionRequestId: LIST_IDS.contribution,
          posSaleId: null,
        }),
      ]),
    });
    expect(
      await screen.findByRole('button', {
        name: 'Fall 2026 team fee, Your contribution: $75.00, Payment outcome being confirmed. Do not pay again.',
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', {
        name: 'Fall 2026 team fee, Contribution for Sam: $50.00, Paid on Oct 23, 2026',
      }),
    ).toBeOnTheScreen();
  });

  it('SPK-UX-008: a failed check for payments on their way is said above the lines with its code and "Try again"', async () => {
    let calls = 0;
    const app = renderList({
      'GET /me/payments': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-mine' }))
          : fakeResponse(200, { items: [], nextCursor: null });
      },
    });
    const notice = await screen.findByTestId('contribution-payments-unchecked');
    expect(
      within(notice).getByText(/We could not check for a payment already on its way/),
    ).toBeOnTheScreen();
    expect(
      within(notice).getByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-mine/),
    ).toBeOnTheScreen();
    // The lines stay listed with their own status.
    expect(
      screen.getByRole('button', {
        name: 'Fall 2026 team fee, Your contribution: $75.00, Requested',
      }),
    ).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(within(notice).getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.queryByTestId('contribution-payments-unchecked')).toBeNull());
    expect(app.fake.requests.filter((r) => r.route === '/me/payments')).toHaveLength(2);
  });

  it('shows the empty state when nothing was asked', async () => {
    renderList({ 'GET /me/contribution-requests': pageOf([]) });
    expect(
      await screen.findByRole('header', { name: 'No contributions asked of you' }),
    ).toBeOnTheScreen();
  });

  it('shows the API error code and reference with "Try again"', async () => {
    let calls = 0;
    renderList({
      'GET /me/contribution-requests': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-25' }))
          : fakeResponse(200, { items: [contributionRequest()], nextCursor: null });
      },
    });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-25/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: /^Fall 2026 team fee, Your contribution/ }),
    ).toBeOnTheScreen();
  });

  it('§4.10: a refused read is "not available" with nothing of any line', async () => {
    renderList({
      'GET /me/contribution-requests': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/Fall 2026 team fee/)).toBeNull();
  });

  it('§4.5: more lines load with the API cursor', async () => {
    const app = renderList({
      'GET /me/contribution-requests': (req) =>
        fakeResponse(
          200,
          req.query.cursor === 'next'
            ? { items: [CHILD_LINE], nextCursor: null }
            : { items: [contributionRequest()], nextCursor: 'next' },
        ),
    });
    await screen.findByTestId(`my-contribution-${LIST_IDS.contribution}`);
    expect(screen.queryByTestId(`my-contribution-${LIST_IDS.contributionChild}`)).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Load more contributions' }));
    });
    expect(
      await screen.findByTestId(`my-contribution-${LIST_IDS.contributionChild}`),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/me/contribution-requests').at(-1)?.query
          .cursor,
      ).toBe('next'),
    );
  });

  it('§4.15: offline keeps the list with its age and says paying needs a connection', async () => {
    const app = renderList();
    await screen.findByTestId(`my-contribution-${LIST_IDS.contribution}`);
    act(() => app.sources.setReachable(false));
    expect(screen.getByText('Needs a connection: paying a contribution.')).toBeOnTheScreen();
    expect(screen.getByTestId(`my-contribution-${LIST_IDS.contribution}`)).toBeOnTheScreen();
  });

  it('without a session it asks to sign in and reads nothing', async () => {
    const app = createTestApp({ session: null, routes: accountRoutes() });
    render(<MyContributionsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/me/contribution-requests')).toHaveLength(
      0,
    );
  });
});
