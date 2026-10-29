/**
 * SCR-C-34 one order (SPK-PAY-002, SPK-PAY-006, SPK-PAY-007, §4.11, SPK-UX-008): the lines per
 * participant with the order's states, each balance it created with its own state (a payment on
 * its way named on its row), the installments, and the not-available and error states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  installmentPlan,
  obligation,
  order,
} from '../../../features/money/testing/fixtures';
import { liveAttempt } from '../../../features/money/testing/list-fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { OrderScreen } from '../OrderScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function renderOrder(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({
    routes: {
      ...accountRoutes(),
      'GET /orders/{id}': { status: 200, body: order() },
      'GET /obligations/{id}': { status: 200, body: obligation() },
      'GET /installment-plans/{id}': { status: 200, body: installmentPlan() },
      ...overrides,
    },
  });
  render(<OrderScreen orderId={IDS.order} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-34 OrderScreen', () => {
  afterEach(settleApps);
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-PAY-002: shows the lines per participant, the total and the order states', async () => {
    renderOrder();
    expect(await screen.findByLabelText('Autumn U10 League, Sam. $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Order total: $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Due at checkout: $40.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration complete')).toBeOnTheScreen();
  });

  it('lists the balances the order created and opens one by its opaque id', async () => {
    renderOrder();
    const balances = await screen.findByTestId('order-balances');
    const row = await within(balances).findByRole('button', {
      name: /^Installment 2 of 3, Left to pay \$40\.00 of \$40\.00, Due /,
    });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/${IDS.obligation}`);
  });

  it('SPK-PAY-007: a balance with a payment on its way says not to pay again', async () => {
    renderOrder({
      'GET /obligations/{id}': { status: 200, body: obligation({ liveAttempt: liveAttempt() }) },
    });
    expect(
      await screen.findByLabelText(
        'Installment 2 of 3, Left to pay $40.00 of $40.00, Payment outcome being confirmed. Do not pay again.',
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-PAY-006: shows the installment plan of the order', async () => {
    renderOrder();
    expect(await screen.findByTestId('installments')).toBeOnTheScreen();
    expect(screen.getByLabelText('Reminders: Sent 3 days before each due date')).toBeOnTheScreen();
  });

  it('§4.11: an order in recovery says the payment was received', async () => {
    renderOrder({
      'GET /orders/{id}': { status: 200, body: order({ fulfillmentStatus: 'recovery_required' }) },
    });
    expect(await screen.findByTestId('order-fulfillment')).toHaveProp(
      'accessibilityLabel',
      'Payment received. We are completing your registration.',
    );
  });

  it('SPK-UX-008: a failed balance read shows its code and "Try again" without hiding the order', async () => {
    renderOrder({
      'GET /obligations/{id}': () =>
        fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-ob' })),
    });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-ob/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Order total: $120.00')).toBeOnTheScreen();
  });

  it('§4.10: an order this account may not see reads "Not available"', async () => {
    renderOrder({ 'GET /orders/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/Autumn U10 League/)).toBeNull();
  });
});
