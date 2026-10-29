/**
 * SCR-C-21 Teams (SPK-UX-002, SPK-CAP-001, SPK-CAP-002, CMP-02, CMP-03): the person's teams from
 * `GET /v1/me/team-entries` with family members, next game in the facility's zone, standing and
 * readiness; open team invitations from `GET /v1/me/team-invitations`, each opening its detail and
 * declinable here with its revision; empty, error, not-available, offline and signed-out states.
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  baseRoutes,
  myTeamEntry,
  standings,
  teamInvitationView,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { TeamsScreen, memberRoleWords, membersText, readinessStatus } from '../TeamsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const kim = {
  personId: IDS.child,
  canonicalPersonId: IDS.child,
  displayName: 'Kim Junior',
  givenName: 'Kim',
  familyName: 'Junior',
  kind: 'child' as const,
};

const routes = (overrides = {}) =>
  baseRoutes({
    'GET /me/team-entries': {
      status: 200,
      body: [
        myTeamEntry({
          members: [
            { personId: IDS.child, roles: [], rosterStatus: 'active' },
            { personId: IDS.me, roles: ['captain'], rosterStatus: 'active' },
          ],
        }),
      ],
    },
    'GET /person-names': { status: 200, body: { items: [kim] } },
    'GET /seasons/{id}/standings': { status: 200, body: standings() },
    'GET /me/team-invitations': { status: 200, body: { items: [], nextCursor: null } },
    ...overrides,
  });

function renderTeams(overrides = {}, options: Parameters<typeof createTeamsTestApp>[0] = {}) {
  const app = createTeamsTestApp({ routes: routes(overrides), ...options });
  render(<TeamsScreen />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-21 TeamsScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-CAP-001, CMP-02: lists the person’s teams with family, next game, standing and readiness', async () => {
    const app = renderTeams();
    const row = await screen.findByRole('button', {
      name: /^Desert Foxes, Fall 2026, Coed Division 2\. On the team: You \(captain\), Kim \(player\)\. Next: vs Canyon Hawks, Sat, Oct 31, 10:00\sAM PDT at Las Vegas Sports Park\. Standing: 2nd of 2, Next game: 1 issue to resolve$/,
    });
    expect(screen.getByLabelText('Your teams')).toBeOnTheScreen();
    expect(screen.getByLabelText('Next game: 1 issue to resolve')).toBeOnTheScreen();
    // §4.14: family members are named through the names read only, never by a route.
    expect(app.requestsTo('GET', '/person-names')[0]?.query).toEqual({ ids: IDS.child });
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/${IDS.entry}`);
    // The stopgap of teams opened in this session is gone: no workspace read is needed here.
    expect(app.requestsTo('GET', '/team-entries/{id}')).toHaveLength(0);
    await app.settle();
  });

  it('SPK-COMP-004: approval stays distinct from the next game’s readiness', async () => {
    const applied = { ...myTeamEntry().teamEntry, id: IDS.newEntry, status: 'applied' as const };
    const app = renderTeams({
      'GET /me/team-entries': {
        status: 200,
        body: [
          myTeamEntry({ teamEntry: applied }),
          myTeamEntry({
            teamEntry: { ...applied, id: IDS.priorEntry },
            teamName: 'Mesa Owls',
            nextFixture: null,
          }),
        ],
      },
    });
    expect(
      await screen.findByRole('button', {
        name: /^Desert Foxes, .*Standing: .*\. Team entry awaiting approval, Next game: 1 issue to resolve$/,
      }),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', {
        name: /^Mesa Owls, .*No upcoming games\. Standing: [^.]*, Team entry awaiting approval$/,
      }),
    ).toBeOnTheScreen();
    await app.settle();
  });

  it('readiness and roles in words, never colour alone', () => {
    expect(readinessStatus({ status: 'ready', blockingCount: 0, unknownCount: 0 })).toEqual({
      tone: 'success',
      label: 'Next game: ready',
    });
    expect(readinessStatus({ status: 'unknown', blockingCount: 0, unknownCount: 2 }).label).toBe(
      'Next game: readiness not known yet (2 items to confirm)',
    );
    expect(readinessStatus({ status: 'blocked', blockingCount: 2, unknownCount: 0 }).label).toBe(
      'Next game: 2 issues to resolve',
    );
    expect(memberRoleWords({ roles: ['co_captain'], rosterStatus: 'active' })).toBe('co-captain');
    expect(memberRoleWords({ roles: [], rosterStatus: 'substitute' })).toBe('substitute');
    expect(memberRoleWords({ roles: [], rosterStatus: null })).toBe('team member');
    expect(
      membersText(
        [{ personId: IDS.child, roles: [], rosterStatus: 'guest' }],
        IDS.me,
        new Map([[IDS.child, { state: 'unavailable' }]]),
      ),
    ).toBe('On the team: Family member (guest player)');
  });

  it('empty: explains joining and creating, and the create entry point opens SCR-C-27', async () => {
    renderTeams({ 'GET /me/team-entries': { status: 200, body: [] } });
    expect(await screen.findByRole('header', { name: 'No teams to show' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'No open team invitations' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Create a team entry' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/team/new');
  });

  it('shows the API error code on a failed list with "Try again"', async () => {
    let attempt = 0;
    const app = renderTeams({
      'GET /me/team-entries': () => {
        attempt += 1;
        return attempt === 1
          ? fakeResponse(
              503,
              apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
            )
          : fakeResponse(200, [myTeamEntry()]);
      },
    });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Desert Foxes, / })).toBeOnTheScreen();
    await app.settle();
  });

  it('offline: the cached list stays with its age and declining is disabled', async () => {
    const app = renderTeams({
      'GET /me/team-invitations': {
        status: 200,
        body: { items: [teamInvitationView()], nextCursor: null },
      },
    });
    expect(await screen.findByRole('button', { name: /^Desert Foxes, / })).toBeOnTheScreen();
    const decline = await screen.findByRole('button', {
      name: 'Decline the invitation to join Canyon Hawks',
    });
    act(() => app.sources.setReachable(false));
    expect(decline).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Desert Foxes, / })).toBeOnTheScreen();
    expect(screen.getAllByLabelText('You are offline').length).toBeGreaterThan(0);
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTeamsTestApp({ session: null, routes: routes() });
    render(<TeamsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });

  describe('team invitations (CMP-03, SPK-CAP-001)', () => {
    const withInvitation = (overrides = {}) =>
      routes({
        'GET /me/team-invitations': {
          status: 200,
          body: { items: [teamInvitationView()], nextCursor: null },
        },
        ...overrides,
      });

    it('lists an open invitation that opens its detail by id only', async () => {
      const app = createTeamsTestApp({ routes: withInvitation() });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      const row = await screen.findByRole('button', {
        name: /^Canyon Hawks, Fall 2026\. From Pat Player: "Join us on Saturdays\.", Open until /,
      });
      expect(app.requestsTo('GET', '/me/team-invitations')[0]?.query).toEqual({
        status: 'pending',
        limit: '20',
      });
      fireEvent.press(row);
      expect(mockRouter.push).toHaveBeenCalledWith(`/invitations/${IDS.invitation}?type=team`);
      await app.settle();
    });

    it('declines after confirming, sending the revision read under one idempotency key', async () => {
      let declined = false;
      const app = createTeamsTestApp({
        routes: withInvitation({
          'GET /me/team-invitations': () =>
            fakeResponse(200, {
              items: declined ? [] : [teamInvitationView()],
              nextCursor: null,
            }),
          'POST /team-invitations/{id}/decline': () => {
            declined = true;
            return fakeResponse(
              200,
              teamInvitationView({ status: 'declined', effectiveStatus: 'declined', revision: 2 }),
            );
          },
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Decline the invitation to join Canyon Hawks' }),
      );
      expect(
        screen.getByText(
          'Decline the invitation to join Canyon Hawks? It can no longer be accepted afterwards.',
        ),
      ).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Decline invitation' }));
      expect(
        await screen.findByLabelText('Declined the invitation to join Canyon Hawks'),
      ).toBeOnTheScreen();
      expect(app.bodiesOf('POST', '/team-invitations/{id}/decline')).toEqual([
        { expectedRevision: 1 },
      ]);
      expect(app.keysOf('POST', '/team-invitations/{id}/decline')).toHaveLength(1);
      expect(
        await screen.findByRole('header', { name: 'No open team invitations' }),
      ).toBeOnTheScreen();
      await app.settle();
    });

    it('§4.9: a failed decline is retried under the same key', async () => {
      let attempt = 0;
      const app = createTeamsTestApp({
        routes: withInvitation({
          'POST /team-invitations/{id}/decline': () => {
            attempt += 1;
            return attempt === 1
              ? fakeResponse(
                  503,
                  apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
                )
              : fakeResponse(
                  200,
                  teamInvitationView({ status: 'declined', effectiveStatus: 'declined' }),
                );
          },
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Decline the invitation to join Canyon Hawks' }),
      );
      fireEvent.press(screen.getByRole('button', { name: 'Decline invitation' }));
      expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await screen.findByLabelText('Declined the invitation to join Canyon Hawks'),
      ).toBeOnTheScreen();
      const [first, second] = app.keysOf('POST', '/team-invitations/{id}/decline');
      expect(second).toBe(first);
      await app.settle();
    });

    it('an invitation answered meanwhile (INVALID_TRANSITION) reloads the list', async () => {
      const app = createTeamsTestApp({
        routes: withInvitation({
          'POST /team-invitations/{id}/decline': () =>
            fakeResponse(
              409,
              apiErrorBody('INVALID_TRANSITION', { nextAction: 'reload_current_state' }),
            ),
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Decline the invitation to join Canyon Hawks' }),
      );
      fireEvent.press(screen.getByRole('button', { name: 'Decline invitation' }));
      expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
      const reads = app.requestsTo('GET', '/me/team-invitations').length;
      fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
      await screen.findByRole('button', { name: 'Decline the invitation to join Canyon Hawks' });
      expect(app.requestsTo('GET', '/me/team-invitations').length).toBeGreaterThan(reads);
      await app.settle();
    });

    it('§4.10: a refused decline is "not available" without detail', async () => {
      const app = createTeamsTestApp({
        routes: withInvitation({
          'POST /team-invitations/{id}/decline': () =>
            fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      fireEvent.press(
        await screen.findByRole('button', { name: 'Decline the invitation to join Canyon Hawks' }),
      );
      fireEvent.press(screen.getByRole('button', { name: 'Decline invitation' }));
      expect(
        await screen.findByText('Declining this invitation is not available to you.'),
      ).toBeOnTheScreen();
      expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
      await app.settle();
    });

    it('an invitation past its expiry shows "Expired" and offers no decline', async () => {
      const app = createTeamsTestApp({
        routes: withInvitation({
          'GET /me/team-invitations': {
            status: 200,
            body: { items: [teamInvitationView({ effectiveStatus: 'expired' })], nextCursor: null },
          },
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      const list = await screen.findByLabelText('Team invitations');
      expect(within(list).getByLabelText('Expired')).toBeOnTheScreen();
      expect(screen.queryByRole('button', { name: /^Decline the invitation/ })).toBeNull();
      await app.settle();
    });

    it('more invitations load on request', async () => {
      const app = createTeamsTestApp({
        routes: withInvitation({
          'GET /me/team-invitations': (request: FakeRequest) =>
            fakeResponse(
              200,
              request.query.cursor
                ? {
                    items: [
                      teamInvitationView({
                        id: '0192f1a0-0000-7000-8000-000000000055',
                        teamName: 'Mesa Owls',
                      }),
                    ],
                    nextCursor: null,
                  }
                : { items: [teamInvitationView()], nextCursor: 'next-page' },
            ),
        }),
      });
      render(<TeamsScreen />, { wrapper: app.wrapper });
      fireEvent.press(await screen.findByRole('button', { name: 'Load more team invitations' }));
      expect(await screen.findByRole('button', { name: /^Mesa Owls, / })).toBeOnTheScreen();
      await app.settle();
    });
  });
});
