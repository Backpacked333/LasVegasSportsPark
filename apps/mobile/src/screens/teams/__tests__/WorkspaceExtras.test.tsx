/**
 * SCR-C-22 team workspace, park UI additions: the form guide from official results only
 * (SPK-RESULT-001), mini standings with the playoff line (SPK-RESULT-003), the next game's
 * availability progress for the management view (SPK-CAP-003), and the captain's check-in of their
 * own side (`GET`/`POST /v1/fixtures/{id}/attendance`, SPK-UX-007, SPK-STAFF-005).
 */
import { apiErrorBody, fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  IDS,
  baseRoutes,
  fixture,
  playerWorkspace,
  result,
  standings,
  upcoming,
  workspace,
} from '../../../features/teams/testing/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { TeamWorkspaceScreen } from '../TeamWorkspaceScreen';
import { formFixtures, miniRows, outcomeFor } from '../WorkspaceExtras';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const f = (n: number) => `0192f1a0-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
const THIRD = '0192f1a0-0000-7000-8000-000000000014';

/** Three played games (won 2-1 away, drew 1-1, lost by forfeit) and the upcoming one. */
const SEASON_FIXTURES = [
  {
    ...fixture({
      id: f(1),
      status: 'played',
      scheduledStart: '2026-10-03T17:00:00.000Z',
      homeEntryId: IDS.opponentEntry,
      awayEntryId: IDS.entry,
    }),
    homeTeamName: 'Canyon Hawks',
    awayTeamName: 'Desert Foxes',
  },
  {
    ...fixture({ id: f(2), status: 'played', scheduledStart: '2026-10-10T17:00:00.000Z' }),
    homeTeamName: 'Desert Foxes',
    awayTeamName: 'Canyon Hawks',
  },
  {
    ...fixture({ id: f(3), status: 'forfeit', scheduledStart: '2026-10-17T17:00:00.000Z' }),
    homeTeamName: 'Desert Foxes',
    awayTeamName: 'Canyon Hawks',
  },
  { ...fixture(), homeTeamName: 'Desert Foxes', awayTeamName: 'Canyon Hawks' },
];
const RESULTS: Record<string, unknown[]> = {
  [f(1)]: [result({ fixtureId: f(1), homeScore: 1, awayScore: 2 })],
  [f(2)]: [
    result({ fixtureId: f(2), homeScore: 3, awayScore: 0, status: 'superseded' }),
    result({ fixtureId: f(2), homeScore: 1, awayScore: 1 }),
  ],
  [f(3)]: [
    result({
      fixtureId: f(3),
      classification: 'forfeit',
      homeScore: null,
      awayScore: null,
      forfeitingEntryId: IDS.entry,
    }),
  ],
};

const TABLE = standings({
  rows: [
    ...standings().rows,
    {
      ...standings().rows[0]!,
      position: 3,
      teamEntryId: THIRD,
      teamName: 'Mesa Owls',
      points: 3,
      goalDifference: -4,
    },
  ],
  playoffLine: {
    specificationId: f(90),
    kind: 'single_elimination',
    qualifyingTeams: 2,
    cutPosition: 2,
  },
});

/** The attendance read as the API answers it, with each POST applied (latest mark per player). */
function attendanceApi() {
  const marks = new Map<string, 'present' | 'absent'>([[IDS.me, 'present']]);
  const view = () => {
    const list = [...marks].map(([personId, state]) => ({
      id: f(50),
      fixtureId: IDS.fixture,
      teamEntryId: IDS.entry,
      personId,
      state,
      recordedBy: { kind: 'customer', accountId: null, personId: IDS.me, actorLabel: 'Casey' },
      recordedAt: '2026-10-24T12:00:00.000Z',
    }));
    return {
      fixtureId: IDS.fixture,
      sides: [
        {
          teamEntryId: IDS.entry,
          present: list.filter((m) => m.state === 'present').length,
          absent: list.filter((m) => m.state === 'absent').length,
          marks: list,
        },
      ],
    };
  };
  return {
    get: () => fakeResponse(200, view()),
    post: (req: FakeRequest) => {
      const body = req.body as { personId: string; state: 'present' | 'absent' | 'cleared' };
      if (body.state === 'cleared') marks.delete(body.personId);
      else marks.set(body.personId, body.state);
      return fakeResponse(201, view().sides[0]!.marks[0]);
    },
  };
}

function routes(overrides = {}) {
  const attendance = attendanceApi();
  return baseRoutes({
    'GET /seasons/{id}/standings': { status: 200, body: TABLE },
    'GET /seasons/{id}/fixtures': {
      status: 200,
      body: { items: SEASON_FIXTURES, nextCursor: null },
    },
    'GET /fixtures/{id}/results': (req: FakeRequest) =>
      fakeResponse(200, RESULTS[req.params.id ?? ''] ?? []),
    'GET /fixtures/{id}/attendance': attendance.get,
    'POST /fixtures/{id}/attendance': attendance.post,
    ...overrides,
  });
}

describe('SCR-C-22 workspace: form, mini standings, availability progress, check-in', () => {
  it('SPK-RESULT-001: the form guide reads the official results only, oldest first, in words', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(
      await screen.findByLabelText('Form, last 3 official results, oldest first: won, drew, lost'),
    ).toBeOnTheScreen();
    const read = app.fake.requests.find((r) => r.route === '/seasons/{id}/fixtures');
    expect(read?.query).toEqual({ teamEntryId: IDS.entry, limit: '200' });
    // The upcoming (scheduled) game is not asked for results.
    expect(app.fake.requests.some((r) => r.path === `/fixtures/${IDS.fixture}/results`)).toBe(
      false,
    );
  });

  it('shows no form while a result read has not answered, and none when the reads fail', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /seasons/{id}/fixtures': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('mini-standings')).toBeOnTheScreen();
    expect(screen.queryByTestId('form-guide')).toBeNull();
  });

  it('SPK-RESULT-003: the mini table names the team and draws the playoff line under the cut', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const table = await screen.findByTestId('mini-standings');
    expect(
      within(table).getByLabelText('2nd, Desert Foxes (your team), goal difference +3, 9 points'),
    ).toBeOnTheScreen();
    expect(
      within(table).getByLabelText(
        'Playoff line: the top 2 teams qualify if the table ends as it stands',
      ),
    ).toBeOnTheScreen();
    expect(
      within(table).getByLabelText('3rd, Mesa Owls, goal difference -4, 3 points'),
    ).toBeOnTheScreen();
  });

  it('SPK-CAP-003: the captain sees how many said they are available for the next game', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const progress = await screen.findByRole('progressbar', {
      name: 'Next game: 1 of 3 available',
    });
    expect(progress).toHaveProp('accessibilityValue', {
      min: 0,
      max: 3,
      now: 1,
      text: '1 of 3 available',
    });
  });

  it('SPK-UX-007: the captain checks in their own players and the count is the API’s', async () => {
    const app = createTestApp({ routes: routes() });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('match-check-in');
    expect(
      await within(section).findByLabelText('Checked in: 1 present, 0 absent, of 3 players'),
    ).toBeOnTheScreen();
    // A requested (not yet rostered) player is not listed.
    expect(within(section).queryByText('Riley Requester')).toBeNull();

    fireEvent.press(within(section).getByRole('button', { name: 'Absent: Pat Player' }));
    expect(
      await within(section).findByLabelText('Checked in: 1 present, 1 absent, of 3 players'),
    ).toBeOnTheScreen();
    const post = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/fixtures/{id}/attendance',
    );
    expect(post?.params.id).toBe(IDS.fixture);
    expect(post?.body).toEqual({ teamEntryId: IDS.entry, personId: IDS.player2, state: 'absent' });
    expect(post?.headers['idempotency-key']).toBeTruthy();

    fireEvent.press(within(section).getByRole('button', { name: 'Clear: Casey Captain' }));
    expect(
      await within(section).findByLabelText('Checked in: 0 present, 1 absent, of 3 players'),
    ).toBeOnTheScreen();
  });

  it('a failed mark shows the API’s answer with its code, and the retry resends the same mark', async () => {
    const api = attendanceApi();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'GET /fixtures/{id}/attendance': api.get,
        'POST /fixtures/{id}/attendance': (req: FakeRequest) => {
          calls += 1;
          return calls === 1 ? fakeResponse(500, apiErrorBody('INTERNAL_ERROR')) : api.post(req);
        },
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const section = await screen.findByTestId('match-check-in');
    fireEvent.press(await within(section).findByRole('button', { name: 'Absent: Kim Junior' }));
    const failure = await within(section).findByTestId(`check-in-failure-${IDS.child}`);
    expect(within(failure).getByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();

    fireEvent.press(within(failure).getByRole('button', { name: /^(Try again|Check again)$/ }));
    expect(
      await within(section).findByLabelText('Checked in: 1 present, 1 absent, of 3 players'),
    ).toBeOnTheScreen();
    const posts = app.fake.requests.filter(
      (r) => r.method === 'POST' && r.route === '/fixtures/{id}/attendance',
    );
    expect(posts.map((r) => (r.body as { state: string }).state)).toEqual(['absent', 'absent']);
  });

  it('protected NOT_FOUND on the check-in read is "not available", without implying more', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /fixtures/{id}/attendance': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    const failure = await screen.findByTestId('check-in-error');
    expect(within(failure).getByText('Check-in is not available for this game.')).toBeOnTheScreen();
  });

  it('a roster player gets neither the progress nor the check-in; a game not scheduled has no check-in', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /team-entries/{id}': { status: 200, body: playerWorkspace() } }),
    });
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: app.wrapper });
    expect(await screen.findByTestId('mini-standings')).toBeOnTheScreen();
    expect(screen.queryByTestId('rsvp-progress')).toBeNull();
    expect(screen.queryByTestId('match-check-in')).toBeNull();

    const postponed = createTestApp({
      routes: routes({
        'GET /team-entries/{id}': {
          status: 200,
          body: workspace({
            upcomingFixtures: [upcoming({ fixture: fixture({ status: 'postponed' }) })],
          }),
        },
      }),
    });
    screen.unmount();
    render(<TeamWorkspaceScreen entryId={IDS.entry} />, { wrapper: postponed.wrapper });
    expect(await screen.findByTestId('mini-standings')).toBeOnTheScreen();
    expect(screen.queryByTestId('check-in-section')).toBeNull();
    await waitFor(() =>
      expect(postponed.fake.requests.some((r) => r.route === '/fixtures/{id}/attendance')).toBe(
        false,
      ),
    );
  });

  it('pure helpers: outcomes, the fixtures counted and the rows shown', () => {
    const won = result({ homeScore: 1, awayScore: 2 });
    expect(outcomeFor(IDS.entry, won, { homeEntryId: IDS.opponentEntry })).toBe('W');
    expect(
      outcomeFor(IDS.entry, { ...won, status: 'submitted' }, { homeEntryId: IDS.entry }),
    ).toBeNull();
    expect(formFixtures(SEASON_FIXTURES).map((x) => x.id)).toEqual([f(1), f(2), f(3)]);
    const long = standings({
      rows: Array.from({ length: 10 }, (_, i) => ({
        ...standings().rows[0]!,
        position: i + 1,
        teamEntryId: i === 6 ? IDS.entry : f(60 + i),
      })),
    });
    expect(miniRows(long, IDS.entry).map((r) => r.position)).toEqual([5, 6, 7, 8, 9]);
  });
});
