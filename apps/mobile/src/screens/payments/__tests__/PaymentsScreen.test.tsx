/**
 * SCR-C-34 Payments and obligations list (SPK-PAY-005, SPK-PAY-006, SPK-PAY-007, SPK-UX-008):
 * balances due and history for the chosen person, with amounts left to pay, overpayments shown,
 * a payment on its way named on its balance, the account's payments, receipts and orders
 * (FIN-01), what needs attention, and every SPK-UX-008 state the lists define.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  inDays,
  obligation,
  order,
  page,
  paymentAttempt,
  receipt,
} from '../../../features/money/testing/fixtures';
import {
  LIST_IDS,
  checkout,
  contributionRequest,
  liveAttempt,
  pageOf,
  unknownPayment,
} from '../../../features/money/testing/list-fixtures';
import { formatDay, formatInstant } from '../../../features/money/format';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { PaymentsScreen } from '../PaymentsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const DUE = obligation();
const OVERDUE = obligation({
  id: IDS.obligationB,
  description: 'Registration order',
  dueAt: '2026-10-01T12:00:00.000Z',
});
const PAID = obligation({
  id: '0192f1a0-0000-7000-8000-000000000703',
  description: 'Installment 1 of 3',
  status: 'settled',
  totals: {
    amountMinor: 4000,
    receivedMinor: 4500,
    allocatedMinor: 4000,
    remainingMinor: 0,
    excessMinor: 500,
    currency: 'USD',
  },
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /obligations': page([OVERDUE, DUE, PAID]),
    // Nothing needs attention unless a test says so.
    'GET /me/payments': page([]),
    'GET /me/registration-checkouts': page([]),
    ...overrides,
  };
}

async function show(view: string) {
  fireEvent.press(await screen.findByRole('radio', { name: view }));
}

describe('SCR-C-34 PaymentsScreen', () => {
  afterEach(settleApps);

  it('lists balances due and history with what is left to pay and the status', async () => {
    const app = createTestApp({ routes: routes() });
    render(<PaymentsScreen />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Balances due' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'History' })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', {
        name: `Installment 2 of 3, Left to pay $40.00 of $40.00, Due ${formatDay(DUE.dueAt)}`,
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText(`Payment due since ${formatDay(OVERDUE.dueAt)}`),
    ).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/obligations')?.query).toEqual({
      debtorPersonId: IDS.self,
      limit: '50',
    });
  });

  it('SPK-PAY-005: an overpayment stays visible, never a silent zero', async () => {
    const app = createTestApp({ routes: routes() });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'Installment 1 of 3, $40.00. Paid beyond the balance: $5.00, Paid',
      }),
    ).toBeOnTheScreen();
  });

  it('opens a balance by its opaque id', async () => {
    const app = createTestApp({ routes: routes() });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: /^Installment 2 of 3/ }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/${IDS.obligation}`);
  });

  it('shows the empty state when nothing is owed or paid', async () => {
    const app = createTestApp({ routes: routes({ 'GET /obligations': page([]) }) });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No payments' })).toBeOnTheScreen();
  });

  it('shows the API error code, reference and recovery action', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations': () =>
          fakeResponse(
            500,
            apiErrorBody('INTERNAL_ERROR', {
              message: 'Something failed on our side.',
              nextAction: 'retry_or_contact_support',
              correlationId: 'corr-34',
            }),
          ),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-34/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.10: balances of a person this account may not see read "Not available", nothing of the other payer', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations': (req) =>
          req.query.debtorPersonId === IDS.child
            ? fakeResponse(404, apiErrorBody('NOT_FOUND'))
            : fakeResponse(200, { items: [DUE], nextCursor: null }),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: 'Sam' }));
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText('Installment 2 of 3')).toBeNull();
  });

  it('§4.15: offline keeps the list with its age and says paying needs a connection', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Balances due' })).toBeOnTheScreen();
    now = new Date('2026-10-24T13:00:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByText('Showing information from 1 hour ago.')).toBeOnTheScreen();
    expect(screen.getByText('Needs a connection: paying a balance.')).toBeOnTheScreen();
  });
  it('offers the views as an accessible radio group, balances first', async () => {
    const app = createTestApp({ routes: routes() });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    const group = await screen.findByLabelText('Show');
    expect(group).toHaveProp('accessibilityRole', 'radiogroup');
    for (const name of ['Balances due', 'Payments', 'Receipts', 'Orders', 'Team contributions']) {
      expect(within(group).getByRole('radio', { name })).toBeOnTheScreen();
    }
    expect(within(group).getByRole('radio', { name: 'Balances due' })).toBeChecked();
    // Only the chosen view is read.
    expect(app.fake.requests.filter((r) => r.route === '/me/receipts')).toHaveLength(0);
  });

  it('SPK-PAY-007: a balance with a payment on its way says not to pay again on its row', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /obligations': page([obligation({ liveAttempt: liveAttempt() })]) }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('button', {
        name: 'Installment 2 of 3, Left to pay $40.00 of $40.00, Payment outcome being confirmed. Do not pay again.',
      }),
    ).toBeOnTheScreen();
  });

  it('§4.5: more balances load with the API cursor, never silently cut off', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations': (req) =>
          req.query.cursor === 'c2'
            ? fakeResponse(200, { items: [PAID], nextCursor: null })
            : fakeResponse(200, { items: [DUE], nextCursor: 'c2' }),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await screen.findByRole('header', { name: 'Balances due' });
    expect(screen.queryByRole('header', { name: 'History' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Load more balances' }));
    expect(await screen.findByRole('header', { name: 'History' })).toBeOnTheScreen();
    const reads = app.fake.requests.filter((r) => r.route === '/obligations');
    expect(reads.at(-1)?.query).toEqual({ debtorPersonId: IDS.self, limit: '50', cursor: 'c2' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more balances' })).toBeNull(),
    );
  });

  it('§4.11, SPK-PAY-007: needs attention lists an unknown payment and a checkout in recovery', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/payments': (req) =>
          fakeResponse(200, {
            items: req.query.status === 'unknown' ? [unknownPayment()] : [],
            nextCursor: null,
          }),
        'GET /me/registration-checkouts': (req) =>
          fakeResponse(200, {
            items: req.query.status === 'recovery_required' ? [checkout()] : [],
            nextCursor: null,
          }),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('needs-attention');
    const payment = await within(section).findByRole('button', {
      name: `Balance payment: $40.00, Payer: You. Started ${formatInstant(inDays(-1))}, Payment outcome being confirmed. Do not pay again.`,
    });
    expect(
      within(section).getByText(/Do not pay again for a payment being confirmed/),
    ).toBeOnTheScreen();
    fireEvent.press(payment);
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/attempt/${LIST_IDS.attemptUnknown}`);
    fireEvent.press(
      within(section).getByRole('button', {
        name: /^Registration payment, \$40\.00\. Started .*, Payment received\. We are completing your registration\.$/,
      }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${LIST_IDS.checkout}`);
    expect(app.fake.requests.find((r) => r.route === '/me/registration-checkouts')?.query).toEqual({
      status: 'recovery_required',
      limit: '20',
    });
  });

  it('needs attention shows its own read failure with the code, without hiding the balances', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/payments': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { correlationId: 'corr-att' })),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(/Error code: INTERNAL_ERROR\. Reference: corr-att/),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'Balances due' })).toBeOnTheScreen();
  });

  it('SPK-PAY-007: the payments view lists each attempt by state; unknown is never success or failure', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/payments': (req) =>
          fakeResponse(200, {
            items:
              req.query.status === 'unknown'
                ? []
                : [
                    unknownPayment(),
                    paymentAttempt({
                      id: LIST_IDS.attemptProcessing,
                      purpose: 'contribution',
                      status: 'processing',
                      amountMinor: 7500,
                      payerPersonId: IDS.child,
                      posSaleId: null,
                    }),
                    paymentAttempt({ posSaleId: null }),
                  ],
            nextCursor: null,
          }),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Payments');
    const list = await screen.findByTestId('my-payments');
    expect(
      await within(list).findByLabelText(
        `Balance payment: $40.00, Payer: You. Started ${formatInstant(inDays(-1))}, Payment outcome being confirmed. Do not pay again.`,
      ),
    ).toBeOnTheScreen();
    expect(
      within(list).getByRole('button', {
        name: /^Team contribution: \$75\.00, Payer: Sam\. .*, Payment processing$/,
      }),
    ).toBeOnTheScreen();
    expect(
      within(list).getByRole('button', {
        name: /^Balance payment: \$40\.00, Payer: You\. .*, Payment received$/,
      }),
    ).toBeOnTheScreen();
    fireEvent.press(within(list).getByTestId(`payment-${LIST_IDS.attemptProcessing}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/attempt/${LIST_IDS.attemptProcessing}`);
    expect(
      app.fake.requests.filter((r) => r.route === '/me/payments').map((r) => r.query),
    ).toContainEqual({ limit: '20' });
  });

  it('the payments view shows its empty state and its error code with "Try again"', async () => {
    let fail = true;
    const app = createTestApp({
      routes: routes({
        'GET /me/payments': (req) =>
          req.query.status === 'unknown'
            ? fakeResponse(200, { items: [], nextCursor: null })
            : fail
              ? fakeResponse(
                  503,
                  apiErrorBody('INTEGRATION_UNAVAILABLE', {
                    nextAction: 'retry_later',
                    correlationId: 'c-pay',
                  }),
                )
              : fakeResponse(200, { items: [], nextCursor: null }),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Payments');
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-pay/),
    ).toBeOnTheScreen();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('header', { name: 'No payments yet' })).toBeOnTheScreen();
  });

  it('SPK-PAY-005: receipts show what was applied and keep an overpayment visible', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/receipts': pageOf([
          receipt({ excessMinor: 500, amountMinor: 4500 }),
          receipt({
            id: LIST_IDS.receiptCash,
            sourceKind: 'cash_tender',
            paymentAttemptId: null,
            cashTenderId: IDS.policy,
          }),
        ]),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Receipts');
    const online = await screen.findByTestId(`receipt-${IDS.booking}`);
    expect(online).toHaveProp(
      'accessibilityLabel',
      `Received $45.00, Paid through the app or online, ${formatInstant(receipt().receivedAt)}. Applied $40.00. Paid beyond the balance: $5.00`,
    );
    fireEvent.press(online);
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/attempt/${IDS.attempt}`);
    // A cash receipt has no payment attempt to open: it is not a button.
    const cash = screen.getByTestId(`receipt-${LIST_IDS.receiptCash}`);
    expect(cash).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^Received \$40\.00, Paid at the front desk/),
    );
    expect(cash).not.toHaveProp('accessibilityRole', 'button');
    expect(app.fake.requests.find((r) => r.route === '/me/receipts')?.query).toEqual({
      limit: '20',
    });
  });

  it('receipts show their own empty state', async () => {
    const app = createTestApp({ routes: routes({ 'GET /me/receipts': pageOf([]) }) });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Receipts');
    expect(await screen.findByRole('header', { name: 'No receipts yet' })).toBeOnTheScreen();
  });

  it('§4.11: orders show their lines, amounts and a registration still being completed', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/orders': pageOf([order({ fulfillmentStatus: 'recovery_required' })]),
      }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Orders');
    const row = await screen.findByRole('button', {
      name: `Autumn U10 League, Total $120.00. Due at checkout $40.00. Ordered ${formatInstant(order().createdAt)}, Payment received. We are completing your registration.`,
    });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/payments/order/${IDS.order}`);
  });

  it('§4.10: a refused orders read is "not available", never the other payer’s records', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/orders': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')) }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Orders');
    const list = await screen.findByTestId('my-orders');
    expect(await within(list).findByLabelText('Not available')).toBeOnTheScreen();
    expect(within(list).queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('SCR-C-25: the team contributions view lists the contributions asked of this account', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/contribution-requests': pageOf([contributionRequest()]) }),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    await show('Team contributions');
    expect(
      await screen.findByRole('button', {
        name: 'Fall 2026 team fee, Your contribution: $75.00, Requested',
      }),
    ).toBeOnTheScreen();
  });
});
