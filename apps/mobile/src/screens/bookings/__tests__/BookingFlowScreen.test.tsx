/**
 * Book a rental or party (Package G; SPK-COND-003, ENR-13, POL-040, DEC-016, DEC-076, DEC-077,
 * DEC-029, DEC-030, §4.9, SPK-SCHED-008, SPK-UX-008): the approved terms before anything is sent,
 * free times of one facility-local day from the API (a rental's length typed by the customer, a
 * party's from the API), exactly the number of resources the API states, one idempotency key per
 * intent; a request holds nothing, an instant booking is held and paid in its basket; field
 * errors next to their field; conflicts listed; turned off before and after a refusal.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { createRouterMock, me } from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import {
  booking,
  bookingTerms,
  G,
  offering,
  ok,
  partyAvailability,
  partyOffering,
  rentalAvailability,
  switchesOn,
} from '../../../features/package-g/__tests__/fixtures';
import { mePermissions, TEST_NOW } from '../../../testing/test-app';
import { BookingFlowScreen } from '../BookingFlowScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

type App = ReturnType<typeof createTestApp>;

function acknowledgment() {
  return {
    id: '0192f1a0-0000-7000-8000-00000000fc01',
    subjectPersonId: G.self,
    policyVersionId: G.policy,
    signedByPersonId: G.self,
    basis: 'self',
    recordedByPersonId: null,
    recordedByKind: 'customer',
    signedAt: '2026-10-24T12:00:00.000Z',
    evidence: {},
    status: 'active',
    withdrawnAt: null,
    withdrawnReason: null,
    revision: 1,
    createdAt: '2026-10-24T12:00:00.000Z',
  };
}

const TEN_AM = 'Sat, Oct 24, 10:00 AM to 11:00 AM PDT, 2 free: Court 1, Court 2';
const ELEVEN_AM = 'Sat, Oct 24, 11:00 AM to 12:00 PM PDT, 1 free: Court 1';
const PARTY_TIME = 'Sat, Oct 24, 1:00 PM to 3:00 PM PDT, 1 free: Party room';

function rentalRoutes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...switchesOn('rentals'),
    'GET /offerings/{id}': ok(offering()),
    'GET /policy-versions/{id}': ok(bookingTerms()),
    'GET /offerings/{id}/booking-availability': ok(rentalAvailability()),
    'POST /bookings': ok(booking()),
    ...overrides,
  };
}

function partyRoutes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...switchesOn('parties'),
    'GET /offerings/{id}': ok(partyOffering()),
    'GET /policy-versions/{id}': ok(
      bookingTerms({ confirmationMode: 'request', hostResponsibilities: 'An adult host stays.' }),
    ),
    'GET /offerings/{id}/booking-availability': ok(partyAvailability()),
    'POST /bookings': ok(
      booking({
        id: G.bookingB,
        kind: 'party',
        offeringId: G.party,
        offeringName: 'Birthday party',
        status: 'requested',
        outstanding: ['approval'],
        basketId: null,
        enrollmentId: null,
        guestCount: 12,
      }),
    ),
    ...overrides,
  };
}

function renderFlow(routes: Record<string, FakeHandler>, offeringId: string = G.rental) {
  const app = createTestApp({ routes });
  render(<BookingFlowScreen offeringId={offeringId} />, { wrapper: app.wrapper });
  return app;
}

const availabilityReads = (app: App) =>
  app.fake.requests.filter((r) => r.route === '/offerings/{id}/booking-availability');
const posts = (app: App) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/bookings');

async function press(name: string) {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name }));
  });
}

async function chooseRentalHour() {
  fireEvent.changeText(await screen.findByLabelText('How long, in minutes'), '60');
  fireEvent.press(await screen.findByRole('radio', { name: TEN_AM }));
  fireEvent.press(await screen.findByRole('radio', { name: 'Court 2' }));
}

describe('Package G BookingFlowScreen (SPK-COND-003)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  it('POL-040: shows the approved terms before anything is sent, and asks a rental how long before reading free times', async () => {
    const app = renderFlow(rentalRoutes());
    expect(await screen.findByRole('header', { name: 'Court rental' })).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        'How it is confirmed: Booked at once: the time is held for you, then you pay in your basket to confirm it.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        'Paying: Paid in full at checkout. Your basket shows the price, taxes and fees.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Access conditions: Enter by the north gate.')).toBeOnTheScreen();
    expect(screen.getByText('Enter how long to see the free times.')).toBeOnTheScreen();
    expect(availabilityReads(app)).toHaveLength(0);
    expect(posts(app)).toHaveLength(0);
  });

  it('ENR-13: an instant rental reads one facility-local day, offers only future times with a free court, and is held in its basket', async () => {
    const app = renderFlow(rentalRoutes());
    await chooseRentalHour();
    expect(screen.getByRole('radio', { name: ELEVEN_AM })).toBeOnTheScreen();
    // 4:00 AM is before the clock: never offered.
    expect(screen.queryByRole('radio', { name: /4:00 AM/ })).toBeNull();
    expect(screen.getByText("Times are in the facility's time zone (PDT).")).toBeOnTheScreen();
    expect(availabilityReads(app)[0]?.query).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-10-25T07:00:00.000Z',
      durationMinutes: '60',
    });
    await press('Book now');
    expect(await screen.findByTestId('booking-outcome')).toBeOnTheScreen();
    expect(screen.getByLabelText('Held for you: pay to confirm')).toBeOnTheScreen();
    const [sent] = posts(app);
    expect(sent?.body).toEqual({
      offeringId: G.rental,
      start: '2026-10-24T17:00:00.000Z',
      end: '2026-10-24T18:00:00.000Z',
      resourceIds: [G.court2],
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    fireEvent.press(screen.getByRole('button', { name: 'Go to basket' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${G.basket}`);
  });

  it('§4.9: with no answer, "Check again" repeats the same booking with the same idempotency key and body', async () => {
    let attempts = 0;
    const app = renderFlow(
      rentalRoutes({
        'POST /bookings': () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('Network request failed');
          return fakeResponse(200, booking());
        },
      }),
    );
    await chooseRentalHour();
    await press('Book now');
    expect(await screen.findByLabelText('No answer yet')).toBeOnTheScreen();
    expect(screen.queryByTestId('booking-outcome')).toBeNull();
    await press('Check again');
    expect(await screen.findByTestId('booking-outcome')).toBeOnTheScreen();
    const [first, second] = posts(app);
    expect(posts(app)).toHaveLength(2);
    expect(first?.headers['idempotency-key']).toMatch(/^key-/);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toEqual(first?.body);
  });

  it('§4.9 IDEMPOTENCY_OUTCOME_UNAVAILABLE: a booking that committed with its answer lost is "This may already have been done", and booking the same time again keeps the key, so it is never booked twice', async () => {
    let attempts = 0;
    const app = renderFlow(
      rentalRoutes({
        'POST /bookings': () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('Network request failed');
          return fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_OUTCOME_UNAVAILABLE', {
              nextAction: 'reload_current_state',
            }),
          );
        },
      }),
    );
    await chooseRentalHour();
    await press('Book now');
    await press('Check again');
    expect(await screen.findByLabelText('This may already have been done')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();
    expect(screen.queryByLabelText('No answer yet')).toBeNull();
    await press('Reload');
    await press('Book now');
    await waitFor(() => expect(posts(app)).toHaveLength(3));
    const keys = posts(app).map((r) => r.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
  });

  it('SPK-UX-008: free times read earlier stay listed offline under the offline notice with their age, and booking is disabled', async () => {
    const app = renderFlow(rentalRoutes());
    await chooseRentalHour();
    act(() => app.sources.setReachable(false));
    const when = screen.getByTestId('booking-when');
    expect(await within(when).findByLabelText('You are offline')).toBeOnTheScreen();
    expect(within(when).getByText(/^Showing information from /)).toBeOnTheScreen();
    expect(within(when).getByText('Needs a connection: Booking.')).toBeOnTheScreen();
    expect(within(when).getByRole('radio', { name: TEN_AM })).toBeOnTheScreen();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Book now' })).toBeDisabled());
    expect(screen.getByText('Booking needs a connection.')).toBeOnTheScreen();
    expect(posts(app)).toHaveLength(0);
  });

  it('SPK-UX-008: free times older than the stale threshold say they may be out of date, with their age', async () => {
    let clock = TEST_NOW;
    const app = createTestApp({
      routes: rentalRoutes(),
      config: { staleDataThresholdMs: 60_000 },
      now: () => clock,
    });
    render(<BookingFlowScreen offeringId={G.rental} />, { wrapper: app.wrapper });
    await chooseRentalHour();
    const when = screen.getByTestId('booking-when');
    // Fresh: only its age.
    expect(within(when).getByTestId('last-updated')).toBeOnTheScreen();
    expect(within(when).queryByLabelText('This information may be out of date')).toBeNull();
    clock = new Date(TEST_NOW.getTime() + 120_000);
    fireEvent.press(screen.getByRole('radio', { name: ELEVEN_AM }));
    expect(
      await within(when).findByLabelText('This information may be out of date'),
    ).toBeOnTheScreen();
    expect(within(when).getByText(/^Showing information from 2 min/)).toBeOnTheScreen();
    expect(within(when).getByRole('radio', { name: ELEVEN_AM })).toBeChecked();
  });

  it('SPK-COND-003 request mode: a party request holds nothing, states its guests, and the deposit-before-approval question stays pending', async () => {
    const app = renderFlow(partyRoutes(), G.party);
    expect(await screen.findByLabelText('Length: 120 minutes')).toBeOnTheScreen();
    expect(screen.getByLabelText('Host responsibilities: An adult host stays.')).toBeOnTheScreen();
    const pending = screen.getByTestId('state-pending-decision');
    expect(within(pending).getByText(/DEC-029, DEC-030/)).toBeOnTheScreen();
    // A party's length is the package's: the read names no duration.
    expect(availabilityReads(app)[0]?.query).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-10-25T07:00:00.000Z',
    });
    fireEvent.press(await screen.findByRole('radio', { name: PARTY_TIME }));
    fireEvent.press(await screen.findByRole('radio', { name: 'Party room' }));
    fireEvent.changeText(screen.getByLabelText('Number of guests'), '12');
    await press('Send request');
    expect(await screen.findByLabelText('Request awaiting approval')).toBeOnTheScreen();
    expect(
      screen.getByText(/Nothing is reserved or charged until staff approve your request\./),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Go to basket' })).toBeNull();
    expect(posts(app)[0]?.body).toEqual({
      offeringId: G.party,
      start: '2026-10-24T20:00:00.000Z',
      resourceIds: [G.room],
      guestCount: 12,
    });
  });

  it('validation failure: missing length and time are field messages and nothing is sent', async () => {
    const app = renderFlow(rentalRoutes());
    await screen.findByLabelText('How long, in minutes');
    await press('Book now');
    expect(screen.getByText(/Enter how long, in minutes \(15 to 1440\)\./)).toBeOnTheScreen();
    expect(screen.getByText(/Choose a start time\./)).toBeOnTheScreen();
    expect(posts(app)).toHaveLength(0);
  });

  it("the package's guest limit is the API's: GUEST_LIMIT_EXCEEDED is shown next to the guests field", async () => {
    const app = renderFlow(
      partyRoutes({
        'POST /bookings': {
          status: 400,
          body: apiErrorBody('VALIDATION_FAILED', {
            message: 'This package takes at most 10 guests.',
            nextAction: 'correct_input',
            details: { code: 'GUEST_LIMIT_EXCEEDED', path: 'guestCount' },
          }),
        },
      }),
      G.party,
    );
    fireEvent.press(await screen.findByRole('radio', { name: PARTY_TIME }));
    fireEvent.press(await screen.findByRole('radio', { name: 'Party room' }));
    fireEvent.changeText(screen.getByLabelText('Number of guests'), '12');
    await press('Send request');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /This package takes at most 10 guests\./,
    );
    expect(screen.getByLabelText('Number of guests')).toHaveDisplayValue('12');
    expect(posts(app)).toHaveLength(1);
  });

  it('a weekly rental sends its number of weeks; weeks that are not free (RESOURCE_CONFLICT) are listed and the times read again', async () => {
    const app = renderFlow(
      rentalRoutes({
        'POST /bookings': {
          status: 409,
          body: apiErrorBody('RESOURCE_CONFLICT', {
            message: 'The requested time is not free.',
            nextAction: 'choose_another_time',
            details: {
              conflicts: [{ occurrenceStart: '2026-11-07T18:00:00.000Z', resourceId: G.court2 }],
            },
          }),
        },
      }),
    );
    await chooseRentalHour();
    fireEvent.press(
      screen.getByRole('checkbox', { name: 'Repeat every week, Same time and spaces each week' }),
    );
    fireEvent.changeText(screen.getByLabelText('Number of weeks, including the first'), '4');
    await press('Book now');
    expect(
      await screen.findByText('▲ Not free: Sat, Nov 7, 10:00 AM PST, Court 2'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: RESOURCE_CONFLICT/)).toBeOnTheScreen();
    expect(posts(app)[0]?.body).toMatchObject({ recurrence: { count: 4 } });
    await waitFor(() => expect(availabilityReads(app).length).toBeGreaterThanOrEqual(2));
  });

  it('SPK-REG-009: forms the offering requires are signed by the booker before booking; MISSING_ACKNOWLEDGMENT shows its code', async () => {
    let signed = false;
    const app = renderFlow(
      rentalRoutes({
        'GET /me': ok(me()),
        'GET /offerings/{id}': ok(offering({ requiredFormPolicyVersionIds: [G.policy] })),
        'GET /policy-versions/{id}': (req) =>
          fakeResponse(
            200,
            req.params.id === G.policy
              ? bookingTerms(
                  { text: 'I accept the court rules.' },
                  { id: G.policy, kind: 'form', title: 'Court waiver' },
                )
              : bookingTerms(),
          ),
        'GET /acknowledgments': () => fakeResponse(200, signed ? [acknowledgment()] : []),
        'POST /acknowledgments': () => {
          signed = true;
          return fakeResponse(201, acknowledgment());
        },
        'POST /bookings': {
          status: 422,
          body: apiErrorBody('MISSING_ACKNOWLEDGMENT', {
            message: 'Required forms must be acknowledged before booking.',
            nextAction: 'complete_required_forms',
          }),
        },
      }),
    );
    const forms = await screen.findByTestId('booking-forms');
    expect(await within(forms).findByText('I accept the court rules.')).toBeOnTheScreen();
    const sign = await within(forms).findByRole('button', { name: 'Sign Court waiver' });
    expect(sign).toBeDisabled();
    await chooseRentalHour();
    await press('Book now');
    expect(await screen.findByText(/Error code: MISSING_ACKNOWLEDGMENT/)).toBeOnTheScreen();
    fireEvent.press(
      within(forms).getByRole('checkbox', { name: 'I have read and agree to Court waiver' }),
    );
    await act(async () => {
      fireEvent.press(within(forms).getByRole('button', { name: 'Sign Court waiver' }));
    });
    expect(
      await within(forms).findByLabelText('Signed Oct 24, 2026, 5:00 AM PDT'),
    ).toBeOnTheScreen();
    const [ack] = app.fake.requests.filter(
      (r) => r.method === 'POST' && r.route === '/acknowledgments',
    );
    expect(ack?.body).toEqual({ subjectPersonId: G.self, policyVersionId: G.policy });
    expect(ack?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('a later day reads the next facility-local day; the first day has no earlier one', async () => {
    const app = renderFlow(rentalRoutes());
    fireEvent.changeText(await screen.findByLabelText('How long, in minutes'), '60');
    await screen.findByRole('radio', { name: TEN_AM });
    expect(screen.getByRole('button', { name: 'Earlier day' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Later day' }));
    expect(await screen.findByText('Sun, Oct 25 (PDT)')).toBeOnTheScreen();
    await waitFor(() =>
      expect(availabilityReads(app).at(-1)?.query).toEqual({
        from: '2026-10-25T07:00:00.000Z',
        to: '2026-10-26T07:00:00.000Z',
        durationMinutes: '60',
      }),
    );
  });

  it('DEC-016: blocked while both switches are off; a rental is turned off while only parties are on', async () => {
    const off = renderFlow({ 'GET /offerings/{id}': ok(offering()) });
    expect(await screen.findByLabelText('Book a rental or party turned off')).toBeOnTheScreen();
    expect(off.fake.requests.filter((r) => r.route === '/offerings/{id}')).toHaveLength(0);
    await settleApps();
    screen.unmount();

    const partiesOnly = renderFlow(rentalRoutes(switchesOn('parties')));
    const state = await screen.findByTestId('state-turned-off');
    expect(within(state).getByLabelText('Rentals turned off')).toBeOnTheScreen();
    expect(within(state).getByText(/DEC-076/)).toBeOnTheScreen();
    expect(
      partiesOnly.fake.requests.filter((r) => r.route === '/policy-versions/{id}'),
    ).toHaveLength(0);
  });

  it('a CAPABILITY_DISABLED answer is "turned off" with its code, never a failure or "not available"', async () => {
    renderFlow(
      rentalRoutes({
        'POST /bookings': {
          status: 403,
          body: capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076']),
        },
      }),
    );
    await chooseRentalHour();
    await press('Book now');
    expect(await screen.findByLabelText('Rentals turned off')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/)).toBeOnTheScreen();
    expect(screen.queryByTestId('state-unavailable')).toBeNull();
    // The customer's choices are kept.
    expect(screen.getByLabelText('How long, in minutes')).toHaveDisplayValue('60');
  });

  it('after a CAPABILITY_DISABLED answer the switches are read again and the flow follows them', async () => {
    let rentalsOn = true;
    const app = renderFlow(
      rentalRoutes({
        'GET /me/permissions': () =>
          fakeResponse(200, mePermissions({ enabled: rentalsOn ? ['rentals'] : [] }).body),
        'POST /bookings': () => {
          rentalsOn = false;
          return fakeResponse(403, capabilityDisabledBody('rentals', ['DEC-016', 'DEC-076']));
        },
      }),
    );
    await chooseRentalHour();
    await press('Book now');
    expect(await screen.findByLabelText('Book a rental or party turned off')).toBeOnTheScreen();
    expect(
      app.fake.requests.filter((r) => r.route === '/me/permissions').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('an offering without approved booking terms is not bookable yet (POL-040), and nothing is read for it', async () => {
    const app = renderFlow(
      rentalRoutes({ 'GET /offerings/{id}': ok(offering({ bookingTermsPolicyVersionId: null })) }),
    );
    expect(await screen.findByLabelText('Not bookable yet')).toBeOnTheScreen();
    expect(screen.getByText(/no approved booking terms yet \(POL-040\)/)).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/policy-versions/{id}')).toHaveLength(0);
  });

  it('the terms read error shows its code and "Try again"', async () => {
    let calls = 0;
    renderFlow(
      rentalRoutes({
        'GET /policy-versions/{id}': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-t' }))
            : fakeResponse(200, bookingTerms());
        },
      }),
    );
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-t/),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('How long, in minutes')).toBeOnTheScreen();
  });

  it('§4.10: an offering the API does not show is "not available"; one that is not a rental or party is not booked here', async () => {
    renderFlow(
      rentalRoutes({
        'GET /offerings/{id}': {
          status: 404,
          body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
        },
      }),
    );
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    await settleApps();
    screen.unmount();

    renderFlow(rentalRoutes({ 'GET /offerings/{id}': ok(offering({ kind: 'season' })) }));
    expect(await screen.findByLabelText('Not booked here')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open the activity' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/offering/${G.rental}`);
  });

  it('a malformed offering id is "Link not available", without a request', async () => {
    const app = createTestApp();
    render(<BookingFlowScreen offeringId={null} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
