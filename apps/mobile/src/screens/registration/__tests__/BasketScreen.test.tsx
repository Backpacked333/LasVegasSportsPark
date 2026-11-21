/**
 * SCR-C-11 Household basket (SPK-REG-004, SPK-REG-002, SPK-REG-006, SPK-REG-008; SPK-AT-001,
 * SPK-AT-005): per-line participant, offering, eligibility, price and forms; held places with the
 * server's expiry; quote, release, remove and waitlist commands with expected revisions; the
 * SPK-UX-008 states.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  acknowledgment,
  basket,
  checkout,
  familyRoutes,
  inMinutes,
  line,
  offering,
  page,
  waitlistEntry,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { BasketScreen, RELEASE_REASON } from '../BasketScreen';
import { openSupportDetails } from '../../../testing/ui-surfaces';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /baskets/{id}': { status: 200, body: basket() },
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /acknowledgments': { status: 200, body: [] },
    ...overrides,
  };
}

function renderBasket(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp(options);
  render(<BasketScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
  return app;
}

/**
 * `GET /me/registration-checkouts` as the API answers it (money-reads.service myCheckouts): newest
 * first, the `status` filter, cursor pages of `limit`. Twenty-five newer checkouts of other
 * baskets come before this basket's checkout in recovery (R3-SCREEN-STATES-04).
 */
