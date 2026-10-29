/**
 * SCR-C-15 Checkout outcome (§4.8 operations, §4.11, SPK-UX-004, SPK-PAY-007, SPK-AT-006): the
 * durable checkout read back with its operation and per-line enrollment and placement; success
 * only when the API confirms it; processing refreshed on return to the app; unknown, failed,
 * recovery and compensation each in their own words; not available and offline states.
 */
import { fakeResponse, type FakeHandler, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  IDS,
  basket,
  checkout,
  enrollment,
  familyRoutes,
  line,
  offering,
  operation,
  payment,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { CheckoutOutcomeScreen, outcomeLineStatus } from '../CheckoutOutcomeScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const LINES = basket({
  status: 'fulfilled',
  lines: [
    line({ outcome: 'confirmed', enrollmentId: IDS.enrollmentA }),
    line({
      id: IDS.lineB,
      participantPersonId: IDS.childB,
      outcome: 'confirmed',
      enrollmentId: IDS.enrollmentB,
    }),
  ],
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /registration-checkouts/{id}': { status: 200, body: checkout() },
    'GET /operations/{id}': { status: 200, body: operation('succeeded') },
    'GET /baskets/{id}': { status: 200, body: LINES },
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /enrollments/{id}': (req: FakeRequest) =>
      fakeResponse(
        200,
        req.params.id === IDS.enrollmentA
          ? enrollment(IDS.enrollmentA, IDS.childA, { placementRequestId: IDS.placement })
          : enrollment(IDS.enrollmentB, IDS.childB),
      ),
    'GET /placement-requests/{id}': {
      status: 200,
      body: { id: IDS.placement, status: 'unassigned' },
    },
    ...overrides,
  };
}

