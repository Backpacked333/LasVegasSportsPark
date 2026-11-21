/**
 * Register 1/3 Who → 2/3 Options → 3/3 Review & pay, and 4e (redesign handoff M 1e, 2a, 1f, 4e;
 * INTERACTIONS "1e–1g"; SPK-REG-002, SPK-REG-004, SPK-REG-005, SPK-PAY-001, SPK-PAY-007,
 * SPK-AT-005, §4.9): who can join in plain words, the person Explore chose pre-ticked, the flow's
 * own cart built, held and priced on Review, a promo code applied or refused inline, paying never
 * optimistic with an Idempotency-Key, an unknown outcome never a failure, and the last place going
 * while paying ("You weren't charged.") with the waitlist one tap away.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { clearDrafts } from '../../../features/register/draft';
import {
  IDS,
  basket,
  familyRoutes,
  ineligible,
  inMinutes,
  line,
  offering,
  optionsHandler,
  quote,
  quoteLine,
  checkout,
} from '../../../features/registration/testing/fixtures';
import {
  createRegistrationTestApp,
  createRouterMock,
} from '../../../features/registration/testing/registration-test-app';
import { RegisterFlowScreen } from '../RegisterFlowScreen';
import { ReviewScreen } from '../ReviewScreen';

const mockRouter = createRouterMock();
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
  useNavigation: () => mockNavigation,
}));

const EMPTY = { status: 200, body: { items: [], nextCursor: null } };
const OPTIONS = {
  offeringId: IDS.offering,
  priceRuleId: null,
  pricingBasis: null,
  currency: 'USD',
  tiers: [],
  addons: [],
  uniform: null,
};

/** The cart grows by each line the flow adds, its revision bumped each time. */
function cartRoutes(capture: { lines: string[] }) {
  let current = basket({ lines: [], revision: 1 });
  return {
    'POST /baskets': () => fakeResponse(201, current),
    'GET /baskets/{id}': () => fakeResponse(200, current),
    'POST /baskets/{id}/lines': (req: FakeRequest) => {
      const body = req.body as { participantPersonId: string; offeringId: string };
      capture.lines.push(`${body.offeringId}:${body.participantPersonId}`);
      current = basket({
        lines: [
          ...current.lines,
          line({
            participantPersonId: body.participantPersonId,
            policies: {
              eligibilityPolicyVersionId: null,
              cancellationPolicyVersionId: null,
              requiredFormPolicyVersionIds: [],
            },
          }),
        ],
        revision: current.revision + 1,
      });
      return fakeResponse(201, current);
    },
    'POST /baskets/{id}/hold': () => {
      current = basket({ ...current, status: 'held', holdExpiresAt: inMinutes(15) });
      return fakeResponse(200, current);
    },
  };
}

function routes(extra: Record<string, unknown> = {}) {
  const capture = { lines: [] as string[] };
  return {
    capture,
    routes: {
      ...familyRoutes(),
      'GET /offerings/{id}': { status: 200, body: offering({ requiredFormPolicyVersionIds: [] }) },
      'GET /offerings/{id}/registration-options': optionsHandler({
        availableIntents: ['youth'],
        participants: [
          {
            personId: IDS.parent,
            intents: [
              {
                intent: 'youth',
                eligibility: ineligible(
                  'The participant is 40 on 2026-11-02; this offering requires at least 8 and at most 10.',
                ),
              },
            ],
          },
          {
            personId: IDS.childA,
            intents: [
              {
                intent: 'youth',
                eligibility: {
                  eligible: true,
                  policyVersionId: null,
                  referenceDate: null,
                  evaluatedAt: inMinutes(0),
                  reasons: [],
                  alternatives: [],
                },
              },
            ],
          },
          {
            personId: IDS.childB,
            intents: [
              {
                intent: 'youth',
                eligibility: ineligible(
                  'The participant is 5 on 2026-11-02; this offering requires at least 8 and at most 10.',
                  'below_minimum_age',
                ),
              },
            ],
          },
        ],
      }),
      'GET /offerings/{id}/sessions': { status: 200, body: [] },
      'GET /offerings/{id}/purchase-options': { status: 200, body: OPTIONS },
      'GET /people/{id}': { status: 404, body: apiErrorBody('NOT_FOUND') },
      'GET /enrollments': EMPTY,
      'GET /acknowledgments': { status: 200, body: [] },
      'GET /me/registration-checkouts': EMPTY,
      'POST /registration-quotes': (req: FakeRequest) => {
        const codes = (req.body as { discountCodes: string[] }).discountCodes;
        if (codes.includes('NOPE')) {
          return fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', { details: { unknownCodes: ['NOPE'] } }),
          );
        }
        return fakeResponse(
          201,
          quote({
            lines: [
              quoteLine({
                participantPersonId: IDS.childA,
                discounts: [],
                discountMinor: 0,
                totalMinor: 12500,
              }),
            ],
            discounts: codes.includes('FRIENDS12')
              ? [
                  {
                    discountDefinitionId: IDS.credit,
                    code: 'FRIENDS12',
                    name: 'Friends of the park',
                    amountMinor: 1200,
                    explanation: [],
                  },
                ]
              : [],
            totalMinor: codes.includes('FRIENDS12') ? 11300 : 12500,
            dueNowMinor: codes.includes('FRIENDS12') ? 11300 : 12500,
          }),
        );
      },
      ...cartRoutes(capture),
      ...extra,
    },
  };
}

