/**
 * SCR-C-24 Availability (SPK-CAP-003, SPK-READY-002, DEC-064): counts per game, the person's own
 * answer, answering for a child with `register`, Tentative pending, and the error, permission,
 * stale and offline states. Availability is never attendance or eligibility.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { IDS, baseRoutes, me, upcoming, workspace } from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { AvailabilityScreen } from '../AvailabilityScreen';

const answer = (state: string, personId = IDS.me) => ({
  id: '0192f1a0-0000-7000-8000-000000000777',
  fixtureId: IDS.fixture,
  teamEntryId: IDS.entry,
  personId,
  state,
  respondedAt: '2026-10-24T12:00:00.000Z',
  note: null,
  revision: 1,
});

function renderAvailability(options: Parameters<typeof createTeamsTestApp>[0] = {}) {
  const app = createTeamsTestApp({ routes: baseRoutes(), ...options });
  render(<AvailabilityScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-24 AvailabilityScreen', () => {
  it('SPK-CAP-003: shows the counts per game and records the person’s own answer', async () => {
    const app = renderAvailability({
      routes: baseRoutes({
        'POST /fixtures/{id}/availability': { status: 200, body: answer('available') },
      }),
    });
    const game = await screen.findByTestId(`game-${IDS.fixture}`);
    expect(
      within(game).getByLabelText(
        'Answers from the roster: Available 1, Unavailable 1, No response 1',
      ),
    ).toBeOnTheScreen();
    expect(within(game).getByText('Your answer: No response')).toBeOnTheScreen();

    const available = within(game).getByRole('button', { name: 'Available' });
    await act(async () => {
      fireEvent.press(available);
    });
    expect(await within(game).findByText('Your answer: Available')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/fixtures/{id}/availability')).toEqual([{ state: 'available' }]);
    expect(app.keysOf('POST', '/fixtures/{id}/availability')[0]).toMatch(/^key-/);
    // Once answered, the person can clear it again (No response).
    expect(within(game).getByRole('button', { name: 'Clear my answer' })).toBeOnTheScreen();
    await app.settle();
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
      routes: baseRoutes({
        'GET /team-entries/{id}': {
          status: 200,
          body: workspace({ upcomingFixtures: [upcoming({ myResponse: 'tentative' })] }),
        },
      }),
    });
    expect(await screen.findByText('Your answer: Tentative')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Tentative' })).toBeNull();
    expect(
      screen.getByLabelText(
        'Tentative is not offered yet: whether it is used is still being decided (DEC-064).',
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-IAM-003: a guardian with register answers for their child on the roster', async () => {
    const app = renderAvailability({
      routes: baseRoutes({
        'GET /me': {
          status: 200,
          body: me({
            authorities: [{ subjectPersonId: IDS.child, permissions: ['view', 'register'] }],
          }),
        },
        'POST /fixtures/{id}/availability': { status: 200, body: answer('unavailable', IDS.child) },
      }),
    });
    expect(
      await screen.findByText(
        "Kim Junior's answer: not shown here (the service returns only your own)",
      ),
    ).toBeOnTheScreen();
    const button = screen.getByRole('button', { name: 'Kim Junior: Unavailable' });
    await act(async () => {
      fireEvent.press(button);
    });
    expect(await screen.findByText("Kim Junior's answer: Unavailable")).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/fixtures/{id}/availability')).toEqual([
      { state: 'unavailable', personId: IDS.child },
    ]);
    await app.settle();
  });

  it('answering for a person without authority is "not available"', async () => {
    renderAvailability({
      routes: baseRoutes({
        'GET /me': {
          status: 200,
          body: me({ authorities: [{ subjectPersonId: IDS.child, permissions: ['register'] }] }),
        },
        'POST /fixtures/{id}/availability': () =>
          fakeResponse(
            403,
            apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED', {
              nextAction: 'request_participant_authority',
            }),
          ),
      }),
    });
    const button = await screen.findByRole('button', { name: 'Kim Junior: Available' });
    await act(async () => {
      fireEvent.press(button);
    });
    expect(
      await screen.findByText('Answering for Kim Junior is not available to you.'),
    ).toBeOnTheScreen();
  });

  it('a game that changed since loading (INVALID_TRANSITION) asks to reload', async () => {
    const app = renderAvailability({
      routes: baseRoutes({
        'POST /fixtures/{id}/availability': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', {
              message: 'Fixture cannot respond_availability from canceled.',
              nextAction: 'reload_current_state',
            }),
          ),
      }),
    });
    const button = await screen.findByRole('button', { name: 'Available' });
    await act(async () => {
      fireEvent.press(button);
    });
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: INVALID_TRANSITION/)).toBeOnTheScreen();
    const reads = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads);
    await app.settle();
  });

  it('§4.9: retrying a failed answer reuses the same idempotency key', async () => {
    let attempt = 0;
    const app = renderAvailability({
      routes: baseRoutes({
        'POST /fixtures/{id}/availability': () => {
          attempt += 1;
          return attempt === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, answer('available'));
        },
      }),
    });
    const button = await screen.findByRole('button', { name: 'Available' });
    await act(async () => {
      fireEvent.press(button);
    });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await act(async () => {
      fireEvent.press(retry);
    });
    expect(await screen.findByText('Your answer: Available')).toBeOnTheScreen();
    const [first, second] = app.keysOf('POST', '/fixtures/{id}/availability');
    expect(second).toBe(first);
    await app.settle();
  });

  it('offline: answering is disabled with an explanation, never queued', async () => {
    const app = renderAvailability();
    expect(await screen.findByRole('button', { name: 'Available' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Available' })).toBeDisabled();
    expect(
      screen.getByText(
        'Answering availability needs a connection. Nothing is queued: your entries are kept on this screen.',
      ),
    ).toBeOnTheScreen();
  });

  it('the captain sees that availability requests are not available yet; empty when no games', async () => {
    renderAvailability({
      routes: baseRoutes({
        'GET /team-entries/{id}': { status: 200, body: workspace({ upcomingFixtures: [] }) },
      }),
    });
    expect(await screen.findByLabelText('Requests not available yet')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'No games published' })).toBeOnTheScreen();
  });
});
