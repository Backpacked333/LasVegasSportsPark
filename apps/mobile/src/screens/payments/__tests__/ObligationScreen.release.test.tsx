/**
 * SCR-C-34 in a release build: the payment provider is not selected (DEC-019, Technical
 * lead/account owners), so no payment method can be collected. The screen shows that pending
 * decision and offers no "Pay" button; the development payment method is absent.
 */
import { render, screen } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  installmentPlan,
  obligation,
  order,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { ObligationScreen } from '../ObligationScreen';

// Release bundles drop the development module (`__DEV__` is false); stand in for that here.
jest.mock('../../../features/money/dev', () => ({ DevPaymentMethodPicker: null }));

describe('SCR-C-34 ObligationScreen (release build)', () => {
  afterEach(settleApps);

  it('DEC-019: shows the pending decision instead of a payment method, and no Pay button', async () => {
    const app = createTestApp({
      routes: {
        ...accountRoutes(),
        'GET /obligations/{id}': { status: 200, body: obligation() },
        'GET /orders/{id}': { status: 200, body: order() },
        'GET /installment-plans/{id}': { status: 200, body: installmentPlan() },
      },
    });
    render(<ObligationScreen obligationId={IDS.obligation} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Waiting on a decision')).toBeOnTheScreen();
    // The rest of the balance still loads: order lines and installments are not payment methods.
    expect(await screen.findByLabelText('Order total: $120.00')).toBeOnTheScreen();
    expect(await screen.findByTestId('installments')).toBeOnTheScreen();
    expect(
      screen.getByText(/Paying in the app is not available yet: it depends on DEC-019/),
    ).toBeOnTheScreen();
    expect(screen.getByText(/owner: Technical lead\/account owners/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    expect(screen.queryByTestId('dev-payment-method')).toBeNull();
  });
});
