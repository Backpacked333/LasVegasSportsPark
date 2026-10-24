/**
 * SCR-C-26 Roster change and substitute request (SPK-CAP-004, SPK-COMP-005, SPK-AT-013,
 * POL-032): eligibility explained by the API before adding, a suspended player refused as a
 * substitute with the API's reasons, league approval shown as pending (not a denial), the
 * expected revision sent and a stale roster reloaded, removal with a reason, and refusals.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  ROSTER,
  baseRoutes,
  member,
  playerWorkspace,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { RosterChangeScreen } from '../RosterChangeScreen';

const former = member({
  personId: IDS.formerPlayer,
  displayName: 'Former Fran',
  status: 'removed',
  statusBeforeRemoval: 'active',
  effectiveTo: '2026-10-01T12:00:00.000Z',
  removedAt: '2026-10-01T12:00:00.000Z',
  eligibility: null,
});
const history = {
  teamEntryId: IDS.entry,
  at: '2026-10-24T12:00:00.000Z',
  members: [...ROSTER, former],
};

const reason = (code: string, message: string, extra = {}) => ({
  code,
  severity: 'blocking',
  message,
  source: { type: code === 'suspended' ? 'suspension' : 'rule_set', id: IDS.ruleSet },
  responsibleRole: 'league_manager',
  requiredAction:
    code === 'suspended'
      ? 'The suspension must end or be lifted before the player can be added.'
      : 'Ask the league manager to add the player.',
  ...extra,
});

const eligibilityFailed = (reasons: unknown[]) => () =>
  fakeResponse(
    422,
    apiErrorBody('ELIGIBILITY_FAILED', {
      message: 'The player is not eligible for this roster.',
      nextAction: 'review_eligibility_reasons',
      details: { personId: IDS.formerPlayer, membershipStatus: 'substitute', reasons },
    }),
  );

function renderChange(overrides = {}) {
  const app = createTeamsTestApp({
    routes: baseRoutes({
      'GET /team-entries/{id}/roster': { status: 200, body: history },
      ...overrides,
    }),
  });
  render(<RosterChangeScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

async function chooseFormerAsSubstitute() {
  fireEvent.press(await screen.findByRole('radio', { name: /^Former Fran/ }));
  fireEvent.press(screen.getByRole('radio', { name: 'Substitute' }));
}

describe('SCR-C-26 RosterChangeScreen', () => {
  it('SPK-CAP-004: explains eligibility from the API before adding', async () => {
    const app = renderChange({
      'GET /team-entries/{id}/eligibility': {
        status: 200,
        body: {
          teamEntryId: IDS.entry,
          personId: IDS.formerPlayer,
          at: '2026-10-24T12:00:00.000Z',
          membershipStatus: 'substitute',
          eligible: true,
          reasons: [],
          evaluatedAt: '2026-10-24T12:00:00.000Z',
        },
      },
    });
    await chooseFormerAsSubstitute();
    fireEvent.press(screen.getByRole('button', { name: 'Check eligibility' }));
    expect(await screen.findByLabelText('Eligible as substitute now')).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/team-entries/{id}/eligibility')[0]?.query).toEqual({
      personId: IDS.formerPlayer,
      status: 'substitute',
    });
  });

  it('SPK-AT-013: a suspended player added as a substitute is refused with the API reasons', async () => {
    const app = renderChange({
      'POST /team-entries/{id}/roster': eligibilityFailed([
        reason('suspended', 'The person is suspended (red card) until 2026-11-01.'),
      ]),
    });
    await chooseFormerAsSubstitute();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to the roster' }));
    });
    const failure = await screen.findByTestId('command-failure');
    expect(
      within(failure).getByText('The person is suspended (red card) until 2026-11-01.'),
    ).toBeOnTheScreen();
    expect(within(failure).getByLabelText('Blocking')).toBeOnTheScreen();
    expect(within(failure).getByText(/Error code: ELIGIBILITY_FAILED/)).toBeOnTheScreen();
    expect(screen.queryByTestId('change-success')).toBeNull();
    expect(app.bodiesOf('POST', '/team-entries/{id}/roster')).toEqual([
      {
        changes: [{ action: 'add', personId: IDS.formerPlayer, status: 'substitute' }],
        expectedRevision: 4,
      },
    ]);
  });

  it('POL-032: league approval is shown as "League approval required", not as a denial', async () => {
    renderChange({
      'POST /team-entries/{id}/roster': eligibilityFailed([
        reason(
          'approval_required',
          'Guest and substitute additions require league approval under this rule set.',
        ),
      ]),
    });
    await chooseFormerAsSubstitute();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to the roster' }));
    });
    expect(await screen.findByLabelText('League approval required')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Blocking')).toBeNull();
    expect(
      screen.getByText('League manager: Ask the league manager to add the player.'),
    ).toBeOnTheScreen();
  });

  it('SPK-COMP-005: adds the player with the effective date the API recorded', async () => {
    const added = member({
      personId: IDS.formerPlayer,
      displayName: 'Former Fran',
      status: 'substitute',
      effectiveFrom: '2026-10-24T12:00:00.000Z',
    });
    renderChange({
      'POST /team-entries/{id}/roster': {
        status: 200,
        body: {
          teamEntryId: IDS.entry,
          at: '2026-10-24T12:00:00.000Z',
          members: [...ROSTER, added],
        },
      },
    });
    await chooseFormerAsSubstitute();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to the roster' }));
    });
    expect(await screen.findByLabelText('Added: Substitute from Oct 24, 2026')).toBeOnTheScreen();
  });

  it('§4.9: a roster that changed meanwhile (STALE_REVISION) asks to reload and keeps the selection', async () => {
    const app = renderChange({
      'POST /team-entries/{id}/roster': () =>
        fakeResponse(
          409,
          apiErrorBody('STALE_REVISION', {
            message: 'The record changed: expected revision 4, found 5.',
            nextAction: 'reload_and_retry',
          }),
        ),
    });
    await chooseFormerAsSubstitute();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to the roster' }));
    });
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    const reads = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads);
    expect(screen.getByRole('radio', { name: /^Former Fran/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Substitute' })).toBeChecked();
    await app.settle();
  });

  it('removes a player only with a reason, sent with the expected revision', async () => {
    const app = renderChange({
      'POST /team-entries/{id}/roster': { status: 200, body: history },
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Remove a player' }));
    fireEvent.press(screen.getByRole('radio', { name: /^Pat Player/ }));
    fireEvent.press(screen.getByRole('button', { name: 'Remove from the roster' }));
    expect(
      screen.getByLabelText(
        'Reason for the removal. Give a reason; it is kept with the roster history.',
      ),
    ).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/team-entries/{id}/roster')).toHaveLength(0);
    fireEvent.changeText(screen.getByLabelText(/^Reason for the removal/), 'Moved away');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Remove from the roster' }));
    });
    expect(app.bodiesOf('POST', '/team-entries/{id}/roster')).toEqual([
      {
        changes: [{ action: 'remove', personId: IDS.player2, reason: 'Moved away' }],
        expectedRevision: 4,
      },
    ]);
    expect(await screen.findByTestId('change-success')).toBeOnTheScreen();
    await app.settle();
  });

  it('a roster change the API refuses (ACCESS_DENIED) is not available', async () => {
    renderChange({
      'POST /team-entries/{id}/roster': () =>
        fakeResponse(
          403,
          apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
        ),
    });
    await chooseFormerAsSubstitute();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Add to the roster' }));
    });
    expect(
      await screen.findByText('Changing this roster is not available to you.'),
    ).toBeOnTheScreen();
  });

  it('a roster player who is not the captain sees roster changes as not available', async () => {
    renderChange({ 'GET /team-entries/{id}': { status: 200, body: playerWorkspace() } });
    expect(
      await screen.findByText(
        'Changing the roster is not available to you for this team. Your captain manages it.',
      ),
    ).toBeOnTheScreen();
  });

  it('offline: changes are disabled with an explanation', async () => {
    const app = renderChange();
    await chooseFormerAsSubstitute();
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Add to the roster' })).toBeDisabled();
    expect(screen.getByText(/Changing the roster needs a connection/)).toBeOnTheScreen();
  });
});
