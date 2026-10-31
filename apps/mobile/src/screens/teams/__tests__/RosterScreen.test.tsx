/**
 * SCR-C-23 Roster and invitations (SPK-IAM-004, SPK-CAP-001, SPK-CAP-002, SPK-COMP-005): roster
 * history with effective dates, invitations per recipient with their own idempotency keys
 * (partial completion), sharing the link once, revoking, join request decisions, handing over the
 * captain or co-captain role (CMP-13), tools offered only when the API lists them (CMP-02), and
 * the permission, stale and offline states.
 */
import { DEFAULT_TIMEOUT_MS } from '@sportspark/api-client';
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import {
  CAPTAIN_ACTIONS,
  IDS,
  ROSTER,
  baseRoutes,
  invitation,
  member,
  playerWorkspace,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { WITHHELD_REVOKE_REASON } from '../../../features/teams/InvitationIssued';
import {
  createTeamsTestApp,
  dropAnswers,
  withholdAnswers,
} from '../../../features/teams/testing/teams-test-app';
import { REVOKE_REASON, RosterScreen } from '../RosterScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const roster = {
  teamEntryId: IDS.entry,
  at: '2026-10-24T12:00:00.000Z',
  members: [
    ...ROSTER,
    member({
      personId: IDS.formerPlayer,
      displayName: 'Former Fran',
      status: 'removed',
      statusBeforeRemoval: 'active',
      effectiveFrom: '2026-09-02T12:00:00.000Z',
      effectiveTo: '2026-10-01T12:00:00.000Z',
      removedAt: '2026-10-01T12:00:00.000Z',
      removalReason: 'Moved away',
      eligibility: null,
    }),
  ],
};

const issued = (overrides = {}) => ({
  ...invitation({ id: '0192f1a0-0000-7000-8000-000000000555', ...overrides }),
  token: 'tok_abcdefghijklmnopqrstuvwxyz',
  eligibilityPreview: null,
});

function routes(overrides = {}) {
  return baseRoutes({
    'GET /team-entries/{id}/roster': { status: 200, body: roster },
    ...overrides,
  });
}

