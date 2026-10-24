/**
 * SCR-C-22 Team workspace overview (SPK-CAP-001, SPK-CAP-002, SPK-COMP-004): the captain's
 * readiness indicators and tools, the reduced player view, upcoming games, the standing, and the
 * SPK-UX-008 states (loading, error with code, not available, offline with age).
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { resetOpenedTeamEntries } from '../../../features/teams/opened-teams';
import {
  IDS,
  baseRoutes,
  me,
  playerWorkspace,
  standings,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { TeamWorkspaceScreen } from '../TeamWorkspaceScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function routes(overrides = {}) {
  return baseRoutes({
    'GET /seasons/{id}/standings': { status: 200, body: standings() },
    ...overrides,
  });
}

describe('SCR-C-22 TeamWorkspaceScreen', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
    resetOpenedTeamEntries();
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

  it('contacting the operating team is shown as not available (no customer case command)', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available in the app yet')).toBeOnTheScreen();
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
