/**
 * SCR-C-09 for a camp (park UI "Register: pick weeks, see the price"; SPK-REG-001, SPK-REG-005,
 * SPK-PAY-002, SPK-PAY-003): the camp's weeks from `GET /v1/offerings?programId=&kind=camp`, places
 * left from `GET /v1/offering-availability`, an informational total from
 * `POST /v1/discounts/evaluate`, and one basket line per chosen week and person. The binding price
 * stays the quote step; an offering of another kind shows no weeks.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  line,
  offering,
  optionsHandler,
  page,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { placesStatus, previewLines } from '../../../features/registration/CampWeeks';
import { RegistrationIntentScreen } from '../RegistrationIntentScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const WEEK2 = '0192f1a0-0000-7000-8000-0000000000f2';
const WEEK3 = '0192f1a0-0000-7000-8000-0000000000f3';

const camp = (overrides: Parameters<typeof offering>[0]) =>
  offering({
    kind: 'camp',
    price: { priceRuleId: IDS.priceRule, basePriceMinor: 26900, currency: 'USD', chargeLines: [] },
    ...overrides,
  });
const WEEK_1 = camp({ name: 'Winter Camp Week 1', startsOn: '2026-12-21', endsOn: '2026-12-24' });
const WEEK_2 = camp({
  id: WEEK2,
  name: 'Winter Camp Week 2',
  startsOn: '2026-12-28',
  endsOn: '2026-12-31',
});
const WEEK_3 = camp({
  id: WEEK3,
  name: 'Winter Camp Week 3',
  startsOn: '2027-01-04',
  endsOn: '2027-01-08',
  publicationState: 'published',
  registrationOpensAt: null,
});

const AVAILABILITY = {
  items: [
    { offeringId: IDS.offering, status: 'available', unit: 'seats', capacity: 30, remaining: 24 },
    { offeringId: WEEK2, status: 'full', unit: 'seats', capacity: 30, remaining: 0 },
    { offeringId: WEEK3, status: 'not_configured', unit: null, capacity: null, remaining: null },
  ],
  unavailableOfferingIds: [],
};

/** The evaluation the API gives: $269 a line, an early-bird $20 off each. */
function evaluate(req: FakeRequest) {
  const body = req.body as { currency: string; lines: { lineId: string }[] };
  const n = body.lines.length;
  return fakeResponse(200, {
    currency: body.currency,
    evaluatedAt: '2026-10-24T12:00:00.000Z',
    lines: body.lines.map((l) => ({
      lineId: l.lineId,
      baseAmountMinor: 26900,
      discountMinor: 2000,
      netAmountMinor: 24900,
    })),
    discounts: [
      {
        discountDefinitionId: '0192f1a0-0000-7000-8000-0000000000e1',
        code: null,
        name: 'Early bird',
        applied: true,
        amountMinor: 2000 * n,
        allocations: [],
        explanation: [],
      },
    ],
    totalBaseMinor: 26900 * n,
    totalDiscountMinor: 2000 * n,
    totalNetMinor: 24900 * n,
    unknownCodes: [],
  });
}

function addLineHandler() {
  return (req: FakeRequest) => {
    const body = req.body as { participantPersonId: string; expectedRevision: number };
    return fakeResponse(
      201,
      basket({
        lines: [line({ participantPersonId: body.participantPersonId })],
        revision: body.expectedRevision + 1,
      }),
    );
  };
}

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /offerings/{id}': { status: 200, body: WEEK_1 },
    'GET /offerings/{id}/registration-options': optionsHandler({ availableIntents: ['youth'] }),
    'GET /offerings': page([WEEK_3, WEEK_2, WEEK_1]),
    'GET /offering-availability': { status: 200, body: AVAILABILITY },
    'POST /discounts/evaluate': evaluate,
    'POST /baskets': { status: 201, body: basket({ lines: [], revision: 1, subtotalMinor: 0 }) },
    'POST /baskets/{id}/lines': addLineHandler(),
    ...overrides,
  };
}

