/**
 * SCR-C-35 Credits and makeup entitlements (SPK-PAY-009, SPK-YOUTH-004, SPK-UX-008, SPK-UX-010):
 * two different assets shown apart with their own vocabulary, separate empties, and each section's
 * own permission restriction.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  credit,
  makeup,
  page,
} from '../../../features/money/testing/fixtures';
import { formatDay } from '../../../features/money/format';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { CreditsScreen } from '../CreditsScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /credits': page([credit()]),
    'GET /makeup-entitlements': { status: 200, body: [makeup()] },
    ...overrides,
  };
}

function renderCredits(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<CreditsScreen />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-35 CreditsScreen', () => {
  afterEach(settleApps);
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-PAY-009: a credit shows remaining and original amount, uses, expiry, source, reason and history', async () => {
    renderCredits();
    const card = await screen.findByTestId(`credit-${IDS.credit}`);
    expect(within(card).getByLabelText('Credit: $30.00')).toBeOnTheScreen();
    expect(within(card).getByLabelText('Remaining: $30.00 of $50.00')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Can be used for: registrations and balances due'),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(`Expiry: Expires ${formatDay(credit().expiresAt)}`),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Source: Goodwill credit from the facility'),
    ).toBeOnTheScreen();
    expect(within(card).getByText(/Used \$20\.00 on a balance due on/)).toBeOnTheScreen();
  });

  it('SPK-YOUTH-004: a makeup shows its origin, limit, expiry, eligible replacements and history, apart from credits', async () => {
    renderCredits();
    const card = await screen.findByTestId(`makeup-${IDS.makeup}`);
    expect(
      within(card).getByLabelText(
        `Makeup sessions available: 1, expires ${formatDay(makeup().expiresAt)}`,
      ),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Why: A session was canceled. Rain closure'),
    ).toBeOnTheScreen();
    expect(within(card).getByLabelText('Used: 1 of 2')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Can replace: 1 eligible activity or program'),
    ).toBeOnTheScreen();
    expect(within(card).getByText(/Session booked on/)).toBeOnTheScreen();
    // The two assets live in different sections and are never added together.
    expect(
      within(screen.getByTestId('credits-section')).queryByTestId(`makeup-${IDS.makeup}`),
    ).toBeNull();
  });

  it('opens the makeup booking by its opaque id', async () => {
    renderCredits();
    fireEvent.press(await screen.findByRole('button', { name: 'Book a makeup session' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/credits/makeup/${IDS.makeup}`);
  });

  it('an exhausted makeup offers no booking', async () => {
    renderCredits({
      'GET /makeup-entitlements': {
        status: 200,
        body: [makeup({ status: 'exhausted', redeemedCount: 2 })],
      },
    });
    expect(await screen.findByLabelText('All makeup sessions used')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Book a makeup session' })).toBeNull();
  });

  it('shows no credits and no makeups as two separate empty states', async () => {
    renderCredits({
      'GET /credits': page([]),
      'GET /makeup-entitlements': { status: 200, body: [] },
    });
    expect(await screen.findByRole('header', { name: 'No credits' })).toBeOnTheScreen();
    expect(await screen.findByRole('header', { name: 'No makeup sessions' })).toBeOnTheScreen();
  });

  it('permission restriction: credits read "not available" on their own while makeups still show', async () => {
    renderCredits({ 'GET /credits': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) });
    expect(
      await screen.findByText('Credits are not available to your account for this person.'),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`makeup-${IDS.makeup}`)).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('shows the API error code and recovery for one section without hiding the other', async () => {
    renderCredits({
      'GET /makeup-entitlements': () =>
        fakeResponse(
          503,
          apiErrorBody('INTEGRATION_UNAVAILABLE', {
            nextAction: 'retry_later',
            correlationId: 'corr-35',
          }),
        ),
    });
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: corr-35/),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`credit-${IDS.credit}`)).toBeOnTheScreen();
  });

  it('asks for the chosen person in both reads', async () => {
    const app = renderCredits();
    fireEvent.press(await screen.findByRole('radio', { name: 'Sam' }));
    await screen.findByTestId(`credit-${IDS.credit}`);
    const credits = app.fake.requests.filter((r) => r.route === '/credits').at(-1);
    const makeups = app.fake.requests.filter((r) => r.route === '/makeup-entitlements').at(-1);
    expect(credits?.query.ownerPersonId).toBe(IDS.child);
    expect(makeups?.query.participantPersonId).toBe(IDS.child);
  });

  it('offline: booking a makeup is disabled', async () => {
    const app = renderCredits();
    await screen.findByTestId(`makeup-${IDS.makeup}`);
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Book a makeup session' })).toBeDisabled();
  });
});
