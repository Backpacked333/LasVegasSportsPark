/**
 * Proposed amendments PA-03 (SPK-PAY-014: price tiers and add-ons, capability
 * `price_tiers_addons`, DEC-097 pending) and PA-07 (SPK-REG-012: uniform, capability `uniforms`,
 * DEC-101 pending) in the customer registration flow: the tier, day, add-on and uniform choices
 * per participant (SCR-C-09), their lines on the basket (SCR-C-11), the quote review (SCR-C-12),
 * the checkout outcome (SCR-C-15) and the order receipt (SCR-C-34). With the capabilities off the
 * flow asks nothing new. Tiers, add-ons, sizes and prices are test data, not policy.
 */
import type { Schema } from '@sportspark/api-client';
import { fakeResponse, type FakeHandler, type FakeRequest } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  missingChoices,
  purchaseLineFields,
  type PurchaseSelection,
} from '../../../features/registration/PurchaseChoices';
import { basketLinePrice, quoteLineBasisLines } from '../../../features/registration/price-basis';
import {
  IDS,
  basket,
  inMinutes,
  familyRoutes,
  line,
  offering,
  optionsHandler,
  policyVersion,
  quote,
  quoteLine,
} from '../../../features/registration/testing/fixtures';
import {
  basketButtonReady,
  createRegistrationTestApp,
} from '../../../features/registration/testing/registration-test-app';
import { mePermissions } from '../../../testing/test-app';
import { BasketScreen } from '../BasketScreen';
import { ReviewScreen } from '../ReviewScreen';
import { RegistrationIntentScreen } from '../RegistrationIntentScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const TIER_WEEK = '0192f1a0-0000-7000-8000-000000004001';
const TIER_DAYS = '0192f1a0-0000-7000-8000-000000004002';
const LUNCH = '0192f1a0-0000-7000-8000-000000004101';
const SHIRT = '0192f1a0-0000-7000-8000-000000004102';
const KIT = '0192f1a0-0000-7000-8000-000000004201';
const MON = '0192f1a0-0000-7000-8000-000000004401';
const TUE = '0192f1a0-0000-7000-8000-000000004402';
const WED = '0192f1a0-0000-7000-8000-000000004403';