async function toReview(app: ReturnType<typeof createRegistrationTestApp>) {
  render(<RegisterFlowScreen offeringId={IDS.offering} personId={IDS.childA} />, {
    wrapper: app.wrapper,
  });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /^Ada/ })).toBeChecked());
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Ada' }));
  await screen.findByTestId('review-total');
}

describe('Register flow (M 1e, 1f, 4e)', () => {
  beforeEach(() => {
    clearDrafts();
    mockRouter.replace.mockClear();
    mockRouter.push.mockClear();
  });

  it("SPK-REG-002 (1e): the person Explore chose is ticked; someone who cannot join is greyed with the reason, the adult left out of a child's place", async () => {
    const { routes: r } = routes();
    const app = createRegistrationTestApp({ routes: r });
    render(<RegisterFlowScreen offeringId={IDS.offering} personId={IDS.childA} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByText("Who's playing?")).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /^Ada/ })).toBeChecked());
    const ben = screen.getByRole('checkbox', { name: /^Ben/ });
    expect(ben).toBeDisabled();
    expect(within(ben).getByText(/Ages 8 to 10\. Ben is 5\./)).toBeOnTheScreen();
    expect(screen.queryByRole('checkbox', { name: /^Robin/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue with Ada' })).toBeEnabled();
    fireEvent.press(screen.getByRole('checkbox', { name: /^Ada/ }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it("SPK-REG-004, SPK-REG-005 (1f): Review builds the flow's own cart, holds it first and prices it; the hold timer leads", async () => {
    const { routes: r, capture } = routes();
    const app = createRegistrationTestApp({ routes: r });
    await toReview(app);
    expect(capture.lines).toEqual([`${IDS.offering}:${IDS.childA}`]);
    const order = app.fake.requests.filter((q) => q.method === 'POST').map((q) => q.route);
    expect(order).toEqual([
      '/baskets',
      '/baskets/{id}/lines',
      '/baskets/{id}/hold',
      '/registration-quotes',
    ]);
    expect(screen.getByTestId('review-hold')).toHaveProp(
      'accessibilityLabel',
      "Ada's place held for 15:00",
    );
    expect(within(screen.getByTestId('review-total')).getByText('$125.00')).toBeOnTheScreen();
  });

  it('SPK-PAY-003 (1f row 6): a code is re-quoted and shown in green with ✕; an unknown code reads "That code isn\'t valid for this activity."', async () => {
    const { routes: r } = routes();
    const app = createRegistrationTestApp({ routes: r });
    await toReview(app);
    fireEvent.press(screen.getByRole('button', { name: 'Have a promo code?' }));
    fireEvent.changeText(screen.getByTestId('promo-code'), 'NOPE');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/That code isn't valid for this activity\./)).toBeOnTheScreen();
    fireEvent.changeText(screen.getByTestId('promo-code'), 'FRIENDS12');
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Friends of the park · FRIENDS12')).toBeOnTheScreen();
    expect(within(screen.getByTestId('review-total')).getByText('$113.00')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Remove code FRIENDS12' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('review-total')).getByText('$125.00')).toBeOnTheScreen(),
    );
  });

  it("SPK-PAY-007, §4.9 (1f row 7): Pay is never optimistic, carries an Idempotency-Key and opens Done on the API's answer", async () => {
    let release: (() => void) | null = null;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const { routes: r } = routes({
      'POST /registration-checkouts': async () => {
        await answered;
        return fakeResponse(201, checkout());
      },
    });
    const app = createRegistrationTestApp({ routes: r });
    await toReview(app);
    const pay = await screen.findByRole('button', { name: 'Pay $125.00' });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.press(pay);
    expect(await screen.findByRole('button', { name: 'Paying…' })).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    const request = app.fake.requests.find((q) => q.route === '/registration-checkouts');
    expect(request?.headers['idempotency-key']).toBeTruthy();
    await act(async () => release?.());
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`),
    );
  });

  it('SPK-PAY-007: a payment with no answer reads "Do not pay again" and is never shown as failed', async () => {
    const { routes: r } = routes({
      'POST /registration-checkouts': () =>
        fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE')),
    });
    const app = createRegistrationTestApp({ routes: r });
    await toReview(app);
    const pay = await screen.findByRole('button', { name: 'Pay $125.00' });
    await waitFor(() => expect(pay).toBeEnabled());
    fireEvent.press(pay);
    expect(
      await screen.findByText('Payment outcome being confirmed. Do not pay again.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pay $125.00' })).toBeDisabled();
  });

  it('SPK-AT-005 (4e): the last place went while holding: "You weren\'t charged." first, the waitlist one tap away', async () => {
    const { routes: r } = routes({
      'POST /baskets/{id}/hold': () => fakeResponse(409, apiErrorBody('CAPACITY_UNAVAILABLE')),
      'GET /offering-availability': {
        status: 200,
        body: {
          items: [
            { offeringId: IDS.offering, status: 'full', unit: 'seats', capacity: 20, remaining: 0 },
          ],
          unavailableOfferingIds: [],
        },
      },
      'POST /waitlist-entries': { status: 201, body: { id: IDS.entry } },
    });
    const app = createRegistrationTestApp({ routes: r });
    render(<RegisterFlowScreen offeringId={IDS.offering} personId={IDS.childA} />, {
      wrapper: app.wrapper,
    });
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /^Ada/ })).toBeChecked());
    fireEvent.press(screen.getByRole('button', { name: 'Continue with Ada' }));
    expect(await screen.findByText("You weren't charged.")).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: /^Join the waitlist/ })).toBeChecked();
    expect(app.fake.requests.some((q) => q.route === '/registration-checkouts')).toBe(false);
    fireEvent.press(screen.getByTestId('last-place-go'));
    await waitFor(() =>
      expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/waitlist/${IDS.entry}`),
    );
    const join = app.fake.requests.find((q) => q.route === '/waitlist-entries');
    expect(join?.body).toMatchObject({ offeringId: IDS.offering, participantPersonId: IDS.childA });
  });

  it("SPK-PAY-014, SPK-REG-012 (QA M-2) on a cart's Review: when what a line chose is full, the waitlist is joined for exactly that choice", async () => {
    const day = '0192f1a0-0000-7000-8000-0000000000d1';
    const chosen = line({
      priceTierId: '0192f1a0-0000-7000-8000-0000000000f1',
      selectedSessionIds: [day],
      addons: [
        {
          addonId: '0192f1a0-0000-7000-8000-0000000000a1',
          code: 'lunch',
          name: 'Lunch',
          selection: 'per_session',
          sessionIds: [day],
          priceMinor: 900,
          currency: 'USD',
          quantity: 1,
        },
      ],
      uniform: {
        offeringUniformId: '0192f1a0-0000-7000-8000-0000000000b1',
        itemKey: 'kit',
        name: 'Camp kit',
        size: 'YM',
        priceMinor: 2500,
        currency: 'USD',
        returningHolderFree: false,
        heldUniformOrderId: null,
      },
    });
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /baskets/{id}': { status: 200, body: basket({ lines: [chosen] }) },
        'GET /offerings/{id}': { status: 200, body: offering() },
        'GET /acknowledgments': { status: 200, body: [] },
        'POST /baskets/{id}/hold': () => fakeResponse(409, apiErrorBody('CAPACITY_UNAVAILABLE')),
        'GET /offering-availability': {
          status: 200,
          body: {
            items: [
              {
                offeringId: IDS.offering,
                status: 'full',
                unit: 'seats',
                capacity: 20,
                remaining: 0,
              },
            ],
            unavailableOfferingIds: [],
          },
        },
        'POST /waitlist-entries': { status: 201, body: { id: IDS.entry } },
      },
    });
    render(<ReviewScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByText("You weren't charged.")).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('last-place-go'));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/waitlist-entries')?.body).toEqual({
        offeringId: IDS.offering,
        participantPersonId: IDS.childA,
        intent: 'youth',
        preferences: {},
        priceTierId: '0192f1a0-0000-7000-8000-0000000000f1',
        selectedSessionIds: [day],
        addons: [{ addonId: '0192f1a0-0000-7000-8000-0000000000a1', sessionIds: [day] }],
        uniform: { offeringUniformId: '0192f1a0-0000-7000-8000-0000000000b1', size: 'YM' },
      }),
    );
  });

  it('SPK-PAY-007, SPK-UX-001: a cart whose payment already started is never priced or paid again; Review leads to that payment', async () => {
    const app = createRegistrationTestApp({
      progress: { pendingCheckoutQuoteId: IDS.quote },
      routes: {
        ...familyRoutes(),
        'GET /baskets/{id}': { status: 200, body: basket({ status: 'checking_out' }) },
        'GET /offerings/{id}': { status: 200, body: offering() },
        'GET /acknowledgments': { status: 200, body: [] },
        'GET /me/registration-checkouts': {
          status: 200,
          body: { items: [checkout({ status: 'awaiting_payment' })], nextCursor: null },
        },
      },
    });
    render(<ReviewScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    fireEvent.press(
      await screen.findByRole('button', { name: 'See your payment and registration' }),
    );
    expect(mockRouter.replace).toHaveBeenCalledWith(`/registration/outcome/${IDS.checkout}`);
    expect(app.fake.requests.some((r) => r.route === '/registration-quotes')).toBe(false);
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/hold')).toBe(false);
  });
});
