/**
 * SCR-C-08 Offering detail (SPK-CAT-001, SPK-REG-002, SPK-SCHED-008, POL-007): every offering
 * fact the public view carries, times in the facility's zone, the read-only eligibility of each
 * person the account may register (registration options, ENR-05), the registration entry point
 * only while registration is open, and the SPK-UX-008 states (not available, error with code,
 * offline with registration disabled, signed out). The activity page v2 (ADR-008, PA-11): key
 * facts as tags, the description with "Read more", the facts in folds, and the bar's one action.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  ineligible,
  offering,
  optionsHandler,
  page,
  policyVersion,
  registrationOptions,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { OfferingDetailScreen, detailActionFor, sessionPattern } from '../OfferingDetailScreen';
import { openSupportDetails } from '../../../testing/ui-surfaces';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const SESSION = {
  id: '0192f1a0-0000-7000-8000-0000000000e1',
  offeringId: IDS.offering,
  sequence: 1,
  title: 'Week 1',
  scheduledStart: '2026-11-02T23:00:00.000Z',
  scheduledEnd: '2026-11-03T00:00:00.000Z',
  schedulingEventId: null,
  capacityOverride: null,
  status: 'scheduled',
  canceledAt: null,
  cancelReason: null,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
};

/** Opens the folds of the activity page named, as a person taps their headings. */
async function openFolds(...names: string[]) {
  for (const name of names) fireEvent.press(await screen.findByRole('button', { name }));
}

function routes(overrides = {}) {
  return {
    ...familyRoutes(),
    'GET /offerings/{id}/registration-options': optionsHandler(),
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings/{id}/sessions': { status: 200, body: [SESSION] },
    'GET /policy-versions/{id}': (req: FakeRequest) =>
      fakeResponse(
        200,
        req.params.id === IDS.formPolicy
          ? policyVersion(IDS.formPolicy, 'Medical consent')
          : policyVersion(IDS.cancellationPolicy, 'Program cancellation', 'cancellation'),
      ),
    ...overrides,
  };
}

