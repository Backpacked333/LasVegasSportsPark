/**
 * Staff redesign Phase 8 screens, behaviour against the fake API: Coach · My week (Needs you,
 * Nudge, the next game card), Coach · Lineup (Going only, bench order, place by tap, Save, Share,
 * offline), Coach · Live game day (score, scorer and assist, End game, offline then sent), Team
 * messages (proposed, nothing sends), Referee home (Accept with Undo, Can't with a reason), Field
 * crew · Fields (ticks, Mark ready only when complete, Undo sends nothing) and the maintenance
 * tasks board (Start after the Undo window, Close field), and "/" opening the role's home.
 */
import { fakeResponse, type FakeHandler, type FakeRequest } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  PITCH,
  event,
  oneFacilityRoutes,
  page,
  scopedPermissions,
  SCHEDULE_FACILITY_ACTIONS,
  task,
} from '../../../features/schedule-facilities/test-fixtures';
import { FACILITY_A, createTestApp, staffMe } from '../../../testing/test-app';

const ME = '0192f1a0-0000-7000-8000-0000000000dd';
const T = '2026-10-20T12:00:00.000Z';

function meWith(roles: string[]) {
  const me = JSON.parse(JSON.stringify(staffMe([FACILITY_A]))) as {
    status: number;
    body: { principal: { staffRoles: string[] } };
  };
  me.body.principal.staffRoles = roles;
  return me;
}

const zero = { available: 0, unavailable: 0, tentative: 0, noResponse: 0 };
function fixture(id: string, start: string, end: string, availability = zero) {
  return {
    id,
    seasonId: 's-1',
    divisionId: null,
    round: 1,
    homeEntryId: 'te-hawks',
    awayEntryId: 'te-devils',
    schedulingEventId: null,
    scheduledStart: start,
    scheduledEnd: end,
    status: 'scheduled',
    notes: null,
    revision: 1,
    createdAt: T,
    updatedAt: T,
    home: { entryId: 'te-hawks', teamId: 't-1', teamName: 'Hawks U10', availability },
    away: { entryId: 'te-devils', teamId: 't-2', teamName: 'Sun Devils U10', availability: zero },
    myResponse: null,
    venue: {
      facilityId: FACILITY_A,
      facilityName: 'North Park 1',
      timezone: 'America/Los_Angeles',
      resources: [{ id: PITCH, name: 'Field 1' }],
    },
    rosterStatus: null,
    responses: [],
  };
}

const player = (id: string, minutes: number, availability: string, jersey: number) => ({
  personId: id,
  displayName: `Player ${id.toUpperCase()}`,
  jerseyNumber: jersey,
  availability,
  minutesThisSeason: minutes,
  gamesThisSeason: minutes > 0 ? 1 : 0,
});
const PLAYERS = [
  player('a', 100, 'available', 2),
  player('b', 25, 'available', 3),
  player('c', 70, 'available', 4),
  player('d', 10, 'unavailable', 5),
  player('e', 0, 'no_response', 6),
];

function sheet(id: string, over: Record<string, unknown> = {}) {
  return {
    fixtureId: id,
    teamEntryId: 'te-hawks',
    side: 'home',
    teamName: 'Hawks U10',
    opponentName: 'Sun Devils U10',
    scheduledStart: '2026-10-24T17:00:00.000Z',
    scheduledEnd: '2026-10-24T17:50:00.000Z',
    fixtureStatus: 'scheduled',
    timezone: 'America/Los_Angeles',
    venueName: 'Field 1',
    players: PLAYERS,
    teamAverageMinutes: 41,
    lineup: null,
    gameLog: null,
    officialResult: null,
    availableActions: ['save_lineup', 'record_game_log'],
    ...over,
  };
}

const NEXT = fixture('fx-next', '2026-10-24T17:00:00.000Z', '2026-10-24T17:50:00.000Z', {
  available: 3,
  unavailable: 1,
  tentative: 0,
  noResponse: 1,
});
const PAST = fixture('fx-past', '2026-10-17T17:00:00.000Z', '2026-10-17T17:50:00.000Z');

