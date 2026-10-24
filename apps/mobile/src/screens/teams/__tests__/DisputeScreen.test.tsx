/**
 * SCR-C-29 Dispute submission (SPK-RESULT-005, POL-029, DEC-010): the window from the rule set,
 * the dispute sent for the captain's entry against the official revision with reason and
 * evidence, "Disputed: under review" on success, the closed window with the draft kept, and the
 * not-eligible, offline and pending-appeal states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { formatInstant } from '../../../features/teams/format';
import {
  IDS,
  baseRoutes,
  dispute,
  fixtureDetail,
  playerWorkspace,
  result,
  ruleSet,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { DisputeScreen } from '../DisputeScreen';

function routes(overrides: Record<string, FakeHandler> = {}) {
  return baseRoutes({
    'GET /fixtures/{id}': { status: 200, body: fixtureDetail() },
    'GET /fixtures/{id}/results': { status: 200, body: [result()] },
    'GET /fixtures/{id}/disputes': { status: 200, body: [] },
    'GET /rule-sets/{id}': { status: 200, body: ruleSet() },
    ...overrides,
  });
}

function renderDispute(overrides: Record<string, FakeHandler> = {}) {
  const app = createTeamsTestApp({ routes: routes(overrides) });
  render(<DisputeScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
    wrapper: app.wrapper,
  });
  return app;
}

describe('SCR-C-29 DisputeScreen', () => {
  it('POL-029: shows the window from the rule set, counted from the official publication', async () => {
    renderDispute();
    const window = await screen.findByTestId('dispute-window');
    expect(
      within(window).getByLabelText(
        'Dispute window: 48 hours after the official result is published (rule set Adult outdoor 7v7, version 3)',
      ),
    ).toBeOnTheScreen();
    expect(
      within(window).getByLabelText(`Window closes: ${formatInstant('2026-10-25T10:00:00.000Z')}`),
    ).toBeOnTheScreen();
    expect(screen.getByText('No disputes for this game yet.')).toBeOnTheScreen();
  });

  it('SPK-RESULT-005: submits for the captain’s entry against the official revision, with reason and evidence', async () => {
    const app = renderDispute({
      'POST /fixtures/{id}/disputes': { status: 201, body: dispute() },
    });
    fireEvent.changeText(
      await screen.findByLabelText('Reason'),
      'The second goal was scored after the final whistle.',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Add an evidence reference' }));
    fireEvent.changeText(screen.getByLabelText('Evidence 1: kind'), 'video');
    fireEvent.changeText(
      screen.getByLabelText('Evidence 1: reference'),
      'https://video.example.test/clip-7',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Submit the dispute' }));
    });
    const done = await screen.findByTestId('dispute-submitted');
    expect(within(done).getByLabelText('Disputed: under review')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/fixtures/{id}/disputes')).toEqual([
      {
        teamEntryId: IDS.entry,
        resultRevisionId: IDS.officialResult,
        reason: 'The second goal was scored after the final whistle.',
        evidence: [{ kind: 'video', reference: 'https://video.example.test/clip-7' }],
      },
    ]);
    expect(app.keysOf('POST', '/fixtures/{id}/disputes')[0]).toMatch(/^key-/);
    await app.settle();
  });

  it('requires a reason before sending', async () => {
    const app = renderDispute();
    fireEvent.press(await screen.findByRole('button', { name: 'Submit the dispute' }));
    expect(screen.getByLabelText('Reason. Give the reason for the dispute.')).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/fixtures/{id}/disputes')).toHaveLength(0);
  });

  it('outside the window: says when it closed and keeps the draft', async () => {
    renderDispute({
      'POST /fixtures/{id}/disputes': () =>
        fakeResponse(
          400,
          apiErrorBody('VALIDATION_FAILED', {
            message: 'The protest window closed at 2026-10-25T10:00:00.000Z.',
            nextAction: 'correct_input',
            details: {
              code: 'protest_window_closed',
              submissionDeadlineAt: '2026-10-25T10:00:00.000Z',
              protestDeadlineHours: 48,
            },
          }),
        ),
    });
    fireEvent.changeText(await screen.findByLabelText('Reason'), 'Late goal.');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Submit the dispute' }));
    });
    const closed = await screen.findByTestId('window-closed');
    expect(within(closed).getByLabelText('Dispute window closed')).toBeOnTheScreen();
    expect(
      within(closed).getByText(
        `The dispute window closed ${formatInstant('2026-10-25T10:00:00.000Z')}. Your draft is kept.`,
      ),
    ).toBeOnTheScreen();
    expect(within(closed).getByText('Error code: VALIDATION_FAILED')).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason').props.value).toBe('Late goal.');
  });

  it('a role the API does not accept is "not available" and the draft stays', async () => {
    renderDispute({
      'POST /fixtures/{id}/disputes': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    fireEvent.changeText(await screen.findByLabelText('Reason'), 'Late goal.');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Submit the dispute' }));
    });
    expect(
      await screen.findByText('Submitting a dispute for this game is not available to you.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason').props.value).toBe('Late goal.');
  });

  it('a roster player who is not the captain cannot file a dispute here', async () => {
    renderDispute({ 'GET /team-entries/{id}': { status: 200, body: playerWorkspace() } });
    expect(
      await screen.findByText(
        'Submitting a dispute is not available to you for this team. Your captain manages it.',
      ),
    ).toBeOnTheScreen();
  });

  it('DEC-010: appeals are shown as waiting on a decision; existing disputes show their status', async () => {
    renderDispute({
      'GET /fixtures/{id}/disputes': {
        status: 200,
        body: [
          dispute({
            status: 'decided',
            decision: 'rejected',
            decisionReason: 'The goal was before the whistle.',
            publicationConsequence: 'result_stands',
          }),
        ],
      },
    });
    expect(await screen.findByLabelText('Dispute not upheld')).toBeOnTheScreen();
    expect(screen.getByText('The result stands')).toBeOnTheScreen();
    expect(screen.getByText('Decision: The goal was before the whistle.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Waiting on a decision')).toBeOnTheScreen();
    expect(screen.getByText(/depends on DEC-010/)).toBeOnTheScreen();
  });

  it('offline: the draft is kept and submitting is disabled', async () => {
    const app = renderDispute();
    fireEvent.changeText(await screen.findByLabelText('Reason'), 'Late goal.');
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Submit the dispute' })).toBeDisabled();
    expect(screen.getByText(/Submitting a dispute needs a connection/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason').props.value).toBe('Late goal.');
  });
});
