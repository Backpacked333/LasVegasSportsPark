/**
 * SCR-C-10 Participant and placement information (SPK-PLACE-001, SPK-PLACE-005, §4.14, DEC-051):
 * only configured fields are collected (pending state while DEC-051 is open), the request carries
 * no teammate identities and the season the API's registration options name (ENR-05), field-level
 * validation keeps the input, and an offering with no season reads as not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  basket,
  familyRoutes,
  line,
  registrationOptions,
} from '../../../features/registration/testing/fixtures';
import { createRegistrationTestApp } from '../../../features/registration/testing/registration-test-app';
import { PlacementInformationScreen } from '../PlacementInformationScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const FIELDS = [
  'availability',
  'preferredCompetition',
  'declaredLevel',
  'positionPreferences',
  'notes',
  'requestedTeammates',
];
const ADULT_LINE = basket({
  lines: [
    line({ participantPersonId: IDS.parent, intent: 'individual_league', offeringKind: 'season' }),
  ],
});

const COMPETITION = {
  id: '0192f1a0-0000-7000-8000-0000000000c7',
  name: 'Monday coed league',
  kind: 'league' as const,
  sportFormat: 'small_sided_other' as const,
  description: null,
  status: 'active' as const,
  revision: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...familyRoutes(),
    'GET /competitions': { status: 200, body: [COMPETITION] },
    'GET /baskets/{id}': { status: 200, body: ADULT_LINE },
    'GET /offerings/{id}/registration-options': {
      status: 200,
      body: registrationOptions({ availableIntents: ['individual_league'], seasonId: IDS.season }),
    },
    ...overrides,
  };
}

function renderPlacement(options: Parameters<typeof createRegistrationTestApp>[0] = {}) {
  const app = createRegistrationTestApp({ config: { placementFields: FIELDS }, ...options });
  render(<PlacementInformationScreen basketId={IDS.basket} lineId={IDS.lineA} />, {
    wrapper: app.wrapper,
  });
  return app;
}

describe('SCR-C-10 PlacementInformationScreen', () => {
  it('DEC-051: without approved fields it shows the pending decision and collects nothing', async () => {
    const app = createRegistrationTestApp({ routes: routes() });
    render(<PlacementInformationScreen basketId={IDS.basket} lineId={IDS.lineA} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Waiting on a decision')).toBeOnTheScreen();
    expect(screen.getByText(/depends on DEC-051, DEC-031/)).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  it("SPK-PLACE-001: records only the approved fields and never another person's identity", async () => {
    const app = renderPlacement({
      routes: routes({
        'POST /placement-requests': {
          status: 201,
          body: { id: IDS.placement, status: 'unassigned' },
        },
      }),
    });
    expect(await screen.findByRole('header', { name: 'About you as a player' })).toBeOnTheScreen();
    expect(
      screen.getByText('Not available in the app yet: Requested teammates.'),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: 'Monday' }));
    fireEvent.changeText(screen.getByLabelText('From (HH:MM)'), '18:00');
    fireEvent.changeText(screen.getByLabelText('To (HH:MM)'), '20:00');
    fireEvent.press(screen.getByRole('button', { name: 'Add this time' }));
    expect(screen.getByText('Monday 18:00 to 20:00')).toBeOnTheScreen();
    // SPK-PLACE-001: the preferred competition from the API's list of active competitions.
    fireEvent.press(await screen.findByRole('radio', { name: 'Monday coed league' }));
    fireEvent.changeText(screen.getByLabelText('Playing level'), 'Played college club soccer');
    fireEvent.changeText(screen.getByLabelText('Preferred positions'), 'Goalkeeper, Defender');
    const save = screen.getByRole('button', { name: 'Save placement information' });
    await act(async () => {
      fireEvent.press(save);
    });
    expect(app.fake.requests.find((r) => r.route === '/placement-requests')?.body).toEqual({
      participantPersonId: IDS.parent,
      seasonId: IDS.season,
      offeringId: IDS.offering,
      applicationId: '0192f1a0-0000-7000-8000-0000000000d1',
      availability: [{ weekday: 1, from: '18:00', to: '20:00' }],
      preferredCompetitionId: COMPETITION.id,
      declaredLevel: 'Played college club soccer',
      positionPreferences: ['Goalkeeper', 'Defender'],
      requestedTeammatePersonIds: [],
    });
    expect(await screen.findByLabelText('Placement information sent')).toBeOnTheScreen();
    expect(screen.getByText(/No team is assigned yet, and no place is reserved/)).toBeOnTheScreen();
    expect(app.fake.requests.find((r) => r.route === '/competitions')?.query).toEqual({
      status: 'active',
    });
  });

  it('SPK-PLACE-001: "No preference" sends no competition; a competition list that cannot be read shows its code and keeps the rest saveable', async () => {
    let failing = true;
    const app = renderPlacement({
      routes: routes({
        'GET /competitions': () =>
          failing
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, [COMPETITION]),
        'POST /placement-requests': {
          status: 201,
          body: { id: IDS.placement, status: 'unassigned' },
        },
      }),
    });
    const choice = await screen.findByTestId('preferred-competition');
    expect(
      await within(choice).findByText(/Error code: INTEGRATION_UNAVAILABLE/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Save placement information' })).not.toBeDisabled();

    failing = false;
    await act(async () => {
      fireEvent.press(within(choice).getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByRole('radio', { name: 'No preference' })).toBeChecked();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save placement information' }));
    });
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/placement-requests')).toBe(true),
    );
    const body = app.fake.requests.find((r) => r.route === '/placement-requests')?.body as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('preferredCompetitionId');
  });

  it('checks a time window before adding it', async () => {
    renderPlacement({ routes: routes() });
    fireEvent.press(await screen.findByRole('radio', { name: 'Tuesday' }));
    fireEvent.changeText(screen.getByLabelText('From (HH:MM)'), '20:00');
    fireEvent.changeText(screen.getByLabelText('To (HH:MM)'), '19:00');
    fireEvent.press(screen.getByRole('button', { name: 'Add this time' }));
    expect(screen.getByText('✕ The end time must be after the start time.')).toBeOnTheScreen();
  });

  it('VALIDATION_FAILED: shows the API message at the field and keeps the input', async () => {
    renderPlacement({
      routes: routes({
        'POST /placement-requests': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'Request validation failed.',
              nextAction: 'correct_input',
              details: [
                { path: 'declaredLevel', message: 'Use at most 100 characters.', code: 'too_big' },
              ],
            }),
          ),
      }),
    });
    fireEvent.changeText(await screen.findByLabelText('Playing level'), 'x'.repeat(120));
    const save = screen.getByRole('button', { name: 'Save placement information' });
    await act(async () => {
      fireEvent.press(save);
    });
    expect(await screen.findByText('✕ Use at most 100 characters.')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Playing level')).toHaveProp('value', 'x'.repeat(120));
  });

  it('permission restriction: no register permission for the participant reads not available', async () => {
    renderPlacement({
      routes: routes({
        'POST /placement-requests': () =>
          fakeResponse(
            403,
            apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
              nextAction: 'request_participant_authority',
            }),
          ),
      }),
    });
    const save = await screen.findByRole('button', { name: 'Save placement information' });
    await act(async () => {
      fireEvent.press(save);
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('SPK-PLACE-001: the season comes from the offering’s registration options; none reads not available', async () => {
    const app = renderPlacement({
      routes: routes({
        'GET /offerings/{id}/registration-options': {
          status: 200,
          body: registrationOptions({ seasonId: null }),
        },
      }),
    });
    expect(await screen.findByLabelText('Not available for this activity')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Save placement information' })).toBeNull();
    expect(
      app.fake.requests.find((r) => r.route === '/offerings/{id}/registration-options')?.params.id,
    ).toBe(IDS.offering);
  });

  it('SPK-UX-008: a season read that fails shows its code with a retry, and nothing is sent', async () => {
    const app = renderPlacement({
      routes: routes({
        'GET /offerings/{id}/registration-options': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(app.fake.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('offline: answers are kept and saving is disabled', async () => {
    const app = renderPlacement({ routes: routes() });
    fireEvent.changeText(await screen.findByLabelText('Preferred positions'), 'Winger');
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Save placement information' })).toBeDisabled();
    expect(screen.getByText('Saving needs a connection. Your answers are kept.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Preferred positions')).toHaveProp('value', 'Winger');
  });
});