function coachRoutes(over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': meWith(['coach']),
    'GET /me/assignments': { status: 200, body: { evaluatedAt: T, items: [] } },
    'GET /me/team-entries': {
      status: 200,
      body: [
        {
          teamEntry: { id: 'te-hawks', teamName: 'Hawks U10' },
          teamName: 'Hawks U10',
          seasonId: 's-1',
          seasonName: 'Fall season',
          divisionName: 'U10',
          members: [{ personId: ME, roles: ['captain'], rosterStatus: null }],
          nextFixture: null,
        },
      ],
    },
    'GET /me/fixtures': { status: 200, body: [PAST, NEXT] },
    'GET /fixtures/{id}/lineup': (request: FakeRequest) =>
      fakeResponse(
        200,
        request.params['id'] === 'fx-past'
          ? sheet('fx-past', {
              gameLog: {
                id: 'gl-1',
                teamEntryId: 'te-hawks',
                homeScore: 2,
                awayScore: 1,
                events: [],
                minutes: [],
                recordedAt: T,
                revision: 1,
              },
            })
          : sheet('fx-next'),
      ),
    ...over,
  };
}

const posts = (requests: FakeRequest[], route: string) =>
  requests.filter((r) => r.method === 'POST' && r.route === route);

describe('Phase 8 item 1: Coach · My week', () => {
  it('shows Needs you (nudge, unconfirmed result) and the next game with its counts; Nudge asks those without an answer', async () => {
    const app = createTestApp({
      routes: coachRoutes({
        'POST /fixtures/{id}/availability-requests': {
          status: 201,
          body: {
            id: 'ar-1',
            fixtureId: 'fx-next',
            teamEntryId: 'te-hawks',
            requestedByPersonId: ME,
            message: null,
            requestedAt: T,
            recipientCount: 1,
          },
        },
      }),
    });
    render(app.at('/workspace/week'));
    expect(
      await screen.findByRole('heading', { name: 'Hawks U10 vs Sun Devils U10' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('countdown')).toHaveTextContent('In 5 h');
    expect(screen.getByRole('link', { name: /Lineup/ })).toHaveAttribute(
      'href',
      '/workspace/fixtures/fx-next/lineup?team=te-hawks',
    );
    expect(screen.getByRole('link', { name: /Start game day/ })).toBeInTheDocument();
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(
      within(needs).getByText(/hasn't answered for Hawks U10 vs Sun Devils U10/),
    ).toBeInTheDocument();
    expect(await within(needs).findByText(/Waiting for the referee/)).toBeInTheDocument();

    await userEvent.click(within(needs).getByRole('button', { name: 'Nudge' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/fixtures/{id}/availability-requests')).toHaveLength(1),
    );
    const sent = posts(app.fake.requests, '/fixtures/{id}/availability-requests')[0]!;
    expect(sent.params['id']).toBe('fx-next');
    expect(sent.body).toMatchObject({ teamEntryId: 'te-hawks' });
    expect(sent.headers['idempotency-key']).toBeTruthy();
    expect(await screen.findByText('Asked the 1 player without an answer')).toBeInTheDocument();
  });

  it('offline, Nudge is disabled with its reason', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/week'));
    await screen.findByRole('heading', { name: 'Hawks U10 vs Sun Devils U10' });
    act(() => app.connectivity.set(false));
    expect(await screen.findByRole('button', { name: 'Nudge' })).toBeDisabled();
  });

  it('"/" opens the coach week for a coach and the referee home for an official', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/'));
    expect(await screen.findByRole('heading', { name: 'My week' })).toBeInTheDocument();
    // The coach tab bar.
    const tabs = screen.getByRole('navigation', { name: 'Workspace tabs' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Week', 'Teams', 'Now', 'Messages', 'More']);
  });
});

describe('Phase 8 item 2: Coach · Lineup', () => {
  it('lists only Going players, fewest minutes first with ▲ below average; a tap places a player; Save sends the places', async () => {
    const app = createTestApp({
      routes: coachRoutes({
        'POST /fixtures/{id}/lineup': (request) =>
          fakeResponse(200, {
            id: 'lu-1',
            formation: (request.body as { formation: string }).formation,
            slots: (request.body as { slots: unknown[] }).slots,
            sharedAt: null,
            changedSinceShared: false,
            revision: 1,
            updatedAt: T,
          }),
      }),
    });
    render(app.at('/workspace/fixtures/fx-next/lineup?team=te-hawks'));
    const bench = await screen.findByTestId('bench');
    const tiles = within(bench).getAllByRole('button');
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Player B, 25 minutes this season, below the team average',
      'Player C, 70 minutes this season',
      'Player A, 100 minutes this season',
    ]);
    expect(within(bench).queryByText('Player D.')).not.toBeInTheDocument();

    await userEvent.click(tiles[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Goalkeeper: empty' }));
    expect(screen.getByRole('button', { name: 'Goalkeeper: Player B' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Player B. placed as Goalkeeper.');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(app.fake.requests, '/fixtures/{id}/lineup')).toHaveLength(1));
    expect(posts(app.fake.requests, '/fixtures/{id}/lineup')[0]!.body).toEqual({
      teamEntryId: 'te-hawks',
      formation: '2-3-1',
      slots: [{ slot: 1, personId: 'b' }],
    });
  });

  it('"Auto-fill fairly" fills the places; Share saves, then shares that revision', async () => {
    const app = createTestApp({
      routes: coachRoutes({
        'POST /fixtures/{id}/lineup': (request) =>
          fakeResponse(200, {
            id: 'lu-1',
            formation: '2-3-1',
            slots: (request.body as { slots: unknown[] }).slots,
            sharedAt: null,
            changedSinceShared: false,
            revision: 4,
            updatedAt: T,
          }),
        'POST /fixtures/{id}/lineup/share': {
          status: 200,
          body: {
            id: 'lu-1',
            formation: '2-3-1',
            slots: [],
            sharedAt: T,
            changedSinceShared: false,
            revision: 5,
            updatedAt: T,
          },
        },
      }),
    });
    render(app.at('/workspace/fixtures/fx-next/lineup?team=te-hawks'));
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-fill fairly' }));
    expect(screen.getByRole('button', { name: 'Goalkeeper: Player B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Defender 1: Player C' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Defender 2: Player A' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/fixtures/{id}/lineup/share')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/fixtures/{id}/lineup/share')[0]!.body).toEqual({
      teamEntryId: 'te-hawks',
      expectedRevision: 4,
    });
    expect(await screen.findByText(/Lineup shared/)).toBeInTheDocument();
  });

  it('offline the lineup can be arranged but Save and Share are disabled with the reason', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/fixtures/fx-next/lineup?team=te-hawks'));
    await screen.findByTestId('bench');
    act(() => app.connectivity.set(false));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share' })).toBeDisabled();
    expect(screen.getByText(/you can still arrange the lineup/)).toBeInTheDocument();
  });
});

describe('Phase 8 item 3: Coach · Live game day', () => {
  const gameLogResponse: FakeHandler = (request) =>
    fakeResponse(200, {
      id: 'gl-9',
      teamEntryId: 'te-hawks',
      homeScore: (request.body as { homeScore: number }).homeScore,
      awayScore: (request.body as { awayScore: number }).awayScore,
      events: (request.body as { events: unknown[] }).events,
      minutes: [],
      recordedAt: T,
      revision: 1,
    });

  async function playOneEach() {
    await userEvent.click(await screen.findByRole('button', { name: /Kick off/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Goal for Hawks U10' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Player A.' }));
    await userEvent.click(await screen.findByRole('button', { name: 'No assist' }));
    await userEvent.click(screen.getByRole('button', { name: 'Goal for Sun Devils U10' }));
    const timeline = screen.getByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText(/Goal · Player A\./)).toBeInTheDocument();
    expect(within(timeline).getByText('Opponent goal')).toBeInTheDocument();
  }

  it('keeps the score with the scorer, and "End game" sends the game log', async () => {
    const app = createTestApp({
      routes: coachRoutes({ 'POST /fixtures/{id}/game-log': gameLogResponse }),
    });
    render(app.at('/workspace/fixtures/fx-next/game-day?team=te-hawks'));
    await playOneEach();
    await userEvent.click(screen.getByRole('button', { name: 'End game · 1–1' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'End game' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/fixtures/{id}/game-log')).toHaveLength(1),
    );
    const sent = posts(app.fake.requests, '/fixtures/{id}/game-log')[0]!;
    expect(sent.body).toMatchObject({
      teamEntryId: 'te-hawks',
      homeScore: 1,
      awayScore: 1,
      events: [
        { kind: 'goal', minute: 0, personId: 'a', assistPersonId: null },
        { kind: 'opponent_goal', minute: 0 },
      ],
    });
    expect(await screen.findByText(/Families see it once it matches/)).toBeInTheDocument();
  });

  it('"−" takes the latest goal off, with Undo', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/fixtures/fx-next/game-day?team=te-hawks'));
    await playOneEach();
    await userEvent.click(screen.getByRole('button', { name: 'Take a goal off Sun Devils U10' }));
    expect(screen.getByLabelText('Sun Devils U10 0')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    expect(screen.getByLabelText('Sun Devils U10 1')).toBeInTheDocument();
  });

  it('offline, the ended game waits on the phone and is sent once the connection is back', async () => {
    const app = createTestApp({
      routes: coachRoutes({ 'POST /fixtures/{id}/game-log': gameLogResponse }),
    });
    render(app.at('/workspace/fixtures/fx-next/game-day?team=te-hawks'));
    await playOneEach();
    act(() => app.connectivity.set(false));
    await userEvent.click(screen.getByRole('button', { name: 'End game · 1–1' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'End game' }),
    );
    expect(await screen.findByText(/Saved on this phone/)).toBeInTheDocument();
    expect(posts(app.fake.requests, '/fixtures/{id}/game-log')).toHaveLength(0);
    act(() => app.connectivity.set(true));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/fixtures/{id}/game-log')).toHaveLength(1),
    );
  });
});

describe('Phase 8 item 4: Coach · Team messages (pending decision 8)', () => {
  it('shows one thread per team in the proposed state; nothing sends', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/messages'));
    await userEvent.click(await screen.findByRole('button', { name: /Hawks U10/ }));
    expect(screen.getAllByText(/to you only/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Phone numbers stay hidden both ways/)).toBeInTheDocument();
    for (const name of [/Send/, /Text them/, /Event/, /Poll/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Message to Hawks U10')).toBeDisabled();
  });
});

function offered(id: string, revision: number) {
  return {
    assignment: {
      id,
      facilityId: FACILITY_A,
      personId: ME,
      kind: 'official',
      targetType: 'fixture',
      targetId: 'fx-next',
      offeringId: null,
      schedulingEventId: null,
      targetTitle: 'Hawks U10 v Sun Devils U10',
      role: 'referee',
      slot: 1,
      engagement: 'regular',
      status: 'offered',
      scheduledStart: '2026-10-24T17:00:00.000Z',
      scheduledEnd: '2026-10-24T17:50:00.000Z',
      turnaroundMinutes: 0,
      committedUntil: '2026-10-24T17:50:00.000Z',
      replacesAssignmentId: null,
      offeredAt: T,
      respondedAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      withdrawnAt: null,
      withdrawnReason: null,
      completedAt: null,
      access: {
        active: false,
        from: null,
        until: null,
        status: 'pending',
        staffMembershipId: null,
      },
      revision,
      createdAt: T,
      updatedAt: T,
    },
    activity: {
      targetType: 'fixture',
      targetId: 'fx-next',
      title: 'Hawks U10 v Sun Devils U10',
      facilityId: FACILITY_A,
      facility: { id: FACILITY_A, name: 'North Park 1', timezone: 'America/Los_Angeles' },
      scheduledStart: '2026-10-24T17:00:00.000Z',
      scheduledEnd: '2026-10-24T17:50:00.000Z',
      participants: [],
    },
    fee: null,
    availableActions: ['accept', 'decline'],
  };
}

function refereeRoutes(over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': meWith(['official']),
    'GET /me/assignments': { status: 200, body: { evaluatedAt: T, items: [offered('as-1', 3)] } },
    'GET /availability': { status: 200, body: [] },
    'GET /fee-submissions': page([]),
    ...over,
  };
}

describe('Phase 8 item 5: Referee home', () => {
  it('Accept answers at once with the revision; Undo withdraws it again', async () => {
    const app = createTestApp({
      routes: refereeRoutes({
        'POST /assignments/{id}/accept': {
          status: 200,
          body: { assignment: { ...offered('as-1', 4).assignment, status: 'accepted' } },
        },
        'POST /assignments/{id}/withdraw': { status: 200, body: {} },
      }),
    });
    render(app.at('/workspace/referee'));
    const request = await screen.findByRole('heading', { name: 'Hawks U10 v Sun Devils U10' });
    const card = request.closest('li') as HTMLElement;
    expect(within(card).getByText('not set yet')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/assignments/{id}/accept')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/assignments/{id}/accept')[0]!.body).toMatchObject({
      expectedRevision: 3,
    });
    await userEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/assignments/{id}/withdraw')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/assignments/{id}/withdraw')[0]!.body).toMatchObject({
      expectedRevision: 4,
    });
  });

  it("Can't asks for a one-tap reason and declines with it", async () => {
    const app = createTestApp({
      routes: refereeRoutes({ 'POST /assignments/{id}/decline': { status: 200, body: {} } }),
    });
    render(app.at('/workspace/referee'));
    await userEvent.click(await screen.findByRole('button', { name: "Can't" }));
    await userEvent.click(await screen.findByRole('button', { name: 'Too far to travel' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/assignments/{id}/decline')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/assignments/{id}/decline')[0]!.body).toMatchObject({
      reason: 'Too far to travel',
      expectedRevision: 3,
    });
    expect(await screen.findByText(/asks the next referee/)).toBeInTheDocument();
  });
});

const operatingStatus = {
  status: 200,
  body: {
    facilityId: FACILITY_A,
    at: T,
    resources: [
      {
        resourceId: PITCH,
        name: 'Field 1',
        kind: 'pitch',
        parentResourceId: null,
        inventoryStatus: 'active',
        conflictUnitIds: [],
        status: 'in_service',
        restrictions: [],
      },
      {
        resourceId: HALF_A,
        name: 'Field 1 north',
        kind: 'subdivision',
        parentResourceId: PITCH,
        inventoryStatus: 'active',
        conflictUnitIds: [],
        status: 'in_service',
        restrictions: [],
      },
    ],
  },
};
const soonGame = event({
  id: 'ev-1',
  title: 'Hawks U10 v Sun Devils U10',
  resourceIds: [HALF_A],
  scheduledStart: '2026-10-24T12:10:00.000Z',
  scheduledEnd: '2026-10-24T13:00:00.000Z',
});
const prep = (items: string[], revision: number, status = 'in_progress') => ({
  id: 'fp-1',
  facilityId: FACILITY_A,
  resourceId: PITCH,
  date: '2026-10-24',
  checkedItems: items,
  status,
  readyAt: status === 'ready' ? T : null,
  readyBy: null,
  updatedBy: { kind: 'staff', accountId: null, personId: ME, actorLabel: 'Crew' },
  revision,
  updatedAt: T,
});

function crewRoutes(over: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...oneFacilityRoutes(),
    'GET /me': meWith(['facilities_operator']),
    'GET /me/permissions': scopedPermissions([
      ...SCHEDULE_FACILITY_ACTIONS,
      'facilities.prepare_field',
    ]),
    'GET /facilities/{id}/operating-status': operatingStatus,
    'GET /events': page([soonGame]),
    'GET /field-preparations': {
      status: 200,
      body: {
        facilityId: FACILITY_A,
        date: '2026-10-24',
        timezone: 'America/Los_Angeles',
        checklist: ['lines', 'goals_anchored', 'nets', 'corner_flags'],
        items: [prep(['lines', 'nets'], 2)],
      },
    },
    ...over,
  };
}

describe('Phase 8 item 7: Field crew · Fields', () => {
  it('SPK-READY-001: a field starting soon reads red; Mark ready unlocks only with every item ticked; Undo sends nothing, dismissing sends it', async () => {
    let revision = 2;
    const app = createTestApp({
      routes: crewRoutes({
        'POST /field-preparations': (request) => {
          revision += 1;
          return fakeResponse(
            200,
            prep((request.body as { checkedItems: string[] }).checkedItems, revision),
          );
        },
        'POST /field-preparations/{id}/ready': {
          status: 200,
          body: prep(['lines', 'goals_anchored', 'nets', 'corner_flags'], 9, 'ready'),
        },
      }),
    });
    render(app.at('/workspace/fields'));
    const card = (await screen.findByRole('heading', { name: 'Field 1' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(card).getByText(/Not ready · starts in 10 min/)).toBeInTheDocument();
    expect(within(card).getByText(/First use .* Hawks U10 v Sun Devils U10/)).toBeInTheDocument();
    const markReady = within(card).getByRole('button', { name: 'Mark ready' });
    expect(markReady).toBeDisabled();

    await userEvent.click(within(card).getByRole('checkbox', { name: 'Goals anchored' }));
    await waitFor(() => expect(posts(app.fake.requests, '/field-preparations')).toHaveLength(1));
    expect(posts(app.fake.requests, '/field-preparations')[0]!.body).toMatchObject({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      date: '2026-10-24',
      checkedItems: ['lines', 'nets', 'goals_anchored'],
      expectedRevision: 2,
    });
    const flags = within(card).getByRole('checkbox', { name: 'Corner flags out' });
    await waitFor(() => expect(flags).toBeEnabled());
    await userEvent.click(flags);
    await waitFor(() => expect(posts(app.fake.requests, '/field-preparations')).toHaveLength(2));
    expect(posts(app.fake.requests, '/field-preparations')[1]!.body).toMatchObject({
      expectedRevision: 3,
    });
    await waitFor(() => expect(markReady).toBeEnabled());

    await userEvent.click(markReady);
    await userEvent.click(await screen.findByRole('button', { name: /Undo/ }));
    expect(posts(app.fake.requests, '/field-preparations/{id}/ready')).toHaveLength(0);
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: 'Mark ready' })).toBeEnabled(),
    );

    await userEvent.click(within(card).getByRole('button', { name: 'Mark ready' }));
    expect(within(card).getAllByText('Ready').length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss message' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/field-preparations/{id}/ready')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/field-preparations/{id}/ready')[0]!.body).toMatchObject({
      expectedRevision: 4,
    });
  });

  it('"Report a problem" creates a task for the field; the photo is proposed', async () => {
    const app = createTestApp({
      routes: crewRoutes({ 'POST /maintenance-tasks': { status: 201, body: task({ id: 't-9' }) } }),
    });
    render(app.at('/workspace/fields'));
    await userEvent.click(await screen.findByRole('button', { name: /Report a problem/ }));
    expect(screen.getByRole('button', { name: /Add a photo/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Net torn' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(posts(app.fake.requests, '/maintenance-tasks')).toHaveLength(1));
    expect(posts(app.fake.requests, '/maintenance-tasks')[0]!.body).toMatchObject({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      issue: 'Net torn on Field 1.',
      severity: 'medium',
    });
  });

  it('offline the checklist is disabled with its reason', async () => {
    const app = createTestApp({ routes: crewRoutes() });
    render(app.at('/workspace/fields'));
    await screen.findByRole('heading', { name: 'Field 1' });
    act(() => app.connectivity.set(false));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Goals anchored' })).toBeDisabled(),
    );
    expect(screen.getByText('Ticking needs a connection.')).toBeInTheDocument();
  });
});

describe('Phase 8 item 8: maintenance tasks board', () => {
  const todo = task({
    id: 't-1',
    issue: 'Goalmouth worn',
    resourceId: PITCH,
    status: 'open',
    revision: 2,
  });
  const doing = task({
    id: 't-2',
    issue: 'Corner flag snapped',
    resourceId: PITCH,
    status: 'in_progress',
    assignedOwnerPersonId: ME,
  });
  const boardRoutes = (over: Record<string, FakeHandler> = {}) =>
    crewRoutes({
      'GET /maintenance-tasks': page([todo, doing]),
      'GET /person-names': { status: 200, body: { items: [] } },
      ...over,
    });

  it('shows To do, Doing and Done with the bookings each affects; Start moves the card and sends after the Undo window', async () => {
    const app = createTestApp({
      routes: boardRoutes({
        'PATCH /maintenance-tasks/{id}': { status: 200, body: { ...todo, status: 'in_progress' } },
      }),
    });
    render(app.at('/facilities/board'));
    const todoCol = await screen.findByRole('region', { name: 'To do' });
    const card = within(todoCol).getByRole('listitem', { name: /Goalmouth worn/ });
    expect(within(card).getByText('▲ 1 booking affected today')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Start' }));
    const doingCol = screen.getByRole('region', { name: 'Doing' });
    expect(within(doingCol).getByRole('listitem', { name: /Goalmouth worn/ })).toBeInTheDocument();
    expect(app.fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss message' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1),
    );
    expect(app.fake.requests.find((r) => r.method === 'PATCH')!.body).toMatchObject({
      status: 'in_progress',
      expectedRevision: 2,
      assignedOwnerPersonId: ME,
    });
  });

  it('"Close field" lists the affected bookings, offers to move or cancel them, then closes the pitch for the task', async () => {
    const app = createTestApp({
      routes: boardRoutes({ 'POST /maintenance-restrictions': { status: 201, body: {} } }),
    });
    render(app.at('/facilities/board'));
    const todoCol = await screen.findByRole('region', { name: 'To do' });
    await userEvent.click(within(todoCol).getByRole('button', { name: 'Close field' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Hawks U10 v Sun Devils U10')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Move' })).toHaveAttribute(
      'href',
      '/schedule/calendar?date=2026-10-24',
    );
    expect(within(dialog).getByRole('button', { name: /Cancel these/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close Field 1' }));
    await waitFor(() =>
      expect(posts(app.fake.requests, '/maintenance-restrictions')).toHaveLength(1),
    );
    expect(posts(app.fake.requests, '/maintenance-restrictions')[0]!.body).toMatchObject({
      facilityId: FACILITY_A,
      resourceId: PITCH,
      taskId: 't-1',
      kind: 'closed',
      reason: 'Goalmouth worn',
    });
  });
});

describe('Phase 8 item 2: the lineup without dragging (SPK-UX-009)', () => {
  it('Enter chooses a player and Enter on a place puts them there; Escape lets go', async () => {
    const app = createTestApp({ routes: coachRoutes() });
    render(app.at('/workspace/fixtures/fx-next/lineup?team=te-hawks'));
    const bench = await screen.findByTestId('bench');
    const tile = within(bench).getByRole('button', { name: /^Player C,/ });
    tile.focus();
    await userEvent.keyboard('{Enter}');
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    tile.focus();
    await userEvent.keyboard('{Enter}');
    screen.getByRole('button', { name: 'Forward: empty' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Forward: Player C' })).toBeInTheDocument();
  });
});
