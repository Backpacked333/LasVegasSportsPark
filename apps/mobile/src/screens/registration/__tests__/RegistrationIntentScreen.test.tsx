/**
 * SCR-C-09 Registration intent chooser (SPK-REG-001, SPK-REG-002, SPK-IAM-003, SPK-REG-004;
 * SPK-AT-001 a returning parent registers two children): the intents the API's registration
 * options offer, participants the API names with their eligibility, one basket line per
 * participant with the basket's expected revision and one idempotency key per line, retries that
 * reuse the key and never add a participant twice, the open basket from `GET /me/baskets`, the
 * Package G booking hand-over and the turned-off state.
 */
import {
  apiErrorBody,
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  eligible,
  familyRoutes,
  ineligible,
  line,
  me,
  offering,
  optionsHandler,
  page,
  personName,
  registrationOptions,
} from '../../../features/registration/testing/fixtures';
import { mePermissions } from '../../../testing/test-app';
import {
  basketButtonReady,
  createRegistrationTestApp,
} from '../../../features/registration/testing/registration-test-app';
import { RegistrationIntentScreen } from '../RegistrationIntentScreen';
import { chooseInSheet, openSheet } from '../../../testing/ui';
import { openSupportDetails } from '../../../testing/ui-surfaces';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const EMPTY_BASKET = basket({ lines: [], revision: 1, subtotalMinor: 0 });

/** PA-11: the youth intent reads "Register a child" (was "Youth enrollment"). */
const YOUTH = 'Register a child. Register a child in this program.';

/** Chooses a registration type in its sheet, once the types have loaded. */
async function chooseType(name: string) {
  await screen.findByRole('button', { name: 'Registration type' });
  await chooseInSheet(screen, 'Registration type', name);
}

/** Opens the registration type sheet and returns it (the types are radios inside). */
async function openTypeSheet() {
  fireEvent.press(await screen.findByRole('button', { name: 'Registration type' }));
  return within(await waitFor(() => openSheet(screen)));
}

/** Answers each line with the basket grown by that line and the revision bumped. */
function addLineHandler(fail?: (req: FakeRequest, call: number) => Response | null) {
  let call = 0;
  return (req: FakeRequest) => {
    call += 1;
    const failure = fail?.(req, call);
    if (failure) return failure;
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
    'GET /offerings/{id}': { status: 200, body: offering() },
    'GET /offerings/{id}/registration-options': optionsHandler(),
    'POST /baskets': { status: 201, body: EMPTY_BASKET },
    'POST /baskets/{id}/lines': addLineHandler(),
    ...overrides,
  };
}

