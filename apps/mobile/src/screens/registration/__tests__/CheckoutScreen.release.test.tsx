/**
 * SCR-C-14 in a release build (no development payment method): the payment provider is not
 * selected (DEC-019, §5.2), so paying in the app shows the pending-decision state and never
 * collects card details; a quote with nothing due can still be confirmed.
 */
import { render, screen } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  inMinutes,
  quote,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { CheckoutScreen } from '../CheckoutScreen';

jest.mock('../../../features/registration/dev', () => ({ DevPaymentMethodPicker: null }));

const HELD = basket({ status: 'held', holdExpiresAt: inMinutes(9) });

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
    expect(await screen.findByLabelText('Waiting on a decision')).toBeOnTheScreen();
    expect(
      screen.getByText(/Paying in the app is not available yet: it depends on DEC-019/),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('dev-payment-method')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay $226.00' })).toBeDisabled();
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
    expect(screen.queryByLabelText('Waiting on a decision')).toBeNull();
    await app.settle();
  });
});
