/**
 * SCR-C-27 Create or renew team entry (SPK-REG-001, SPK-COMP-001, SPK-CAP-005, SPK-AT-003): a new
 * team in an open season with no division chosen by the customer, renewal that leaves the prior
 * season untouched, charges nothing and suggests prior players for invitation, renewal offered
 * only when the API lists it for the viewer (CMP-02), the new entry listed on SCR-C-21, and the
 * empty, validation, refused and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  competition,
  division,
  invitation,
  season,
  team,
  teamEntry,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { WITHHELD_REVOKE_REASON } from '../../../features/teams/InvitationIssued';
import { createTeamsTestApp, dropAnswers } from '../../../features/teams/testing/teams-test-app';
import { TeamEntryScreen, divisionCriteriaText } from '../TeamEntryScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const prior = workspace({
  entry: teamEntry({ id: IDS.priorEntry, seasonId: IDS.priorSeason }),
  season: {
    id: IDS.priorSeason,
    name: 'Fall 2026',
    status: 'completed',
    startsOn: '2026-09-07',
    endsOn: '2026-12-13',
  },
});

const created = (overrides = {}) => ({
  entry: teamEntry({ id: IDS.newEntry, status: 'applied', divisionId: null }),
  team: team(),
  operationId: IDS.operation,
  renewedFromEntryId: null,
  suggestedPlayers: [],
  ...overrides,
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /seasons': { status: 200, body: [season()] },
    'GET /competitions': { status: 200, body: [competition()] },
    'GET /divisions': { status: 200, body: [division()] },
    ...overrides,
  };
}

function renderEntry(
  renewFrom: string | null | 'invalid',
  overrides: Record<string, FakeHandler> = {},
) {
  const app = createTeamsTestApp({ routes: routes(overrides) });
  render(<TeamEntryScreen renewFrom={renewFrom} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-27 TeamEntryScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-REG-001: creates a team entry in an open season; the division is the league’s to place', async () => {
    const app = renderEntry(null, {
      'POST /team-entries': { status: 201, body: created() },
    });
    fireEvent.changeText(await screen.findByLabelText('Team name'), '  Desert Foxes ');
    fireEvent.press(screen.getByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    expect(
      await screen.findByLabelText(
        'Coed Division 2: ages 18 and over, Recreational, Coed, 7v7. 5 of 8 team places taken',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByText(/it cannot be chosen in the app/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Create the team entry' }));
    });
    expect(await screen.findByLabelText('Team entry awaiting approval')).toBeOnTheScreen();
    expect(screen.getByText(/Nothing has been charged/)).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-entries')).toEqual([
      { seasonId: IDS.season, team: { name: 'Desert Foxes' } },
    ]);
    expect(app.requestsTo('GET', '/seasons')[0]?.query).toEqual({ status: 'open' });
    fireEvent.press(screen.getByRole('button', { name: 'Open the new team' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/${IDS.newEntry}`);
  });

  it('checks the team name and season before sending', async () => {
    const app = renderEntry(null);
    fireEvent.press(await screen.findByRole('button', { name: 'Create the team entry' }));
    expect(screen.getByLabelText('Team name. Enter the team name.')).toBeOnTheScreen();
    expect(screen.getByText('▲ Choose a season.')).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/team-entries')).toHaveLength(0);
  });

  it('a closed registration window is the API’s answer, and the draft is kept', async () => {
    renderEntry(null, {
      'POST /team-entries': () =>
        fakeResponse(
          422,
          apiErrorBody('ELIGIBILITY_FAILED', {
            message: 'The registration window for this season is closed.',
            nextAction: 'review_eligibility_reasons',
          }),
        ),
    });
    fireEvent.changeText(await screen.findByLabelText('Team name'), 'Desert Foxes');
    fireEvent.press(screen.getByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Create the team entry' }));
    });
    expect(
      await screen.findByText('The registration window for this season is closed.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Error code: ELIGIBILITY_FAILED/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Team name').props.value).toBe('Desert Foxes');
  });

  it('SPK-AT-003, SPK-CAP-005: renewal leaves the prior season untouched, charges nothing and suggests players to invite', async () => {
    const app = renderEntry(IDS.priorEntry, {
      'GET /team-entries/{id}': { status: 200, body: prior },
      'POST /team-entries': {
        status: 201,
        body: created({
          renewedFromEntryId: IDS.priorEntry,
          suggestedPlayers: [
            {
              personId: IDS.player2,
              displayName: 'Pat Player',
              lastStatus: 'active',
              lastEffectiveTo: '2026-12-13T12:00:00.000Z',
            },
          ],
        }),
      },
      'POST /team-entries/{id}/invitations': {
        status: 201,
        body: {
          ...invitation({
            teamEntryId: IDS.newEntry,
            recipientContact: null,
            recipientPersonId: IDS.player2,
          }),
          token: 'tok_renewal_abcdefghijklmnop',
          eligibilityPreview: null,
        },
      },
    });
    expect(await screen.findByLabelText('Team: Desert Foxes')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Team name')).toBeNull();
    fireEvent.press(screen.getByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Renew the team entry' }));
    });
    expect(
      await screen.findByText('Your Fall 2026 entry and its roster are unchanged.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/Nothing has been charged/)).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/team-entries')).toEqual([
      { seasonId: IDS.season, renewFromEntryId: IDS.priorEntry },
    ]);

    const suggestions = screen.getByTestId('suggested-players');
    expect(within(suggestions).getByText(/Nobody is added automatically/)).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(within(suggestions).getByRole('button', { name: 'Invite Pat Player' }));
    });
    expect(await screen.findByText('Invitation for Pat Player.')).toBeOnTheScreen();
    const invite = app.requestsTo('POST', '/team-entries/{id}/invitations')[0];
    expect(invite?.params.id).toBe(IDS.newEntry);
    expect(invite?.body).toEqual({ recipientPersonId: IDS.player2 });
    // Nothing was written to the prior entry.
    expect(
      app.fake.requests.filter((r) => r.method !== 'GET' && r.path.includes(IDS.priorEntry)),
    ).toHaveLength(0);
    await app.settle();
  });

  it('§4.14: a suggested player whose invitation link was lost is not invited twice; it is revoked and issued again', async () => {
    const lost = '0192f1a0-0000-7000-8000-000000000777';
    let posts = 0;
    const app = createTeamsTestApp({
      routes: routes({
        'GET /team-entries/{id}': { status: 200, body: prior },
        'POST /team-entries': {
          status: 201,
          body: created({
            renewedFromEntryId: IDS.priorEntry,
            suggestedPlayers: [
              {
                personId: IDS.player2,
                displayName: 'Pat Player',
                lastStatus: 'active',
                lastEffectiveTo: '2026-12-13T12:00:00.000Z',
              },
            ],
          }),
        },
        'POST /team-entries/{id}/invitations': () => {
          posts += 1;
          return posts <= 2
            ? fakeResponse(
                409,
                apiErrorBody('IDEMPOTENCY_SECRET_WITHHELD', {
                  nextAction: 'revoke_and_reissue',
                  details: { resourceId: lost },
                }),
              )
            : fakeResponse(201, {
                ...invitation({
                  teamEntryId: IDS.newEntry,
                  recipientContact: null,
                  recipientPersonId: IDS.player2,
                }),
                token: 'tok_renewal_abcdefghijklmnop',
                eligibilityPreview: null,
              });
        },
        'POST /team-invitations/{id}/revoke': {
          status: 200,
          body: invitation({ id: lost, status: 'revoked' }),
        },
      }),
    });
    dropAnswers(app, 'POST', /\/team-entries\/[^/]+\/invitations$/);
    render(<TeamEntryScreen renewFrom={IDS.priorEntry} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Team: Desert Foxes')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Renew the team entry' }));
    });
    const suggestions = await screen.findByTestId('suggested-players');
    await act(async () => {
      fireEvent.press(within(suggestions).getByRole('button', { name: 'Invite Pat Player' }));
    });
    expect(
      await within(suggestions).findByLabelText(
        'No answer yet: this may already have been recorded',
      ),
    ).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(within(suggestions).getByRole('button', { name: 'Check again' }));
    });
    expect(
      await within(suggestions).findByLabelText('Created, but the link cannot be shown again'),
    ).toBeOnTheScreen();
    // "Invite" is not offered beside the invitation that was created.
    expect(within(suggestions).queryByRole('button', { name: 'Invite Pat Player' })).toBeNull();
    await act(async () => {
      fireEvent.press(
        within(suggestions).getByRole('button', { name: 'Revoke and issue a new link' }),
      );
    });
    expect(await screen.findByText('Invitation for Pat Player.')).toBeOnTheScreen();
    expect(app.requestsTo('POST', '/team-invitations/{id}/revoke')[0]?.params.id).toBe(lost);
    expect(app.bodiesOf('POST', '/team-invitations/{id}/revoke')).toEqual([
      { reason: WITHHELD_REVOKE_REASON },
    ]);
    const keys = app.keysOf('POST', '/team-entries/{id}/invitations');
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    await app.settle();
  });

  it('§4.10: a prior entry answered NOT_FOUND is generically not available, implying no team or captain', async () => {
    renderEntry(IDS.priorEntry, {
      'GET /team-entries/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/captain/i)).toBeNull();
  });

  it('a renewal the API refuses (ACCESS_DENIED) is not available, without the error code', async () => {
    renderEntry(IDS.priorEntry, {
      'GET /team-entries/{id}': { status: 200, body: prior },
      'POST /team-entries': () =>
        fakeResponse(
          403,
          apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
        ),
    });
    fireEvent.press(await screen.findByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Renew the team entry' }));
    });
    expect(
      await screen.findByText(
        'Renewing this team is not available to you. Only a captain of the prior entry can renew it.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('CMP-02: renewal is not offered when the prior entry’s workspace does not list it', async () => {
    const app = renderEntry(IDS.priorEntry, {
      'GET /team-entries/{id}': {
        status: 200,
        body: {
          ...prior,
          // A roster player: no management lists, no workspace action.
          pendingInvitations: null,
          pendingJoinRequests: null,
          viewer: { roles: ['member'], actingAsCaptain: false, availableActions: [] },
        },
      },
    });
    expect(
      await screen.findByText(
        'Renewing this team is not available to you. Only a captain of the prior entry can renew it.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Renew the team entry' })).toBeNull();
    expect(app.requestsTo('GET', '/seasons')).toHaveLength(0);
  });

  it('CMP-02: a captain whose entry the API does not list renewal for is given no invented reason', async () => {
    // The captain of an entry still awaiting approval: the API lists renewal for approved entries
    // only and says nothing about why, so the app names no reason either.
    const app = renderEntry(IDS.priorEntry, {
      'GET /team-entries/{id}': {
        status: 200,
        body: {
          ...prior,
          entry: teamEntry({ id: IDS.priorEntry, seasonId: IDS.priorSeason, status: 'applied' }),
          viewer: {
            roles: ['captain'],
            actingAsCaptain: true,
            availableActions: ['competition.manage_team', 'competition.invite_player'],
          },
        },
      },
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(
      screen.getByText('Renewing this team is not available for this team now.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Only a captain/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew the team entry' })).toBeNull();
    expect(app.requestsTo('GET', '/seasons')).toHaveLength(0);
  });

  it('SCR-C-21: a created entry refreshes the person’s team list', async () => {
    const app = renderEntry(null, {
      'POST /team-entries': { status: 201, body: created() },
      'GET /me/team-entries': { status: 200, body: [] },
    });
    // The Teams list was read before (cached); creating an entry invalidates it.
    await app.queryClient.fetchQuery({
      queryKey: ['api', '/me/team-entries', null, null],
      queryFn: () => [],
    });
    fireEvent.changeText(await screen.findByLabelText('Team name'), 'Desert Foxes');
    fireEvent.press(screen.getByRole('radio', { name: /^Adult Coed League: Winter 2027/ }));
    fireEvent.press(screen.getByRole('button', { name: 'Create the team entry' }));
    expect(await screen.findByLabelText('Team entry awaiting approval')).toBeOnTheScreen();
    expect(
      app.queryClient.getQueryState(['api', '/me/team-entries', null, null])?.isInvalidated,
    ).toBe(true);
  });

  it('empty: no season is open for team entries', async () => {
    renderEntry(null, { 'GET /seasons': { status: 200, body: [] } });
    expect(
      await screen.findByRole('header', { name: 'No season open for team entries' }),
    ).toBeOnTheScreen();
  });

  it('a malformed renewal link shows "No prior team to renew"', async () => {
    const app = renderEntry('invalid');
    expect(await screen.findByRole('header', { name: 'No prior team to renew' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Create a new team entry' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/team/new');
    expect(app.requestsTo('GET', '/team-entries/{id}')).toHaveLength(0);
  });

  it('offline: the draft is kept and the entry cannot be sent', async () => {
    const app = renderEntry(null);
    fireEvent.changeText(await screen.findByLabelText('Team name'), 'Desert Foxes');
    act(() => app.sources.setReachable(false));
    expect(screen.getByRole('button', { name: 'Create the team entry' })).toBeDisabled();
    expect(screen.getByLabelText('Team name').props.value).toBe('Desert Foxes');
  });

  it('describes division criteria and capacity from the API', () => {
    expect(divisionCriteriaText(division({ capacityTeamEntries: null, entryCount: 3 }))).toBe(
      'ages 18 and over, Recreational, Coed, 7v7. 3 teams entered',
    );
  });
});