describe('SCR-C-09 camp weeks and live total', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-005: lists the camp weeks in date order with places left, the opened week chosen', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });

    const weeks = await screen.findByTestId('camp-weeks');
    const rows = await within(weeks).findAllByRole('checkbox');
    expect(rows.map((r) => r.props.accessibilityLabel.split('.')[0])).toEqual([
      'Winter Camp Week 1',
      'Winter Camp Week 2',
      'Winter Camp Week 3',
    ]);
    expect(await within(weeks).findByRole('checkbox', { name: /24 places left/ })).toBeChecked();
    expect(
      within(weeks).getByRole('checkbox', { name: /^Winter Camp Week 2.*Full/ }),
    ).not.toBeChecked();
    // Registration not open: listed with its state, not choosable; no pool: no count.
    const week3 = within(weeks).getByRole('checkbox', { name: /^Winter Camp Week 3/ });
    expect(week3).toBeDisabled();
    expect(week3.props.accessibilityLabel).toMatch(/Registration not open yet/);
    expect(week3.props.accessibilityLabel).not.toMatch(/left/);

    const list = app.fake.requests.find((r) => r.route === '/offerings');
    expect(list?.query).toEqual({ programId: IDS.program, kind: 'camp', limit: '50' });
    const availability = app.fake.requests.filter((r) => r.route === '/offering-availability');
    expect(availability.at(-1)?.query.offeringIds?.split(',').sort()).toEqual(
      [IDS.offering, WEEK2, WEEK3].sort(),
    );
    await app.settle();
  });

  it('SPK-PAY-002/003: the price bar shows the evaluated total with the discount applied, as an estimate', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const bar = await screen.findByTestId('camp-price-bar');
    expect(within(bar).getByText('Choose who is going to see the total.')).toBeOnTheScreen();

    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    fireEvent.press(screen.getByRole('checkbox', { name: /^Winter Camp Week 2/ }));
    const total = await within(bar).findByTestId('camp-total');
    expect(total.props.accessibilityLabel).toBe(
      'Estimated total $498.00. Early bird applied, $40.00 off. Your quote gives the binding price',
    );
    expect(within(bar).getByRole('header', { name: '2 of 3 weeks · Ada' })).toBeOnTheScreen();
    const sent = app.fake.requests.filter((r) => r.route === '/discounts/evaluate').at(-1);
    expect(sent?.body).toEqual({
      currency: 'USD',
      codes: [],
      lines: previewLines([IDS.offering, WEEK2], [IDS.childA]),
    });
    // Choosing a full week says the basket offers its waitlist.
    expect(
      screen.getByText('A full week can still be added: your basket offers its waitlist.'),
    ).toBeOnTheScreen();
    await app.settle();
  });

  it('adds one basket line per chosen week and person, then opens the basket (the quote is unchanged)', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    fireEvent.press(await screen.findByRole('checkbox', { name: /^Winter Camp Week 2/ }));
    fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
    await screen.findByRole('checkbox', { name: 'Ada. Added to your basket' });

    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(lines.map((r) => (r.body as { offeringId: string }).offeringId)).toEqual([
      IDS.offering,
      WEEK2,
    ]);
    expect(lines.map((r) => (r.body as { expectedRevision: number }).expectedRevision)).toEqual([
      1, 2,
    ]);
    expect(new Set(lines.map((r) => r.headers['idempotency-key'])).size).toBe(2);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    expect(app.fake.requests.some((r) => r.route === '/registration-quotes')).toBe(false);
    await app.settle();
  });

  it('SPK-UX-008: a failed total shows its code with "Try again"; a failed week list keeps the opened week', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
        'POST /discounts/evaluate': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const weeks = await screen.findByTestId('camp-weeks');
    expect(
      await within(weeks).findByText('The other weeks of this camp could not be loaded.'),
    ).toBeOnTheScreen();
    expect(within(weeks).getAllByRole('checkbox')).toHaveLength(1);

    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    const bar = screen.getByTestId('camp-price-bar');
    expect(
      await within(bar).findByText(
        'The total could not be worked out. Your quote gives the price.',
      ),
    ).toBeOnTheScreen();
    expect(within(bar).getByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(bar).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    await app.settle();
  });

  it('an offering that is not a camp shows no weeks and no price bar', async () => {
    const app = createRegistrationTestApp({
      routes: routes({ 'GET /offerings/{id}': { status: 200, body: offering() } }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('checkbox', { name: 'Ada. Eligible' })).toBeOnTheScreen();
    expect(screen.queryByTestId('camp-weeks')).toBeNull();
    expect(screen.queryByTestId('camp-price-bar')).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/offerings')).toBe(false);
    expect(placesStatus(undefined)).toBeNull();
    await app.settle();
  });
});
