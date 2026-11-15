/**
 * Public views in the customer app (SPK-SCHED-010, proposed amendment PA-06): today's schedule and
 * public standings without sign-in, and the links to them from the signed-out Discover screen.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { formatInstant } from '../../../features/teams/format';
import { createTestApp } from '../../../testing/test-app';
import {
  PublicLinks,
  PublicScheduleScreen,
  PublicStandingsScreen,
  entryDetail,
  entryTitle,
  standingsRowText,
} from '../PublicViews';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const ORG = 'desert-park';
const CODE = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const COMPETITION = 'c1b2c3d4e5f6a7b8c9d0e1f2';
const SEASON = 'b1b2c3d4e5f6a7b8c9d0e1f2';
const TZ = 'America/Los_Angeles';
const COMPUTED = '2026-11-21T16:30:00.000Z';

const directory = (overrides = {}) => ({
  organizationName: 'Desert Park',
  schedules: [{ facilityName: 'Main complex', code: CODE }],
  competitions: [{ name: 'Monday Men Open', kind: 'league', code: COMPETITION }],
  computedAt: COMPUTED,
  cacheSeconds: 30,
  ...overrides,
});

const entry = (overrides = {}) => ({
  startsAt: '2026-11-21T17:00:00.000Z',
  endsAt: '2026-11-21T18:00:00.000Z',
  fields: ['Field 1'],
  kind: 'game',
  title: 'League game',
  score: null,
  ...overrides,
});

const schedule = {
  organizationName: 'Desert Park',
  facilityName: 'Main complex',
  timezone: TZ,
  date: '2026-11-21',
  window: { from: '2026-11-20', to: '2026-12-05' },
  fields: ['Field 1', 'Field 2'],
  entries: [
    entry({ kind: 'reserved', title: 'Reserved', fields: ['Field 2'] }),
    entry({
      startsAt: '2026-11-22T03:00:00.000Z',
      endsAt: '2026-11-22T04:00:00.000Z',
      title: 'Comets vs Rockets',
      score: { home: 5, away: 3 },
    }),
    entry({ startsAt: '2026-11-22T04:00:00.000Z', endsAt: '2026-11-22T05:00:00.000Z' }),
  ],
  computedAt: COMPUTED,
  cacheSeconds: 30,
};

const row = (position: number, team: string, points: number) => ({
  position,
  team,
  played: 1,
  won: points === 3 ? 1 : 0,
  drawn: 0,
  lost: points === 3 ? 0 : 1,
  goalsFor: points === 3 ? 5 : 3,
  goalsAgainst: points === 3 ? 3 : 5,
  goalDifference: points === 3 ? 2 : -2,
  points,
});

const routes = (overrides = {}) => ({
  'GET /public/{organization}/directory': { status: 200, body: directory() },
  'GET /public/{organization}/schedule/{code}': { status: 200, body: schedule },
  'GET /public/{organization}/competitions/{code}': {
    status: 200,
    body: {
      organizationName: 'Desert Park',
      name: 'Monday Men Open',
      kind: 'league',
      sportFormat: 'indoor_boarded',
      seasons: [
        { code: SEASON, name: 'Winter 2026', startsOn: '2026-11-16', endsOn: '2027-01-25' },
      ],
      computedAt: COMPUTED,
      cacheSeconds: 30,
    },
  },
  'GET /public/{organization}/seasons/{code}': {
    status: 200,
    body: {
      organizationName: 'Desert Park',
      competitionName: 'Monday Men Open',
      competitionKind: 'league',
      sportFormat: 'indoor_boarded',
      seasonName: 'Winter 2026',
      startsOn: '2026-11-16',
      endsOn: '2027-01-25',
      divisions: [
        { name: 'Open', fixtures: [], standings: [row(1, 'Comets', 3), row(2, 'Rockets', 0)] },
      ],
      otherFixtures: [],
      bracket: null,
      computedAt: COMPUTED,
      cacheSeconds: 30,
    },
  },
  ...overrides,
});

const signedOut = (overrides = {}) =>
  createTestApp({ session: null, config: { organizationSlug: ORG }, routes: routes(overrides) });

const settle = (app: ReturnType<typeof createTestApp>) =>
  waitFor(() => expect(app.queryClient.isFetching()).toBe(0));

describe('SPK-SCHED-010 public views (customer app)', () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
  });

  it("SPK-SCHED-010: today's schedule is read without sign-in, by field and time, with when it was last updated", async () => {
    const app = signedOut();
    render(<PublicScheduleScreen />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Main complex today' })).toBeOnTheScreen();
    // A private booking is occupied time without a name.
    expect(screen.getByLabelText('Reserved, 9:00 AM to 10:00 AM, Field 2')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Comets vs Rockets, 5 to 3, 7:00 PM to 8:00 PM, Field 1'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('League game, 8:00 PM to 9:00 PM, Field 1')).toBeOnTheScreen();
    expect(screen.getByLabelText(`Last updated: ${formatInstant(COMPUTED, TZ)}`)).toBeOnTheScreen();
    // Addressed by the organization's slug and public codes; no token is sent.
    const read = app.fake.requests.find(
      (r) => r.route === '/public/{organization}/schedule/{code}',
    );
    expect(read?.params).toEqual({ organization: ORG, code: CODE });
    expect(app.fake.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    await settle(app);
  });

  it('SPK-SCHED-010: the standings of a public competition are read without sign-in', async () => {
    const app = signedOut();
    render(<PublicStandingsScreen />, { wrapper: app.wrapper });

    expect(await screen.findByRole('header', { name: 'Open, Winter 2026' })).toBeOnTheScreen();
    expect(
      screen.getByLabelText('1. Comets, Played 1, won 1, drawn 0, lost 0, goals 5 to 3, 3 points'),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('2. Rockets, Played 1, won 0, drawn 0, lost 1, goals 3 to 5, 0 points'),
    ).toBeOnTheScreen();
    const season = app.fake.requests.find(
      (r) => r.route === '/public/{organization}/seasons/{code}',
    );
    expect(season?.params).toEqual({ organization: ORG, code: SEASON });
    await settle(app);
  });

  it('SPK-SCHED-010: an organization that has turned public views off, or has nothing public, reads "not available" or says so', async () => {
    const off = signedOut({
      'GET /public/{organization}/directory': () =>
        fakeResponse(
          404,
          apiErrorBody('NOT_FOUND', {
            message: 'This view is not available.',
            details: { code: 'PUBLIC_VIEW_NOT_AVAILABLE' },
          }),
        ),
    });
    const first = render(<PublicScheduleScreen />, { wrapper: off.wrapper });
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    expect(
      off.fake.requests.some((r) => r.route === '/public/{organization}/schedule/{code}'),
    ).toBe(false);
    first.unmount();

    const nothing = signedOut({
      'GET /public/{organization}/directory': {
        status: 200,
        body: directory({ schedules: [], competitions: [] }),
      },
    });
    const second = render(<PublicStandingsScreen />, { wrapper: nothing.wrapper });
    expect(await screen.findByText('No public standings')).toBeOnTheScreen();
    second.unmount();

    // A build with no organization configured has no public pages to show.
    const unconfigured = createTestApp({ session: null, routes: routes() });
    render(<PublicScheduleScreen />, { wrapper: unconfigured.wrapper });
    expect(await screen.findByText('Not available')).toBeOnTheScreen();
    expect(unconfigured.fake.requests).toHaveLength(0);
  });

  it("SPK-SCHED-010: the signed-out Discover links open today's schedule and the standings, and are absent when nothing is public", async () => {
    const app = signedOut();
    const shown = render(<PublicLinks />, { wrapper: app.wrapper });
    fireEvent.press(await screen.findByRole('button', { name: "Today's schedule" }));
    expect(mockRouter.push).toHaveBeenCalledWith('/public/schedule');
    fireEvent.press(screen.getByRole('button', { name: 'League standings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/public/standings');
    shown.unmount();

    const onlySchedule = signedOut({
      'GET /public/{organization}/directory': {
        status: 200,
        body: directory({ competitions: [] }),
      },
    });
    const partial = render(<PublicLinks />, { wrapper: onlySchedule.wrapper });
    expect(await screen.findByRole('button', { name: "Today's schedule" })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'League standings' })).toBeNull();
    partial.unmount();

    const none = signedOut({
      'GET /public/{organization}/directory': {
        status: 200,
        body: directory({ schedules: [], competitions: [] }),
      },
    });
    render(<PublicLinks />, { wrapper: none.wrapper });
    await settle(none);
    expect(screen.queryByTestId('public-links')).toBeNull();
  });

  it('SPK-SCHED-010: the words for an entry and a standings row', () => {
    expect(entryTitle(entry({ title: 'Reserved', kind: 'reserved' }) as never)).toBe('Reserved');
    expect(entryTitle(entry({ title: 'A vs B', score: { home: 2, away: 1 } }) as never)).toBe(
      'A vs B, 2 to 1',
    );
    expect(entryDetail(entry({ fields: [] }) as never, TZ)).toBe(
      '9:00 AM to 10:00 AM, Field to be announced',
    );
    expect(standingsRowText(row(1, 'Comets', 3))).toBe(
      'Played 1, won 1, drawn 0, lost 0, goals 5 to 3, 3 points',
    );
  });
});
