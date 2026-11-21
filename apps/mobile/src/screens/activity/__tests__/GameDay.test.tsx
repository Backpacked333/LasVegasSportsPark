/**
 * Handoff M 1i Game day (INTERACTIONS 1i rows 1 to 5; SPK-CAP-003, SPK-RESULT-001, SPK-RESULT-003,
 * SPK-SCHED-008, SPK-UX-009): the scoreboard band, who's playing with the household child's shared
 * answer, check in with the child's pass, team chat proposed, and the standings card that opens
 * the full table.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';
import { standings } from '../../../features/teams/testing/fixtures';
import {
  AWAY_ENTRY,
  CHILD,
  FIXTURE,
  fixtureDetail,
  HOME_ENTRY,
  inboxPage,
  me,
  names,
  ok,
  readiness,
  result,
  teamWorkspace,
} from '../../../features/today/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';
import { FixtureDetailScreen } from '../FixtureDetailScreen';
import { ordinal, recordLine, shortTeamName } from '../GameDay';

jest.mock('../../../features/today/device-time-zone', () => ({
  deviceTimeZone: () => 'America/Los_Angeles',
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
}));

beforeEach(() => mockPush.mockClear());

const SEASON = '0192f1a0-0000-7000-8000-00000000f301';
const PLAYED = '0192f1a0-0000-7000-8000-00000000f1a1';

/** Lions (the viewer's child's team) second of four, the playoff cut after second place. */
const TABLE = standings({
  seasonId: SEASON,
  rows: [
    {
      ...standings().rows[0]!,
      position: 1,
      teamEntryId: AWAY_ENTRY,
      teamName: 'Tigers',
      points: 18,
    },
    {
      ...standings().rows[0]!,
      position: 2,
      teamEntryId: HOME_ENTRY,
      teamName: 'Lions',
      won: 5,
      drawn: 1,
      lost: 1,
      goalDifference: 8,
      points: 16,
    },
    { ...standings().rows[0]!, position: 3, teamEntryId: PLAYED, teamName: 'Comets', points: 12 },
  ],
  playoffLine: {
    specificationId: PLAYED,
    kind: 'single_elimination',
    qualifyingTeams: 2,
    cutPosition: 2,
  },
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  const workspace = { ...teamWorkspace('Lions U9'), roster: [{ personId: CHILD }] };
  return {
    'GET /fixtures/{id}': ok(
      fixtureDetail({
        round: 7,
        responses: [
          { personId: CHILD, state: 'available', revision: 1, respondedAt: '2026-10-23T12:00:00Z' },
        ],
      }),
    ),
    'GET /fixtures/{id}/readiness': ok(readiness()),
    'GET /fixtures/{id}/results': (req) =>
      fakeResponse(200, req.params.id === PLAYED ? [result({ fixtureId: PLAYED })] : []),
    'GET /team-entries/{id}': (req) =>
      req.params.id === HOME_ENTRY
        ? fakeResponse(200, workspace)
        : fakeResponse(404, apiErrorBody('NOT_FOUND')),
    'GET /me': ok(me([{ subjectPersonId: CHILD, permissions: ['view', 'register'] }])),
    'GET /person-names': names({ [CHILD]: 'Maya' }),
    'GET /me/inbox': inboxPage([]),
    'GET /seasons/{id}/standings': ok(TABLE),
    'GET /seasons/{id}/fixtures': ok({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function renderGame(overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(overrides) });
  render(<FixtureDetailScreen fixtureId={FIXTURE} />, { wrapper: app.wrapper });
  return app;
}

describe('handoff M 1i Game day', () => {
  it('the band names the season, division and week, both teams with their place and record, and the kickoff', async () => {
    renderGame();
    const band = await screen.findByTestId('game-day');
    expect(
      within(band).getByRole('header', { name: 'Fall 2026 · Division 2 · Week 7' }),
    ).toBeTruthy();
    expect(
      await within(band).findByLabelText('Lions, your team, 2nd place, 5 won, 1 drawn, 1 lost'),
    ).toBeOnTheScreen();
    expect(within(band).getByText('2nd · 5-1-1')).toBeOnTheScreen();
    // Kickoff on the venue's clock (10:00 AM in Los Angeles).
    expect(within(band).getByLabelText(/^Kickoff 10:00 AM/)).toBeOnTheScreen();
    expect(within(band).getByRole('button', { name: 'Map' })).toBeOnTheScreen();
  });

  it("INTERACTIONS 1i row 2: who is playing, in a bar and in words, with the child's answer and Change", async () => {
    renderGame();
    const card = await screen.findByTestId('game-day-playing');
    expect(
      within(card).getByLabelText('5 going, 0 maybe, 1 not going, 4 no answer'),
    ).toBeOnTheScreen();
    // "Enough to play" needs players needed per game: hidden until that decision (PROPOSED).
    expect(within(card).queryByText(/Enough to play/)).toBeNull();
    expect(await within(card).findByText('Maya is going')).toBeOnTheScreen();
    fireEvent.press(within(card).getByRole('button', { name: "Change Maya's answer" }));
    // The shared answer control (the same as Home's).
    expect(await within(card).findByTestId('game-day-answer')).toBeOnTheScreen();
  });

  it('INTERACTIONS 1i row 4: check in opens the pass on the child; team chat is proposed; the coach is a message away', async () => {
    renderGame();
    fireEvent.press(await screen.findByRole('button', { name: "Check in with Maya's pass" }));
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/pass', params: { person: CHILD } });
    const chat = screen.getByTestId('game-day-team-chat');
    expect(within(chat).getByRole('button', { name: 'Team chat' })).toBeDisabled();
    expect(within(chat).getByText('Proposed')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('link', { name: 'Message the coach' }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: '/messages/coach',
      params: { fixtureId: FIXTURE },
    });
  });

  it('INTERACTIONS 1i row 5: standings with the playoff cut as a dashed line; the card opens the full table', async () => {
    renderGame();
    const card = await screen.findByTestId('game-day-standings');
    expect(within(card).getByText('Tigers')).toBeOnTheScreen();
    expect(within(card).getByText('Dashed line: playoff cut')).toBeOnTheScreen();
    expect(
      within(card).getByLabelText(
        'Playoff line: the top 2 teams qualify if the table ends as it stands',
      ),
    ).toBeOnTheScreen();
    fireEvent.press(card);
    expect(mockPush).toHaveBeenLastCalledWith(`/team/${HOME_ENTRY}/standings`);
  });

  it('a game with a result shows the score in the band', async () => {
    renderGame({
      'GET /fixtures/{id}/results': ok([
        result({ fixtureId: FIXTURE, homeScore: 3, awayScore: 1 }),
      ]),
    });
    expect(await screen.findByLabelText('Score 3 – 1')).toBeOnTheScreen();
    expect(screen.getByText('Final')).toBeOnTheScreen();
  });

  it('Share sends the game, its time and its place to the system share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    renderGame();
    fireEvent.press(await screen.findByRole('button', { name: 'Share the game' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0]?.[0]).toEqual({
      message: expect.stringMatching(/^Lions vs Tigers · .*10:00/),
    });
    share.mockRestore();
  });
});

describe('Game day words', () => {
  it('names a place, a record and a team without its age group', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ]);
    expect(recordLine(TABLE.rows[1])).toBe('2nd · 5-1-1');
    expect(shortTeamName('Desert Foxes U9')).toBe('Desert Foxes');
    expect(shortTeamName('U9')).toBe('U9');
  });
});
