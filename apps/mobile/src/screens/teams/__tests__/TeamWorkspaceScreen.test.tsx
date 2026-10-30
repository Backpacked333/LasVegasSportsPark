/**
 * SCR-C-22 Team workspace overview (SPK-CAP-001, SPK-CAP-002, SPK-COMP-004, SPK-SUPPORT-002): the
 * captain's readiness indicators and the tools the API lists for this viewer (CMP-02
 * `viewer.availableActions`), the reduced player view, upcoming games, the standing, contacting
 * the operating team (SUP-01), and the SPK-UX-008 states (loading, error with code, not
 * available, offline with age).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { formatInstant } from '../../../features/teams/format';
import {
  CAPTAIN_ACTIONS,
  IDS,
  baseRoutes,
  customerCase,
  me,
  playerWorkspace,
  standings,
  upcomingFixtureDetail,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { TeamWorkspaceScreen } from '../TeamWorkspaceScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

/** A string as a literal inside a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routes(overrides = {}) {
  return baseRoutes({
    'GET /seasons/{id}/standings': { status: 200, body: standings() },
    ...overrides,
  });
}

describe('SCR-C-22 TeamWorkspaceScreen', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
  });

  it('SPK-CAP-001: the captain sees upcoming games, the standing and the captain tools', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Desert Foxes' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Team entry approved')).toBeOnTheScreen();
    expect(screen.getByLabelText('Rule set: Adult outdoor 7v7, version 3')).toBeOnTheScreen();
    expect(
      screen.getByRole('button', {
        name: /vs Canyon Hawks, Home, round 3\. Availability: Available 1, Unavailable 1, No response 1/,
      }),
    ).toBeOnTheScreen();
    expect(await screen.findByLabelText('Standing: 2nd of 2, 9 points')).toBeOnTheScreen();

    for (const name of [
      'Roster and invitations',
      'Availability',
      'Team contributions',
      'Roster change or substitute',
      'Renew for a new season',
    ]) {
      expect(screen.getByRole('button', { name })).toBeOnTheScreen();
    }
    fireEvent.press(screen.getByRole('button', { name: 'Renew for a new season' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/new?renewFrom=${IDS.entry}`);

    const request = app.fake.requests.find((r) => r.route === '/seasons/{id}/standings');
    expect(request?.query).toEqual({ divisionId: IDS.division });
  });

  it('SPK-COMP-004, SPK-CAP-002: readiness indicators keep approval, payment, roster and eligibility distinct and name who resolves them', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    const readiness = await screen.findByTestId('captain-readiness');
    expect(
      within(readiness).getByLabelText('On the roster: 3 (minimum 7, maximum 15)'),
    ).toBeOnTheScreen();
    expect(within(readiness).getByLabelText('Roster not complete')).toBeOnTheScreen();
    expect(within(readiness).getByLabelText('Eligible players: 1 of 3')).toBeOnTheScreen();
    expect(
      within(readiness).getByLabelText('Team payment: No obligation recorded yet'),
    ).toBeOnTheScreen();
    expect(within(readiness).getByLabelText('Blocking')).toBeOnTheScreen();
    expect(
      within(readiness).getByText('Team captain: Add 4 more eligible player(s).'),
    ).toBeOnTheScreen();
    expect(
      within(readiness).getByText('Finance team: Finance records the entry obligation.'),
    ).toBeOnTheScreen();
    // No private family details or payment instruments are part of the indicators.
    expect(screen.queryByText(/card|date of birth/i)).toBeNull();
  });

  it('SPK-CAP-002: a roster player gets the reduced view without captain sections or eligibility', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me': { status: 200, body: me() },
        'GET /team-entries/{id}': { status: 200, body: playerWorkspace() },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });

    expect(await screen.findByTestId('reduced-roster')).toBeOnTheScreen();
    expect(screen.queryByTestId('captain-readiness')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Roster and invitations' })).toBeNull();
    expect(screen.getByRole('button', { name: /Your answer: No response/ })).toBeOnTheScreen();
    expect(screen.getByText('Pat Player')).toBeOnTheScreen();
    expect(screen.queryByText(/Not eligible/)).toBeNull();
    // A pending join request is not a teammate.
    expect(screen.queryByText('Riley Requester')).toBeNull();
  });

  it('SCR-C-25, SPK-PAY-004: a roster player opens the contributions asked of them', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me': { status: 200, body: me() },
        'GET /team-entries/{id}': { status: 200, body: playerWorkspace() },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: 'Your contributions' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/team/contributions');
    expect(screen.queryByText(/cannot list the contributions/)).toBeNull();
  });

  it('SPK-SCHED-008: an upcoming game’s time is in the facility’s zone from its fixture read', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /fixtures/{id}': { status: 200, body: upcomingFixtureDetail() } }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    // 17:00 UTC is 10:00 in Las Vegas (America/Los_Angeles, PDT), named.
    expect(
      await screen.findByRole('button', { name: /vs Canyon Hawks.*Sat, Oct 31, 10:00\sAM PDT/ }),
    ).toBeOnTheScreen();
    const read = app.fake.requests.find((r) => r.route === '/fixtures/{id}');
    expect(read?.params).toEqual({ id: IDS.fixture });
  });

  it('SPK-SCHED-008: when the fixture read fails the time is in the device’s zone, still named', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /fixtures/{id}': () =>
          fakeResponse(
            500,
            apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
          ),
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/fixtures/{id}').length).toBeGreaterThan(
        0,
      ),
    );
    const device = formatInstant('2026-10-31T17:00:00.000Z');
    expect(
      await screen.findByRole('button', {
        name: new RegExp(`vs Canyon Hawks.*${literal(device)}`),
      }),
    ).toBeOnTheScreen();
  });

  it('shows the empty games state when nothing is scheduled yet', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /team-entries/{id}': { status: 200, body: workspace({ upcomingFixtures: [] }) },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(
      await screen.findByText(
        'No games yet. They appear here once the league publishes the schedule.',
      ),
    ).toBeOnTheScreen();
  });

  it('CMP-02: a captain tool the API does not list for this viewer is not offered', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /team-entries/{id}': {
          status: 200,
          body: workspace({
            viewer: {
              roles: ['captain'],
              actingAsCaptain: true,
              availableActions: CAPTAIN_ACTIONS.filter(
                (a) => a !== 'competition.manage_roster' && a !== 'competition.renew_team_entry',
              ),
            },
          }),
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Roster and invitations' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Roster change or substitute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew for a new season' })).toBeNull();
  });

  describe('contact the operating team (SUP-01, SPK-SUPPORT-002)', () => {
    it('the captain sends a team request and sees its status only', async () => {
      const app = createTestApp({
        routes: routes({ 'POST /me/support-requests': { status: 201, body: customerCase() } }),
      });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      const form = await screen.findByTestId('contact-operations');
      fireEvent.changeText(within(form).getByLabelText('Title'), '  Field 2 lights  ');
      fireEvent.changeText(
        within(form).getByLabelText('What you need'),
        'The lights on Field 2 were out on Saturday.',
      );
      fireEvent.press(within(form).getByRole('button', { name: 'Send to the operating team' }));
      const sent = await screen.findByTestId('support-request-sent');
      expect(within(sent).getByLabelText('Request open')).toBeOnTheScreen();
      expect(app.fake.requests.filter((r) => r.route === '/me/support-requests')).toHaveLength(1);
      const post = app.fake.requests.find((r) => r.route === '/me/support-requests');
      expect(post?.body).toEqual({
        category: 'team',
        title: 'Field 2 lights',
        description: 'The lights on Field 2 were out on Saturday.',
        teamEntryId: IDS.entry,
      });
      expect(post?.headers['idempotency-key']).toMatch(/^key-/);
      fireEvent.press(within(sent).getByRole('button', { name: 'See your support requests' }));
      expect(mockRouter.push).toHaveBeenCalledWith('/support');
    });

    it('asks for a title and a description before sending anything', async () => {
      const app = createTestApp({ routes: routes() });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      fireEvent.press(await screen.findByRole('button', { name: 'Send to the operating team' }));
      expect(await screen.findByLabelText('Title. Enter a short title.')).toBeOnTheScreen();
      expect(screen.getByLabelText('What you need. Enter what you need.')).toBeOnTheScreen();
      expect(app.fake.requests.filter((r) => r.route === '/me/support-requests')).toHaveLength(0);
    });

    it('a refused request is "not available" and the draft is kept', async () => {
      const app = createTestApp({
        routes: routes({
          'POST /me/support-requests': () =>
            fakeResponse(
              403,
              apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
            ),
        }),
      });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      fireEvent.changeText(await screen.findByLabelText('Title'), 'Lights');
      fireEvent.changeText(screen.getByLabelText('What you need'), 'Field 2');
      fireEvent.press(screen.getByRole('button', { name: 'Send to the operating team' }));
      expect(
        await screen.findByText(
          'Contacting the operating team about this team is not available to you. Use Support for a request about yourself.',
        ),
      ).toBeOnTheScreen();
      expect(screen.getByLabelText('Title').props.value).toBe('Lights');
    });

    it('shows a failed request with its code and retries under the same key', async () => {
      let attempt = 0;
      const app = createTestApp({
        routes: routes({
          'POST /me/support-requests': () => {
            attempt += 1;
            return attempt === 1
              ? fakeResponse(
                  503,
                  apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
                )
              : fakeResponse(201, customerCase());
          },
        }),
      });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      fireEvent.changeText(await screen.findByLabelText('Title'), 'Lights');
      fireEvent.changeText(screen.getByLabelText('What you need'), 'Field 2');
      fireEvent.press(screen.getByRole('button', { name: 'Send to the operating team' }));
      expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByTestId('support-request-sent')).toBeOnTheScreen();
      const keys = app.fake.requests
        .filter((r) => r.route === '/me/support-requests')
        .map((r) => r.headers['idempotency-key']);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    it('offline: sending is disabled and the draft kept', async () => {
      const app = createTestApp({ routes: routes() });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      fireEvent.changeText(await screen.findByLabelText('Title'), 'Lights');
      act(() => app.sources.setReachable(false));
      expect(screen.getByRole('button', { name: 'Send to the operating team' })).toBeDisabled();
      expect(
        screen.getByLabelText('Contacting the operating team needs a connection'),
      ).toBeOnTheScreen();
      expect(screen.getByLabelText('Title').props.value).toBe('Lights');
    });

    it('a co-captain the rule set does not let act as captain is pointed to Support, not given the form', async () => {
      // The API fills the management lists for every co-captain, but the support request takes
      // the captain role, which this co-captain does not act in (actingAsCaptain false).
      const app = createTestApp({
        routes: routes({
          'GET /team-entries/{id}': {
            status: 200,
            body: workspace({
              viewer: {
                roles: ['co_captain'],
                actingAsCaptain: false,
                availableActions: ['competition.invite_player'],
              },
            }),
          },
        }),
      });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      // The management view stays (the API filled its lists for this viewer)...
      expect(await screen.findByTestId('captain-readiness')).toBeOnTheScreen();
      // ...but contacting the operating team about the team is not offered.
      expect(screen.queryByTestId('contact-operations')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Send to the operating team' })).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: 'Open Support' }));
      expect(mockRouter.push).toHaveBeenCalledWith('/support');
      expect(app.fake.requests.filter((r) => r.route === '/me/support-requests')).toHaveLength(0);
    });

    it('a roster player is pointed to Support instead', async () => {
      const app = createTestApp({
        routes: routes({ 'GET /team-entries/{id}': { status: 200, body: playerWorkspace() } }),
      });
      render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
      fireEvent.press(await screen.findByRole('button', { name: 'Open Support' }));
      expect(mockRouter.push).toHaveBeenCalledWith('/support');
      expect(screen.queryByTestId('contact-operations')).toBeNull();
    });
  });

  it('§4.10: a team the person may not see is "not available", with no hint it exists', async () => {
    const app = createTestApp({
      routes: {
        'GET /me': { status: 200, body: me() },
        'GET /team-entries/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      },
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND|Desert Foxes/)).toBeNull();
  });

  it('a malformed route id is not available and sends no request', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={null} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(app.fake.requests.filter((r) => r.route === '/team-entries/{id}')).toHaveLength(0);
  });

  it('shows the API error code, reference and recovery on failure', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /team-entries/{id}': () =>
          fakeResponse(
            500,
            apiErrorBody('INTERNAL_ERROR', {
              message: 'Something failed on our side.',
              correlationId: 'corr-22',
            }),
          ),
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByText('Something failed on our side.')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: INTERNAL_ERROR\. Reference: corr-22/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.15: keeps the workspace when offline and says how old it is', async () => {
    let now = new Date('2026-10-24T12:00:00.000Z');
    const app = createTestApp({ routes: routes(), now: () => now });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('header', { name: 'Desert Foxes' })).toBeOnTheScreen();
    now = new Date('2026-10-24T12:30:00.000Z');
    act(() => app.sources.setReachable(false));
    expect(screen.getByText('Showing information from 30 minutes ago.')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Desert Foxes' })).toBeOnTheScreen();
  });
});
