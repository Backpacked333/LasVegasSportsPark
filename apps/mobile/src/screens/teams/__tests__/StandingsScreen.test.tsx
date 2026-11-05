/**
 * SCR-C-28 Standings and results (SPK-RESULT-001, SPK-RESULT-002, SPK-RESULT-003,
 * SPK-RESULT-004, SPK-DISC-004): official standings with the rule set version and tiebreak
 * explanation, the team's results opening their revisions ("Official", "Corrected on <date>",
 * history kept), the published bracket, disputes (withdrawable while open, CMP-12), tournament
 * pools only where tournaments are on (DEC-078), times in the facility's zone, and the empty,
 * error and not-available states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  baseRoutes,
  dispute,
  fixture,
  fixtureDetail,
  playerWorkspace,
  result,
  standings,
  venue,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { mePermissions } from '../../../testing/test-app';
import { FixtureResultsScreen } from '../FixtureResultsScreen';
import { StandingsScreen, standingsRowLabel } from '../StandingsScreen';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const played = fixture({
  id: IDS.playedFixture,
  status: 'played',
  scheduledStart: '2026-10-17T17:00:00.000Z',
});

function routes(overrides: Record<string, FakeHandler> = {}) {
  return baseRoutes({
    'GET /seasons/{id}/standings': { status: 200, body: standings() },
    'GET /seasons/{id}/fixtures': {
      status: 200,
      body: { items: [played, fixture()], nextCursor: null },
    },
    'GET /seasons/{id}/bracket-nodes': { status: 200, body: [] },
    ...overrides,
  });
}

describe('SCR-C-28 StandingsScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-RESULT-003: official standings with the versioned rule set and every row read in full', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText(
        '2nd: Desert Foxes (your team), 9 points, played 4, won 3, drawn 0, lost 1, goals 8 for and 5 against, difference 3',
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        /from 1 official result with Adult outdoor 7v7, version 3\. Provisional results are never counted\./,
      ),
    ).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/seasons/{id}/standings')[0]?.query).toEqual({
      divisionId: IDS.division,
    });
  });

  it('SPK-UX-009: at large text sizes each row is stacked text instead of fixed-width cells', async () => {
    // The component reads useWindowDimensions from this same module object.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reactNative = require('react-native') as { useWindowDimensions: () => unknown };
    const dimensions = jest
      .spyOn(reactNative, 'useWindowDimensions')
      .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1.6 });
    const app = createTeamsTestApp({ routes: routes() });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('standings-stacked')).toBeOnTheScreen();
    expect(
      screen.getByText(
        '2nd: Desert Foxes (your team), 9 points, played 4, won 3, drawn 0, lost 1, goals 8 for and 5 against, difference 3',
      ),
    ).toBeOnTheScreen();
    dimensions.mockRestore();
  });

  it('SPK-RESULT-003: explains how a tie on points was decided', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const ties = await screen.findByTestId('tiebreaks');
    expect(
      within(ties).getByText('Tied on 9 points: Canyon Hawks and Desert Foxes'),
    ).toBeOnTheScreen();
    expect(
      within(ties).getByLabelText(
        'Head-to-head separated the teams. Canyon Hawks won the head-to-head game 2-1.',
      ),
    ).toBeOnTheScreen();
    expect(within(ties).getByText('Canyon Hawks 3, Desert Foxes 0')).toBeOnTheScreen();
  });

  it('lists the team’s played games and opens one; unplayed games are not results', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`result-${IDS.playedFixture}`);
    expect(within(row).getByText('vs Canyon Hawks')).toBeOnTheScreen();
    expect(screen.queryByTestId(`result-${IDS.fixture}`)).toBeNull();
    fireEvent.press(row);
    expect(mockRouter.push).toHaveBeenCalledWith(`/team/${IDS.entry}/results/${IDS.playedFixture}`);
    expect(app.requestsTo('GET', '/seasons/{id}/fixtures')[0]?.query).toEqual({
      teamEntryId: IDS.entry,
      limit: '100',
    });
  });

  it('SPK-SCHED-008: a played game is dated in the facility’s zone from its fixture read', async () => {
    // 05:00 UTC on Oct 18 is 10 PM on Oct 17 in Las Vegas: the facility's day is shown.
    const late = fixture({
      id: IDS.playedFixture,
      status: 'played',
      scheduledStart: '2026-10-18T05:00:00.000Z',
      scheduledEnd: '2026-10-18T06:00:00.000Z',
    });
    const app = createTeamsTestApp({
      routes: routes({
        'GET /seasons/{id}/fixtures': { status: 200, body: { items: [late], nextCursor: null } },
        'GET /fixtures/{id}': {
          status: 200,
          body: fixtureDetail({
            scheduledStart: late.scheduledStart,
            scheduledEnd: late.scheduledEnd,
            venue: venue(),
          }),
        },
      }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const row = await screen.findByTestId(`result-${IDS.playedFixture}`);
    expect(await within(row).findByText('Oct 17, 2026')).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/fixtures/{id}')[0]?.params).toEqual({ id: IDS.playedFixture });
    await app.settle();
  });

  it('shows the published bracket where the season has one', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /seasons/{id}/bracket-nodes': {
          status: 200,
          body: [
            {
              id: IDS.bracketNode,
              seasonId: IDS.season,
              divisionId: IDS.division,
              name: 'Final',
              round: 2,
              slot: 1,
              sourceRule: { home: { kind: 'seed', seed: 1 }, away: { kind: 'seed', seed: 2 } },
              homeEntryId: IDS.opponentEntry,
              awayEntryId: IDS.entry,
              fixtureId: null,
              winnerEntryId: null,
              published: true,
              publishedAt: '2026-10-23T12:00:00.000Z',
              revision: 1,
              createdAt: '2026-10-23T12:00:00.000Z',
              updatedAt: '2026-10-23T12:00:00.000Z',
            },
          ],
        },
      }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(
      await screen.findByText('Round 2, game 1 (Final): Canyon Hawks vs Desert Foxes'),
    ).toBeOnTheScreen();
  });

  it('SPK-RESULT-001: no official results yet is an empty state, never provisional standings', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /seasons/{id}/standings': {
          status: 200,
          body: standings({ id: null, sourceResultIds: [], rows: [], tiebreakExplanations: [] }),
        },
      }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(
      await screen.findByRole('header', { name: 'No official results yet' }),
    ).toBeOnTheScreen();
  });

  it('shows the standings error code and recovery', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /seasons/{id}/standings': () =>
          fakeResponse(429, apiErrorBody('RATE_LIMITED', { nextAction: 'retry_later' })),
      }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByText(/Error code: RATE_LIMITED/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });

  it('§4.10: standings of a team the person may not see are not available', async () => {
    const app = createTeamsTestApp({
      routes: routes({
        'GET /team-entries/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(app.requestsTo('GET', '/seasons/{id}/standings')).toHaveLength(0);
  });

  it('DEC-078: with tournaments on, says pool tables cannot be listed for a team yet', async () => {
    const app = createTeamsTestApp({
      routes: routes({ 'GET /me/permissions': mePermissions({ enabled: ['tournaments'] }) }),
    });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const pools = await screen.findByTestId('tournament-pools');
    expect(within(pools).getByRole('header', { name: 'Tournament pools' })).toBeOnTheScreen();
    expect(within(pools).getByLabelText('Pool tables not listed yet')).toBeOnTheScreen();
  });

  it('DEC-016: with tournaments off (as every switch starts), no pool section is shown', async () => {
    const app = createTeamsTestApp({ routes: routes() });
    render(<StandingsScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    await screen.findByTestId(`standings-row-${IDS.entry}`);
    await waitFor(() => expect(app.requestsTo('GET', '/me/permissions')).toHaveLength(1));
    await app.settle();
    expect(screen.queryByTestId('tournament-pools')).toBeNull();
  });

  it('labels a row for screen readers without colour', () => {
    expect(standingsRowLabel(standings().rows[0]!, false)).toBe(
      '1st: Canyon Hawks, 9 points, played 4, won 3, drawn 0, lost 1, goals 8 for and 5 against, difference 3',
    );
  });
});

describe('SCR-C-28 FixtureResultsScreen', () => {
  beforeEach(() => mockRouter.push.mockClear());

  const resultRoutes = (overrides: Record<string, FakeHandler> = {}) =>
    baseRoutes({
      'GET /fixtures/{id}': { status: 200, body: fixtureDetail() },
      'GET /fixtures/{id}/results': {
        status: 200,
        body: [
          result({
            id: IDS.supersededResult,
            revisionNo: 1,
            status: 'superseded',
            homeScore: 1,
            awayScore: 1,
            publishedAt: '2026-10-18T10:00:00.000Z',
            supersededAt: '2026-10-23T10:00:00.000Z',
            supersededByRevisionId: IDS.officialResult,
          }),
          result({
            revisionNo: 2,
            supersedesRevisionId: IDS.supersededResult,
            reason: 'Goal credited to the wrong team on the sheet.',
          }),
        ],
      },
      'GET /fixtures/{id}/disputes': { status: 200, body: [dispute()] },
      ...overrides,
    });

  it('SPK-RESULT-004: the corrected official result, its reason, and the replaced result kept as history', async () => {
    const app = createTeamsTestApp({ routes: resultRoutes() });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    const official = await screen.findByTestId('official-result');
    expect(within(official).getByLabelText('Corrected on Oct 23, 2026')).toBeOnTheScreen();
    expect(
      within(official).getByLabelText('Score: Desert Foxes 1, Canyon Hawks 2'),
    ).toBeOnTheScreen();
    expect(within(official).getByLabelText('Outcome: Completed')).toBeOnTheScreen();
    expect(
      within(official).getByLabelText(
        'Reason for the correction: Goal credited to the wrong team on the sheet.',
      ),
    ).toBeOnTheScreen();
    const history = screen.getByTestId('result-history');
    expect(
      within(history).getByLabelText('Replaced by a correction on Oct 23, 2026'),
    ).toBeOnTheScreen();
    expect(within(history).getByText('Desert Foxes 1, Canyon Hawks 1')).toBeOnTheScreen();
  });

  it('SPK-RESULT-005: lists disputes with their status, and the captain can open the dispute form', async () => {
    const app = createTeamsTestApp({ routes: resultRoutes() });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    const row = await screen.findByTestId(`dispute-${IDS.dispute}`);
    expect(within(row).getByLabelText('Disputed: under review')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Dispute this result' }));
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/team/${IDS.entry}/disputes/${IDS.playedFixture}`,
    );
  });

  it('a roster player sees the result without the dispute form', async () => {
    const app = createTeamsTestApp({
      routes: resultRoutes({
        'GET /team-entries/{id}': { status: 200, body: playerWorkspace() },
        'GET /fixtures/{id}/disputes': { status: 200, body: [] },
      }),
    });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByTestId('official-result')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Dispute this result' })).toBeNull();
  });

  it('empty: no official result yet', async () => {
    const app = createTeamsTestApp({
      routes: resultRoutes({ 'GET /fixtures/{id}/results': { status: 200, body: [] } }),
    });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByRole('header', { name: 'No official result yet' })).toBeOnTheScreen();
  });

  it('§4.10: a game the person may not see is not available', async () => {
    const app = createTeamsTestApp({
      routes: resultRoutes({
        'GET /fixtures/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }),
    });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
  });

  it('CMP-12: an open dispute can be withdrawn from the result', async () => {
    const app = createTeamsTestApp({
      routes: resultRoutes({
        'POST /disputes/{id}/withdraw': {
          status: 200,
          body: dispute({ status: 'withdrawn', revision: 2 }),
        },
      }),
    });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    fireEvent.press(await screen.findByRole('button', { name: 'Withdraw this dispute' }));
    fireEvent.changeText(screen.getByLabelText('Reason for withdrawing'), 'Resolved.');
    fireEvent.press(screen.getByRole('button', { name: 'Withdraw the dispute' }));
    expect(
      await screen.findByText('You withdrew this dispute. The league no longer reviews it.'),
    ).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/disputes/{id}/withdraw')).toEqual([
      { reason: 'Resolved.', expectedRevision: 1 },
    ]);
    await app.settle();
  });

  it('SPK-SCHED-008: kickoff and venue in the facility’s zone', async () => {
    const app = createTeamsTestApp({
      routes: resultRoutes({
        'GET /fixtures/{id}': { status: 200, body: fixtureDetail({ venue: venue() }) },
      }),
    });
    render(<FixtureResultsScreen entryId={IDS.entry} fixtureId={IDS.playedFixture} />, {
      wrapper: app.wrapper,
    });
    expect(await screen.findByLabelText(/^Kickoff: Sat, Oct 17, 10:00\sAM PDT$/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Where: Las Vegas Sports Park')).toBeOnTheScreen();
  });
});
