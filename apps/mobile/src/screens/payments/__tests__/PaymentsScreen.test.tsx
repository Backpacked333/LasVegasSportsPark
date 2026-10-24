/**
 * SCR-C-34 Payments and obligations list (SPK-PAY-005, SPK-PAY-006, SPK-UX-008): balances due and
 * history for the chosen person, with amounts left to pay, overpayments shown, and every
 * SPK-UX-008 state the list defines.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  obligation,
  page,
} from '../../../features/money/testing/fixtures';
import { formatDay } from '../../../features/money/format';
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
    ...overrides,
  };
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
});
