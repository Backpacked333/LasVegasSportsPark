/**
 * SCR-C-14 in a release build (no development payment method): the payment provider is not
 * selected (DEC-019, §5.2), so the Pay step says to pay at the front desk until the spots' hold
 * ends (PA-11; DEC-019 in the support fold) and never collects card details; a quote with
 * nothing due can still be confirmed.
 */
import { render, screen, within } from '@testing-library/react-native';
import { formatInstant } from '../../../features/registration/format';
import {
  IDS,
  basket,
  familyRoutes,
  inMinutes,
  quote,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { CheckoutScreen, payAtDeskMessage } from '../CheckoutScreen';
import { openSupportDetails } from '../../../testing/ui-surfaces';

jest.mock('../../../features/registration/dev', () => ({ DevPaymentMethodPicker: null }));

const HELD = basket({ status: 'held', holdExpiresAt: inMinutes(9) });
/** PA-11 (was "Paying in the app. This isn't available in the app yet."). */
const PAY_AT_DESK = `Paying in the app isn't available yet. Pay at the front desk for now. Your spots are held until ${formatInstant(HELD.holdExpiresAt as string)}.`;

describe('SCR-C-14 CheckoutScreen (release build)', () => {
  it('DEC-019: shows paying in the app as waiting on the provider decision, with no way to enter card details', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /registration-quotes/{id}': { status: 200, body: quote() },
        'GET /baskets/{id}': { status: 200, body: HELD },
      },
    });
    render(<CheckoutScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText(PAY_AT_DESK)).toBeOnTheScreen();
    expect(screen.getByLabelText('Step 5 of 5, Pay')).toBeOnTheScreen();
    // The fold is closed: the decision is not on the page until the customer opens it.
    const card = within(screen.getByTestId('checkout-pay-at-desk'));
    expect(card.getByRole('button', { name: 'Details for support' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ expanded: false }),
    );
    expect(screen.queryByText('Decision: DEC-019')).toBeNull();
    await openSupportDetails(screen);
    expect(card.getByText('Decision: DEC-019')).toBeOnTheScreen();
    expect(card.getByText('Owner: Technical lead/account owners')).toBeOnTheScreen();
    expect(screen.getByLabelText(PAY_AT_DESK)).toBeOnTheScreen();
    expect(screen.queryByTestId('dev-payment-method')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    // Nothing can be paid in the app, so no Pay button is drawn disabled under the message.
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();
    // The held time is said once by the hold notice (and in the message), not by a second badge.
    expect(screen.getAllByLabelText(/^Place held until /)).toHaveLength(1);
    expect(screen.queryByTestId('checkout-basket-status')).toBeNull();
    await app.settle();
  });

  it('confirms a quote with nothing due without a payment provider', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /registration-quotes/{id}': { status: 200, body: quote({ dueNowMinor: 0 }) },
        'GET /baskets/{id}': { status: 200, body: HELD },
      },
    });
    render(<CheckoutScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Confirm registration' })).toBeEnabled();
    expect(screen.queryByLabelText(PAY_AT_DESK)).toBeNull();
    await app.settle();
  });

  it('DEC-019: the time comes only from the real hold; without one the message says what to do', () => {
    expect(payAtDeskMessage(null)).toBe(
      "Paying in the app isn't available yet. Pay at the front desk for now.",
    );
    expect(payAtDeskMessage(HELD.holdExpiresAt)).toBe(PAY_AT_DESK);
  });
});
