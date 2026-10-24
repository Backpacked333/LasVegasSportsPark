/**
 * SCR-C-21 Teams (SPK-UX-002, SPK-CAP-001, SPK-CAP-002): the missing team list is shown as not
 * available, opened teams list with next game, standing and readiness, a team no longer visible
 * says so without detail, and the create entry point.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { rememberTeamEntry } from '../../../features/teams/opened-teams';
import {
  IDS,
  baseRoutes,
  playerWorkspace,
  standings,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { TEST_SESSION } from '../../../testing/test-app';
import { TeamsScreen, teamRowStatus } from '../TeamsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const routes = (overrides = {}) =>
  baseRoutes({ 'GET /seasons/{id}/standings': { status: 200, body: standings() }, ...overrides });

describe('SCR-C-21 TeamsScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('says the full team list is not available and explains how to join or create a team', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    render(<TeamsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Full team list not available yet')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'No teams to show' })).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Create a team entry' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/team/new');
    expect(app.requestsTo('GET', '/team-entries/{id}')).toHaveLength(0);
  });

  it('SPK-CAP-001: lists an opened team with its next game, standing and readiness indicator', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    act(() => rememberTeamEntry(TEST_SESSION.accountId as string, IDS.entry));
    render(<TeamsScreen />, { wrapper: app.wrapper });

    const row = await screen.findByRole('button', {
      name: /^Desert Foxes, Fall 2026, Coed Division 2\. Next: vs Canyon Hawks/,
    });
    expect(row).toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: /Standing: 2nd of 2/ })).toBeOnTheScreen();
    // The captain's indicator counts blocking readiness issues.
    expect(screen.getByLabelText('1 readiness issue to resolve')).toBeOnTheScreen();
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/${IDS.entry}`);
    await app.settle();
  });

  it('SPK-CAP-002: a roster player sees the entry state, not the captain indicator', () => {
    expect(teamRowStatus(playerWorkspace(), false)).toEqual({
      tone: 'success',
      label: 'Team entry approved',
    });
    expect(teamRowStatus(workspace(), true).label).toBe('1 readiness issue to resolve');
  });

  it('§4.10: a team the API no longer shows is "no longer available" and can be removed', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /team-entries/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    act(() => rememberTeamEntry(TEST_SESSION.accountId as string, IDS.entry));
    render(<TeamsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('No longer available')).toBeOnTheScreen();
    expect(screen.queryByText(/Desert Foxes|NOT_FOUND/)).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Remove from this list' }));
    expect(await screen.findByRole('header', { name: 'No teams to show' })).toBeOnTheScreen();
  });

  it('shows the API error code on a failed team read', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /team-entries/{id}': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      }),
    });
    act(() => rememberTeamEntry(TEST_SESSION.accountId as string, IDS.entry));
    render(<TeamsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('asks a signed-out user to sign in and sends no request', async () => {
    const app = createTeamsTestApp({ session: null, routes: routes() });
    render(<TeamsScreen />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
