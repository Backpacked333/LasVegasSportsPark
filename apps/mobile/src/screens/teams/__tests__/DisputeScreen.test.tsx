/**
 * SCR-C-29 Dispute submission (SPK-RESULT-005, POL-029, DEC-010, CMP-12): the window from the rule
 * set in the facility's zone, the dispute sent for the captain's entry against the official
 * revision with reason and evidence, "Disputed: under review" on success, the closed window with
 * the draft kept, withdrawing an open dispute with its revision, and the not-eligible, offline and
 * pending-appeal states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { formatInstant } from '../../../features/teams/format';
import {
  IDS,
  baseRoutes,
  dispute,
  fixtureDetail,
  playerWorkspace,
  result,
  ruleSet,
  venue,
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

  it('an evidence row with only a reference blocks sending, says what is missing and is kept', async () => {
    const app = renderDispute({
      'POST /fixtures/{id}/disputes': { status: 201, body: dispute() },
    });
    fireEvent.changeText(await screen.findByLabelText('Reason'), 'Late goal.');
    fireEvent.press(screen.getByRole('button', { name: 'Add an evidence reference' }));
    fireEvent.changeText(
      screen.getByLabelText('Evidence 1: reference'),
      'https://video.example.test/clip-7',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Submit the dispute' }));
    expect(
      screen.getByLabelText(
        'Evidence 1: kind. Give the kind and the reference, or remove this evidence.',
      ),
    ).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/fixtures/{id}/disputes')).toHaveLength(0);
    expect(screen.getByLabelText(/^Evidence 1: reference/)).toHaveProp(
      'value',
      'https://video.example.test/clip-7',
    );
  });

  it('SPK-UX-008: a failed read of the existing disputes shows its code, never "no disputes"', async () => {
    renderDispute({
      'GET /fixtures/{id}/disputes': () =>
        fakeResponse(
          500,
          apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
        ),
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.queryByText('No disputes for this game yet.')).toBeNull();
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

  it('SPK-SCHED-008: the window closes at a time shown in the facility’s zone', async () => {
    renderDispute({
      'GET /fixtures/{id}': { status: 200, body: fixtureDetail({ venue: venue() }) },
    });
    const window = await screen.findByTestId('dispute-window');
    expect(
      within(window).getByLabelText(/^Window closes: Sun, Oct 25, 3:00\sAM PDT$/),
    ).toBeOnTheScreen();
  });

  describe('withdraw (CMP-12)', () => {
    const open = () => ({ 'GET /fixtures/{id}/disputes': { status: 200, body: [dispute()] } });

    it('withdraws an open dispute with a reason and its revision', async () => {
      let withdrawn = false;
      const app = renderDispute({
        'GET /fixtures/{id}/disputes': () =>
          fakeResponse(200, [
            withdrawn ? dispute({ status: 'withdrawn', revision: 2 }) : dispute(),
          ]),
        'POST /disputes/{id}/withdraw': () => {
          withdrawn = true;
          return fakeResponse(200, dispute({ status: 'withdrawn', revision: 2 }));
        },
      });
      const item = await screen.findByTestId(`dispute-${IDS.dispute}`);
      fireEvent.press(within(item).getByRole('button', { name: 'Withdraw this dispute' }));
      fireEvent.press(within(item).getByRole('button', { name: 'Withdraw the dispute' }));
      // A reason is required and nothing is sent without one.
      expect(
        within(item).getByLabelText('Reason for withdrawing. Give the reason for withdrawing.'),
      ).toBeOnTheScreen();
      expect(app.requestsTo('POST', '/disputes/{id}/withdraw')).toHaveLength(0);
      fireEvent.changeText(
        within(item).getByLabelText(/^Reason for withdrawing/),
        'Settled with the other captain.',
      );
      fireEvent.press(within(item).getByRole('button', { name: 'Withdraw the dispute' }));
      expect(
        await screen.findByText('You withdrew this dispute. The league no longer reviews it.'),
      ).toBeOnTheScreen();
      expect(await screen.findByLabelText('Dispute withdrawn')).toBeOnTheScreen();
      expect(app.bodiesOf('POST', '/disputes/{id}/withdraw')).toEqual([
        { reason: 'Settled with the other captain.', expectedRevision: 1 },
      ]);
      expect(app.keysOf('POST', '/disputes/{id}/withdraw')[0]).toMatch(/^key-/);
      await app.settle();
    });

    it('§4.9: a failed withdrawal is retried under the same idempotency key', async () => {
      let attempt = 0;
      const app = renderDispute({
        ...open(),
        'POST /disputes/{id}/withdraw': () => {
          attempt += 1;
          return attempt === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, dispute({ status: 'withdrawn', revision: 2 }));
        },
      });
      fireEvent.press(await screen.findByRole('button', { name: 'Withdraw this dispute' }));
      fireEvent.changeText(screen.getByLabelText('Reason for withdrawing'), 'Settled.');
      fireEvent.press(screen.getByRole('button', { name: 'Withdraw the dispute' }));
      expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
      expect(screen.queryByText(/You withdrew this dispute/)).toBeNull();
      // The reason is kept for the retry.
      expect(screen.getByLabelText('Reason for withdrawing').props.value).toBe('Settled.');
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await screen.findByText('You withdrew this dispute. The league no longer reviews it.'),
      ).toBeOnTheScreen();
      const keys = app.keysOf('POST', '/disputes/{id}/withdraw');
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(app.bodiesOf('POST', '/disputes/{id}/withdraw')).toEqual([
        { reason: 'Settled.', expectedRevision: 1 },
        { reason: 'Settled.', expectedRevision: 1 },
      ]);
      await app.settle();
    });

    it('a decided dispute offers no withdrawal', async () => {
      renderDispute({
        'GET /fixtures/{id}/disputes': {
          status: 200,
          body: [dispute({ status: 'decided', decision: 'upheld' })],
        },
      });
      expect(await screen.findByLabelText('Dispute upheld')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Withdraw this dispute' })).toBeNull();
    });

    it('a dispute decided meanwhile (INVALID_TRANSITION) reloads the list', async () => {
      const app = renderDispute({
        ...open(),
        'POST /disputes/{id}/withdraw': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', { nextAction: 'reload_current_state' }),
          ),
      });
      fireEvent.press(await screen.findByRole('button', { name: 'Withdraw this dispute' }));
      fireEvent.changeText(screen.getByLabelText('Reason for withdrawing'), 'Settled.');
      fireEvent.press(screen.getByRole('button', { name: 'Withdraw the dispute' }));
      expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
      expect(screen.getByText(/Error code: INVALID_TRANSITION/)).toBeOnTheScreen();
      const reads = app.requestsTo('GET', '/fixtures/{id}/disputes').length;
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
      // Wait for the read the reload sends, not only for the button the reset brings back.
      await waitFor(() =>
        expect(app.requestsTo('GET', '/fixtures/{id}/disputes').length).toBeGreaterThan(reads),
      );
      expect(
        await screen.findByRole('button', { name: 'Withdraw this dispute' }),
      ).toBeOnTheScreen();
      await app.settle();
    });

    it('a refused withdrawal is "not available"', async () => {
      renderDispute({
        ...open(),
        'POST /disputes/{id}/withdraw': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      });
      fireEvent.press(await screen.findByRole('button', { name: 'Withdraw this dispute' }));
      fireEvent.changeText(screen.getByLabelText('Reason for withdrawing'), 'Settled.');
      fireEvent.press(screen.getByRole('button', { name: 'Withdraw the dispute' }));
      expect(
        await screen.findByText('Withdrawing this dispute is not available to you.'),
      ).toBeOnTheScreen();
      expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    });

    it('offline: withdrawing is disabled', async () => {
      const app = renderDispute(open());
      expect(
        await screen.findByRole('button', { name: 'Withdraw this dispute' }),
      ).toBeOnTheScreen();
      act(() => app.sources.setReachable(false));
      expect(screen.getByRole('button', { name: 'Withdraw this dispute' })).toBeDisabled();
    });
  });
});