function renderOutcome(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp(options);
  render(<CheckoutOutcomeScreen checkoutId={IDS.checkout} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-15 CheckoutOutcomeScreen', () => {
  it('SPK-UX-004: names each line\'s confirmed state, keeping "awaiting placement" distinct from "confirmed"', async () => {
    const app = renderOutcome({
      progress: { pendingCheckoutQuoteId: IDS.quote },
      routes: routes(),
    });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'Ada: Autumn Youth Program. Confirmed in Autumn Youth Program. Awaiting placement.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Ben: Autumn Youth Program. Confirmed in Autumn Youth Program'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Request status: Done')).toBeOnTheScreen();
    expect(screen.getByLabelText('Payment received')).toBeOnTheScreen();
    expect(screen.getByLabelText('Received: $226.00')).toBeOnTheScreen();
    // The API has this checkout: the device forgets the request it remembered for its quote.
    await waitFor(() => expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBeNull());
    fireEvent.press(screen.getByRole('button', { name: 'See your schedule' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/schedule');
  });

  it('SPK-UX-001: "Payment processing" never reads as confirmed, and returning to the app shows the new state', async () => {
    let current = checkout({
      status: 'awaiting_payment',
      payment: payment({ status: 'processing' }),
      receipt: null,
      nextAction: 'await_payment_confirmation',
    });
    const app = renderOutcome({
      routes: routes({
        'GET /registration-checkouts/{id}': () => fakeResponse(200, current),
        'GET /operations/{id}': { status: 200, body: operation('running') },
      }),
    });
    expect((await screen.findAllByLabelText('Payment processing')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Request status: Processing')).toBeOnTheScreen();
    expect(screen.getAllByLabelText(/Waiting for the payment outcome$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Confirmed/)).toBeNull();

    current = checkout();
    await act(async () => {
      app.sources.setForeground(false);
      app.sources.setForeground(true);
    });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
  });

  it('SPK-PAY-007: an unknown outcome says do not pay again and offers no new payment', async () => {
    renderOutcome({
      routes: routes({
        'GET /registration-checkouts/{id}': {
          status: 200,
          body: checkout({
            status: 'awaiting_payment',
            payment: payment({ status: 'unknown' }),
            receipt: null,
            nextAction: 'await_reconciliation',
          }),
        },
      }),
    });
    expect(
      (await screen.findAllByLabelText('Payment outcome being confirmed. Do not pay again.'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/You will not be charged twice/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Try this payment method' })).toBeNull();
    expect(screen.queryByText('Payment failed')).toBeNull();
  });

  it('a failed payment may be retried with a new method only when the API says retry_payment', async () => {
    const app = renderOutcome({
      routes: routes({
        'GET /registration-checkouts/{id}': {
          status: 200,
          body: checkout({
            status: 'awaiting_payment',
            payment: payment({ status: 'failed', failureReason: 'The card was declined.' }),
            receipt: null,
            nextAction: 'retry_payment',
          }),
        },
        'POST /registration-checkouts/{id}/payments': { status: 201, body: checkout() },
      }),
    });
    expect((await screen.findAllByLabelText('Payment failed')).length).toBeGreaterThan(0);
    expect(screen.getByText('The card was declined.')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: 'Succeeds at once' }));
    const retry = screen.getByRole('button', { name: 'Try this payment method' });
    await act(async () => {
      fireEvent.press(retry);
    });
    const sent = app.fake.requests.find((r) => r.route === '/registration-checkouts/{id}/payments');
    expect(sent?.body).toEqual({ paymentMethodToken: 'pm_fake_visa' });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('§4.11: recovery required and compensation are explicit, never "confirmed" or "failed"', async () => {
    const app = renderOutcome({
      routes: routes({
        'GET /registration-checkouts/{id}': {
          status: 200,
          body: checkout({ status: 'recovery_required', nextAction: 'await_staff_recovery' }),
        },
      }),
    });
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Staff are\s+completing it\. Do not pay again\./)).toBeOnTheScreen();

    app.fake.set('GET /registration-checkouts/{id}', {
      status: 200,
      body: checkout({
        status: 'compensated',
        recovery: {
          reasonCode: 'x',
          message: 'm',
          plan: 'credit',
          refundAttemptId: null,
          creditId: IDS.credit,
          exceptionId: null,
        },
      }),
    });
    await act(async () => {
      await app.queryClient.invalidateQueries({
        queryKey: ['api', '/registration-checkouts/{id}'],
      });
    });
    expect(
      await screen.findByLabelText('Payment returned. Registration was not completed.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Your payment was returned to you as a credit on your account.'),
    ).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Not registered')).toHaveLength(2);
  });

  it('an older checkout forgets only its own quote: another unanswered checkout stays remembered', async () => {
    const app = renderOutcome({
      progress: { pendingCheckoutQuoteId: IDS.quote2 },
      routes: routes(),
    });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
    await act(async () => undefined);
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBe(IDS.quote2);
  });

  it('SPK-UX-001: a finished checkout leaves "In progress": the customer lists are read again', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    const listed = ['api', '/me/registration-checkouts', null, { limit: 20 }];
    app.queryClient.setQueryData(listed, { data: { items: [], nextCursor: null } });
    render(<CheckoutOutcomeScreen checkoutId={IDS.checkout} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
    await waitFor(() => expect(app.queryClient.getQueryState(listed)?.isInvalidated).toBe(true));
  });

  it('SPK-PAY-007: a payment retry with no answer is never shown as failed, and only "Check again" is offered', async () => {
    let posts = 0;
    const app = renderOutcome({
      routes: routes({
        'GET /registration-checkouts/{id}': {
          status: 200,
          body: checkout({
            status: 'awaiting_payment',
            payment: payment({ status: 'failed', failureReason: 'The card was declined.' }),
            receipt: null,
            nextAction: 'retry_payment',
          }),
        },
        'POST /registration-checkouts/{id}/payments': () => {
          posts += 1;
          throw new TypeError('Network request failed');
        },
      }),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try this payment method' }));
    });
    expect(
      (await screen.findAllByLabelText('Payment outcome being confirmed. Do not pay again.'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('The card was declined.')).toBeNull();
    expect(screen.queryByText(/The payment did not go through/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try this payment method' })).toBeNull();
    expect(screen.queryAllByLabelText(/Not registered yet$/)).toHaveLength(0);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    const keys = app.fake.requests
      .filter((r) => r.route === '/registration-checkouts/{id}/payments')
      .map((r) => r.headers['idempotency-key']);
    expect(posts).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    // The checkout is re-read while the new attempt's outcome is unknown.
    expect(
      app.fake.requests.filter((r) => r.route === '/registration-checkouts/{id}').length,
    ).toBeGreaterThan(1);
  });

  it('SPK-UX-010: line words agree with the badges above them before the checkout completes', () => {
    expect(outcomeLineStatus({ status: 'recovery_required', payment: null }).label).toBe(
      'Payment received. Registration being completed.',
    );
    expect(outcomeLineStatus({ status: 'finalizing', payment: null }).label).toBe(
      'Payment processing',
    );
    expect(
      outcomeLineStatus({ status: 'awaiting_payment', payment: payment({ status: 'failed' }) })
        .label,
    ).toBe('Not registered yet');
    expect(
      outcomeLineStatus({ status: 'awaiting_payment', payment: payment({ status: 'unknown' }) })
        .label,
    ).toBe('Waiting for the payment outcome');
    expect(outcomeLineStatus({ status: 'aborted', payment: null }).label).toBe('Not registered');
  });

  it('§4.10: a checkout of another account reads not available', async () => {
    renderOutcome({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('§4.15: offline shows the last known status with its age', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = renderOutcome({ now: () => now, routes: routes() });
    expect(await screen.findByLabelText('Registration complete')).toBeOnTheScreen();
    now = new Date('2026-10-24T12:05:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByText('Showing information from 5 minutes ago.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration complete')).toBeOnTheScreen();
  });
});
