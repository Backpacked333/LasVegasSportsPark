/**
 * SCR-C-35 Credits and makeup entitlements (SPK-PAY-009, SPK-YOUTH-004, SPK-UX-008, SPK-UX-010):
 * two different assets shown apart with their own vocabulary, separate empties, and each section's
 * own permission restriction; credits in cursor pages; session packages (ENR-11, DEC-074) as a
 * third, separate list behind their switch.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { illustrations } from '../../../artwork/manifest';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  credit,
  makeup,
  page,
} from '../../../features/money/testing/fixtures';
import {
  LIST_IDS,
  packageEntitlement,
  pageOf,
} from '../../../features/money/testing/list-fixtures';
import { mePermissions } from '../../../testing/test-app';
import { formatDay } from '../../../features/money/format';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { CreditsScreen } from '../CreditsScreen';
import { openSupportDetails } from '../../../testing/ui-surfaces';
import { Artwork } from '../../../ui/Artwork';

/** The API's money summary for the person (`creditsAvailable` is the credit balance). */
function moneySummary(creditsAvailable: { currency: string; amountMinor: number }[]) {
  return {
    status: 200,
    body: {
      personId: IDS.self,
      accountBalance: [],
      openObligations: 0,
      pastDueObligations: 0,
      creditsAvailable,
      creditsPendingApproval: [],
      paidThisYear: [],
      refundedThisYear: [],
      paidSince: '2026-01-01T08:00:00.000Z',
      yearTimeZone: 'America/Los_Angeles',
      asOf: '2026-10-24T12:00:00.000Z',
    },
  };
}

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
    'GET /me/package-entitlements': pageOf([]),
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
      within(card).getByLabelText('Can be used for: registrations and amounts due'),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(`Expiry: Expires ${formatDay(credit().expiresAt)}`),
    ).toBeOnTheScreen();
    expect(
      within(card).getByLabelText('Source: Goodwill credit from the facility'),
    ).toBeOnTheScreen();
    expect(within(card).getByText(/Used \$20\.00 on an amount due on/)).toBeOnTheScreen();
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
    await openSupportDetails(screen);
    expect(await screen.findByText('Error code: INTEGRATION_UNAVAILABLE')).toBeOnTheScreen();
    expect(await screen.findByText('Reference: corr-35')).toBeOnTheScreen();
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
  it('§4.5: more credits load with the API cursor', async () => {
    const SECOND = '0192f1a0-0000-7000-8000-000000000902';
    const app = renderCredits({
      'GET /credits': (req) =>
        fakeResponse(
          200,
          req.query.cursor === 'k2'
            ? { items: [credit({ id: SECOND, reason: null })], nextCursor: null }
            : { items: [credit()], nextCursor: 'k2' },
        ),
    });
    await screen.findByTestId(`credit-${IDS.credit}`);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Load more credits' }));
    });
    expect(await screen.findByTestId(`credit-${SECOND}`)).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/credits').at(-1)?.query.cursor).toBe('k2');
  });

  it('ENR-11, SPK-PAY-009: session packages are a third, separate list, never added to credits', async () => {
    renderCredits({
      'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
      'GET /me/package-entitlements': pageOf([packageEntitlement()]),
    });
    const section = await screen.findByTestId('packages-section');
    expect(within(section).getByRole('header', { name: 'Class packs' })).toBeOnTheScreen();
    expect(await within(section).findByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
    expect(
      within(section).getByText(/It is not money and is never added to credits/),
    ).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('credits-section')).queryByTestId(`package-${LIST_IDS.package}`),
    ).toBeNull();
    expect(within(section).queryByTestId('state-turned-off')).toBeNull();
  });

  it('DEC-016, DEC-074: with the switch off, packages show the turned-off state and stay listed', async () => {
    renderCredits({ 'GET /me/package-entitlements': pageOf([packageEntitlement()]) });
    const section = await screen.findByTestId('packages-section');
    expect(await within(section).findByLabelText('Class packs turned off')).toBeOnTheScreen();
    await openSupportDetails(within(section));
    expect(within(section).getByText('Decisions: DEC-016, DEC-074')).toBeOnTheScreen();
    expect(await within(section).findByTestId(`package-${LIST_IDS.package}`)).toBeOnTheScreen();
    // Credits and makeups are not affected by the switch.
    expect(screen.getByTestId(`credit-${IDS.credit}`)).toBeOnTheScreen();
  });

  it('ADR-008 SPK-PAY-009: opens with the credit balance and the makeups left as stat tiles, never added together', async () => {
    const app = renderCredits({
      'GET /people/{id}/money-summary': moneySummary([{ currency: 'USD', amountMinor: 3000 }]),
    });
    expect(await screen.findByLabelText('Credit balance, $30.00, Ready to use')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText('Makeup sessions available, 1, Session to book'),
    ).toBeOnTheScreen();
    // The balance is the API's figure for the chosen person, not a sum made in the app.
    expect(app.fake.requests.find((r) => r.route === '/people/{id}/money-summary')?.params.id).toBe(
      IDS.self,
    );
  });

  it('SPK-UX-008: without the money summary the credit tile is left out and the credits list keeps its own states', async () => {
    renderCredits();
    expect(
      await screen.findByLabelText('Makeup sessions available, 1, Session to book'),
    ).toBeOnTheScreen();
    expect(await screen.findByTestId(`credit-${IDS.credit}`)).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Credit balance/)).toBeNull();
  });

  it('DEC-058 (PA-11): a credit without an expiry says what to do, with the decision in the closed fold', async () => {
    renderCredits({ 'GET /credits': page([credit({ expiresAt: null })]) });
    const card = within(await screen.findByTestId(`credit-${IDS.credit}`));
    expect(card.getByLabelText('Expiry: Not set')).toBeOnTheScreen();
    expect(card.getByText('Ask the front desk when your credit expires.')).toBeOnTheScreen();
    expect(card.getByRole('button', { name: 'Details for support' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ expanded: false }),
    );
    expect(card.queryByText(/DEC-058/)).toBeNull();
    await openSupportDetails(card);
    expect(card.getByText('Decision: DEC-058')).toBeOnTheScreen();
    expect(card.getByText('Owner: Finance')).toBeOnTheScreen();
  });

  it('ADR-008 SPK-UX-008: no credits shows the payments illustration, announced with what would appear', async () => {
    renderCredits({ 'GET /credits': page([]) });
    expect(await screen.findByRole('header', { name: 'No credits' })).toBeOnTheScreen();
    const art = screen
      .UNSAFE_getAllByType(Artwork)
      .filter((a) => a.props.source === illustrations['empty-payments']);
    expect(art).toHaveLength(1);
    expect(AccessibilityInfo.announceForAccessibilityWithOptions).toHaveBeenCalledWith(
      'No credits. Money credits from the facility appear here, with what they can be used for and when they expire.',
      { queue: true },
    );
  });

  it('DEC-016, DEC-074: with the switch off and no class pack held, the class packs section is not shown', async () => {
    renderCredits();
    expect(await screen.findByTestId(`credit-${IDS.credit}`)).toBeOnTheScreen();
    await act(async () => undefined);
    expect(screen.queryByTestId('packages-section')).toBeNull();
    expect(screen.queryByLabelText('Class packs turned off')).toBeNull();
  });
});
