/**
 * The team routes under app/team (SCR-C-22 to SCR-C-29) resolve to their screens through the real
 * Expo Router tree (SPK-UX-001 native navigation, SPK-UX-002 Teams destination), carry only opaque
 * ids (§4.14), and the Teams tab opens a team's workspace.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { RootNavigator } from '../../../navigation/RootNavigator';
import {
  IDS,
  baseRoutes,
  contributionRequest,
  dispute,
  fixture,
  fixtureDetail,
  myTeamEntry,
  obligation,
  pool,
  poolStandings,
  result,
  ruleSet,
  season,
  standings,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';

const ROUTES: Record<string, FakeHandler> = baseRoutes({
  'GET /me/inbox': { status: 200, body: { items: [], nextCursor: null } },
  'GET /seasons/{id}/standings': { status: 200, body: standings() },
  'GET /seasons/{id}/fixtures': { status: 200, body: { items: [fixture()], nextCursor: null } },
  'GET /seasons/{id}/bracket-nodes': { status: 200, body: [] },
  'GET /team-entries/{id}/roster': {
    status: 200,
    body: { teamEntryId: IDS.entry, at: '2026-10-24T12:00:00.000Z', members: [] },
  },
  'GET /obligations': { status: 200, body: { items: [obligation()], nextCursor: null } },
  'GET /contribution-requests/{id}': { status: 200, body: contributionRequest() },
  'GET /seasons': { status: 200, body: [season()] },
  'GET /competitions': { status: 200, body: [] },
  'GET /fixtures/{id}': { status: 200, body: fixtureDetail() },
  'GET /fixtures/{id}/results': { status: 200, body: [result()] },
  'GET /fixtures/{id}/disputes': { status: 200, body: [dispute()] },
  'GET /rule-sets/{id}': { status: 200, body: ruleSet() },
  'GET /me/team-entries': { status: 200, body: [myTeamEntry()] },
  'GET /me/team-invitations': { status: 200, body: { items: [], nextCursor: null } },
  'GET /fixtures/{id}/availability-requests': { status: 200, body: [] },
  'GET /pools/{id}': { status: 200, body: pool() },
  'GET /pools/{id}/standings': { status: 200, body: poolStandings() },
});

/** Rendering the whole router tree is slow on a shared machine; allow it time. */
const SLOW = { timeout: 5_000 };

function renderApp(initialUrl: string) {
  const app = createTeamsTestApp({ routes: ROUTES });
  const TestRootLayout = () => (
    <app.wrapper>
      <RootNavigator />
    </app.wrapper>
  );
  const router = renderRouter(
    { appDir: 'app', overrides: { _layout: TestRootLayout } },
    { initialUrl },
  );
  return { app, router };
}

describe('team routes (SCR-C-21 to SCR-C-29)', () => {
  it('SPK-UX-002: the Teams destination opens a team workspace by its opaque id', async () => {
    const { router } = renderApp('/teams');
    fireEvent.press(await screen.findByRole('button', { name: /^Desert Foxes, / }, SLOW));
    expect(router.getPathname()).toBe(`/team/${IDS.entry}`);
    expect(
      await screen.findByRole('button', { name: 'Roster and invitations' }, SLOW),
    ).toBeOnTheScreen();
  });

  it.each([
    [`/team/${IDS.entry}`, 'Desert Foxes'],
    [`/team/${IDS.entry}/roster`, 'Desert Foxes: roster'],
    [`/team/${IDS.entry}/availability`, 'Desert Foxes: availability'],
    [`/team/${IDS.entry}/contributions`, 'Desert Foxes: contributions'],
    [`/team/contribution/${IDS.contribution}`, 'Your contribution'],
    [`/team/${IDS.entry}/roster-change`, 'Desert Foxes: roster change'],
    ['/team/new', 'Create a team entry'],
    [`/team/new?renewFrom=${IDS.entry}`, 'Renew Desert Foxes'],
    [`/team/${IDS.entry}/standings`, 'Fall 2026: Coed Division 2'],
    [`/team/${IDS.entry}/results/${IDS.playedFixture}`, 'Desert Foxes vs Canyon Hawks'],
    [`/team/${IDS.entry}/disputes/${IDS.playedFixture}`, 'Dispute: Desert Foxes vs Canyon Hawks'],
    [`/team/${IDS.entry}/pools/${IDS.pool}`, 'Pool A: Fall 2026'],
  ])('%s resolves to its screen', async (url, heading) => {
    renderApp(url);
    expect(await screen.findByRole('header', { name: heading }, SLOW)).toBeOnTheScreen();
    expect(screen.queryByLabelText('Link not available')).toBeNull();
  });

  it('a route with a malformed id is "not available" and sends no team request', async () => {
    const { app } = renderApp('/team/not-a-record-id/roster');
    expect(await screen.findByLabelText('Not available', {}, SLOW)).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/team-entries/{id}')).toHaveLength(0);
  });
});
