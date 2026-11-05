/**
 * SCR-C-24 Availability (SPK-CAP-001, SPK-CAP-003, SPK-READY-002, DEC-064): counts per game, the
 * answers the person may give read from the game (CMP-04 `responses`, sent back with their
 * revision), answering for a child with `register`, Tentative pending, the captain's request to
 * the players without an answer (CMP-14), answers and requests closed at kickoff, times in the
 * facility's zone, and the error, permission, stale and offline states. Availability is never
 * attendance or eligibility.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  availabilityRequest,
  baseRoutes,
  fixtureResponse,
  playerWorkspace,
  upcomingFixtureDetail,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { AvailabilityScreen } from '../AvailabilityScreen';

const answer = (state: string, personId = IDS.me, revision = 3) => ({
  id: '0192f1a0-0000-7000-8000-000000000777',
  fixtureId: IDS.fixture,
  teamEntryId: IDS.entry,
  personId,
  state,
  respondedAt: '2026-10-24T12:00:00.000Z',
  note: null,
  revision,
});

const closed = () =>
  fakeResponse(
    409,
    apiErrorBody('INVALID_TRANSITION', {
      message: 'Availability for this fixture closed at kickoff.',
      nextAction: 'reload_current_state',
      details: {
        code: 'AVAILABILITY_CLOSED',
        fixtureId: IDS.fixture,
        scheduledStart: '2026-10-31T17:00:00.000Z',
      },
    }),
  );

function routes(overrides = {}) {
  return baseRoutes({
    'GET /fixtures/{id}': { status: 200, body: upcomingFixtureDetail() },
    'GET /fixtures/{id}/availability-requests': { status: 200, body: [availabilityRequest()] },
    ...overrides,
  });
}

function renderAvailability(
  overrides = {},
  options: Parameters<typeof createTeamsTestApp>[0] = {},
) {
  const app = createTeamsTestApp({ routes: routes(overrides), ...options });
  render(<AvailabilityScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-24 AvailabilityScreen', () => {
  it('SPK-CAP-003, CMP-04: shows the counts and changes the person’s own answer from the revision read', async () => {
    const app = renderAvailability({
      'POST /fixtures/{id}/availability': { status: 200, body: answer('unavailable') },
    });
    const game = await screen.findByTestId(`game-${IDS.fixture}`);
    expect(
      within(game).getByLabelText(
        'Answers from the roster: Available 1, Unavailable 1, No response 1',
      ),
    ).toBeOnTheScreen();
    expect(await within(game).findByText('Your answer: Available')).toBeOnTheScreen();

    fireEvent.press(within(game).getByRole('button', { name: 'Unavailable' }));
    expect(await within(game).findByText('Your answer: Unavailable')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/fixtures/{id}/availability')).toEqual([
      { state: 'unavailable', expectedRevision: 2 },
    ]);
    expect(app.keysOf('POST', '/fixtures/{id}/availability')[0]).toMatch(/^key-/);
    expect(within(game).getByRole('button', { name: 'Clear my answer' })).toBeOnTheScreen();
    await app.settle();
  });

  it('SPK-SCHED-008: the game time and place come from the venue, in the facility’s zone', async () => {
    renderAvailability();
    const game = await screen.findByTestId(`game-${IDS.fixture}`);
    expect(await within(game).findByLabelText(/Sat, Oct 31, 10:00\sAM PDT/)).toBeOnTheScreen();
    expect(within(game).getByLabelText('Where: Las Vegas Sports Park, Field 2')).toBeOnTheScreen();
  });

  it('SPK-READY-002: says availability is not attendance or eligibility and never blocks a game', async () => {
    renderAvailability();
    expect(
      await screen.findByText(
        'An answer helps the captain plan. It is not a check-in and does not decide who is eligible to play, and a missing answer never blocks a game.',
      ),
    ).toBeOnTheScreen();
  });

  it('DEC-064: Tentative is not offered while it is pending, but an existing tentative answer is shown', async () => {
    renderAvailability({
      'GET /fixtures/{id}': {
        status: 200,
        body: upcomingFixtureDetail({
          responses: [fixtureResponse({ personId: IDS.me, state: 'tentative', revision: 1 })],
        }),
      },
    });
    expect(await screen.findByText('Your answer: Tentative')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Tentative' })).toBeNull();
    expect(
      screen.getByLabelText(
        'Tentative is not offered yet: whether it is used is still being decided (DEC-064).',
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-IAM-003: a guardian answers for their child with the child’s current answer shown', async () => {
    const app = renderAvailability({
      'POST /fixtures/{id}/availability': {
        status: 200,
        body: answer('unavailable', IDS.child, 1),
      },
    });
    expect(await screen.findByText("Kim Junior's answer: No response")).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Kim Junior: Unavailable' }));
    expect(await screen.findByText("Kim Junior's answer: Unavailable")).toBeOnTheScreen();
    // No answer was recorded yet, so no revision is sent.
    expect(app.bodiesOf('POST', '/fixtures/{id}/availability')).toEqual([
      { state: 'unavailable', personId: IDS.child },
    ]);
    await app.settle();
  });

  it('answering for a person without authority is "not available"', async () => {
    renderAvailability({
      'POST /fixtures/{id}/availability': () =>
        fakeResponse(
          403,
          apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
            nextAction: 'request_participant_authority',
          }),
        ),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Kim Junior: Available' }));
    expect(
      await screen.findByText('Answering for Kim Junior is not available to you.'),
    ).toBeOnTheScreen();
  });

  it('§4.9: an answer changed elsewhere (STALE_REVISION) asks to reload the game', async () => {
    const app = renderAvailability({
      'POST /fixtures/{id}/availability': () =>
        fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_current_state' })),
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Unavailable' }));
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    const reads = app.requestsTo('GET', '/fixtures/{id}').length;
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.requestsTo('GET', '/fixtures/{id}').length).toBeGreaterThan(reads),
    );
    await app.settle();
  });

  it('CMP-04: an answer after kickoff is refused and said so, in the facility’s zone', async () => {
    renderAvailability({ 'POST /fixtures/{id}/availability': closed });
    fireEvent.press(await screen.findByRole('button', { name: 'Unavailable' }));
    expect(await screen.findByLabelText('Availability closed')).toBeOnTheScreen();
    expect(
      screen.getByText(/^Answers closed at kickoff, Sat, Oct 31, 10:00\sAM PDT\.$/),
    ).toBeOnTheScreen();
    expect(screen.getByText('Error code: INVALID_TRANSITION')).toBeOnTheScreen();
  });

  it('§4.9: retrying a failed answer reuses the same idempotency key', async () => {
    let attempt = 0;
    const app = renderAvailability({
      'POST /fixtures/{id}/availability': () => {
        attempt += 1;
        return attempt === 1
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
            )
          : fakeResponse(200, answer('unavailable'));
      },
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Unavailable' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Your answer: Unavailable')).toBeOnTheScreen();
    const [first, second] = app.keysOf('POST', '/fixtures/{id}/availability');
    expect(second).toBe(first);
    await app.settle();
  });

  it('offline: answering and asking are disabled with an explanation, never queued', async () => {
    const app = renderAvailability();
    expect(await screen.findByRole('button', { name: 'Unavailable' })).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', { name: 'Send a reminder to players without an answer' }),
    ).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Send a reminder to players without an answer' }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        'Answering availability needs a connection. Nothing is queued: your entries are kept on this screen.',
      ),
    ).toBeOnTheScreen();
  });

  it('a game the API does not show is "not available" without detail', async () => {
    renderAvailability({
      'GET /fixtures/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(
      await screen.findByText('The answers you can give for this game are not available.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
  });

  it('someone not on the roster has no answer to give', async () => {
    renderAvailability({
      'GET /fixtures/{id}': {
        status: 200,
        body: upcomingFixtureDetail({ responses: [], rosterStatus: null }),
      },
    });
    expect(
      await screen.findByText('You are not on this roster, so there is no answer to give here.'),
    ).toBeOnTheScreen();
  });

  it('empty when no games are published', async () => {
    renderAvailability({
      'GET /team-entries/{id}': { status: 200, body: workspace({ upcomingFixtures: [] }) },
    });
    expect(await screen.findByRole('header', { name: 'No games published' })).toBeOnTheScreen();
  });

  describe('captain request (CMP-14, SPK-CAP-001)', () => {
    it('lists earlier requests and reminds only the players without an answer', async () => {
      const app = renderAvailability({
        'POST /fixtures/{id}/availability-requests': {
          status: 201,
          body: availabilityRequest({
            id: '0192f1a0-0000-7000-8000-000000000111',
            requestedAt: '2026-10-24T12:00:00.000Z',
            recipientCount: 3,
          }),
        },
      });
      expect(await screen.findByRole('header', { name: 'Ask the roster' })).toBeOnTheScreen();
      expect(
        await screen.findByLabelText(
          /^Request sent Thu, Oct 22, 5:00\sAM PDT: asked 2 people without an answer$/,
        ),
      ).toBeOnTheScreen();
      expect(app.requestsTo('GET', '/fixtures/{id}/availability-requests')[0]?.query).toEqual({
        teamEntryId: IDS.entry,
      });
      fireEvent.changeText(
        screen.getByLabelText('Message to the players (optional)'),
        'Need 7 for Saturday',
      );
      fireEvent.press(
        screen.getByRole('button', { name: 'Send a reminder to players without an answer' }),
      );
      expect(await screen.findByLabelText('Asked 3 people without an answer')).toBeOnTheScreen();
      expect(app.bodiesOf('POST', '/fixtures/{id}/availability-requests')).toEqual([
        { teamEntryId: IDS.entry, message: 'Need 7 for Saturday' },
      ]);
      expect(app.keysOf('POST', '/fixtures/{id}/availability-requests')[0]).toMatch(/^key-/);
      await app.settle();
    });

    it('the first request says so; nobody is asked when everyone has answered', async () => {
      const app = renderAvailability({
        'GET /fixtures/{id}/availability-requests': { status: 200, body: [] },
        'POST /fixtures/{id}/availability-requests': {
          status: 201,
          body: availabilityRequest({ recipientCount: 0 }),
        },
      });
      expect(await screen.findByRole('header', { name: 'No request sent yet' })).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Ask players without an answer' }));
      expect(
        await screen.findByLabelText('Everyone has answered: nobody was asked'),
      ).toBeOnTheScreen();
      expect(app.bodiesOf('POST', '/fixtures/{id}/availability-requests')).toEqual([
        { teamEntryId: IDS.entry },
      ]);
      await app.settle();
    });

    it('§4.9: a failed request is retried under the same idempotency key', async () => {
      let attempt = 0;
      const app = renderAvailability({
        'POST /fixtures/{id}/availability-requests': () => {
          attempt += 1;
          return attempt === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(201, availabilityRequest({ recipientCount: 1 }));
        },
      });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Send a reminder to players without an answer' }),
      );
      expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
      expect(screen.queryByLabelText(/^Asked /)).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByLabelText('Asked 1 person without an answer')).toBeOnTheScreen();
      const keys = app.keysOf('POST', '/fixtures/{id}/availability-requests');
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      await app.settle();
    });

    it('a request after kickoff is refused and said so', async () => {
      renderAvailability({ 'POST /fixtures/{id}/availability-requests': closed });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Send a reminder to players without an answer' }),
      );
      expect(
        await screen.findByText(/^Availability requests closed at kickoff, Sat, Oct 31/),
      ).toBeOnTheScreen();
    });

    it('a refused request is "not available"', async () => {
      renderAvailability({
        'POST /fixtures/{id}/availability-requests': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
          ),
      });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Send a reminder to players without an answer' }),
      );
      expect(
        await screen.findByText(
          'Asking the roster for availability is not available to you for this team.',
        ),
      ).toBeOnTheScreen();
    });

    it('CMP-02: a roster player is not offered the request and nothing is read for it', async () => {
      const app = renderAvailability({
        'GET /team-entries/{id}': { status: 200, body: playerWorkspace() },
      });
      expect(await screen.findByText('Your answer: Available')).toBeOnTheScreen();
      expect(screen.queryByRole('header', { name: 'Ask the roster' })).toBeNull();
      expect(app.requestsTo('GET', '/fixtures/{id}/availability-requests')).toHaveLength(0);
    });
  });
});
