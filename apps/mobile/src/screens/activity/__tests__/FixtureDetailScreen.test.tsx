/**
 * SCR-C-20 fixture detail with the SCR-C-04 card and RSVP (SPK-UX-004, SPK-CAP-002, SPK-CAP-003,
 * SPK-READY-002, SPK-RESULT-001, SPK-COMMS-005, SPK-SCHED-008, SPK-UX-008, SPK-UX-009, §4.9,
 * §4.10, §4.15).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  AWAY_ENTRY,
  eventDetails,
  me,
  SELF_CAPTAIN,
  fail,
  FIXTURE,
  fixtureDetail,
  HOME_ENTRY,
  inboxPage,
  ok,
  readiness,
  result,
  scheduleChange,
  teamWorkspace,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { FixtureDetailScreen } from '../FixtureDetailScreen';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

/** A notice moving the fixture to Pitch 2 on Sunday 10:00 (the fixture's own time). */
const MOVED = scheduleChange({
  title: 'Schedule changed: Lions vs Tigers',
  detailsBefore: eventDetails({
    title: 'Lions vs Tigers',
    scheduledStart: '2026-10-25T16:00:00.000Z',
    scheduledEnd: '2026-10-25T17:30:00.000Z',
    resources: [{ id: '0192f1a0-0000-7000-8000-00000000b702', name: 'Pitch 1' }],
  }),
  detailsAfter: eventDetails({
    title: 'Lions vs Tigers',
    scheduledStart: '2026-10-25T17:00:00.000Z',
    scheduledEnd: '2026-10-25T18:30:00.000Z',
  }),
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /fixtures/{id}': ok(fixtureDetail()),
    'GET /fixtures/{id}/readiness': ok(readiness()),
    'GET /fixtures/{id}/results': ok([]),
    // The person may read the home entry (their team) but not the opponent's.
    // The viewer captains the home entry (readiness detail is for captains, SCR-C-20).
    'GET /team-entries/{id}': (req) =>
      req.params.id === HOME_ENTRY
        ? fakeResponse(200, teamWorkspace('Lions', SELF_CAPTAIN))
        : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    'GET /me': ok(me()),
    'GET /me/inbox': inboxPage([MOVED]),
    ...overrides,
  };
}

