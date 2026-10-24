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
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  acknowledgment,
  basket,
  familyRoutes,
  inMinutes,
  line,
  offering,
  quote,
  waitlistEntry,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { BasketScreen, RELEASE_REASON } from '../BasketScreen';

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

describe('SCR-C-11 BasketScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-004: every line keeps its participant, offering, price and forms; all-or-nothing is stated', async () => {
    renderBasket({ routes: routes() });
    expect(await screen.findByText('Ada: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByText('Ben: Autumn Youth Program')).toBeOnTheScreen();
    expect(screen.getByLabelText('In your basket. No place is held yet.')).toBeOnTheScreen();
    expect(
      screen.getByText('All places in this basket are confirmed together, or none are.'),
    ).toBeOnTheScreen();
    expect(screen.getAllByLabelText('Base price each: $120.00')).toHaveLength(2);
    expect(screen.getByLabelText('Subtotal: $240.00')).toBeOnTheScreen();
    expect(await screen.findByText('Required form for Ada: 1 still to sign.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Ada: Autumn Youth Program. Not held yet')).toBeOnTheScreen();
  });

  it('SPK-REG-009: offers the required forms while a signature is missing, and not once they are signed', async () => {
    const app = renderBasket({ routes: routes() });
    fireEvent.press(await screen.findByRole('button', { name: 'Complete required forms' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/forms?basketId=${IDS.basket}`);

    app.fake.set('GET /acknowledgments', (req: FakeRequest) =>
      fakeResponse(200, [acknowledgment(req.query.subjectPersonId as string, IDS.formPolicy)]),
    );
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/acknowledgments'] });
    });
    expect(await screen.findByText('Required form for Ada: signed.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Complete required forms' })).toBeNull();
  });

  it('gets a price with no amounts in the request and opens the quote (SPK-PAY-001)', async () => {
    const app = renderBasket({
      routes: routes({ 'POST /registration-quotes': { status: 201, body: quote() } }),
    });
    const target = await screen.findByRole('button', { name: 'Get your price' });
    await act(async () => {
      fireEvent.press(target);
    });
    const sent = app.fake.requests.find((r) => r.route === '/registration-quotes');
    expect(sent?.body).toEqual({ basketId: IDS.basket, discountCodes: [], creditIds: [] });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/quote/${IDS.quote}`);
    expect(app.progressStore.snapshot().quoteId).toBe(IDS.quote);
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
      fireEvent.press(screen.getByRole('button', { name: 'Release my held places' }));
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
    expect(screen.getByText(/Places are held only\s+when you check out\./)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Get your price' })).toBeNull();
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

  it('SPK-IAM-003: a payer without pay permission for a line sees the price as not available', async () => {
    renderBasket({
      routes: routes({
        'POST /registration-quotes': () =>
          fakeResponse(
            403,
            apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
              nextAction: 'request_participant_authority',
            }),
          ),
      }),
    });
    const target = await screen.findByRole('button', { name: 'Get your price' });
    await act(async () => {
      fireEvent.press(target);
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('removes a line with the expected revision; a stale basket offers Reload', async () => {
    const app = renderBasket({
      routes: routes({
        'POST /baskets/{id}/lines/{lineId}/remove': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    const target = await screen.findByRole('button', { name: 'Remove Ada from the basket' });
    await act(async () => {
      fireEvent.press(target);
    });
    const sent = app.fake.requests.find((r) => r.route === '/baskets/{id}/lines/{lineId}/remove');
    expect(sent?.params).toEqual({ id: IDS.basket, lineId: IDS.lineA });
    expect(sent?.body).toEqual({ expectedRevision: 3 });
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
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Join the waitlist for Ada' }));
    });
    expect(app.fake.requests.find((r) => r.route === '/waitlist-entries')?.body).toEqual({
      offeringId: IDS.offering,
      participantPersonId: IDS.childA,
      intent: 'youth',
      preferences: {},
    });
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/waitlist/${IDS.entry}`);
    expect(app.progressStore.snapshot().waitlistEntryIds).toEqual([IDS.entry]);
  });

  it('a checkout whose answer never arrived (app closed mid-payment) is found again from the basket', async () => {
    renderBasket({
      progress: { basketId: IDS.basket, quoteId: IDS.quote, pendingCheckoutQuoteId: IDS.quote },
      routes: routes({
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
      }),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Check your payment' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/checkout/${IDS.quote}`);
  });

  it('§4.10: a basket of another household reads not available', async () => {
    renderBasket({ routes: { ...familyRoutes() } });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('offline: the basket is kept and pricing is disabled', async () => {
    const app = renderBasket({ routes: routes() });
    expect(await screen.findByRole('button', { name: 'Get your price' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Get your price' })).toBeDisabled();
    expect(
      screen.getByText('Getting a price and checking out need a connection. Your basket is kept.'),
    ).toBeOnTheScreen();
  });
});
