/**
 * SCR-C-34 in a release build: the payment provider is not selected (DEC-019, Technical
 * lead/account owners), so no payment method can be collected. The screen says to pay at the
 * front desk for now (PA-11), with the decision in the closed "Details for support" fold, and
 * offers no "Pay" button; the development payment method is absent.
 */
import { render, screen, within } from '@testing-library/react-native';
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
import { PAY_AT_DESK_MESSAGE } from '../../../features/money/surfaces';
import { ObligationScreen } from '../ObligationScreen';
import { openSupportDetails } from '../../../testing/ui-surfaces';

// Release bundles drop the development module (`__DEV__` is false); stand in for that here.
jest.mock('../../../features/money/dev', () => ({ DevPaymentMethodPicker: null }));

/** PA-11 (was "Paying in the app. This isn't available in the app yet."). */
const PAY_AT_DESK = "Paying in the app isn't available yet. Pay at the front desk for now.";

function renderRelease() {
  const app = createTestApp({
    routes: {
      ...accountRoutes(),
      'GET /obligations/{id}': { status: 200, body: obligation() },
      'GET /orders/{id}': { status: 200, body: order() },
      'GET /installment-plans/{id}': { status: 200, body: installmentPlan() },
    },
  });
  render(<ObligationScreen obligationId={IDS.obligation} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-34 ObligationScreen (release build)', () => {
  afterEach(settleApps);

  it('DEC-019: says to pay at the front desk for now, with no payment method and no Pay button', async () => {
    renderRelease();
    expect(await screen.findByLabelText(PAY_AT_DESK)).toBeOnTheScreen();
    expect(PAY_AT_DESK_MESSAGE).toBe(PAY_AT_DESK);
    // The rest of the amount due still loads: order lines and installments are not payment methods.
    expect(await screen.findByLabelText('Order total: $120.00')).toBeOnTheScreen();
    expect(await screen.findByTestId('installments')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    expect(screen.queryByTestId('dev-payment-method')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('DEC-019 (PA-11): the decision is in the "Details for support" fold, closed until opened', async () => {
    renderRelease();
    expect(await screen.findByLabelText(PAY_AT_DESK)).toBeOnTheScreen();
    const card = within(screen.getByTestId('pay-at-desk'));
    // Closed: the decision is not on the page until the customer opens the fold.
    expect(card.getByRole('button', { name: 'Details for support' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ expanded: false }),
    );
    expect(screen.queryByText('Decision: DEC-019')).toBeNull();
    expect(screen.queryByText(/DEC-019/)).toBeNull();
    // Open: the decision and its owner, inside the pay-at-desk card; the message stays.
    await openSupportDetails(card);
    expect(card.getByRole('button', { name: 'Details for support' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ expanded: true }),
    );
    expect(card.getByText('Decision: DEC-019')).toBeOnTheScreen();
    expect(card.getByText('Owner: Technical lead/account owners')).toBeOnTheScreen();
    expect(screen.getByLabelText(PAY_AT_DESK)).toBeOnTheScreen();
  });
});