function renderFixture(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<FixtureDetailScreen fixtureId={FIXTURE} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-20 FixtureDetailScreen', () => {
  it('SPK-UX-004: shows the team, opponent, field and time in the facility zone, status and the change', async () => {
    renderFixture();
    const card = await screen.findByTestId('fixture-card');
    expect(within(card).getByRole('header', { name: 'Lions vs Tigers' })).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText(
        'For: Lions. Against: Tigers. When: Sun, Oct 25, 10:00 AM to 11:30 AM PDT. Where: Pitch 2',
      ),
    ).toBeOnTheScreen();
    expect(within(card).getByLabelText('Scheduled')).toBeOnTheScreen();
    expect(within(card).getByTestId('fixture-card-change')).toHaveProp(
      'accessibilityLabel',
      'Changed. Was: Sun, Oct 25, 9:00 AM to 10:30 AM PDT at Pitch 1. Now: Sun, Oct 25, 10:00 AM to 11:30 AM PDT at Pitch 2',
    );
    expect(screen.getByText(/Adult 7v7 \(version 2\), Fall 2026, Division 2\./)).toBeOnTheScreen();
    expect(
      screen.getByText(/Lions: 5 available, 1 unavailable, 0 tentative, 4 no response/),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Arrival guidance for this activity is not available yet: it depends on POL-046/,
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-READY-002 / SPK-CAP-002: readiness as an assessment with responsible role and action, counts only', async () => {
    renderFixture();
    expect(await screen.findByTestId('readiness-status')).toHaveProp(
      'accessibilityLabel',
      'Match readiness: needs attention',
    );
    expect(screen.getByTestId('readiness-issue-0')).toHaveProp(
      'accessibilityLabel',
      'Warning. Lions have 6 eligible players; the rule set needs 7. Responsible: Captain. Action: Invite or confirm another eligible player.',
    );
    expect(
      screen.getByText(/Lions: 6 of 10 rostered players eligible, 1 not yet known; at least 7/),
    ).toBeOnTheScreen();
  });

  it("SPK-CAP-002: a player who is not captain sees no readiness detail, and only their own side's availability", async () => {
    renderFixture({
      'GET /team-entries/{id}': (req) =>
        req.params.id === HOME_ENTRY
          ? fakeResponse(200, teamWorkspace('Lions'))
          : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    });
    expect(await screen.findByTestId('fixture-availability')).toBeOnTheScreen();
    expect(screen.queryByTestId('fixture-readiness')).toBeNull();
    expect(screen.queryByText(/eligible players/)).toBeNull();
    // The opponent's answers (3 available) are not shown.
    expect(screen.queryByText(/3 available/)).toBeNull();
  });

  it("SPK-CAP-002: a captain sees only their side and issues about it, never the opponent's roster issues", async () => {
    renderFixture({
      'GET /fixtures/{id}/readiness': ok(
        readiness({
          issues: [
            ...readiness().issues,
            {
              code: 'ROSTER_BELOW_MINIMUM',
              severity: 'warning',
              message: 'Tigers have 5 eligible players; the rule set needs 7.',
              source: { type: 'team_entry', id: AWAY_ENTRY },
              responsibleRole: 'captain',
              requiredAction: 'Invite or confirm another eligible player.',
              lastEvaluatedAt: '2026-10-24T11:30:00.000Z',
              deadline: null,
            },
            {
              code: 'PLAYER_SUSPENDED',
              severity: 'blocking',
              message: "A player on Tigers' roster is suspended for this fixture.",
              source: { type: 'suspension', id: '0192f1a0-0000-7000-8000-00000000fa01' },
              responsibleRole: 'league_manager',
              requiredAction: 'Remove the player from the lineup.',
              lastEvaluatedAt: '2026-10-24T11:30:00.000Z',
              deadline: null,
            },
          ],
          sides: [
            ...readiness().sides,
            {
              teamEntryId: AWAY_ENTRY,
              teamName: 'Tigers',
              entryStatus: 'approved',
              rosterSize: 9,
              eligiblePlayers: 5,
              unknownPlayers: 0,
              minimumPlayers: 7,
            },
          ],
        }),
      ),
    });
    expect(await screen.findByTestId('readiness-issue-0')).toBeOnTheScreen();
    expect(screen.queryByTestId('readiness-issue-1')).toBeNull();
    expect(screen.queryByText(/Tigers have 5/)).toBeNull();
    expect(screen.queryByText(/suspended/)).toBeNull();
    expect(screen.queryByText(/Tigers: 5 of 9/)).toBeNull();
  });

  it('§4.10: after a 200, a refetch answering NOT_FOUND removes the fixture and its RSVP from the screen', async () => {
    let gone = false;
    const app = renderFixture({
      'GET /fixtures/{id}': () =>
        gone
          ? fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }))
          : fakeResponse(200, fixtureDetail()),
    });
    expect(await screen.findByRole('radio', { name: 'Available' })).toBeOnTheScreen();
    gone = true;
    await act(async () => {
      await app.queryClient.invalidateQueries({ queryKey: ['api', '/fixtures/{id}'] });
    });
    expect(await screen.findByText(/This fixture is not available\./)).toBeOnTheScreen();
    expect(screen.queryByRole('radio', { name: 'Available' })).toBeNull();
    expect(screen.queryByTestId('fixture-card')).toBeNull();
  });

  it('SPK-UX-009: the RSVP choices are a named radio group', async () => {
    renderFixture();
    // The group is a container (not one accessibility element), so the radios stay focusable.
    const group = await screen.findByLabelText('Your availability for this fixture');
    expect(group).toHaveProp('accessibilityRole', 'radiogroup');
    expect(within(group).getByRole('radio', { name: 'Available' })).toBeOnTheScreen();
  });

  it('SPK-RESULT-001: an official result, and a provisional one that does not count yet', async () => {
    renderFixture({ 'GET /fixtures/{id}/results': ok([result()]) });
    const official = await screen.findByLabelText('Lions 2, Tigers 1. Official');
    expect(official).toBeOnTheScreen();
    expect(
      screen.getByText('Disputing a result is not available in the app yet.'),
    ).toBeOnTheScreen();

    screen.unmount();
    renderFixture({ 'GET /fixtures/{id}/results': ok([result({ status: 'submitted' })]) });
    expect(await screen.findByLabelText('Lions 2, Tigers 1. Provisional')).toBeOnTheScreen();
    expect(screen.getByText(/do not count in the standings until official/)).toBeOnTheScreen();
  });

  it('SPK-CAP-003: records an RSVP with an idempotency key; a different answer is a new intent', async () => {
    let state: string | null = null;
    const app = renderFixture({
      'GET /fixtures/{id}': () => fakeResponse(200, fixtureDetail({ myResponse: state })),
      'POST /fixtures/{id}/availability': (req) => {
        state = (req.body as { state: string }).state;
        return fakeResponse(200, {
          id: '0192f1a0-0000-7000-8000-00000000fa01',
          fixtureId: FIXTURE,
          teamEntryId: HOME_ENTRY,
          personId: 'self',
          state,
          respondedAt: '2026-10-24T12:00:00.000Z',
          note: null,
          revision: 1,
        });
      },
    });
    expect(await screen.findByLabelText('No response')).toBeOnTheScreen();
    // Tentative is not offered while DEC-064 is pending.
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Available',
      'Unavailable',
    ]);
    expect(
      screen.getByText(/whether it is used is still being decided \(DEC-064\)/),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('radio', { name: 'Available' }));
    expect(await screen.findByTestId('rsvp-recorded')).toHaveTextContent(
      'Answer recorded: Available.',
    );
    expect(screen.getByRole('radio', { name: 'Available' })).toHaveProp(
      'accessibilityState',
      expect.objectContaining({ checked: true }),
    );
    fireEvent.press(screen.getByRole('radio', { name: 'Unavailable' }));
    expect(await screen.findByText('Answer recorded: Unavailable.')).toBeOnTheScreen();

    const posts = app.fake.requests.filter((r) => r.route === '/fixtures/{id}/availability');
    expect(posts.map((p) => p.body)).toEqual([{ state: 'available' }, { state: 'unavailable' }]);
    expect(posts[0]?.headers['idempotency-key']).not.toBe(posts[1]?.headers['idempotency-key']);
    expect(screen.getByText(/not a check-in and does not affect eligibility/)).toBeOnTheScreen();
  });

  it('retrying the same RSVP after INTEGRATION_UNAVAILABLE reuses its key (§4.9)', async () => {
    let calls = 0;
    const app = renderFixture({
      'POST /fixtures/{id}/availability': () => {
        calls += 1;
        return calls === 1
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
            )
          : fakeResponse(200, { state: 'available' });
      },
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Available' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Answer recorded: Available.')).toBeOnTheScreen();
    const keys = app.fake.requests
      .filter((r) => r.route === '/fixtures/{id}/availability')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows the API answers for an RSVP: not on the roster, no authority, closed fixture', async () => {
    renderFixture({
      'POST /fixtures/{id}/availability': fail(
        400,
        'VALIDATION_FAILED',
        'The person is not on a roster of this fixture.',
      ),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Available' }));
    expect(
      await screen.findByText('The person is not on a roster of this fixture.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();

    screen.unmount();
    renderFixture({
      'POST /fixtures/{id}/availability': fail(403, 'PARTICIPANT_AUTHORITY_REQUIRED'),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Available' }));
    expect(await screen.findByLabelText('Responding is not available')).toBeOnTheScreen();
    expect(screen.getByText(/\(DEC-090\)/)).toBeOnTheScreen();

    screen.unmount();
    let reads = 0;
    renderFixture({
      'GET /fixtures/{id}': () => {
        reads += 1;
        return fakeResponse(200, fixtureDetail());
      },
      'POST /fixtures/{id}/availability': fail(409, 'INVALID_TRANSITION'),
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Available' }));
    const reload = await screen.findByRole('button', { name: 'Reload' });
    const before = reads;
    fireEvent.press(reload);
    // The mutation reset and the refetch notify through TanStack Query's batched (timer-based)
    // notifier, so wait for the re-render instead of assuming it lands within one act() flush.
    await waitFor(() => expect(reads).toBe(before + 1));
    // The stale answer is cleared with the reload (no lingering "Something went wrong").
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull());
    expect(screen.queryByText(/Error code: INVALID_TRANSITION/)).toBeNull();
  });

  it('a played fixture takes no answers; offline, answering is disabled and nothing is queued', async () => {
    renderFixture({
      'GET /fixtures/{id}': ok(fixtureDetail({ status: 'played', myResponse: 'available' })),
    });
    expect(
      await screen.findByText('This fixture no longer takes availability answers.'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByTestId('rsvp-current')).toHaveProp('accessibilityLabel', 'Available');

    screen.unmount();
    const app = renderFixture();
    expect(await screen.findByRole('radio', { name: 'Available' })).toBeOnTheScreen();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('radio', { name: 'Available' })).toBeDisabled();
    expect(screen.getByText(/Answering needs a connection\. Nothing is saved/)).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('§4.10: a fixture the person may not see is "not available"; a readiness denial hides only that section', async () => {
    renderFixture({ 'GET /fixtures/{id}': fail(404, 'NOT_FOUND') });
    expect(await screen.findByText(/This fixture is not available\./)).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();

    screen.unmount();
    renderFixture({ 'GET /fixtures/{id}/readiness': fail(404, 'NOT_FOUND') });
    expect(await screen.findByText('Match readiness is not available to you.')).toBeOnTheScreen();
    expect(screen.getByTestId('fixture-card')).toBeOnTheScreen();
  });

  it('names the teams as stated when no team entry is readable (bye and unknown side)', async () => {
    renderFixture({
      'GET /fixtures/{id}': ok(fixtureDetail({ away: null, awayEntryId: null })),
      'GET /team-entries/{id}': fail(404, 'NOT_FOUND'),
      'GET /me/inbox': inboxPage([]),
    });
    const card = await screen.findByTestId('fixture-card');
    expect(within(card).getByRole('header', { name: 'Lions (bye)' })).toBeOnTheScreen();
    expect(
      await within(card).findByLabelText(
        'For: Your team. When: Sun, Oct 25, 10:00 AM to 11:30 AM PDT. Where: Place not shown yet',
      ),
    ).toBeOnTheScreen();
    expect(
      await screen.findByText('The rule set summary is shown to team members.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Times are in this device's time zone/)).toBeOnTheScreen();
  });
});