function checkoutsBehindNewerOnes(options: { failRecoveryPage?: () => boolean } = {}): FakeHandler {
  const other = (n: number) => `0192f1a0-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
  const all = [
    ...Array.from({ length: 25 }, (_, n) =>
      checkout({ id: other(n), basketId: other(500 + n), quoteId: other(900 + n) }),
    ),
    checkout({ status: 'recovery_required' }),
  ];
  return (req: FakeRequest) => {
    if (req.query.status && options.failRecoveryPage?.()) {
      return fakeResponse(
        503,
        apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
      );
    }
    const matching = req.query.status ? all.filter((c) => c.status === req.query.status) : all;
    const start = req.query.cursor ? Number(req.query.cursor) : 0;
    const end = start + Number(req.query.limit ?? 50);
    return fakeResponse(200, {
      items: matching.slice(start, end),
      nextCursor: end < matching.length ? String(end) : null,
    });
  };
}

describe('SCR-C-11 BasketScreen', () => {
  it('PA-11 ADR-008: an empty cart shows its illustration and leads to Explore; the cart is not a step', async () => {
    const app = renderBasket({
      routes: routes({ 'GET /baskets/{id}': { status: 200, body: basket({ lines: [] }) } }),
    });
    expect(await screen.findByRole('header', { name: 'Your cart is empty' })).toBeOnTheScreen();
    expect(screen.getByText('Add an activity from Explore.')).toBeOnTheScreen();
    expect(screen.queryByTestId('registration-steps')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Explore activities' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/discover');
    expect(screen.queryByRole('button', { name: 'Review and pay' })).toBeNull();
    await app.settle();
  });

  it("PA-11 ADR-008: each line is a card with the person's initials, the activity and its status", async () => {
    const app = renderBasket({ routes: routes() });
    expect(
      await screen.findByLabelText('Ada: Autumn Youth Program. Not held yet'),
    ).toBeOnTheScreen();
    const card = within(screen.getByTestId(`line-${IDS.lineA}`));
    expect(card.getByText('A', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(card.getByRole('button', { name: 'Remove Ada from the cart' })).toBeOnTheScreen();
    await app.settle();
  });

  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-004: every line keeps its participant, offering, price and forms; all-or-nothing is stated', async () => {
    renderBasket({ routes: routes() });
    expect(await screen.findByText('Ada: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByText('Ben: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByLabelText('In your cart. No spots are saved yet.')).toBeOnTheScreen();
    expect(
      screen.getByText('All spots in this cart are confirmed together, or none are.'),
    ).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Base price each: $120.00')).toHaveLength(2);
    expect(screen.getByLabelText('Subtotal: $240.00')).toBeOnTheScreen();
    expect(await screen.findByText('Required form for Ada: 1 still to sign.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Ada: Autumn Youth Program. Not held yet')).toBeOnTheScreen();
  });

  it('SPK-REG-009: offers the required forms while a signature is missing, and not once they are signed', async () => {
    const app = renderBasket({ routes: routes() });
    fireEvent.press(await screen.findByRole('button', { name: 'Complete required forms' }));
    // Forms are signed on Review & pay (handoff 1f).
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/review/${IDS.basket}`);

    app.fake.set('GET /acknowledgments', (req: FakeRequest) =>
      fakeResponse(200, [acknowledgment(req.query.subjectPersonId as string, IDS.formPolicy)]),
    );
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/acknowledgments'] });
    });
    expect(await screen.findByText('Required form for Ada: signed.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Complete required forms' })).toBeNull();
  });

  it('handoff 1f: "Review and pay" opens Review & pay for this cart, which holds, prices and pays it (nothing is sent from the cart)', async () => {
    const app = renderBasket({ routes: routes() });
    fireEvent.press(await screen.findByRole('button', { name: 'Review and pay' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/review/${IDS.basket}`);
    expect(app.fake.requests.some((r) => r.route === '/registration-quotes')).toBe(false);
  });

  it('SPK-REG-006: held places show the server expiry and an informational countdown; release sends the revision', async () => {
    const held = basket({
      status: 'held',
      holdExpiresAt: inMinutes(9),
      lines: [line({ outcome: 'held' })],
    });
    const app = renderBasket({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: held },
        'POST /baskets/{id}/release': { status: 200, body: basket({ status: 'released' }) },
      }),
    });
    expect((await screen.findAllByLabelText(/^Place held until /)).length).toBeGreaterThan(0);
    expect(screen.getByText('Countdown: about 9 minutes left')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Release my saved spots' }));
    });
    expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/release')?.body).toEqual({
      reason: RELEASE_REASON,
      expectedRevision: 3,
    });
  });

  it('SPK-REG-007: a line awaiting approval blocks the price; places are held only at checkout', async () => {
    renderBasket({
      routes: routes({
        'GET /baskets/{id}': {
          status: 200,
          body: basket({
            approvalPending: true,
            lines: [line({ requiresApproval: true, applicationStatus: 'awaiting_review' })],
          }),
        },
      }),
    });
    expect((await screen.findAllByLabelText('Awaiting approval')).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'A line in this cart needs approval by staff before you can pay. Your spots are saved only when you check out.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Review and pay' })).toBeNull();
  });

  it('SPK-REG-002: an ineligible line shows the API reasons and permitted alternatives', async () => {
    renderBasket({
      routes: routes({
        'GET /baskets/{id}': {
          status: 200,
          body: basket({
            lines: [
              line({
                eligibility: {
                  eligible: false,
                  policyVersionId: null,
                  referenceDate: '2026-09-01',
                  evaluatedAt: '2026-10-24T12:00:00.000Z',
                  reasons: [
                    {
                      code: 'age_out_of_band',
                      severity: 'blocking',
                      message: 'Ada is older than the age band on the reference date.',
                      source: { type: 'offering', id: IDS.offering },
                      requiredAction: 'choose_another_offering',
                    },
                  ],
                  alternatives: [
                    {
                      kind: 'other_offering',
                      message: 'Look at programs for older players.',
                      offeringId: null,
                    },
                  ],
                  overridden: false,
                },
              }),
            ],
          }),
        },
      }),
    });
    expect(
      await screen.findByText('✕ Ada is older than the age band on the reference date.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('→ Look at programs for older players.')).toBeOnTheScreen();
    expect(screen.getAllByLabelText(/Not eligible as entered/).length).toBeGreaterThan(0);
  });

  it('removes a line with the expected revision; a stale basket offers Reload', async () => {
    const app = renderBasket({
      routes: routes({
        'POST /baskets/{id}/lines/{lineId}/remove': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    const target = await screen.findByRole('button', { name: 'Remove Ada from the cart' });
    await act(async () => {
      fireEvent.press(target);
    });
    const sent = app.fake.requests.find((r) => r.route === '/baskets/{id}/lines/{lineId}/remove');
    expect(sent?.params).toEqual({ id: IDS.basket, lineId: IDS.lineA });
    expect(sent?.body).toEqual({ expectedRevision: 3 });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    const reads = app.fake.requests.filter((r) => r.route === '/baskets/{id}').length;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(app.fake.requests.filter((r) => r.route === '/baskets/{id}').length).toBe(reads + 1);
  });

  it('SPK-AT-005: when the held place was released, offers the waitlist for each line', async () => {
    const app = renderBasket({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'expired' }) },
        'POST /waitlist-entries': { status: 201, body: waitlistEntry() },
      }),
    });
    expect(
      (await screen.findAllByLabelText('Your held place was released')).length,
    ).toBeGreaterThan(0);
    // The participant's name arrives with the family read, which may land after the basket.
    const join = await screen.findByRole('button', { name: 'Join the waitlist for Ada' });
    await act(async () => {
      fireEvent.press(join);
    });
    expect(app.fake.requests.find((r) => r.route === '/waitlist-entries')?.body).toEqual({
      offeringId: IDS.offering,
      participantPersonId: IDS.childA,
      intent: 'youth',
      preferences: {},
    });
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/waitlist/${IDS.entry}`);
    // Nothing is kept on the device: GET /me/waitlist-entries lists the entry everywhere.
    expect(app.progressStore.snapshot()).toEqual({ pendingCheckoutQuoteId: null });
  });

  it('a checkout whose answer never arrived (app closed mid-payment) is found again from the basket', async () => {
    renderBasket({
      progress: { pendingCheckoutQuoteId: IDS.quote },
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Check your payment' }));
    // Review finds the payment that started and never charges again.
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/review/${IDS.basket}`);
  });

  it('SPK-UX-001: after a reinstall, the basket finds its checkout in GET /me/registration-checkouts', async () => {
    const app = renderBasket({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
        'GET /me/registration-checkouts': page([
          checkout({ id: IDS.quote2, basketId: IDS.lineB }),
          checkout({ status: 'finalizing' }),
        ]),
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'See your payment' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    expect(app.progressStore.snapshot().pendingCheckoutQuoteId).toBeNull();
  });

  it('R3-SCREEN-STATES-04 §4.11: a checking-out basket whose checkout in recovery is behind twenty newer checkouts still offers "See your payment"', async () => {
    renderBasket({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
        'GET /me/registration-checkouts': checkoutsBehindNewerOnes(),
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'See your payment' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
  });

  it('R3-SCREEN-STATES-04: when the checkouts in recovery cannot be read and the newest page does not list it, the basket shows the failure with "Try again"', async () => {
    let fail = true;
    renderBasket({
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
        'GET /me/registration-checkouts': checkoutsBehindNewerOnes({
          failRecoveryPage: () => fail,
        }),
      }),
    });
    expect(
      await screen.findByText('The payment for this cart could not be looked up.'),
    ).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'See your payment' })).toBeNull();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'See your payment' })).toBeOnTheScreen();
    expect(screen.queryByText('The payment for this cart could not be looked up.')).toBeNull();
  });

  it('§4.10: a basket of another household reads not available', async () => {
    renderBasket({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline: the basket is kept and pricing is disabled', async () => {
    const app = renderBasket({ routes: routes() });
    expect(await screen.findByRole('button', { name: 'Review and pay' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Review and pay' })).toBeDisabled();
    expect(
      screen.getByText('Getting a price and checking out need a connection. Your cart is kept.'),
    ).toBeOnTheScreen();
  });
});
