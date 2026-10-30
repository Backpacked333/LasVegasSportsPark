/**
 * SCR-C-12 Quote review (SPK-PAY-001, SPK-PAY-002, SPK-PAY-003, SPK-PAY-009, POL-013): the price
 * explanation per participant from the API's minor units, totals, due now, policies and defaults,
 * the server expiry, requotes for codes and credits (no amounts sent), and the SPK-UX-008 states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  familyRoutes,
  inMinutes,
  policyVersion,
  quote,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { QuoteReviewScreen } from '../QuoteReviewScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const CREDIT = {
  id: IDS.credit,
  ownerPersonId: IDS.parent,
  currency: 'USD',
  originalMinor: 5000,
  remainingMinor: 2500,
  permittedUses: ['registration'],
  sourceKind: 'goodwill',
  sourceId: null,
  status: 'active',
  expiresAt: null,
  reason: 'Goodwill',
  approvedAt: '2026-10-01T00:00:00.000Z',
  redemptions: [],
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /registration-quotes/{id}': { status: 200, body: quote() },
    'GET /policy-versions/{id}': {
      status: 200,
      body: policyVersion(IDS.cancellationPolicy, 'Program cancellation', 'cancellation'),
    },
    'GET /credits': { status: 200, body: { items: [], nextCursor: null } },
    ...overrides,
  };
}

function renderQuote(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp(options);
  render(<QuoteReviewScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-12 QuoteReviewScreen', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
  });

  it('SPK-PAY-002: explains each participant line, the totals, due now, expiry and policies', async () => {
    renderQuote({ routes: routes() });
    expect(await screen.findByText('Ada: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByText('Ben: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Sibling discount: -$12.00')).toHaveLength(2);
    expect(screen.getAllByText('10% off the second and later children.')).toHaveLength(2);
    expect(screen.getAllByLabelText('Facility fee: $5.00')).toHaveLength(2);
    expect(screen.getByLabelText('Total for Ada: $113.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Subtotal: $240.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Discounts: -$24.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Fees: $10.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Total: $226.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Due now: $226.00')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Price valid until /)).toBeOnTheScreen();
    expect(
      screen.getByText('A price does not hold a place. Places are held when you check out.'),
    ).toBeOnTheScreen();
    expect(await screen.findByText('Cancellation: Program cancellation')).toBeOnTheScreen();
    expect(screen.getByText('• refund/compensation: refund (POL-009, DEC-009)')).toBeOnTheScreen();
  });

  it('continues to checkout (SCR-C-14)', async () => {
    renderQuote({ routes: routes() });
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to checkout' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/checkout/${IDS.quote}`);
  });

  it('POL-013: an expired price reads "Price expired. Get a new price." and requotes the basket', async () => {
    const app = renderQuote({
      routes: routes({
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ expiresAt: inMinutes(-5) }),
        },
        'POST /registration-quotes': { status: 201, body: quote({ id: IDS.quote2 }) },
      }),
    });
    expect(await screen.findByLabelText('Price expired. Get a new price.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Continue to checkout' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Get a new price' });
    await act(async () => {
      fireEvent.press(button);
    });
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      basketId: IDS.basket,
      discountCodes: [],
      creditIds: [],
    });
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/quote/${IDS.quote2}`);
  });

  it('SPK-UX-001: a price used for a checkout opens that checkout, as the API names it', async () => {
    renderQuote({
      routes: routes({
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ status: 'consumed', consumedByCheckoutId: IDS.checkout }),
        },
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'See your payment' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
  });

  it('VALIDATION_FAILED: an unknown discount code is shown at the field and the code is kept', async () => {
    renderQuote({
      routes: routes({
        'POST /registration-quotes': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'Unknown or inactive discount code.',
              nextAction: 'correct_input',
              details: { unknownCodes: ['SPRING'] },
            }),
          ),
      }),
    });
    fireEvent.changeText(await screen.findByLabelText('Discount code'), 'SPRING');
    const apply = screen.getByRole('button', { name: 'Apply code' });
    await act(async () => {
      fireEvent.press(apply);
    });
    expect(
      await screen.findByText('✕ This code is not recognized or is no longer active.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Discount code')).toHaveProp('value', 'SPRING');
  });

  it("SPK-PAY-009: applies the payer's credit through a new quote that carries only its id", async () => {
    const app = renderQuote({
      routes: routes({
        'GET /credits': { status: 200, body: { items: [CREDIT], nextCursor: null } },
        'POST /registration-quotes': { status: 201, body: quote({ id: IDS.quote2 }) },
      }),
    });
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Credit: $25.00' }));
    const update = screen.getByRole('button', { name: 'Update price with my credits' });
    await act(async () => {
      fireEvent.press(update);
    });
    expect(app.fake.requests.find((r) => r.method === 'POST')?.body).toEqual({
      basketId: IDS.basket,
      discountCodes: [],
      creditIds: [IDS.credit],
    });
    expect(app.fake.requests.find((r) => r.route === '/credits')?.query).toEqual({
      ownerPersonId: IDS.parent,
      limit: '50',
    });
  });

  it('§4.10: a quote of another payer reads not available', async () => {
    renderQuote({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline: the price stays with its expiry and checkout is disabled', async () => {
    const app = renderQuote({ routes: routes() });
    expect(await screen.findByRole('button', { name: 'Continue to checkout' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Continue to checkout' })).toBeDisabled();
    expect(screen.getByLabelText(/^Price valid until /)).toBeOnTheScreen();
  });
});
