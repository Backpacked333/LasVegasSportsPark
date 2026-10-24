/**
 * SCR-C-35 redeem a makeup (SPK-YOUTH-004, SPK-AT-020, §4.9, SPK-UX-008): eligible replacements
 * only, upcoming sessions only, one idempotency key per intent, and a concurrent redemption that
 * the database refused reads "Not available: already redeemed".
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  createRouterMock,
  makeup,
  offering,
  offeringSession,
  page,
  sessionBooking,
} from '../../../features/money/testing/fixtures';
import { formatInstant } from '../../../features/money/format';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { MakeupRedeemScreen } from '../MakeupRedeemScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const UPCOMING = offeringSession(IDS.session, 2);
const PAST = offeringSession(IDS.sessionPast, -2, { title: 'Week 1' });

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /makeup-entitlements/{id}': { status: 200, body: makeup() },
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings/{id}/sessions': { status: 200, body: [PAST, UPCOMING] },
    'POST /makeup-entitlements/{id}/redeem': { status: 201, body: sessionBooking() },
    ...overrides,
  };
}

function renderRedeem(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<MakeupRedeemScreen makeupId={IDS.makeup} />, { wrapper: app.wrapper });
  return app;
}

const redeems = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter(
    (r) => r.method === 'POST' && r.route === '/makeup-entitlements/{id}/redeem',
  );

async function chooseAndBook() {
  fireEvent.press(await screen.findByRole('radio', { name: /^Autumn U10 League/ }));
  fireEvent.press(await screen.findByRole('radio', { name: /^Week 4/ }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Book this session' }));
  });
}

describe('SCR-C-35 MakeupRedeemScreen', () => {
  afterEach(settleApps);

  it('offers only eligible activities and upcoming sessions', async () => {
    renderRedeem();
    fireEvent.press(await screen.findByRole('radio', { name: /^Autumn U10 League/ }));
    expect(
      await screen.findByRole('radio', {
        name: `Week 4, ${formatInstant(UPCOMING.scheduledStart)}`,
      }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: /^Week 1/ })).toBeNull();
  });

  it('includes the published offerings of an eligible program', async () => {
    const app = renderRedeem({
      'GET /makeup-entitlements/{id}': {
        status: 200,
        body: makeup({ eligibleOfferingIds: [], eligibleProgramIds: [IDS.program] }),
      },
      'GET /offerings': page([offering({ id: IDS.offeringB, name: 'Spring Clinic' })]),
    });
    expect(await screen.findByRole('radio', { name: /^Spring Clinic/ })).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/offerings')?.query).toEqual({
      programId: IDS.program,
      limit: '50',
    });
  });

  it('§4.9: books with offering, session and expectedRevision under one idempotency key, then shows "Booked"', async () => {
    const app = renderRedeem();
    await chooseAndBook();
    expect(await screen.findByTestId('redeem-success')).toHaveProp('accessibilityLabel', 'Booked');
    const [sent] = redeems(app);
    expect(sent?.body).toEqual({
      offeringId: IDS.offering,
      sessionId: IDS.session,
      expectedRevision: 2,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-AT-020: a redemption the database refused reads "Not available: already redeemed"', async () => {
    renderRedeem({
      'POST /makeup-entitlements/{id}/redeem': () =>
        fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', {
            message: 'This makeup entitlement has no redemption left.',
            nextAction: 'resolve_conflict',
            details: { code: 'MAKEUP_REDEMPTION_LIMIT' },
          }),
        ),
    });
    await chooseAndBook();
    expect(await screen.findByTestId('redeem-refused')).toHaveProp(
      'accessibilityLabel',
      'Not available: already redeemed',
    );
    expect(screen.getByRole('button', { name: 'Book this session' })).toBeDisabled();
  });

  it('validation failure: a session that is not an eligible replacement shows the API reasons', async () => {
    renderRedeem({
      'POST /makeup-entitlements/{id}/redeem': () =>
        fakeResponse(
          422,
          apiErrorBody('ELIGIBILITY_FAILED', {
            message: 'This session is not an eligible replacement for the makeup.',
            nextAction: 'review_eligibility_reasons',
            details: {
              reasons: [
                {
                  code: 'makeup_replacement_not_eligible',
                  severity: 'blocking',
                  message:
                    'The makeup can be redeemed only in its eligible replacement offerings or programs.',
                },
              ],
            },
          }),
        ),
    });
    await chooseAndBook();
    expect(await screen.findByTestId('redeem-ineligible')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'The makeup can be redeemed only in its eligible replacement offerings or programs.',
      ),
    ).toBeOnTheScreen();
  });

  it('stale version: the makeup changed since it was opened, so Reload shows what is left', async () => {
    renderRedeem({
      'POST /makeup-entitlements/{id}/redeem': () =>
        fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
    });
    await chooseAndBook();
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeOnTheScreen();
  });

  it('a makeup with nothing left reads "Nothing left to book" and offers no booking', async () => {
    renderRedeem({
      'GET /makeup-entitlements/{id}': {
        status: 200,
        body: makeup({ status: 'exhausted', redeemedCount: 2 }),
      },
    });
    expect(await screen.findByLabelText('Nothing left to book')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Book this session' })).toBeNull();
  });

  it('§4.10: a makeup this account may not see reads "Not available"', async () => {
    renderRedeem({
      'GET /makeup-entitlements/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline: booking is disabled and needs a connection', async () => {
    const app = renderRedeem();
    fireEvent.press(await screen.findByRole('radio', { name: /^Autumn U10 League/ }));
    fireEvent.press(await screen.findByRole('radio', { name: /^Week 4/ }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Book this session' })).toBeDisabled();
    expect(screen.getByText('Needs a connection.')).toBeOnTheScreen();
  });
});
