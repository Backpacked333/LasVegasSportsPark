/**
 * SCR-C-34 one payment attempt (SPK-PAY-007, SPK-PAY-008, SPK-UX-004, SPK-UX-008, §4.10): its
 * state in the journeys.md words with "Check again" for an unresolved one, its refunds with their
 * own states, links to what it paid for, and the not-available and error states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { formatInstant } from '../../../features/money/format';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  inDays,
} from '../../../features/money/testing/fixtures';
import { LIST_IDS, paymentDetail, refund } from '../../../features/money/testing/list-fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { PaymentAttemptScreen } from '../PaymentAttemptScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function renderPayment(handler: FakeHandler) {
  const app = createTestApp({ routes: { ...accountRoutes(), 'GET /payments/{id}': handler } });
  render(<PaymentAttemptScreen paymentId={IDS.attempt} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-34 PaymentAttemptScreen', () => {
  afterEach(settleApps);
  beforeEach(() => mockRouter.push.mockClear());

  it('shows a received payment with its amount, payer and what it paid for', async () => {
    renderPayment({ status: 200, body: paymentDetail() });
    expect(await screen.findByLabelText('Payment received')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Balance payment' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Amount: $40.00')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Payer: You')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Open the balance' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/${IDS.obligation}`);
    fireEvent.press(screen.getByRole('button', { name: 'Open the order' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/order/${IDS.order}`);
    // What can still be refunded is a finance figure, not shown to the customer.
    expect(screen.queryByText(/refundable/i)).toBeNull();
  });

  it('SPK-PAY-007: an unknown outcome says "Do not pay again"; "Check again" reads it again, never pays', async () => {
    let status = 'unknown';
    const app = renderPayment(() =>
      fakeResponse(
        200,
        paymentDetail({
          status,
          unknownSince: inDays(-1),
          resolvedAt: status === 'unknown' ? null : inDays(0),
        }),
      ),
    );
    expect(
      await screen.findByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(new RegExp(`waiting since ${formatInstant(inDays(-1))}`)),
    ).toBeOnTheScreen();
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    status = 'succeeded';
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByLabelText('Payment received')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('SPK-UX-004: "Payment processing" is its own state with "Check again"', async () => {
    renderPayment({ status: 200, body: paymentDetail({ status: 'processing', resolvedAt: null }) });
    expect(await screen.findByLabelText('Payment processing')).toBeOnTheScreen();
    expect(
      screen.getByText(/still working on this payment\. Do not pay again\./),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeOnTheScreen();
  });

  it('DEC-019: a step the provider asks for is the pending decision, not an action the app invents', async () => {
    renderPayment({
      status: 200,
      body: paymentDetail({ status: 'action_required', resolvedAt: null }),
    });
    expect(await screen.findByLabelText('Payment needs your action')).toBeOnTheScreen();
    expect(screen.getByText(/depends on DEC-019/)).toBeOnTheScreen();
  });

  it('SPK-PAY-008: refunds show their own states; one being confirmed is never "Refunded"', async () => {
    renderPayment({
      status: 200,
      body: paymentDetail({
        refunds: [
          refund(),
          refund({ id: LIST_IDS.refundUnknown, status: 'unknown', amountMinor: 500 }),
        ],
      }),
    });
    const refunds = await screen.findByTestId('payment-refunds');
    expect(
      within(refunds).getByLabelText(
        `Refund of $10.00, Requested ${formatInstant(inDays(-2))}, Refunded`,
      ),
    ).toBeOnTheScreen();
    expect(
      within(refunds).getByLabelText(
        `Refund of $5.00, Requested ${formatInstant(inDays(-2))}, Refund outcome being confirmed`,
      ),
    ).toBeOnTheScreen();
    expect(within(refunds).getByText(/checked by the facility/)).toBeOnTheScreen();
  });

  it('links a contribution payment to its contribution and a checkout payment to its registration', async () => {
    renderPayment({
      status: 200,
      body: paymentDetail({
        purpose: 'contribution',
        obligationId: null,
        orderId: null,
        contributionRequestId: LIST_IDS.contribution,
        checkoutId: LIST_IDS.checkout,
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Open the contribution' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/contribution/${LIST_IDS.contribution}`);
    fireEvent.press(screen.getByRole('button', { name: 'Open the registration' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${LIST_IDS.checkout}`);
  });

  it('§4.10: a payment this account may not see reads "Not available" with no detail', async () => {
    renderPayment(() =>
      fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    );
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/\$40\.00|NOT_FOUND/)).toBeNull();
  });

  it('shows the API error code and reference with "Try again"', async () => {
    let calls = 0;
    renderPayment(() => {
      calls += 1;
      return calls === 1
        ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-pay' }))
        : fakeResponse(200, paymentDetail());
    });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-pay/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByLabelText('Payment received')).toBeOnTheScreen());
  });

  it('§4.15: offline keeps the payment with its age and disables "Check again"', async () => {
    const app = renderPayment({
      status: 200,
      body: paymentDetail({ status: 'unknown', resolvedAt: null }),
    });
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getAllByText(/^Showing information from/).length).toBeGreaterThan(0);
    expect(
      screen.getByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
  });
});
