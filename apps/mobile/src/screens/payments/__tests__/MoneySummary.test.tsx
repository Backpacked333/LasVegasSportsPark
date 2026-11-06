/**
 * SCR-C-34 money summary (SPK-PAY-004, SPK-PAY-009, SPK-PAY-011, §4.10):
 * `GET /v1/people/{id}/money-summary` for the person whose balances are shown, per currency and
 * never summed across currencies, refunds apart from payments, credits waiting for approval kept
 * apart from usable ones, and protected NOT_FOUND shown as "not available".
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  page,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { amountsText } from '../MoneySummary';
import { PaymentsScreen } from '../PaymentsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

afterEach(settleApps);

function summary(personId: string) {
  return {
    personId,
    accountBalance: [{ currency: 'USD', amountMinor: 4500 }],
    openObligations: 2,
    pastDueObligations: 1,
    creditsAvailable: [{ currency: 'USD', amountMinor: 1000 }],
    creditsPendingApproval: [{ currency: 'USD', amountMinor: 2500 }],
    paidThisYear: [
      { currency: 'USD', amountMinor: 28900 },
      { currency: 'CAD', amountMinor: 5000 },
    ],
    refundedThisYear: [{ currency: 'USD', amountMinor: 2000 }],
    paidSince: '2026-01-01T08:00:00.000Z',
    yearTimeZone: 'America/Los_Angeles',
    asOf: '2026-10-24T12:00:00.000Z',
  };
}

function routes(moneySummary: (req: FakeRequest) => Response) {
  return {
    ...accountRoutes(),
    'GET /obligations': page([]),
    'GET /me/payments': page([]),
    'GET /me/registration-checkouts': page([]),
    'GET /people/{id}/money-summary': moneySummary,
  };
}

describe('SCR-C-34 money summary', () => {
  it('SPK-PAY-004/009/011: shows what is owed, credits and paid this year per currency, refunds apart', async () => {
    const app = createTestApp({
      routes: routes((req) => fakeResponse(200, summary(req.params.id ?? ''))),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('money-summary');
    expect(within(card).getByRole('header', { name: 'Your money' })).toBeOnTheScreen();
    expect(await within(card).findByLabelText('Owed on open balances: $45.00')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Open balances: 2 open, 1 past due')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Credits you can use: $10.00')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Credits waiting for approval (not usable yet): $25.00'),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Paid since Jan 1, 2026: $289.00 and CA$50.00'),
    ).toBeOnTheScreen();
    expect(within(card).getByLabelText('Refunded in the same period: $20.00')).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/people/{id}/money-summary')?.params.id).toBe(
      IDS.self,
    );
  });

  it('§4.10: a person whose money the account may not see is "not available"; another person reads their own', async () => {
    const app = createTestApp({
      routes: routes((req) =>
        req.params.id === IDS.child
          ? fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }))
          : fakeResponse(200, summary(IDS.self)),
      ),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Owed on open balances: $45.00')).toBeOnTheScreen();

    fireEvent.press(await screen.findByRole('radio', { name: 'Sam' }));
    const card = await screen.findByTestId('money-summary');
    expect(within(card).getByRole('header', { name: "Sam's money" })).toBeOnTheScreen();
    expect(await within(card).findByText('Money summary not available')).toBeOnTheScreen();
    expect(within(card).queryByText(/\$45\.00/)).toBeNull();
  });

  it('SPK-UX-008: a failed read shows its code with "Try again"', async () => {
    const app = createTestApp({
      routes: routes(() => fakeResponse(500, apiErrorBody('INTERNAL_ERROR'))),
    });
    render(<PaymentsScreen />, { wrapper: app.wrapper });
    const card = await screen.findByTestId('money-summary');
    expect(await within(card).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(amountsText([], 'Nothing owed')).toBe('Nothing owed');
  });
});