describe('SCR-C-09 RegistrationIntentScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-001, ENR-05: offers exactly the intents the API answers, for the people it names', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // ADR-008: with more than one type, the types are a sheet behind "Registration type".
    expect(await screen.findByRole('button', { name: 'Registration type' })).toHaveProp(
      'accessibilityValue',
      { text: 'Register a child' },
    );
    const sheet = await openTypeSheet();
    expect(sheet.getByRole('radio', { name: YOUTH })).toBeChecked();
    // Not in the API's answer, so not offered (no client table of intents per kind).
    expect(sheet.queryByRole('radio', { name: /^Join as a player/ })).toBeNull();
    // A makeup is booked from the makeup sessions the participant has (SCR-C-35).
    const makeup = sheet.getByRole('radio', {
      name: 'Makeup session. Use a makeup for a missed session. A makeup is booked from the makeup sessions you have (You, credits and makeups).',
    });
    expect(makeup).toBeDisabled();
    fireEvent.press(sheet.getByRole('button', { name: 'Close' }));
    fireEvent.press(screen.getByRole('button', { name: 'Open your makeup sessions' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/credits');
    const read = app.fake.requests.find((r) => r.route === '/offerings/{id}/registration-options');
    expect(read?.query.participantPersonIds?.split(',').sort()).toEqual(
      [IDS.parent, IDS.childA, IDS.childB, IDS.viewOnlyChild].sort(),
    );
  });

  it('§4.14: names come from the names-only GET /person-names (no person records); someone it omits is not listed', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /person-names': {
          status: 200,
          body: { items: [personName(IDS.childA, 'Ada'), personName(IDS.viewOnlyChild, 'Cy')] },
        },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('checkbox', { name: 'Ada. Eligible' })).toBeOnTheScreen();
    // Ben's name was not given: he is not listed, and nothing says he exists.
    expect(screen.queryByRole('checkbox', { name: /^Ben/ })).toBeNull();
    expect(app.fake.requests.some((r) => r.path.startsWith('/people/'))).toBe(false);
    expect(app.fake.requests.filter((r) => r.route === '/person-names')).toHaveLength(1);
  });

  it('SPK-UX-008: names that cannot be read show the code and a retry; nobody is registered meanwhile', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /person-names': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/registration-options')).toBe(
      false,
    );
  });

  it('SPK-REG-002: shows each participant’s eligibility and keeps an ineligible one from being added', async () => {
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
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    const ada = await screen.findByRole('checkbox', { name: 'Ada. Eligible' });
    expect(ada).not.toBeDisabled();
    const ben = screen.getByRole('checkbox', {
      name: 'Ben. Not eligible. Ages 9 to 12. Ben is 13.. Look for another activity that fits.',
    });
    expect(ben).toBeDisabled();
  });

  it('Package G: a rental hands over to the booking route; a switch that is off reads turned off', async () => {
    const rental = offering({ kind: 'rental', name: 'Field rental' });
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': { status: 200, body: rental },
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({ availableIntents: ['rental_request'], participants: [] }),
        },
        'GET /me/permissions': mePermissions({ enabled: ['rentals'] }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // ADR-008: one type is said, not offered as a choice.
    expect(
      await screen.findByLabelText(
        'Registration type: Rental request. Request this rental. Choose a time and what you need on the next screen.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Registration type' })).toBeNull();
    fireEvent.press(await screen.findByRole('button', { name: 'Continue to booking' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/bookings/new/${IDS.offering}`);
    // No basket line is ever sent for a booking intent (SPK-COND-003).
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);
  });

  it('DEC-016: a Package G intent whose switch is off is not offered and says it is turned off', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'membership', name: 'Family membership' }),
        },
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({ availableIntents: ['membership'] }),
        },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // PA-11: the plain message is shown; the decisions are in the support fold only.
    expect(
      await screen.findByLabelText(
        'Registration type: Membership. Join this membership. Memberships turned off. Ask the front desk about memberships.',
      ),
    ).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText('Decisions: DEC-016, DEC-072')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
  });

  it('CAPABILITIES-07: an intent the API reports unavailable reads turned off, even before the permission view catches up', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'membership', name: 'Family membership' }),
        },
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({
            availableIntents: [],
            unavailableIntents: [
              {
                intent: 'membership',
                code: 'CAPABILITY_DISABLED',
                capability: 'memberships',
                applicabilityReferences: ['DEC-016', 'DEC-072'],
              },
            ],
            participants: [],
          }),
        },
        // A permission view read before the switch went off.
        'GET /me/permissions': mePermissions({ enabled: ['memberships'] }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // PA-11: the plain message is shown; the decisions are in the support fold only.
    expect(
      await screen.findByLabelText(
        'Registration type: Membership. Join this membership. Memberships turned off. Ask the front desk about memberships.',
      ),
    ).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText('Decisions: DEC-016, DEC-072')).toBeOnTheScreen();
    expect(screen.queryByText('This activity cannot be registered for in the app.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);
  });

  it('DEC-016: a basket line refused with CAPABILITY_DISABLED shows the turned-off state', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({
            availableIntents: ['package_purchase'],
            participants: [
              {
                personId: IDS.childA,
                intents: [
                  {
                    intent: 'package_purchase',
                    eligibility: registrationOptions().participants[0]!.intents[0]!.eligibility,
                  },
                ],
              },
            ],
          }),
        },
        'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
        // The body the kernel sends (ACCESS_DENIED, contact_support_or_request_access).
        'POST /baskets/{id}/lines': () =>
          fakeResponse(403, capabilityDisabledBody('session_packages', ['DEC-016', 'DEC-074'])),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    expect(await screen.findByLabelText('Class packs turned off')).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText(/CAPABILITY_DISABLED/)).toBeOnTheScreen();
  });

  it('SPK-AT-001: adds two children as two basket lines with the expected revision and one key per line', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben. Eligible' }));
    expect(screen.getByRole('checkbox', { name: 'Ada. Eligible' })).toBeChecked();

    await basketButtonReady('Add 2 people to cart');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to cart' }));
    });
    // The hand-over follows both lines and their invalidations (timer-batched): wait for it.
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`),
    );

    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(app.fake.requests.filter((r) => r.route === '/baskets')[0]?.body).toEqual({
      fulfillmentMode: 'all_or_nothing',
      acceptPartialFulfillment: false,
    });
    expect(lines.map((r) => r.body)).toEqual([
      {
        participantPersonId: IDS.childA,
        offeringId: IDS.offering,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 1,
      },
      {
        participantPersonId: IDS.childB,
        offeringId: IDS.offering,
        intent: 'youth',
        quantity: 1,
        expectedRevision: 2,
      },
    ]);
    const keys = lines.map((r) => r.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(2);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
    // The new basket is listed by the API from now on (no id kept on the device).
    expect(app.progressStore.snapshot()).toEqual({ pendingCheckoutQuoteId: null });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to cart' })).not.toBeBusy());
  });

  it('§4.9: retrying after a failure reuses the key and never adds a participant twice', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /baskets/{id}/lines': addLineHandler((_req, call) =>
          call === 2
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : null,
        ),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben. Eligible' }));
    await basketButtonReady('Add 2 people to cart');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to cart' }));
    });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Ada. Added to your cart' })).toBeDisabled();
    // A 503 is no definite answer: the line may have been added (SPK-UX-008, §4.9).
    expect(
      screen.getByLabelText('No answer yet: this may already have been recorded'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Something went wrong')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`),
    );
    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(
      lines.map((r) => (r.body as { participantPersonId: string }).participantPersonId),
    ).toEqual([IDS.childA, IDS.childB, IDS.childB]);
    expect(lines[2]?.headers['idempotency-key']).toBe(lines[1]?.headers['idempotency-key']);
    expect(app.fake.requests.filter((r) => r.route === '/baskets')).toHaveLength(1);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
  });

  it('STALE_REVISION on the second line: Reload takes the reloaded basket, and the retry carries its revision under a new key', async () => {
    let changedElsewhere = false;
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /baskets/{id}/lines': addLineHandler((_req, call) => {
          if (call !== 2) return null;
          changedElsewhere = true;
          return fakeResponse(
            409,
            apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }),
          );
        }),
        'GET /me/baskets': () =>
          fakeResponse(200, {
            items: changedElsewhere
              ? [basket({ lines: [line({ participantPersonId: IDS.childA })], revision: 7 })]
              : [],
            nextCursor: null,
          }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben. Eligible' }));
    await basketButtonReady('Add 2 people to cart');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to cart' }));
    });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    await waitFor(() => expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull());
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(lines).toHaveLength(3);
    expect(lines[2]?.body).toMatchObject({ participantPersonId: IDS.childB, expectedRevision: 7 });
    expect(lines[2]?.headers['idempotency-key']).not.toBe(lines[1]?.headers['idempotency-key']);
  });

  it('SPK-UX-001: never starts a second basket while the list of open baskets is unread', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me/baskets': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    expect(app.fake.requests.filter((r) => r.route === '/baskets')).toHaveLength(0);
  });

  it('SPK-AT-004: a duplicate equivalent registration is explained without revealing who holds it', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /baskets/{id}/lines': () =>
          fakeResponse(
            409,
            apiErrorBody('DUPLICATE_ENTITLEMENT', {
              message: 'An application for this participant and offering already exists.',
              nextAction: 'review_existing_participation',
            }),
          ),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    expect(
      await screen.findByText('An application for this participant and offering already exists.'),
    ).toBeOnTheScreen();
    await openSupportDetails(screen);
    expect(screen.getByText(/Error code: DUPLICATE_ENTITLEMENT/)).toBeOnTheScreen();
    expect(screen.getByText('Review existing registration')).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('SPK-IAM-003: lists a person the account may only view as not available, and shows a denial as not available', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        // The basket this screen just opened reads back (the screen re-reads it once it is
        // remembered), so the only failure on screen is the refused line.
        'GET /baskets/{id}': { status: 200, body: EMPTY_BASKET },
        'POST /baskets/{id}/lines': () =>
          fakeResponse(
            403,
            apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
              nextAction: 'request_participant_authority',
            }),
          ),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    const viewOnly = await screen.findByRole('checkbox', { name: /^Cy\. Not available/ });
    expect(viewOnly).toBeDisabled();

    fireEvent.press(screen.getByRole('checkbox', { name: 'Ada. Eligible' }));
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    const refusal = await screen.findByTestId('command-error');
    expect(within(refusal).getByLabelText('Not available')).toBeOnTheScreen();
    expect(within(refusal).getByText(/does not have the permission this needs/)).toBeOnTheScreen();
  });

  it('SPK-UX-001: adds to the newest open basket the API lists (also after a reinstall) instead of opening another', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me/baskets': page([
          basket({ status: 'held', id: IDS.offer }),
          basket({ revision: 7 }),
        ]),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    expect(app.fake.requests.filter((r) => r.route === '/baskets')).toHaveLength(0);
    const added = app.fake.requests.find((r) => r.route === '/baskets/{id}/lines');
    expect(added?.params.id).toBe(IDS.basket);
    expect((added?.body as { expectedRevision: number }).expectedRevision).toBe(7);
  });

  it('SPK-REG-002: choosing another intent starts from nobody, so a person blocked there is never sent', async () => {
    const adultOnly = ineligible(
      'Youth enrollment is for child participants.',
      'youth_requires_child',
    );
    const childOnly = ineligible(
      'This offering accepts adult participants only.',
      'participant_kind_not_permitted',
    );
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': { status: 200, body: offering({ kind: 'season' }) },
        'GET /offerings/{id}/registration-options': optionsHandler({
          availableIntents: ['individual_league', 'youth'],
          participants: [
            {
              personId: IDS.parent,
              intents: [
                { intent: 'individual_league', eligibility: eligible() },
                { intent: 'youth', eligibility: adultOnly },
              ],
            },
            {
              personId: IDS.childA,
              intents: [
                { intent: 'individual_league', eligibility: childOnly },
                { intent: 'youth', eligibility: eligible() },
              ],
            },
          ],
        }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Registration type' })).toHaveProp(
        'accessibilityValue',
        { text: 'Join as a player' },
      ),
    );
    fireEvent.press(await screen.findByRole('checkbox', { name: 'You (Robin). Eligible' }));
    expect(screen.getByRole('checkbox', { name: 'You (Robin). Eligible' })).toBeChecked();

    await chooseType(YOUTH);
    const self = await screen.findByRole('checkbox', {
      name: 'You (Robin). Not eligible. This registration type is for children.. Look for another activity that fits.',
    });
    // Blocked under youth: not ticked, cannot be ticked, and nothing to add yet.
    expect(self).toBeDisabled();
    expect(self).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeDisabled();

    fireEvent.press(screen.getByRole('checkbox', { name: 'Ada. Eligible' }));
    await basketButtonReady();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to cart' }));
    });
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`),
    );
    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(lines.map((r) => r.body)).toEqual([
      expect.objectContaining({ participantPersonId: IDS.childA, intent: 'youth' }),
    ]);
  });

  it('DEC-016: while GET /me/permissions cannot be read a gated intent is not usable, with the code and a retry', async () => {
    let failing = true;
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': {
          status: 200,
          body: offering({ kind: 'membership', name: 'Family membership' }),
        },
        'GET /offerings/{id}/registration-options': optionsHandler({
          availableIntents: ['membership'],
          participants: [
            { personId: IDS.childA, intents: [{ intent: 'membership', eligibility: eligible() }] },
          ],
        }),
        'GET /me/permissions': () =>
          failing
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, mePermissions({ enabled: ['memberships'] }).body),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // One type, its switch not known yet: said, and nobody can be added under it.
    expect(
      await screen.findByLabelText(
        'Registration type: Membership. Join this membership. Checking memberships.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('checkbox', { name: 'Ada. Eligible' })).toBeNull();
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Add to cart' })).toBeNull();

    failing = false;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(
      await screen.findByLabelText('Registration type: Membership. Join this membership.'),
    ).toBeOnTheScreen();
    expect(await screen.findByRole('checkbox', { name: 'Ada. Eligible' })).not.toBeDisabled();
    expect(app.fake.requests.some((r) => r.route === '/baskets/{id}/lines')).toBe(false);
  });

  it('RegistrationOptionsQuery: a household of more than 20 is read in groups of 20; nobody reads "not available" for being left unasked', async () => {
    const children = Array.from(
      { length: 21 },
      (_, i) => `0192f1a0-0000-7000-8000-${String(900 + i).padStart(12, '0')}`,
    );
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me': {
          status: 200,
          body: me({
            authorities: children.map((id) => ({
              subjectPersonId: id,
              permissions: ['view', 'register', 'pay', 'complete_forms', 'receive_messages'],
            })),
          }),
        },
        'GET /person-names': {
          status: 200,
          body: { items: children.map((id, i) => personName(id, `Child ${i + 1}`)) },
        },
        'GET /offerings/{id}/registration-options': (req: FakeRequest) => {
          const named = (req.query.participantPersonIds ?? '').split(',').filter(Boolean);
          return fakeResponse(200, {
            ...registrationOptions({ availableIntents: ['youth'] }),
            participants: named.map((personId) => ({
              personId,
              intents: [{ intent: 'youth', eligibility: eligible() }],
            })),
          });
        },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    // The last of the 22 people (sorted ids) is in the second request, and reads eligible.
    expect(await screen.findByRole('checkbox', { name: 'Child 21. Eligible' })).not.toBeDisabled();
    expect(screen.queryByText(/can view this person but not register them/)).toBeNull();
    const reads = app.fake.requests.filter(
      (r) => r.route === '/offerings/{id}/registration-options',
    );
    const asked = reads.map((r) => (r.query.participantPersonIds ?? '').split(','));
    expect(asked.map((ids) => ids.length)).toEqual([20, 2]);
    expect(asked.flat().sort()).toEqual([IDS.parent, ...children].sort());
  });

  it('empty: explains family setup when there is no one to register', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me': { status: 200, body: me({ person: null, authorities: [] }) },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No one to register yet' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Go to You' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/account');
  });

  it('stale: an offering that is no longer open cannot be started', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': { status: 200, body: offering({ publicationState: 'closed' }) },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Registration is not open')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
  });

  it('offline: cannot start, and the choice is kept', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await chooseType(YOUTH);
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada. Eligible' }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeDisabled();
    expect(
      screen.getByText('Adding to your cart needs a connection. Your choices are kept.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Ada. Eligible' })).toBeChecked();
  });

  it('SPK-UX-008: registration options that cannot be read show the code and a retry, and nothing is offered', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    await openSupportDetails(screen);
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Registration type' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('§4.10: options the API answers NOT_FOUND for read as not available, without the code', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Registration not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it("PA-11 ADR-008: the Who step shows the progress steps and a card per person with the API's eligibility inside it", async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': optionsHandler({
          availableIntents: ['youth'],
          participants: [
            { personId: IDS.childA, intents: [{ intent: 'youth', eligibility: eligible() }] },
            {
              personId: IDS.childB,
              intents: [{ intent: 'youth', eligibility: ineligible() }],
            },
          ],
        }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: "Who's going?" })).toBeOnTheScreen();
    expect(screen.getByLabelText('Step 1 of 5, Who')).toBeOnTheScreen();
    const ben = screen.getByTestId(`participant-${IDS.childB}`);
    // The reasons and the alternative are written inside Ben's card, under his name.
    // PA-11: in customer words, by the reason's code; the staff-only override is not offered.
    for (const text of [
      'Ben',
      'Not eligible',
      'Ages 9 to 12. Ben is 13.',
      'Look for another activity that fits.',
    ]) {
      expect(within(ben).getByText(text)).toBeOnTheScreen();
    }
    expect(screen.queryByText(/override eligibility/)).toBeNull();
    expect(screen.queryByText(/The participant is 13/)).toBeNull();
    // The API's own words stay available in "Details for support".
    await openSupportDetails(screen);
    expect(
      screen.getByText(
        'Ben, above_maximum_age: The participant is 13 on 2026-09-01; this offering requires at least 9 and at most 12.',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Ben, option 2 (contact_staff): Staff with program authority may override eligibility with a recorded reason.',
      ),
    ).toBeOnTheScreen();
    // Initials only, and hidden from screen readers: the card's name says who it is.
    expect(within(ben).getByText('B', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(within(ben).queryByText('B')).toBeNull();
    expect(ben).toBeDisabled();
    await app.settle();
  });

  it('PA-11 ADR-008: the registration type is a sheet only when there is more than one choice', async () => {
    const two = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}': { status: 200, body: offering({ kind: 'season' }) },
        'GET /offerings/{id}/registration-options': optionsHandler({
          availableIntents: ['individual_league', 'youth'],
        }),
      }),
    });
    const first = render(<RegistrationIntentScreen offeringId={IDS.offering} />, {
      wrapper: two.wrapper,
    });
    const sheet = await openTypeSheet();
    expect(sheet.getByRole('header', { name: 'Registration type' })).toBeOnTheScreen();
    expect(sheet.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Join as a player. Register one adult player; staff place individual players on a team.',
      YOUTH,
    ]);
    await act(async () => {
      fireEvent.press(sheet.getByRole('radio', { name: YOUTH }));
    });
    // Choosing closes the sheet; the button shows the choice.
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Registration type' })).toHaveProp(
      'accessibilityValue',
      { text: 'Register a child' },
    );
    await two.settle();
    first.unmount();

    const one = createRegistrationTestApp({
      routes: routes({
        'GET /offerings/{id}/registration-options': optionsHandler({ availableIntents: ['youth'] }),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: one.wrapper });
    expect(await screen.findByLabelText(`Registration type: ${YOUTH}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Registration type' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await one.settle();
  });

  it('asks a signed-out user to sign in and sends nothing', async () => {
    const app = createRegistrationTestApp({ session: null, routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
