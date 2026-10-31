/**
 * SCR-C-14 Checkout and payment (SPK-REG-006, SPK-REG-007, SPK-PAY-007, §4.9, §4.11; SPK-AT-005
 * final-place contention, SPK-AT-006 payment after hold expiry): server-owned hold with a
 * countdown, payment only through a provider token (development fake provider here), an unknown
 * outcome is never failure and is resolved by asking again with the same idempotency key when the
 * app returns to the foreground or reconnects, and the SPK-UX-008 states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  IDS,
  basket,
  checkout,
  familyRoutes,
  inMinutes,
  line,
  page,
  quote,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { CheckoutScreen } from '../CheckoutScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const HELD = basket({
  status: 'held',
  holdExpiresAt: inMinutes(9),
  lines: [
    line({ outcome: 'held' }),
    line({ id: IDS.lineB, participantPersonId: IDS.childB, outcome: 'held' }),
  ],
  revision: 4,
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /registration-quotes/{id}': { status: 200, body: quote() },
    'GET /baskets/{id}': { status: 200, body: HELD },
    ...overrides,
  };
}

function renderCheckout(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp(options);
  render(<CheckoutScreen quoteId={IDS.quote} />, { wrapper: app.wrapper });
  return app;
}

async function choosePaymentAndPay() {
  fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
  const pay = screen.getByRole('button', { name: 'Pay $226.00' });
  await act(async () => {
    fireEvent.press(pay);
  });
}

const checkoutRequests = (app: ReturnType<typeof createRegistrationTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/registration-checkouts');

describe('SCR-C-14 CheckoutScreen', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
  });

  it('SPK-REG-006: holds the places with the expected revision, then shows the server expiry and countdown', async () => {
    let current = basket();
    const app = renderCheckout({
      routes: routes({
        'GET /baskets/{id}': () => fakeResponse(200, current),
        'POST /baskets/{id}/hold': () => {
          current = HELD;
          return fakeResponse(200, HELD);
        },
      }),
    });
    expect(await screen.findByLabelText('Due now: $226.00')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();
    const hold = screen.getByRole('button', { name: 'Hold my places' });
    await act(async () => {
      fireEvent.press(hold);
    });
    expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/hold')?.body).toEqual({
      expectedRevision: 3,
    });
    expect(await screen.findByText('Countdown: about 9 minutes left')).toBeOnTheScreen();
    expect(screen.getAllByLabelText(/^Place held until /).length).toBeGreaterThan(0);
  });

  it('§4.11: pays with a provider token only (no card data, no amount) and hands off to the outcome', async () => {
    const app = renderCheckout({
      routes: routes({ 'POST /registration-checkouts': { status: 201, body: checkout() } }),
    });
    const pay = await screen.findByRole('button', { name: 'Pay $226.00' });
    expect(pay).toBeDisabled();
    await choosePaymentAndPay();
    expect(checkoutRequests(app)[0]?.body).toEqual({
      quoteId: IDS.quote,
      payment: { method: 'provider', paymentMethodToken: 'pm_fake_visa' },
      authorizeFutureInstallments: false,
    });
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    // Answered: the API lists the checkout from now on; nothing is left on the device.
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBeNull();
  });

  it('SPK-UX-001: a price already used for a checkout links to it from the API, after a reinstall too', async () => {
    renderCheckout({
      routes: routes({
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ status: 'consumed', consumedByCheckoutId: IDS.checkout }),
        },
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
      }),
    });
    expect(
      await screen.findByText(
        'A checkout already exists for this price. It is never charged twice.',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'See your payment and registration' }));
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
  });

  it('SPK-UX-001: a checking-out basket finds its checkout in GET /me/registration-checkouts', async () => {
    const app = renderCheckout({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
        'GET /me/registration-checkouts': page([checkout({ status: 'finalizing' })]),
      }),
    });
    fireEvent.press(
      await screen.findByRole('button', { name: 'See your payment and registration' }),
    );
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    expect(checkoutRequests(app)).toHaveLength(0);
  });

  it('SPK-PAY-007: a definite refusal leaves no unanswered checkout to look for later', async () => {
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () =>
          fakeResponse(409, apiErrorBody('QUOTE_EXPIRED', { nextAction: 'request_new_quote' })),
      }),
    });
    await choosePaymentAndPay();
    expect(await screen.findByText(/Error code: QUOTE_EXPIRED/)).toBeOnTheScreen();
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBeNull();
  });

  it('SPK-PAY-007: no answer is "being confirmed, do not pay again", and returning to the app asks again with the same key', async () => {
    let calls = 0;
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () => {
          calls += 1;
          if (calls === 1) throw new Error('connection lost while the app was in the background');
          return fakeResponse(201, checkout(), { 'Idempotent-Replayed': 'true' });
        },
      }),
    });
    await choosePaymentAndPay();
    expect(
      await screen.findByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Payment failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();

    await act(async () => {
      app.sources.setForeground(false);
      app.sources.setForeground(true);
    });
    await waitFor(() => expect(checkoutRequests(app)).toHaveLength(2));
    const [first, second] = checkoutRequests(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toEqual(first?.body);
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`),
    );
  });

  it('SPK-PAY-007: reconnecting, or "Check now", resends the same intent instead of paying again', async () => {
    let calls = 0;
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () => {
          calls += 1;
          if (calls <= 2) throw new Error('no connection');
          return fakeResponse(201, checkout());
        },
      }),
    });
    await choosePaymentAndPay();
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeOnTheScreen();
    await act(async () => {
      app.sources.setReachable(false);
    });
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    await act(async () => {
      app.sources.setReachable(true);
    });
    await waitFor(() => expect(checkoutRequests(app)).toHaveLength(2));
    const check = await screen.findByRole('button', { name: 'Check now' });
    await act(async () => {
      fireEvent.press(check);
    });
    await waitFor(() => expect(checkoutRequests(app)).toHaveLength(3));
    expect(new Set(checkoutRequests(app).map((r) => r.headers['idempotency-key'])).size).toBe(1);
  });

  it('SPK-PAY-007: a 5xx answer is no definite answer: "being confirmed, do not pay again", no payment methods, and "Check now" keeps the key', async () => {
    let calls = 0;
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(201, checkout());
        },
      }),
    });
    await choosePaymentAndPay();
    expect(
      await screen.findByLabelText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Succeeds at once' })).toBeNull();
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBe(IDS.quote);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check now' }));
    });
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`),
    );
    const [first, second] = checkoutRequests(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('§4.9 IDEMPOTENCY_OUTCOME_UNAVAILABLE: "Check now" that finds the checkout committed with its answer lost offers no payment, reads the price again and opens the checkout it names', async () => {
    let calls = 0;
    const app = renderCheckout({
      routes: routes({
        'GET /registration-quotes/{id}': () =>
          fakeResponse(
            200,
            calls >= 2
              ? quote({ status: 'consumed', consumedByCheckoutId: IDS.checkout })
              : quote(),
          ),
        'POST /registration-checkouts': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('Network request failed');
          return fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_OUTCOME_UNAVAILABLE', {
              nextAction: 'reload_current_state',
            }),
          );
        },
      }),
    });
    await choosePaymentAndPay();
    await act(async () => {
      fireEvent.press(await screen.findByRole('button', { name: 'Check now' }));
    });
    expect(
      await screen.findByText(
        'A checkout already exists for this price. It is never charged twice.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    // The checkout exists: the device still remembers its price until the outcome screen has it.
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBe(IDS.quote);
    fireEvent.press(screen.getByRole('button', { name: 'See your payment and registration' }));
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    expect(new Set(checkoutRequests(app).map((r) => r.headers['idempotency-key'])).size).toBe(1);
  });

  it('§4.9 IDEMPOTENCY_OUTCOME_UNAVAILABLE: while the price still reads unused, the answer is "This may already have been done" and nothing is offered to pay', async () => {
    renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () =>
          fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_OUTCOME_UNAVAILABLE', {
              nextAction: 'reload_current_state',
            }),
          ),
      }),
    });
    await choosePaymentAndPay();
    expect(await screen.findByLabelText('This may already have been done')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pay $226.00' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeOnTheScreen();
  });

  it('SPK-AT-005: losing the final place charges nothing and offers the waitlist', async () => {
    const app = renderCheckout({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket() },
        'POST /baskets/{id}/hold': () =>
          fakeResponse(
            409,
            apiErrorBody('CAPACITY_UNAVAILABLE', {
              message: 'No places capacity is available.',
              nextAction: 'join_waitlist_or_choose_alternative',
            }),
          ),
      }),
    });
    const hold = await screen.findByRole('button', { name: 'Hold my places' });
    await act(async () => {
      fireEvent.press(hold);
    });
    expect(await screen.findByText(/Error code: CAPACITY_UNAVAILABLE/)).toBeOnTheScreen();
    expect(
      screen.getByText('Nothing was charged. You can join the waitlist instead.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Join the waitlist for Ada' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Join the waitlist for Ben' })).toBeOnTheScreen();
    expect(checkoutRequests(app)).toHaveLength(0);
  });

  it('MISSING_ACKNOWLEDGMENT on hold opens the required forms', async () => {
    renderCheckout({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket() },
        'POST /baskets/{id}/hold': () =>
          fakeResponse(
            422,
            apiErrorBody('MISSING_ACKNOWLEDGMENT', { nextAction: 'complete_acknowledgment' }),
          ),
      }),
    });
    const hold = await screen.findByRole('button', { name: 'Hold my places' });
    await act(async () => {
      fireEvent.press(hold);
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Complete required forms' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/forms?basketId=${IDS.basket}`);
  });

  it('§4.9: after MISSING_ACKNOWLEDGMENT the next "Hold my places" is a new intent (the API would replay the stored refusal)', async () => {
    let holds = 0;
    const app = renderCheckout({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket() },
        'POST /baskets/{id}/hold': () => {
          holds += 1;
          return holds === 1
            ? fakeResponse(
                422,
                apiErrorBody('MISSING_ACKNOWLEDGMENT', { nextAction: 'complete_acknowledgment' }),
              )
            : fakeResponse(200, HELD);
        },
      }),
    });
    const hold = await screen.findByRole('button', { name: 'Hold my places' });
    await act(async () => {
      fireEvent.press(hold);
    });
    await screen.findByRole('button', { name: 'Complete required forms' });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Hold my places' }));
    });
    const keys = app.fake.requests
      .filter((r) => r.route === '/baskets/{id}/hold')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('remembers the quote before paying, so a restart mid-payment can find the checkout again', async () => {
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () => new Promise<Response>(() => undefined),
      }),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Pay $226.00' }));
    });
    await waitFor(() =>
      expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBe(IDS.quote),
    );
  });

  it('QUOTE_EXPIRED: gets a new price and moves the checkout to it', async () => {
    const app = renderCheckout({
      routes: routes({
        'POST /registration-checkouts': () =>
          fakeResponse(409, apiErrorBody('QUOTE_EXPIRED', { nextAction: 'request_new_quote' })),
        'POST /registration-quotes': { status: 201, body: quote({ id: IDS.quote2 }) },
      }),
    });
    await choosePaymentAndPay();
    const again = await screen.findByRole('button', { name: 'Get a new price' });
    await act(async () => {
      fireEvent.press(again);
    });
    expect(app.fake.requests.find((r) => r.route === '/registration-quotes')?.body).toEqual({
      basketId: IDS.basket,
      discountCodes: [],
      creditIds: [],
    });
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/checkout/${IDS.quote2}`);
  });

  it('confirms a quote with nothing due without any payment', async () => {
    const app = renderCheckout({
      routes: routes({
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({ dueNowMinor: 0, totalMinor: 0 }),
        },
        'POST /registration-checkouts': {
          status: 201,
          body: checkout({ paymentKind: 'none', payment: null }),
        },
      }),
    });
    const confirm = await screen.findByRole('button', { name: 'Confirm registration' });
    await act(async () => {
      fireEvent.press(confirm);
    });
    expect(checkoutRequests(app)[0]?.body).toEqual({
      quoteId: IDS.quote,
      authorizeFutureInstallments: false,
    });
  });

  it('SPK-PAY-006: an installment plan needs explicit authorization of the future payments', async () => {
    const app = renderCheckout({
      routes: routes({
        'GET /registration-quotes/{id}': {
          status: 200,
          body: quote({
            paymentPlan: 'installments',
            dueNowMinor: 11300,
            futureObligations: [
              { sequence: 2, dueAt: inMinutes(60 * 24 * 30), amountMinor: 11300 },
            ],
          }),
        },
        'POST /registration-checkouts': { status: 201, body: checkout() },
      }),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    expect(screen.getByRole('button', { name: 'Pay $113.00' })).toBeDisabled();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'I authorize the future payments listed on my price' }),
    );
    const pay = screen.getByRole('button', { name: 'Pay $113.00' });
    await act(async () => {
      fireEvent.press(pay);
    });
    expect(
      (checkoutRequests(app)[0]?.body as { authorizeFutureInstallments: boolean })
        .authorizeFutureInstallments,
    ).toBe(true);
  });

  it('SPK-REG-007: a basket awaiting approval cannot be paid', async () => {
    renderCheckout({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ approvalPending: true }) },
      }),
    });
    expect((await screen.findAllByLabelText('Awaiting approval')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Hold my places' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });

  it('§4.10: a quote of another payer reads not available', async () => {
    renderCheckout({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline: payment cannot start', async () => {
    const app = renderCheckout({ routes: routes() });
    fireEvent.press(await screen.findByRole('radio', { name: 'Succeeds at once' }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Pay $226.00' })).toBeDisabled();
    expect(screen.getByText('Payment cannot start without a connection.')).toBeOnTheScreen();
  });
});
