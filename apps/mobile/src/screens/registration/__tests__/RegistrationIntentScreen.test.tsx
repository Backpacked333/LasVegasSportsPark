/**
 * SCR-C-09 Registration intent chooser (SPK-REG-001, SPK-IAM-003, SPK-REG-004; SPK-AT-001 a
 * returning parent registers two children): intents for the offering kind, participants from the
 * API's authorities, one basket line per participant with the basket's expected revision and one
 * idempotency key per line, retries that reuse the key and never add a participant twice.
 */
import {
  apiErrorBody,
  fakeResponse,
  type FakeHandler,
  type FakeRequest,
} from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  line,
  me,
  offering,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { RegistrationIntentScreen } from '../RegistrationIntentScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const EMPTY_BASKET = basket({ lines: [], revision: 1, subtotalMinor: 0 });

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
    'POST /baskets': { status: 201, body: EMPTY_BASKET },
    'POST /baskets/{id}/lines': addLineHandler(),
    ...overrides,
  };
}

describe('SCR-C-09 RegistrationIntentScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-001: offers the intents of this kind of offering; session bookings are explained, not offered', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('radio', { name: /^Youth enrollment/ })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: /^Individual league entry/ })).toBeOnTheScreen();
    const makeup = screen.getByRole('radio', { name: /^Makeup session/ });
    expect(makeup).toBeDisabled();
    expect(makeup.props.accessibilityLabel).toMatch(/not available in the app yet/);
  });

  it('SPK-AT-001: adds two children as two basket lines with the expected revision and one key per line', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben' }));
    expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeChecked();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to your basket' }));
    });

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
    expect(app.progressStore.snapshot().basketId).toBe(IDS.basket);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add to your basket' })).not.toBeBusy(),
    );
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
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to your basket' }));
    });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Ada. Added to your basket' })).toBeDisabled();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(
      lines.map((r) => (r.body as { participantPersonId: string }).participantPersonId),
    ).toEqual([IDS.childA, IDS.childB, IDS.childB]);
    expect(lines[2]?.headers['idempotency-key']).toBe(lines[1]?.headers['idempotency-key']);
    expect(app.fake.requests.filter((r) => r.route === '/baskets')).toHaveLength(1);
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${IDS.basket}`);
  });

  it('STALE_REVISION on the second line: Reload takes the reloaded basket, and the retry carries its revision under a new key', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'POST /baskets/{id}/lines': addLineHandler((_req, call) =>
          call === 2
            ? fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }))
            : null,
        ),
        'GET /baskets/{id}': {
          status: 200,
          body: basket({ lines: [line({ participantPersonId: IDS.childA })], revision: 7 }),
        },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    fireEvent.press(screen.getByRole('checkbox', { name: 'Ben' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add 2 people to your basket' }));
    });
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    await waitFor(() => expect(screen.queryByText(/Error code: STALE_REVISION/)).toBeNull());
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
    });
    const lines = app.fake.requests.filter((r) => r.route === '/baskets/{id}/lines');
    expect(lines).toHaveLength(3);
    expect(lines[2]?.body).toMatchObject({ participantPersonId: IDS.childB, expectedRevision: 7 });
    expect(lines[2]?.headers['idempotency-key']).not.toBe(lines[1]?.headers['idempotency-key']);
  });

  it('never starts a second basket while the remembered one is still unread', async () => {
    const app = createRegistrationTestApp({
      progress: { basketId: IDS.basket },
      routes: routes({
        'GET /baskets/{id}': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
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
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
    });
    expect(
      await screen.findByText('An application for this participant and offering already exists.'),
    ).toBeOnTheScreen();
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
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    const viewOnly = await screen.findByRole('checkbox', { name: /^Cy\. Not available/ });
    expect(viewOnly).toBeDisabled();

    fireEvent.press(screen.getByRole('checkbox', { name: 'Ada' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
    });
    const refusal = await screen.findByTestId('command-error');
    expect(within(refusal).getByLabelText('Not available')).toBeOnTheScreen();
    expect(within(refusal).getByText(/does not have the permission this needs/)).toBeOnTheScreen();
  });

  it('adds to the open basket already in progress instead of opening another', async () => {
    const app = createRegistrationTestApp({
      progress: { basketId: IDS.basket },
      routes: routes({ 'GET /baskets/{id}': { status: 200, body: basket({ revision: 7 }) } }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to your basket' }));
    });
    expect(app.fake.requests.filter((r) => r.route === '/baskets')).toHaveLength(0);
    const added = app.fake.requests.find((r) => r.route === '/baskets/{id}/lines');
    expect((added?.body as { expectedRevision: number }).expectedRevision).toBe(7);
  });

  it('empty: explains family setup when there is no one to register', async () => {
    const app = createRegistrationTestApp({
      routes: routes({
        'GET /me': { status: 200, body: me({ person: null, authorities: [] }) },
      }),
    });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'No one to register yet' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Open Account' }));
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
    fireEvent.press(await screen.findByRole('radio', { name: /^Youth enrollment/ }));
    fireEvent.press(await screen.findByRole('checkbox', { name: 'Ada' }));
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Add to your basket' })).toBeDisabled();
    expect(
      screen.getByText('Adding to your basket needs a connection. Your choices are kept.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeChecked();
  });

  it('asks a signed-out user to sign in and sends nothing', async () => {
    const app = createRegistrationTestApp({ session: null, routes: routes() });
    render(<RegistrationIntentScreen offeringId={IDS.offering} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
