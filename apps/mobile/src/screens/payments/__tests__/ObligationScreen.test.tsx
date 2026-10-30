/**
 * SCR-C-34 one balance (SPK-PAY-005, SPK-PAY-006, SPK-PAY-007, §4.9, §4.11, SPK-UX-004,
 * SPK-UX-008): totals, order lines, installments with authorization, notices and the API's retry
 * rules; paying with one idempotency key per intent; "Payment processing" and an unknown outcome
 * never shown as success or failure, and never paid twice.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  installment,
  installmentPlan,
  obligation,
  order,
  paymentAttempt,
  receipt,
} from '../../../features/money/testing/fixtures';
import { formatInstant } from '../../../features/money/format';
import {
  LIST_IDS,
  liveAttempt,
  pageOf,
  unknownPayment,
} from '../../../features/money/testing/list-fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { ObligationScreen } from '../ObligationScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const SETTLED = obligation({
  status: 'settled',
  totals: {
    amountMinor: 4000,
    receivedMinor: 4000,
    allocatedMinor: 4000,
    remainingMinor: 0,
    excessMinor: 0,
    currency: 'USD',
  },
});

function outcome(status: string, extra: Record<string, unknown> = {}) {
  return {
    payment: paymentAttempt({ status, ...extra }),
    receipt: status === 'succeeded' ? receipt() : null,
    obligation: status === 'succeeded' ? SETTLED : obligation(),
    overpaymentCreditId: null,
  };
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /obligations/{id}': { status: 200, body: obligation() },
    'GET /orders/{id}': { status: 200, body: order() },
    'GET /installment-plans/{id}': { status: 200, body: installmentPlan() },
    'POST /obligations/{id}/payments': { status: 201, body: outcome('succeeded') },
    ...overrides,
  };
}

function renderObligation(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<ObligationScreen obligationId={IDS.obligation} />, { wrapper: app.wrapper });
  return app;
}

const payments = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/obligations/{id}/payments');

async function pay(scenario = 'Succeeds at once') {
  fireEvent.press(await screen.findByRole('radio', { name: scenario }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Pay $40.00' }));
  });
}

describe('SCR-C-34 ObligationScreen', () => {
  afterEach(settleApps);

  it('shows amount, received, applied, left to pay and the due date', async () => {
    renderObligation();
    expect(await screen.findByLabelText('Amount: $40.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Received: $0.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Applied to this balance: $0.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Left to pay: $40.00')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Order total: $120.00')).toBeOnTheScreen();
  });

  it('shows the order lines per participant and the order state', async () => {
    renderObligation();
    expect(await screen.findByLabelText('Autumn U10 League, Sam. $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Order total: $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration complete')).toBeOnTheScreen();
  });

  it('SPK-PAY-006: installments show amount, due date, state, authorization, reminders and the API retry rules', async () => {
    const plan = installmentPlan();
    renderObligation();
    expect(await screen.findByTestId('installments')).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        `Authorization: You authorized these installments on ${formatInstant(plan.authorization.authorizedAt)}`,
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Reminders: Sent 3 days before each due date')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('If a payment fails: Tried up to 3 times, 24 hours apart'),
    ).toBeOnTheScreen();
    expect(screen.getByTestId('installment-1')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^Installment 1: \$40\.00, Due .*, Paid$/),
    );
    expect(screen.getByText(/stays confirmed while they are paid/)).toBeOnTheScreen();
  });

  it('SPK-PAY-006: a failed installment reads "Payment attention needed" with the facility as the next step', async () => {
    renderObligation({
      'GET /installment-plans/{id}': {
        status: 200,
        body: installmentPlan({
          installments: [
            installment(1, {
              status: 'failed',
              lastFailureReason: 'Card declined',
              attemptCount: 3,
            }),
          ],
        }),
      },
    });
    expect(await screen.findByTestId('installment-1')).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/last attempt: Card declined, Payment attention needed$/),
    );
    expect(
      screen.getByText(/Retrying a failed installment is done by\s+the facility/),
    ).toBeOnTheScreen();
  });

  it('§4.9: pays with a provider token and an idempotency key, then shows "Payment received" with the receipt', async () => {
    let paid = false;
    const app = renderObligation({
      'GET /obligations/{id}': () => fakeResponse(200, paid ? SETTLED : obligation()),
      'POST /obligations/{id}/payments': () => {
        paid = true;
        return fakeResponse(201, outcome('succeeded'));
      },
    });
    await pay();
    expect(await screen.findByLabelText('Payment received')).toBeOnTheScreen();
    // The balance refreshes to "Paid"; the payment and its receipt stay on screen.
    await waitFor(() =>
      expect(screen.getByTestId('obligation-status')).toHaveProp('accessibilityLabel', 'Paid'),
    );
    expect(screen.queryByTestId('pay-section')).toBeNull();
    expect(screen.getByTestId('receipt')).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Receipt: $40.00 received ${formatInstant(receipt().receivedAt)}`),
    ).toBeOnTheScreen();
    const [sent] = payments(app);
    expect(sent?.body).toEqual({ paymentMethodToken: 'pm_fake_visa' });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-PAY-007: an unknown outcome says "Do not pay again", blocks paying and checks the attempt', async () => {
    const app = renderObligation({
      'POST /obligations/{id}/payments': {
        status: 201,
        body: outcome('unknown', { unknownSince: '2026-10-24T12:00:00.000Z', resolvedAt: null }),
      },
      'GET /payments/{id}': {
        status: 200,
        body: paymentAttempt({ status: 'unknown', unknownSince: '2026-10-24T12:00:00.000Z' }),
      },
    });
    await pay('Times out after the money was taken');
    expect(
      await screen.findByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Payment failed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    const reads = () => app.fake.requests.filter((r) => r.route === '/payments/{id}').length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0)); // the automatic first re-read
    await settleApps();
    const before = reads();
    const count = (route: string) => app.fake.requests.filter((r) => r.route === route).length;
    const balanceBefore = count('/obligations/{id}');
    const planBefore = count('/installment-plans/{id}');
    app.fake.set('GET /payments/{id}', {
      status: 200,
      body: paymentAttempt({ status: 'succeeded' }),
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(reads()).toBe(before + 1);
    // Settling the attempt re-reads the balance and the installments it changed.
    await waitFor(() => expect(count('/obligations/{id}')).toBeGreaterThan(balanceBefore));
    await waitFor(() => expect(count('/installment-plans/{id}')).toBeGreaterThan(planBefore));
  });

  it.each([
    [
      'IDEMPOTENCY_IN_PROGRESS',
      () =>
        fakeResponse(
          409,
          apiErrorBody('IDEMPOTENCY_IN_PROGRESS', { nextAction: 'retry_later_with_same_key' }),
        ),
    ],
    ['a 502 without the error contract', () => fakeResponse(502, '<html>Bad gateway</html>')],
  ])(
    'SPK-PAY-007: %s is an unknown outcome, never "Something went wrong", and paying stays blocked',
    async (_name, answer) => {
      renderObligation({ 'POST /obligations/{id}/payments': answer });
      await pay();
      expect(await screen.findByTestId('payment-no-answer')).toBeOnTheScreen();
      expect(screen.queryByText('Something went wrong')).toBeNull();
      expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    },
  );

  it('SPK-PAY-006: a plan authorized by someone else, or by no recorded person, never says "You authorized"', async () => {
    const plan = installmentPlan({
      authorization: {
        authorizedAt: installmentPlan().authorization.authorizedAt,
        authorizedByPersonId: null,
      },
    });
    renderObligation({ 'GET /installment-plans/{id}': { status: 200, body: plan } });
    expect(
      await screen.findByLabelText(
        `Authorization: Authorized on ${formatInstant(plan.authorization.authorizedAt)}`,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/You authorized/)).toBeNull();
  });

  it('SPK-UX-008: a failed order read shows its code and Try again, never a silently missing section', async () => {
    renderObligation({
      'GET /orders/{id}': () =>
        fakeResponse(
          500,
          apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
        ),
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
  });

  it('SPK-UX-004: "Payment processing" is its own state, distinct from received', async () => {
    renderObligation({
      'POST /obligations/{id}/payments': {
        status: 201,
        body: outcome('processing', { resolvedAt: null }),
      },
      'GET /payments/{id}': { status: 200, body: paymentAttempt({ status: 'processing' }) },
    });
    await pay('Processing, outcome later');
    expect(await screen.findByLabelText('Payment processing')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Payment received')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
  });

  it('§4.9: with no answer, "Check again" asks about the same payment with the same idempotency key', async () => {
    let attempts = 0;
    const app = renderObligation({
      'POST /obligations/{id}/payments': () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Network request failed');
        return fakeResponse(201, outcome('succeeded'));
      },
    });
    await pay();
    expect(await screen.findByTestId('payment-no-answer')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByLabelText('Payment received')).toBeOnTheScreen();
    const keys = payments(app).map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('PAYMENT_OUTCOME_UNKNOWN: a payment already in progress is never started again', async () => {
    renderObligation({
      'POST /obligations/{id}/payments': () =>
        fakeResponse(
          409,
          apiErrorBody('PAYMENT_OUTCOME_UNKNOWN', {
            message: 'The payment outcome is not yet known.',
            nextAction: 'await_reconciliation',
            details: { code: 'PAYMENT_IN_PROGRESS' },
          }),
        ),
    });
    await pay();
    expect(await screen.findByTestId('payment-in-progress')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: PAYMENT_OUTCOME_UNKNOWN/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
  });

  it('a declined payment reads "Payment failed" with the reason, and a new payment may be tried', async () => {
    renderObligation({
      'POST /obligations/{id}/payments': {
        status: 201,
        body: outcome('failed', { failureReason: 'The card was declined', resolvedAt: null }),
      },
    });
    await pay('Declined');
    expect(await screen.findByLabelText('Payment failed')).toBeOnTheScreen();
    expect(screen.getByText(/The card was declined\. Nothing was charged/)).toBeOnTheScreen();
  });

  it('validation failure: the API message is shown with its code', async () => {
    renderObligation({
      'POST /obligations/{id}/payments': () =>
        fakeResponse(
          400,
          apiErrorBody('VALIDATION_FAILED', {
            message: 'The payment exceeds the remaining balance.',
            nextAction: 'correct_input',
          }),
        ),
    });
    await pay();
    expect(await screen.findByText('The payment exceeds the remaining balance.')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();
  });

  it('offline: paying is disabled and needs a connection', async () => {
    const app = renderObligation();
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    expect(screen.getByText('Needs a connection.')).toBeOnTheScreen();
  });

  it('§4.10: a balance this account may not see reads "Not available"', async () => {
    renderObligation({
      'GET /obligations/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByTestId('pay-section')).toBeNull();
  });

  it('§4.11: a recovery-required order says the payment was received', async () => {
    renderObligation({
      'GET /orders/{id}': { status: 200, body: order({ fulfillmentStatus: 'recovery_required' }) },
    });
    expect(await screen.findByTestId('order-fulfillment')).toHaveProp(
      'accessibilityLabel',
      'Payment received. We are completing your registration.',
    );
  });
  it('SPK-PAY-007, FIN-01: a payment on its way from elsewhere blocks paying until the API no longer reports it', async () => {
    let live: ReturnType<typeof liveAttempt> | null = liveAttempt();
    const app = renderObligation({
      'GET /obligations/{id}': () => fakeResponse(200, obligation({ liveAttempt: live })),
      // The attempt is the account's own, so it can be opened.
      'GET /me/payments': pageOf([unknownPayment()]),
    });
    const section = await screen.findByTestId('live-attempt');
    expect(screen.getByTestId('live-attempt-status')).toHaveProp(
      'accessibilityLabel',
      'Payment outcome being confirmed. Do not pay again.',
    );
    expect(section).toBeOnTheScreen();
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    fireEvent.press(await screen.findByRole('button', { name: 'Open the payment' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/attempt/${LIST_IDS.attemptUnknown}`);
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));
    // The facility reconciled it: the balance no longer reports a live payment.
    live = null;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    await waitFor(() => expect(screen.queryByTestId('live-attempt')).toBeNull());
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeEnabled();
    expect(payments(app)).toHaveLength(0);
  });

  it('FIN-01: a payment someone else in the household started blocks paying but is not offered to open', async () => {
    const app = renderObligation({
      'GET /obligations/{id}': { status: 200, body: obligation({ liveAttempt: liveAttempt() }) },
      // The account's own payments do not include it: a co-guardian paid (GET /payments/{id}
      // would answer NOT_FOUND to this account).
      'GET /me/payments': pageOf([]),
    });
    const section = await screen.findByTestId('live-attempt');
    expect(
      await within(section).findByText(
        /may have been started by someone else who pays for this balance/,
      ),
    ).toBeOnTheScreen();
    expect(within(section).queryByRole('button', { name: 'Open the payment' })).toBeNull();
    expect(screen.getByTestId('live-attempt-status')).toHaveProp(
      'accessibilityLabel',
      'Payment outcome being confirmed. Do not pay again.',
    );
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    expect(screen.getByRole('button', { name: 'Pay $40.00' })).toBeDisabled();
    expect(app.fake.requests.find((r) => r.route === '/me/payments')?.query).toEqual({
      status: 'unknown',
      limit: '50',
    });
    expect(app.fake.requests.filter((r) => r.route === '/payments/{id}')).toHaveLength(0);
  });

  it('SPK-UX-010: a live attempt in "created" reads "Payment processing", the same as on its payment detail', async () => {
    renderObligation({
      'GET /obligations/{id}': {
        status: 200,
        body: obligation({ liveAttempt: liveAttempt({ status: 'created', unknownSince: null }) }),
      },
      'GET /me/payments': pageOf([]),
    });
    expect(await screen.findByTestId('live-attempt-status')).toHaveProp(
      'accessibilityLabel',
      'Payment processing',
    );
    expect(screen.queryByText(/depends on DEC-019/)).toBeNull();
  });

  it('SPK-UX-004: a live payment still processing reads "Payment processing", not received', async () => {
    renderObligation({
      'GET /obligations/{id}': {
        status: 200,
        body: obligation({
          liveAttempt: liveAttempt({ status: 'processing', unknownSince: null }),
        }),
      },
    });
    expect(await screen.findByTestId('live-attempt-status')).toHaveProp(
      'accessibilityLabel',
      'Payment processing',
    );
    expect(screen.queryByLabelText('Payment received')).toBeNull();
  });
});