const OPTIONS: Schema<'OfferingPurchaseOptions'> = {
  offeringId: IDS.offering,
  priceRuleId: IDS.priceRule,
  pricingBasis: 'term',
  currency: 'USD',
  tiers: [
    {
      id: TIER_WEEK,
      code: 'full_week',
      name: 'Full week',
      sequence: 1,
      attendance: 'all_sessions',
      minSessions: null,
      maxSessions: null,
      priceMinor: 30000,
      memberPriceMinor: null,
      availableUntil: null,
    },
    {
      id: TIER_DAYS,
      code: 'two_days',
      name: 'Two days',
      sequence: 2,
      attendance: 'chosen_sessions',
      minSessions: 2,
      maxSessions: 2,
      priceMinor: 13000,
      memberPriceMinor: null,
      availableUntil: null,
    },
  ],
  addons: [
    {
      id: LUNCH,
      offeringId: IDS.offering,
      code: 'lunch',
      name: 'Lunch',
      description: null,
      priceMinor: 900,
      currency: 'USD',
      chargeLines: [],
      selection: 'per_session',
      capacity: null,
      status: 'active',
      revision: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: SHIRT,
      offeringId: IDS.offering,
      code: 'shirt',
      name: 'Camp shirt',
      description: null,
      priceMinor: 1500,
      currency: 'USD',
      chargeLines: [],
      selection: 'per_registration',
      capacity: 40,
      status: 'active',
      revision: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  uniform: {
    id: KIT,
    offeringId: IDS.offering,
    itemKey: 'club-kit-2026',
    name: 'Club kit',
    sizes: ['YS', 'YM'],
    requirement: 'required',
    priceMinor: 2500,
    currency: 'USD',
    chargeLines: [],
    returningHolderFree: true,
    status: 'active',
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
};

function day(id: string, sequence: number, start: string): Schema<'OfferingSession'> {
  return {
    id,
    offeringId: IDS.offering,
    sequence,
    title: null,
    scheduledStart: start,
    scheduledEnd: start.replace('T17:', 'T23:'),
    schedulingEventId: null,
    capacityOverride: null,
    location: null,
    status: 'scheduled',
    canceledAt: null,
    cancelReason: null,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}
const DAYS = [
  day(MON, 1, '2026-11-02T17:00:00.000Z'),
  day(TUE, 2, '2026-11-03T17:00:00.000Z'),
  day(WED, 3, '2026-11-04T17:00:00.000Z'),
];

const EMPTY_BASKET = basket({ lines: [], revision: 1, subtotalMinor: 0 });

function intentRoutes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings/{id}/registration-options': optionsHandler(),
    'GET /offerings/{id}/purchase-options': { status: 200, body: OPTIONS },
    'GET /offerings/{id}/sessions': { status: 200, body: DAYS },
    'POST /baskets': { status: 201, body: EMPTY_BASKET },
    'POST /baskets/{id}/lines': (req: FakeRequest) =>
      fakeResponse(
        201,
        basket({
          lines: [line()],
          revision: (req.body as { expectedRevision: number }).expectedRevision + 1,
        }),
      ),
    ...overrides,
  };
}

describe('Tier, day, add-on and uniform choices in registration (SPK-PAY-014, SPK-REG-012)', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-PAY-014, SPK-REG-012: with the capabilities off nothing new is asked, no purchase options are read and the line is the line of before', async () => {
    const app = createRegistrationTestApp({ routes: intentRoutes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    expect(screen.queryByText(/^Options for/i)).toBeNull();
    await basketButtonReady();
    fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toEqual({
        participantPersonId: IDS.childA,
        offeringId: IDS.offering,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 1,
      }),
    );
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/purchase-options')).toBe(
      false,
    );
  });

  it('SPK-PAY-014, SPK-REG-012: each chosen person gets their own tier, days, add-ons and uniform size, and nothing is sent while a choice is missing', async () => {
    const app = createRegistrationTestApp({
      routes: intentRoutes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons', 'uniforms'] }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    // The options appear for the chosen person only.
    expect(await screen.findByTestId(`choices-${IDS.childA}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`choices-${IDS.childB}`)).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'Full week: $300.00. Attends every day' }),
    ).toBeOnTheScreen();
    const twoDays = screen.getByRole('radio', {
      name: 'Two days: $130.00. Attends 2 days of your choice',
    });

    // Nothing chosen yet: the missing choices are said in words and nothing is sent.
    await basketButtonReady();
    fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    expect(await screen.findByText('✕ Choose an option.')).toBeOnTheScreen();
    expect(screen.getByText('✕ Choose a size for the Club kit.')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);

    fireEvent.press(twoDays);
    fireEvent.press(await screen.findByTestId(`day-${IDS.childA}-${MON}`));
    expect(screen.getByText('✕ Choose 2 days of your choice.')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(`day-${IDS.childA}-${WED}`));
    // Lunch is offered for the two chosen days only.
    expect(screen.getByTestId(`addon-${IDS.childA}-lunch-${MON}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`addon-${IDS.childA}-lunch-${TUE}`)).toBeNull();
    fireEvent.press(screen.getByTestId(`addon-${IDS.childA}-lunch-${WED}`));
    fireEvent.press(screen.getByTestId(`addon-${IDS.childA}-shirt`));
    fireEvent.press(screen.getByRole('radio', { name: 'Size YM' }));
    expect(screen.queryByText(/^✕/)).toBeNull();
    expect(
      screen.getByText(
        'Required: choose a size. If this person already has this uniform, it is not charged again.',
      ),
    ).toBeOnTheScreen();

    await basketButtonReady();
    fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/baskets/{id}/lines')?.body).toEqual({
        participantPersonId: IDS.childA,
        offeringId: IDS.offering,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 1,
        priceTierId: TIER_DAYS,
        selectedSessionIds: [MON, WED],
        addons: [{ addonId: LUNCH, sessionIds: [WED] }, { addonId: SHIRT }],
        uniform: { offeringUniformId: KIT, size: 'YM' },
      }),
    );
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`),
    );
  });

  it('SPK-PAY-014, SPK-REG-012: a selection becomes the request fields the API takes, and a missing choice is named', () => {
    const selection: PurchaseSelection = {
      priceTierId: TIER_WEEK,
      selectedSessionIds: [MON],
      addons: { [LUNCH]: [], [SHIRT]: [] },
      uniformSize: null,
    };
    // A tier of every day sends no days; a per-day add-on with no day is not sent.
    expect(purchaseLineFields(selection, OPTIONS)).toEqual({
      priceTierId: TIER_WEEK,
      addons: [{ addonId: SHIRT }],
    });
    expect(missingChoices(selection, OPTIONS)).toEqual(['Choose a size for the Club kit.']);
    expect(purchaseLineFields(selection, undefined)).toEqual({});
    expect(
      missingChoices(
        { ...selection, priceTierId: TIER_DAYS, uniformSize: 'YS' },
        { ...OPTIONS, uniform: null },
      ),
    ).toEqual(['Choose 2 days of your choice.']);
  });
});

describe('PA-11 ADR-008: the Options step of registering', () => {
  it('SPK-PAY-014, SPK-REG-012: choosing people moves the steps from Who to Options, with the options grouped per person', async () => {
    const app = createRegistrationTestApp({
      routes: intentRoutes({
        'GET /me/permissions': mePermissions({ enabled: ['price_tiers_addons', 'uniforms'] }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const ada = await screen.findByRole('checkbox', { name: 'Ada. Eligible' });
    expect(screen.getByLabelText('Step 1 of 3, Who')).toBeOnTheScreen();
    fireEvent.press(ada);
    expect(await screen.findByLabelText('Step 2 of 3, Options')).toBeOnTheScreen();
    const choices = within(screen.getByTestId(`choices-${IDS.childA}`));
    expect(choices.getByRole('header', { name: 'Options for Ada' })).toBeOnTheScreen();
    for (const group of ['Price', 'Add-ons', 'Uniform size']) {
      expect(choices.getByText(group)).toBeOnTheScreen();
    }
    // Unticking the only person goes back to Who; nothing was sent.
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ada. Eligible' }));
    expect(await screen.findByLabelText('Step 1 of 3, Who')).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);
    await app.settle();
  });
});

describe('Tier, add-on and uniform lines on the basket, quote and receipt (SPK-PAY-014, SPK-REG-012)', () => {
  const chosenLine = line({
    priceTierId: TIER_DAYS,
    selectedSessionIds: [MON, WED],
    price: {
      priceRuleId: IDS.priceRule,
      basePriceMinor: 30000,
      currency: 'USD',
      chargeLines: [],
      estimate: {
        pricingBasis: 'term',
        tier: { id: TIER_DAYS, code: 'two_days', name: 'Two days' },
        appliedPrice: 'standard',
        appliedPriceMinor: 13000,
        sessionCount: null,
        unitPriceMinor: 13000,
        estimatedAt: '2026-10-24T12:00:00.000Z',
      },
    },
    addons: [
      {
        addonId: LUNCH,
        code: 'lunch',
        name: 'Lunch',
        selection: 'per_session',
        sessionIds: [MON, WED],
        priceMinor: 900,
        currency: 'USD',
        quantity: 2,
      },
    ],
    uniform: {
      offeringUniformId: KIT,
      itemKey: 'club-kit-2026',
      name: 'Club kit',
      size: 'YM',
      priceMinor: 2500,
      currency: 'USD',
      returningHolderFree: true,
      heldUniformOrderId: '0192f1a0-0000-7000-8000-000000004301',
    },
  });

  it('SPK-PAY-014, SPK-REG-012: a basket line shows the estimate of its tier, its days, its add-ons and its uniform, never the base price of another tier', async () => {
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /baskets/{id}': {
          status: 200,
          body: basket({ lines: [chosenLine], subtotalMinor: 13000 + 1800 }),
        },
        'GET /offerings/{id}': { status: 200, body: offering() },
        'GET /acknowledgments': { status: 200, body: [] },
      },
    });
    render(<BasketScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Estimated price each: $130.00')).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Base price each/)).toBeNull();
    expect(screen.queryByText(/\$300\.00/)).toBeNull();
    expect(screen.getByText('Two days')).toBeOnTheScreen();
    expect(screen.getByText('The price is confirmed when you review it.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Days chosen: 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Lunch × 2 days: $9.00 each')).toBeOnTheScreen();
    expect(screen.getByLabelText('Club kit, size YM: $25.00')).toBeOnTheScreen();
    // The participant's name is read apart from the basket, so this sentence is awaited.
    expect(
      await screen.findByText('Ada already has this uniform: it is not charged again.'),
    ).toBeOnTheScreen();
  });

  it('SPK-PAY-013: a per-class line shows the API estimate (price per class times the classes still to come), not the price of one class as the price each', () => {
    expect(
      basketLinePrice({
        priceRuleId: IDS.priceRule,
        basePriceMinor: 2400,
        currency: 'USD',
        chargeLines: [],
        estimate: {
          pricingBasis: 'per_session',
          tier: null,
          appliedPrice: 'member',
          appliedPriceMinor: 2000,
          sessionCount: 7,
          unitPriceMinor: 14000,
          estimatedAt: '2026-11-02T15:00:00.000Z',
        },
      }),
    ).toEqual({
      label: 'Estimated price each',
      value: '$140.00',
      notes: [
        '$20.00 per class × 7 classes',
        'Member price',
        'The price is confirmed when you review it.',
      ],
    });
    // A plain term price reads as it always did.
    expect(
      basketLinePrice({
        priceRuleId: IDS.priceRule,
        basePriceMinor: 12000,
        currency: 'USD',
        chargeLines: [],
      }),
    ).toEqual({ label: 'Base price each', value: '$120.00', notes: [] });
  });

  it('SPK-PAY-014, SPK-REG-012 (handoff 1f): Review & pay shows each add-on and the uniform as its own line with what the quote stored', async () => {
    const place = quoteLine({
      description: 'Autumn Youth Program: Two days',
      unitPriceMinor: 13000,
      baseAmountMinor: 13000,
      discountMinor: 0,
      feeMinor: 0,
      totalMinor: 13000,
      discounts: [],
      charges: [],
      priceBasis: {
        pricingBasis: 'term',
        standardPriceMinor: 13000,
        tier: {
          tierId: TIER_DAYS,
          code: 'two_days',
          name: 'Two days',
          attendance: 'chosen_sessions',
          priceMinor: 13000,
          memberPriceMinor: null,
          availableUntil: null,
          purchasedAt: '2026-10-24T12:00:00.000Z',
          selectedSessionIds: [MON, WED],
        },
        appliedPrice: 'standard',
        appliedPriceMinor: 13000,
        member: null,
        sessions: null,
        unitPriceMinor: 13000,
      },
    });
    const extra = { discountMinor: 0, feeMinor: 0, discounts: [], charges: [], priceRuleId: null };
    const lunch = quoteLine({
      ...extra,
      id: '0192f1a0-0000-7000-8000-0000000000a3',
      sequence: 2,
      description: 'Lunch',
      quantity: 2,
      unitPriceMinor: 900,
      baseAmountMinor: 1800,
      totalMinor: 1800,
      lineKind: 'addon',
      sourceId: LUNCH,
      addon: {
        addonId: LUNCH,
        code: 'lunch',
        name: 'Lunch',
        selection: 'per_session',
        sessionIds: [MON, WED],
        quantity: 2,
        unitPriceMinor: 900,
      },
    });
    const kit = quoteLine({
      ...extra,
      id: '0192f1a0-0000-7000-8000-0000000000a4',
      sequence: 3,
      description: 'Club kit (YM)',
      unitPriceMinor: 0,
      baseAmountMinor: 0,
      totalMinor: 0,
      lineKind: 'uniform',
      sourceId: KIT,
      uniform: {
        offeringUniformId: KIT,
        itemKey: 'club-kit-2026',
        name: 'Club kit',
        size: 'YM',
        priceMinor: 2500,
        charged: false,
        reason: 'returning_holder',
        heldUniformOrderId: '0192f1a0-0000-7000-8000-000000004301',
        unitPriceMinor: 0,
      },
    });
    const app = createRegistrationTestApp({
      routes: {
        ...familyRoutes(),
        'GET /baskets/{id}': {
          status: 200,
          body: basket({ status: 'held', holdExpiresAt: inMinutes(10), lines: [line()] }),
        },
        'GET /offerings/{id}': { status: 200, body: offering() },
        'GET /acknowledgments': { status: 200, body: [] },
        'POST /registration-quotes': {
          status: 201,
          body: quote({
            lines: [place, lunch, kit],
            subtotalMinor: 14800,
            discountMinor: 0,
            feeMinor: 0,
            totalMinor: 14800,
            dueNowMinor: 14800,
          }),
        },
        'GET /policy-versions/{id}': {
          status: 200,
          body: policyVersion(IDS.cancellationPolicy, 'Program cancellation', 'cancellation'),
        },
        'GET /credits': { status: 200, body: { items: [], nextCursor: null } },
      },
    });
    render(<ReviewScreen basketId={IDS.basket} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Total, $148.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Lunch, $18.00')).toBeOnTheScreen();
    expect(screen.getByText('Chosen for 2 days')).toBeOnTheScreen();
    expect(screen.getByText('Size YM')).toBeOnTheScreen();
    expect(
      screen.getByText('Not charged: this uniform is already held (listed at $25.00).'),
    ).toBeOnTheScreen();
    // The stored basis of each kind of line, as helpers the other screens share.
    expect(quoteLineBasisLines(lunch)).toEqual(['Chosen for 2 days']);
    expect(quoteLineBasisLines(quoteLine())).toEqual([]);
  });
});