describe('SCR-C-08 OfferingDetailScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-CAT-001: shows the offering facts, price basis, forms and cancellation policy', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Autumn Youth Program' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Registration open')).toBeOnTheScreen();
    await openFolds(
      'Schedule',
      'Options and add-ons',
      "What you'll need",
      'Cancellation and eligibility',
      'Location',
    );
    expect(screen.getByLabelText('Format: 7v7')).toBeOnTheScreen();
    expect(screen.getByLabelText('Location: Field 2')).toBeOnTheScreen();
    expect(screen.getByLabelText('Dates: Nov 2, 2026 to Dec 14, 2026')).toBeOnTheScreen();
    expect(screen.getByLabelText('Age: Ages 8 to 10')).toBeOnTheScreen();
    expect(screen.getByText('20 places')).toBeOnTheScreen();
    expect(screen.getByLabelText('Base price: $120.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Facility fee: $5.00, added to the price')).toBeOnTheScreen();
    expect(await screen.findByText('• Medical consent')).toBeOnTheScreen();
    expect(screen.getByText('Program cancellation')).toBeOnTheScreen();
    expect(await screen.findByLabelText(/^Week 1: /)).toBeOnTheScreen();
  });

  it('SPK-PAY-013: a price for each class is shown with the classes still to come and their product', async () => {
    const base = offering();
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({
            price: {
              ...(base.price as NonNullable<typeof base.price>),
              basePriceMinor: 2400,
              chargeLines: [],
              pricingBasis: 'per_session',
              remainingSessionCount: 7,
              remainingSessionsPriceMinor: 16800,
              notQuotable: null,
            },
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Options and add-ons');
    expect(await screen.findByLabelText('Price per class: $24.00')).toBeOnTheScreen();
    expect(screen.getByText('$24.00 per class × 7 classes = $168.00')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'You pay for the classes still to come. They are counted again when you ask for a price.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Base price/)).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(/^Member price/)).not.toBeOnTheScreen();
  });

  it('SPK-PAY-013: a per-class price with no class left says so and shows no product', async () => {
    const base = offering();
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({
            price: {
              ...(base.price as NonNullable<typeof base.price>),
              basePriceMinor: 2400,
              pricingBasis: 'per_session',
              remainingSessionCount: 0,
              remainingSessionsPriceMinor: 0,
              notQuotable: null,
            },
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Options and add-ons');
    expect(await screen.findByLabelText('Price per class: $24.00')).toBeOnTheScreen();
    expect(screen.getByText('No class of this activity is still to come.')).toBeOnTheScreen();
    expect(screen.queryByText(/classes =/)).not.toBeOnTheScreen();
  });

  it('SPK-PAY-015: a member price is shown with the membership it is for', async () => {
    const base = offering();
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({
            price: {
              ...(base.price as NonNullable<typeof base.price>),
              basePriceMinor: 30000,
              memberPrice: {
                priceMinor: 25000,
                entitlementDefinitionId: '0192f1a0-0000-7000-8000-0000000000f1',
                entitlementName: 'Annual membership',
              },
            },
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Options and add-ons');
    expect(await screen.findByLabelText('Base price: $300.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Member price (Annual membership): $250.00')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'The member price applies to a participant who holds this membership when the price is made.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/per class/)).not.toBeOnTheScreen();
  });

  it('SPK-SCHED-008: session and registration times are in the facility time zone, with the facility named', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Location', 'Schedule');
    expect(await screen.findByLabelText('Facility: Test complex')).toBeOnTheScreen();
    // 23:00 UTC on Nov 2 is 3:00 PM in Los Angeles (PST).
    expect(await screen.findByLabelText('Week 1: Mon, Nov 2, 3:00 PM PST')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Registration closes: Fri, Oct 30, 8:00 AM PDT'),
    ).toBeOnTheScreen();
  });

  it('SPK-REG-002: shows read-only eligibility per person the account may register, and a view-only child as not available', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({
            availableIntents: ['youth'],
            participants: [
              {
                personId: IDS.childA,
                intents: [
                  {
                    intent: 'youth',
                    eligibility: registrationOptions().participants[0]!.intents[0]!.eligibility,
                  },
                ],
              },
              {
                personId: IDS.childB,
                intents: [{ intent: 'youth', eligibility: ineligible() }],
              },
            ],
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Cancellation and eligibility');
    expect(await screen.findByLabelText('Ada, Register a child: Eligible')).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        'Ben, Register a child: Not eligible. Ages 9 to 12. Ben is 13.. Look for another activity that fits.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Cy: Not available to register from your account'),
    ).toBeOnTheScreen();
    // Nothing is held or written by the preview: a read only.
    expect(app.fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('SPK-UX-008: an eligibility read that fails shows its code; the rest of the detail stays', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { message: 'Options failed.' })),
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openFolds('Cancellation and eligibility');
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Autumn Youth Program' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Register' })).toBeOnTheScreen();
  });

  it('SPK-PAY-013 (QA M-6): with per-class pricing turned off, a per-class activity shows the reason and no price, and is not registered for online', async () => {
    const base = offering();
    const message =
      'This activity is priced per class, and per-class pricing is turned off for this organization. It is not open for online registration; ask the front desk.';
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({
            price: {
              ...(base.price as NonNullable<typeof base.price>),
              basePriceMinor: 2400,
              chargeLines: [],
              pricingBasis: 'per_session',
              remainingSessionCount: null,
              remainingSessionsPriceMinor: null,
              memberPrice: null,
              notQuotable: { code: 'per_session_pricing_off', message },
            },
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByText(message)).toBeOnTheScreen();
    expect(screen.getByText('Not open for online registration')).toBeOnTheScreen();
    // No amount the customer cannot get, and nothing to press.
    expect(screen.queryByLabelText(/^Price per class/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/\$24\.00/)).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeOnTheScreen();
  });

  it('opens the registration chooser (SCR-C-09) from Register', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Register' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/start/${IDS.offering}`);
  });

  it('SPK-CAT-004: a paused registration keeps existing participation and offers no registration', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ publicationState: 'registration_paused' }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(
      await screen.findByText('Registration is paused. Existing registrations are kept.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();
  });

  it('signed out: asks to sign in to register and reads no policy (they need an account)', async () => {
    const app = createRegistrationTestApp({ session: null, routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in to register' })).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.route === '/policy-versions/{id}')).toBe(false);
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/registration-options')).toBe(
      false,
    );
    await openFolds('Cancellation and eligibility');
    expect(
      screen.getByText('This activity has a cancellation policy. Sign in to read it.'),
    ).toBeOnTheScreen();
  });

  it('§4.10: a withdrawn or unknown offering reads not available', async () => {
    const app = createRegistrationTestApp({ routes: {} });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('shows the API error code with a recovery action', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': () =>
          fakeResponse(500, apiErrorBody('INTERNAL_ERROR', { message: 'Something failed.' })),
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.15: offline keeps the detail with its age and disables registration', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Register' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled();
    expect(screen.getByText('Registration needs a connection.')).toBeOnTheScreen();
    expect(screen.getByText('Showing information from just now.')).toBeOnTheScreen();
  });

  it('Activity page: the key facts are tags under the name, with the picture above', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const facts = await screen.findByTestId('offering-facts');
    await screen.findByLabelText('Mon · 3:00 PM');
    expect(
      within(facts)
        .getAllByRole('text')
        .map((tag) => tag.props.accessibilityLabel as string | undefined)
        // The tags' decorative icons are text too, without a name.
        .filter((name) => name !== undefined),
    ).toEqual([
      'Ages 8 to 10',
      'Nov 2 to Dec 14, 2026',
      'Mon · 3:00 PM',
      'Field 2',
      '20 places',
      'From $120.00',
    ]);
    // Facts move into folds: closed until the person opens one.
    expect(screen.queryByLabelText('Format: 7v7')).toBeNull();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeCollapsed();
    expect(
      sessionPattern(
        [
          { scheduledStart: '2026-11-03T01:00:00.000Z', status: 'scheduled' },
          { scheduledStart: '2026-11-06T01:00:00.000Z', status: 'scheduled' },
          { scheduledStart: '2026-11-04T01:00:00.000Z', status: 'canceled' },
        ],
        'America/Los_Angeles',
      ),
    ).toBe('Mon & Thu · 5:00 PM');
  });

  it('Activity page: a long description is clamped, and "Read more" shows all of it', async () => {
    const description = `${'Small-sided games, footwork and team play every week. '.repeat(5)}Bring water.`;
    const app = createRegistrationTestApp({
      routes: routes({ 'GET /offerings/{id}': { status: 200, body: offering({ description }) } }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const text = await screen.findByTestId('offering-description');
    expect(text.props.numberOfLines).toBe(4);
    const more = screen.getByRole('button', { name: 'Read more' });
    expect(more).toBeCollapsed();
    fireEvent.press(more);
    expect(screen.getByTestId('offering-description').props.numberOfLines).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeExpanded();
    await app.settle();
  });

  it('Activity page: a short description shows whole, with no "Read more"', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByText('Skills sessions for young players.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    await app.settle();
  });

  it('Activity page: the bar shows the price and Register for an open activity', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const bar = await screen.findByTestId('offering-action');
    expect(within(bar).getByLabelText('From, $120.00')).toBeOnTheScreen();
    expect(await within(bar).findByRole('button', { name: 'Register' })).toBeEnabled();
    await app.settle();
  });

  it('Activity page SPK-SCHED-008: before registration opens, the bar says when, in the facility zone, and cannot be pressed', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({
            publicationState: 'published',
            // 07:30 UTC on Nov 4 is still Nov 3 in Los Angeles.
            registrationOpensAt: '2026-11-04T07:30:00.000Z',
          }),
        },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Opens Nov 3' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();
    await app.settle();
  });

  it('Activity page: with this activity already in an open cart, the bar says so and checks out', async () => {
    const app = createRegistrationTestApp({
      routes: routes({ 'GET /me/baskets': page([basket()]) }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const bar = await screen.findByTestId('offering-action');
    fireEvent.press(await within(bar).findByRole('button', { name: 'Check out' }));
    expect(within(bar).getByLabelText('In your cart, $120.00')).toBeOnTheScreen();
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    expect(app.fake.requests.find((r) => r.route === '/me/baskets')?.query).toEqual({
      limit: '20',
    });
  });

  it('Activity page SPK-REG-008: when the API offers everyone only the waitlist, the bar offers "Join waitlist"', async () => {
    const full = {
      ...ineligible('This activity is full.', 'offering_full'),
      alternatives: [
        { kind: 'join_waitlist' as const, message: 'Join the waitlist.', offeringId: null },
      ],
    };
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': optionsHandler({
          availableIntents: ['youth'],
          participants: [IDS.parent, IDS.childA, IDS.childB].map((personId) => ({
            personId,
            intents: [{ intent: 'youth' as const, eligibility: full }],
          })),
        }),
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Join waitlist' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/start/${IDS.offering}`);
    expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();
  });

  it('Activity page: a trial is booked, from the same chooser', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': { status: 200, body: offering({ kind: 'trial' }) },
      }),
    });
    render(<OfferingDetailScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Book' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/start/${IDS.offering}`);
  });

  it('Activity page: the bar picks one action for each state', () => {
    const base = offering();
    const now = new Date('2026-10-24T12:00:00.000Z');
    const pick = (over: Partial<Parameters<typeof detailActionFor>[0]> = {}) =>
      detailActionFor({
        offering: base,
        signedIn: true,
        now,
        cartBasketId: null,
        waitlistOnly: false,
        ...over,
      });
    expect(pick()).toEqual({ kind: 'register' });
    expect(pick({ signedIn: false })).toEqual({ kind: 'sign_in' });
    expect(pick({ cartBasketId: IDS.basket })).toEqual({ kind: 'checkout', basketId: IDS.basket });
    expect(pick({ waitlistOnly: true })).toEqual({ kind: 'waitlist' });
    expect(pick({ offering: offering({ kind: 'pickup' }) })).toEqual({ kind: 'book' });
    expect(
      pick({
        offering: offering({
          publicationState: 'published',
          registrationOpensAt: '2027-03-03T17:00:00.000Z',
        }),
      }),
    ).toEqual({ kind: 'opens', label: 'Opens Mar 3' });
    expect(pick({ offering: offering({ publicationState: 'registration_paused' }) })).toBeNull();
    expect(pick({ offering: offering({ publicationState: 'closed' }) })).toBeNull();
  });
});