function renderRoster(options: Parameters<typeof createTeamsTestApp>[0] = {}) {
  const app = createTeamsTestApp({ routes: routes(), ...options });
  render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-23 RosterScreen', () => {
  it('SPK-COMP-005: shows the roster with effective dates, pending rows and kept history', async () => {
    const app = renderRoster();
    const history = await screen.findByTestId('roster-history');
    expect(
      within(history).getByLabelText('Player from Sep 2, 2026 to Oct 1, 2026'),
    ).toBeOnTheScreen();
    expect(within(history).getByText('Reason: Moved away')).toBeOnTheScreen();
    const current = screen.getByTestId('roster-current');
    expect(within(current).getByText('Casey Captain')).toBeOnTheScreen();
    expect(within(current).getByText('Jersey 9. Eligible')).toBeOnTheScreen();
    // SPK-CAP-002: eligibility is a reason code in words, never the private detail behind it.
    expect(within(current).getByText('Not eligible: suspended')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('roster-waiting')).getByText('Riley Requester'),
    ).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/team-entries/{id}/roster')[0]?.query).toEqual({
      includeHistory: 'true',
    });
  });

  it('SPK-UX-009: roster completeness is stated in words, not by colour or glyph alone', async () => {
    renderRoster();
    expect(
      await screen.findByLabelText(
        /^Roster (not )?complete: \d+ on the roster \(minimum \d+, maximum \d+\)$/,
      ),
    ).toBeOnTheScreen();
  });

  it('SPK-IAM-004: invites several recipients, each with its own key and outcome (partial completion)', async () => {
    let calls = 0;
    const app = renderRoster({
      routes: routes({
        'POST /team-entries/{id}/invitations': (req: FakeRequest) => {
          calls += 1;
          const body = req.body as { recipientContact: { value: string } };
          if (body.recipientContact.value === 'bad@example.test' && calls < 4) {
            return fakeResponse(
              400,
              apiErrorBody('VALIDATION_FAILED', {
                message: 'Request validation failed.',
                nextAction: 'correct_input',
                details: [
                  { path: 'recipientContact.value', message: 'Not deliverable', code: 'custom' },
                ],
              }),
            );
          }
          return fakeResponse(
            201,
            issued({ recipientContact: { kind: 'email', value: body.recipientContact.value } }),
          );
        },
      }),
    });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Add another recipient' }));
    fireEvent.changeText(screen.getByLabelText('Recipient 2: email address'), 'bad@example.test');
    fireEvent.changeText(screen.getByLabelText('Message (optional)'), 'Join us for Fall!');
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send 2 invitations' }));
    });

    expect(await screen.findByText('Invitation for sam@example.test.')).toBeOnTheScreen();
    expect(
      screen.getByTestId('invitation-issued-0192f1a0-0000-7000-8000-000000000555'),
    ).toBeOnTheScreen();
    const failure = screen.getByTestId('recipient-2-failure');
    expect(
      within(failure).getByText('▲ recipientContact.value: Not deliverable'),
    ).toBeOnTheScreen();
    expect(within(failure).getByText(/Error code: VALIDATION_FAILED/)).toBeOnTheScreen();

    const bodies = app.bodiesOf('POST', '/team-entries/{id}/invitations');
    expect(bodies[0]).toEqual({
      recipientContact: { kind: 'email', value: 'sam@example.test' },
      message: 'Join us for Fall!',
    });
    // POL-044 is pending: the app never sends its own expiry.
    expect(bodies[0]).not.toHaveProperty('expiresInHours');
    const [first, second] = app.keysOf('POST', '/team-entries/{id}/invitations');
    expect(first).not.toEqual(second);

    // Sending again only retries the failed recipient. VALIDATION_FAILED is a definitive answer the
    // API stores under the key and would replay, so the retry is that recipient's new intent (§4.9).
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    const keys = app.keysOf('POST', '/team-entries/{id}/invitations');
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(second);
    expect(keys[2]).not.toBe(first);
    expect(app.bodiesOf('POST', '/team-entries/{id}/invitations')[2]).toEqual(bodies[1]);
    await app.settle();
  });

  it('shares a sent invitation link once, through the native share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderRoster({
      routes: routes({ 'POST /team-entries/{id}/invitations': { status: 201, body: issued() } }),
    });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    const shareButton = await screen.findByRole('button', {
      name: 'Share the invitation for sam@example.test',
    });
    await act(async () => {
      fireEvent.press(shareButton);
    });
    const message = share.mock.calls[0]?.[0] as { message: string };
    expect(message.message).toContain(
      'sportspark://link?to=team-invitation&id=0192f1a0-0000-7000-8000-000000000555&token=tok_abcdefghijklmnopqrstuvwxyz',
    );
    // The token is never shown as text on screen.
    expect(screen.queryByText(/tok_abcdefghijklmnopqrstuvwxyz/)).toBeNull();
    share.mockRestore();
  });

  it('§4.14: an invitation created but whose link was lost is shown as created, then revoked and issued again under a new key', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const created = '0192f1a0-0000-7000-8000-000000000555';
    let posts = 0;
    const app = createTeamsTestApp({
      routes: routes({
        'POST /team-entries/{id}/invitations': () => {
          posts += 1;
          // The first answer is lost; "Check again" under the same key finds it created.
          if (posts <= 2) {
            return fakeResponse(
              409,
              apiErrorBody('IDEMPOTENCY_SECRET_WITHHELD', {
                message: 'This request already succeeded.',
                nextAction: 'revoke_and_reissue',
                correlationId: 'corr-w1',
                details: { resourceId: created },
              }),
            );
          }
          return fakeResponse(201, issued({ id: '0192f1a0-0000-7000-8000-000000000556' }));
        },
        'POST /team-invitations/{id}/revoke': {
          status: 200,
          body: invitation({ id: created, status: 'revoked' }),
        },
      }),
    });
    dropAnswers(app, 'POST', /\/team-entries\/[^/]+\/invitations$/);
    render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    expect(
      await screen.findByLabelText('No answer yet: this may already have been recorded'),
    ).toBeOnTheScreen();
    await app.settle();
    const reads = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    const withheld = await screen.findByTestId('recipient-1-withheld');
    expect(
      within(withheld).getByLabelText('Created, but the link cannot be shown again'),
    ).toBeOnTheScreen();
    expect(
      within(withheld).getByText('Error code: IDEMPOTENCY_SECRET_WITHHELD. Reference: corr-w1'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Not done')).toBeNull();
    // Nothing is sent again beside the created invitation, and the open invitations are re-read.
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
    await waitFor(() =>
      expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads),
    );
    await act(async () => {
      fireEvent.press(
        within(withheld).getByRole('button', { name: 'Revoke and issue a new link' }),
      );
    });
    const shareButton = await screen.findByRole('button', {
      name: 'Share the invitation for sam@example.test',
    });
    expect(app.requestsTo('POST', '/team-invitations/{id}/revoke')[0]?.path).toBe(
      `/team-invitations/${created}/revoke`,
    );
    expect(app.bodiesOf('POST', '/team-invitations/{id}/revoke')).toEqual([
      { reason: WITHHELD_REVOKE_REASON },
    ]);
    const keys = app.keysOf('POST', '/team-entries/{id}/invitations');
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    await act(async () => {
      fireEvent.press(shareButton);
    });
    expect((share.mock.calls[0]?.[0] as { message: string }).message).toContain(
      'id=0192f1a0-0000-7000-8000-000000000556&token=tok_abcdefghijklmnopqrstuvwxyz',
    );
    share.mockRestore();
    await app.settle();
  });

  it('§4.14: an invitation whose link was lost but that was accepted meanwhile is not issued again', async () => {
    const created = '0192f1a0-0000-7000-8000-000000000555';
    const app = createTeamsTestApp({
      routes: routes({
        'POST /team-entries/{id}/invitations': () =>
          fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_SECRET_WITHHELD', {
              nextAction: 'revoke_and_reissue',
              details: { resourceId: created },
            }),
          ),
        'POST /team-invitations/{id}/revoke': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', {
              nextAction: 'reload_current_state',
              details: { machine: 'TeamInvitation', from: 'accepted', event: 'revoke' },
            }),
          ),
      }),
    });
    dropAnswers(app, 'POST', /\/team-entries\/[^/]+\/invitations$/);
    render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    await act(async () => {
      fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    });
    const withheld = await screen.findByTestId('recipient-1-withheld');
    await act(async () => {
      fireEvent.press(
        within(withheld).getByRole('button', { name: 'Revoke and issue a new link' }),
      );
    });
    // "Open invitations" lists only pending ones: an accepted invitation is on the roster.
    expect(
      await within(withheld).findByText(
        'It can no longer be revoked: it was accepted already. It is shown under "Roster" below. Nothing new was created.',
      ),
    ).toBeOnTheScreen();
    expect(within(withheld).queryByText(/under "Open invitations"/)).toBeNull();
    expect(app.requestsTo('POST', '/team-entries/{id}/invitations')).toHaveLength(2);
    await app.settle();
  });

  it('§4.14: an invitation whose link was lost but that was declined meanwhile no longer appears among the open invitations', async () => {
    const created = '0192f1a0-0000-7000-8000-000000000555';
    const app = createTeamsTestApp({
      routes: routes({
        'POST /team-entries/{id}/invitations': () =>
          fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_SECRET_WITHHELD', {
              nextAction: 'revoke_and_reissue',
              details: { resourceId: created },
            }),
          ),
        'POST /team-invitations/{id}/revoke': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', {
              nextAction: 'reload_current_state',
              details: { machine: 'TeamInvitation', from: 'declined', event: 'revoke' },
            }),
          ),
      }),
    });
    render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    const withheld = await screen.findByTestId('recipient-1-withheld');
    await act(async () => {
      fireEvent.press(
        within(withheld).getByRole('button', { name: 'Revoke and issue a new link' }),
      );
    });
    expect(
      await within(withheld).findByText(
        'It can no longer be revoked: it was declined already. It no longer appears under "Open invitations". Nothing new was created.',
      ),
    ).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/team-entries/{id}/invitations')).toHaveLength(1);
    await app.settle();
  });

  it('§4.14: when the API cannot name the created invitation, the captain is told it is listed under "Open invitations" only while still open', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'POST /team-entries/{id}/invitations': () =>
          fakeResponse(
            409,
            apiErrorBody('IDEMPOTENCY_SECRET_WITHHELD', {
              nextAction: 'revoke_and_reissue',
              details: { resourceId: null },
            }),
          ),
      }),
    });
    render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    const withheld = await screen.findByTestId('recipient-1-withheld');
    expect(
      within(withheld).getByText(
        'If it is still open, it is listed under "Open invitations": revoke it there. Once it is accepted or declined it no longer appears there. Then create a new one.',
      ),
    ).toBeOnTheScreen();
    expect(
      within(withheld).queryByRole('button', { name: 'Revoke and issue a new link' }),
    ).toBeNull();
    await app.settle();
  });

  it('§4.9 IDEMPOTENCY_OUTCOME_UNAVAILABLE: a same-key retry that finds the first attempt committed is "This may already have been done"; "Send" skips the recipient until "Start a new one"', async () => {
    let posts = 0;
    const app = createTeamsTestApp({
      routes: routes({
        'POST /team-entries/{id}/invitations': () => {
          posts += 1;
          if (posts === 2) {
            return fakeResponse(
              409,
              apiErrorBody('IDEMPOTENCY_OUTCOME_UNAVAILABLE', {
                nextAction: 'reload_current_state',
                correlationId: 'corr-l1',
              }),
            );
          }
          return fakeResponse(201, issued());
        },
      }),
    });
    dropAnswers(app, 'POST', /\/team-entries\/[^/]+\/invitations$/);
    render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    await app.settle();
    const reads = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(await screen.findByRole('button', { name: 'Check again' }));
    });
    const lost = await screen.findByTestId('recipient-1-withheld');
    expect(within(lost).getByLabelText('This may already have been done')).toBeOnTheScreen();
    expect(
      within(lost).getByText('Error code: IDEMPOTENCY_OUTCOME_UNAVAILABLE. Reference: corr-l1'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Not done')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
    await waitFor(() =>
      expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads),
    );
    const afterAnswer = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(within(lost).getByRole('button', { name: 'Reload' }));
    });
    await waitFor(() =>
      expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(afterAnswer),
    );
    expect(app.requestsTo('POST', '/team-entries/{id}/invitations')).toHaveLength(2);
    await act(async () => {
      fireEvent.press(within(lost).getByRole('button', { name: 'Start a new one' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    expect(
      await screen.findByRole('button', { name: 'Share the invitation for sam@example.test' }),
    ).toBeOnTheScreen();
    const keys = app.keysOf('POST', '/team-entries/{id}/invitations');
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    await app.settle();
  });

  it('checks the recipient before sending and keeps the draft', async () => {
    const app = renderRoster();
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'not-an-email',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByLabelText(
        'Recipient 1: email address. Enter an email address like name@example.com.',
      ),
    ).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/team-entries/{id}/invitations')).toHaveLength(0);
  });

  it('revokes an open invitation with a reason; an already answered one asks to reload', async () => {
    const app = renderRoster({
      routes: routes({
        'POST /team-invitations/{id}/revoke': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', {
              message: 'TeamInvitation cannot revoke from accepted.',
              nextAction: 'reload_current_state',
            }),
          ),
      }),
    });
    fireEvent.press(
      await screen.findByRole('button', { name: 'Revoke the invitation for sam@example.test' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Revoke invitation' }));
    });
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-invitations/{id}/revoke')[0]).toEqual({
      reason: REVOKE_REASON,
    });
    const reads = app.requestsTo('GET', '/team-entries/{id}').length;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    });
    expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads);
    await app.settle();
  });

  it('SPK-CAP-001: approving a join request shows the API eligibility reasons when it is refused', async () => {
    const app = renderRoster({
      routes: routes({
        'POST /join-requests/{id}/decide': () =>
          fakeResponse(
            422,
            apiErrorBody('ELIGIBILITY_FAILED', {
              message: 'The player is not eligible for this roster.',
              nextAction: 'review_eligibility_reasons',
              details: {
                reasons: [
                  {
                    code: 'multi_team_limit',
                    severity: 'blocking',
                    message: 'The person is already on 2 teams this season.',
                    source: { type: 'rule_set', id: IDS.ruleSet },
                    responsibleRole: 'league_manager',
                    requiredAction: 'Leave another team first.',
                  },
                ],
              },
            }),
          ),
      }),
    });
    const approve = await screen.findByRole('button', { name: 'Approve Riley Requester' });
    await act(async () => {
      fireEvent.press(approve);
    });
    expect(
      await screen.findByText('The person is already on 2 teams this season.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('League manager: Leave another team first.')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/join-requests/{id}/decide')[0]).toEqual({
      decision: 'approve',
      expectedRevision: 1,
    });
  });

  it('SPK-CAP-002: a player who is not the captain sees roster management as not available', async () => {
    const app = renderRoster({
      routes: routes({ 'GET /team-entries/{id}': { status: 200, body: playerWorkspace() } }),
    });
    expect(
      await screen.findByText(
        'Managing the roster is not available to you for this team. Your captain manages it.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('invite-form')).toBeNull();
    expect(app.requestsTo('GET', '/team-entries/{id}/roster')).toHaveLength(0);
  });

  it('SPK-UX-008: when GET /me fails, a captain sees its code and Try again, never "not available to you"', async () => {
    renderRoster({
      routes: routes({
        'GET /me': () =>
          fakeResponse(
            500,
            apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
          ),
      }),
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByText(/Your captain manages it/)).toBeNull();
  });

  it('a refused invitation (ACCESS_DENIED) is shown as not available', async () => {
    renderRoster({
      routes: routes({
        'POST /team-entries/{id}/invitations': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
          ),
      }),
    });
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Send invitation' }));
    });
    expect(
      await screen.findByText('Inviting players is not available to you for this team.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('offline: inviting is disabled with an explanation and the draft is kept', async () => {
    const app = renderRoster();
    fireEvent.changeText(
      await screen.findByLabelText('Recipient 1: email address'),
      'sam@example.test',
    );
    act(() => app.sources.setReachable(false));
    expect(
      screen.getByText(
        'Inviting players needs a connection. Nothing is queued: your entries are kept on this screen.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
    expect(screen.getByLabelText('Recipient 1: email address').props.value).toBe(
      'sam@example.test',
    );
  });

  it('CMP-02: tools the API does not list for this viewer are not offered', async () => {
    renderRoster({
      routes: routes({
        'GET /team-entries/{id}': {
          status: 200,
          body: workspace({
            viewer: { roles: ['co_captain'], actingAsCaptain: false, availableActions: [] },
          }),
        },
      }),
    });
    expect(
      await screen.findByText('Inviting players is not available for this team now.'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('invite-form')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revoke the invitation/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve Riley Requester' })).toBeNull();
    expect(screen.queryByTestId('leaders')).toBeNull();
    // The management lists the API filled stay readable.
    expect(screen.getByText('sam@example.test')).toBeOnTheScreen();
  });

  describe('role handover (CMP-13, SPK-COMP-005)', () => {
    const handover = (overrides = {}) => ({
      teamEntryId: IDS.entry,
      role: 'captain',
      fromPersonId: IDS.me,
      toPersonId: IDS.player2,
      effectiveAt: '2026-10-24T12:00:00.000Z',
      roles: [],
      entryRevision: 5,
      ...overrides,
    });

    async function chooseCaptainToPat(reason = 'Moving away for the season') {
      const section = await screen.findByTestId('role-handover');
      fireEvent.press(within(section).getByRole('radio', { name: 'Captain, held by you' }));
      fireEvent.press(within(section).getByRole('radio', { name: 'Pat Player' }));
      fireEvent.changeText(within(section).getByLabelText('Reason'), reason);
      fireEvent.press(within(section).getByRole('button', { name: 'Review the handover' }));
      expect(
        within(section).getByText('Hand the captain role from you to Pat Player?'),
      ).toBeOnTheScreen();
      fireEvent.press(within(section).getByRole('button', { name: 'Hand over to Pat Player' }));
    }

    it('hands the captain role to an active roster member with the entry revision', async () => {
      mockRouter.replace.mockClear();
      const app = renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': { status: 200, body: handover() },
        }),
      });
      const section = await screen.findByTestId('role-handover');
      // Only active roster members now are offered; a pending request and the holder are not.
      expect(within(section).queryByRole('radio', { name: 'Riley Requester' })).toBeNull();
      fireEvent.press(within(section).getByRole('radio', { name: 'Captain, held by you' }));
      expect(within(section).queryByRole('radio', { name: 'Casey Captain' })).toBeNull();
      expect(within(section).getByRole('radio', { name: 'Kim Junior' })).toBeOnTheScreen();
      await chooseCaptainToPat();
      const done = await screen.findByTestId('handover-done');
      expect(
        within(done).getByLabelText(/^Pat Player is captain from Sat, Oct 24/),
      ).toBeOnTheScreen();
      expect(
        within(done).getByText(
          'You no longer hold the captain role. Earlier role records are kept as history.',
        ),
      ).toBeOnTheScreen();
      expect(app.bodiesOf('POST', '/team-entries/{id}/roles/handover')).toEqual([
        {
          role: 'captain',
          fromPersonId: IDS.me,
          toPersonId: IDS.player2,
          reason: 'Moving away for the season',
          expectedRevision: 4,
        },
      ]);
      expect(app.keysOf('POST', '/team-entries/{id}/roles/handover')[0]).toMatch(/^key-/);
      fireEvent.press(within(done).getByRole('button', { name: 'Show the team' }));
      expect(mockRouter.replace).toHaveBeenCalledWith(`/team/${IDS.entry}`);
      await app.settle();
    });

    it('asks for the role, the new holder and a reason before sending', async () => {
      const app = renderRoster();
      const section = await screen.findByTestId('role-handover');
      fireEvent.press(within(section).getByRole('button', { name: 'Review the handover' }));
      expect(within(section).getByText('▲ Choose the role to hand over.')).toBeOnTheScreen();
      expect(
        within(section).getByLabelText('Reason. Give the reason for the handover.'),
      ).toBeOnTheScreen();
      expect(app.requestsTo('POST', '/team-entries/{id}/roles/handover')).toHaveLength(0);
    });

    it('SPK-AT-013: a new holder the rule set refuses shows the API reasons and code', async () => {
      renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': () =>
            fakeResponse(
              422,
              apiErrorBody('ELIGIBILITY_FAILED', {
                message: 'The new holder is not eligible under the rule set.',
                nextAction: 'review_eligibility_reasons',
                details: {
                  personId: IDS.player2,
                  reasons: [
                    {
                      code: 'suspended',
                      severity: 'blocking',
                      message: 'The player is suspended.',
                      responsibleRole: 'league_manager',
                      requiredAction: 'Wait until the suspension is served.',
                    },
                  ],
                },
              }),
            ),
        }),
      });
      await chooseCaptainToPat();
      expect(await screen.findByText('The player is suspended.')).toBeOnTheScreen();
      expect(
        screen.getByText('League manager: Wait until the suspension is served.'),
      ).toBeOnTheScreen();
      expect(screen.getByText(/Error code: ELIGIBILITY_FAILED/)).toBeOnTheScreen();
    });

    it('§4.9: a changed entry (STALE_REVISION) reloads the workspace', async () => {
      const app = renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': () =>
            fakeResponse(
              409,
              apiErrorBody('STALE_REVISION', { nextAction: 'reload_current_state' }),
            ),
        }),
      });
      await chooseCaptainToPat();
      expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
      const reads = app.requestsTo('GET', '/team-entries/{id}').length;
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
      // Wait for the workspace read the reload sends ('role-handover' never leaves the screen).
      await waitFor(() =>
        expect(app.requestsTo('GET', '/team-entries/{id}').length).toBeGreaterThan(reads),
      );
      expect(screen.queryByLabelText('This changed since you opened it')).toBeNull();
      await app.settle();
    });

    it('CMP-13: a handover rule the API refuses (VALIDATION_FAILED) shows its message and both codes, with no retry', async () => {
      const app = renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': () =>
            fakeResponse(
              422,
              apiErrorBody('VALIDATION_FAILED', {
                message: 'A team captain must be an adult.',
                nextAction: 'correct_input',
                correlationId: 'corr-23',
                details: { code: 'CAPTAIN_MUST_BE_ADULT' },
              }),
            ),
        }),
      });
      const section = await screen.findByTestId('role-handover');
      fireEvent.press(within(section).getByRole('radio', { name: 'Captain, held by you' }));
      // The app does not pre-decide the adult-captain rule: a child roster member is offered.
      fireEvent.press(within(section).getByRole('radio', { name: 'Kim Junior' }));
      fireEvent.changeText(within(section).getByLabelText('Reason'), 'Stepping down');
      fireEvent.press(within(section).getByRole('button', { name: 'Review the handover' }));
      fireEvent.press(within(section).getByRole('button', { name: 'Hand over to Kim Junior' }));
      expect(await screen.findByText('A team captain must be an adult.')).toBeOnTheScreen();
      expect(
        screen.getByText(
          'Error code: VALIDATION_FAILED (CAPTAIN_MUST_BE_ADULT). Reference: corr-23',
        ),
      ).toBeOnTheScreen();
      expect(screen.getByLabelText('Not done')).toBeOnTheScreen();
      expect(screen.getByText('Review your entries')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.queryByTestId('handover-done')).toBeNull();
      expect(app.requestsTo('POST', '/team-entries/{id}/roles/handover')).toHaveLength(1);
    });

    it('§4.9: a failed handover is retried under the same idempotency key', async () => {
      let attempt = 0;
      const app = renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': () => {
            attempt += 1;
            return attempt === 1
              ? fakeResponse(
                  503,
                  apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
                )
              : fakeResponse(200, handover());
          },
        }),
      });
      await chooseCaptainToPat();
      expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
      expect(screen.queryByTestId('handover-done')).toBeNull();
      // A 5xx may come after part of the command committed: never "Not done" (§4.9).
      expect(
        screen.getByLabelText('No answer yet: this may already have been recorded'),
      ).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByTestId('handover-done')).toBeOnTheScreen();
      const keys = app.keysOf('POST', '/team-entries/{id}/roles/handover');
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(app.bodiesOf('POST', '/team-entries/{id}/roles/handover')[1]).toEqual(
        app.bodiesOf('POST', '/team-entries/{id}/roles/handover')[0],
      );
      await app.settle();
    });

    describe('an unknown outcome (no answer before the client gives up)', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      it('is never shown as done, and the retry reuses the same key', async () => {
        const app = createTeamsTestApp({
          routes: routes({
            'POST /team-entries/{id}/roles/handover': { status: 200, body: handover() },
          }),
        });
        withholdAnswers(app, 'POST', /\/roles\/handover$/);
        render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
        await chooseCaptainToPat();
        await waitFor(() =>
          expect(app.requestsTo('POST', '/team-entries/{id}/roles/handover')).toHaveLength(1),
        );
        await act(async () => {
          jest.advanceTimersByTime(DEFAULT_TIMEOUT_MS);
        });
        expect(
          await screen.findByLabelText('No answer yet: this may already have been recorded'),
        ).toBeOnTheScreen();
        expect(screen.getByText(/Error code: TIMEOUT/)).toBeOnTheScreen();
        expect(screen.queryByTestId('handover-done')).toBeNull();
        expect(screen.queryByLabelText(/is captain from/)).toBeNull();
        fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByTestId('handover-done')).toBeOnTheScreen();
        const [first, second] = app.keysOf('POST', '/team-entries/{id}/roles/handover');
        expect(second).toBe(first);
        await app.settle();
      });
    });

    it('SPK-UX-008: a connection lost after sending is "No answer yet", never "Not done", and is checked under the same key', async () => {
      const app = createTeamsTestApp({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': { status: 200, body: handover() },
        }),
      });
      dropAnswers(app, 'POST', /\/roles\/handover$/);
      render(<RosterScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      await chooseCaptainToPat();
      expect(
        await screen.findByLabelText('No answer yet: this may already have been recorded'),
      ).toBeOnTheScreen();
      expect(screen.getByText(/Error code: NETWORK_UNAVAILABLE/)).toBeOnTheScreen();
      expect(screen.queryByLabelText('Not done')).toBeNull();
      expect(screen.queryByTestId('handover-done')).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByTestId('handover-done')).toBeOnTheScreen();
      const [first, second] = app.keysOf('POST', '/team-entries/{id}/roles/handover');
      expect(second).toBe(first);
      await app.settle();
    });

    it('a refused handover is "not available"', async () => {
      renderRoster({
        routes: routes({
          'POST /team-entries/{id}/roles/handover': () =>
            fakeResponse(
              403,
              apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
            ),
        }),
      });
      await chooseCaptainToPat();
      expect(
        await screen.findByText('Handing over this role is not available to you.'),
      ).toBeOnTheScreen();
      expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
    });

    it('lists a co-captain role held by someone else, and offline disables the handover', async () => {
      const app = renderRoster({
        routes: routes({
          'GET /team-entries/{id}': {
            status: 200,
            body: workspace({
              roles: [
                ...workspace().roles,
                {
                  id: IDS.coCaptainRole,
                  teamEntryId: IDS.entry,
                  personId: IDS.player2,
                  role: 'co_captain',
                  effectiveFrom: '2026-09-01T12:00:00.000Z',
                  effectiveTo: null,
                },
              ],
              viewer: {
                roles: ['captain'],
                actingAsCaptain: true,
                availableActions: CAPTAIN_ACTIONS,
              },
            }),
          },
        }),
      });
      const section = await screen.findByTestId('role-handover');
      fireEvent.press(
        within(section).getByRole('radio', { name: 'Co-captain, held by Pat Player' }),
      );
      fireEvent.press(within(section).getByRole('radio', { name: 'Kim Junior' }));
      fireEvent.changeText(within(section).getByLabelText('Reason'), 'Rotation');
      fireEvent.press(within(section).getByRole('button', { name: 'Review the handover' }));
      act(() => app.sources.setReachable(false));
      expect(
        within(section).getByRole('button', { name: 'Hand over to Kim Junior' }),
      ).toBeDisabled();
      expect(
        within(section).getByLabelText('Handing over a role needs a connection'),
      ).toBeOnTheScreen();
    });
  });
});
