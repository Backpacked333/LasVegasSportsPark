/**
 * SCR-C-23 Roster and invitations (SPK-IAM-004, SPK-CAP-001, SPK-CAP-002, SPK-COMP-005): roster
 * history with effective dates, invitations per recipient with their own idempotency keys
 * (partial completion), sharing the link once, revoking, join request decisions, and the
 * permission, stale and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import {
  IDS,
  ROSTER,
  baseRoutes,
  invitation,
  member,
  playerWorkspace,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { REVOKE_REASON, RosterScreen } from '../RosterScreen';

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
});
