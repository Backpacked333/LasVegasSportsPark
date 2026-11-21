/**
 * The Phase 8 rules as pure functions (staff redesign "specified, not yet drawn"): the lineup's
 * bench order, ▲ below average, place or swap and "Auto-fill fairly" (item 2); the live game's
 * clock, score and minutes (item 3); field readiness and the 15-minute manager issue (item 7);
 * the home per role.
 */
import { describe, expect, it } from 'vitest';
import type { ResourceStatus, ScheduledEvent } from '../../today/today-model';
import {
  fieldDays,
  fieldIssues,
  pitchOf,
  preparationForEvent,
  type FieldPreparation,
} from '../../today/field-readiness';
import {
  minuteOf,
  minutesPlayed,
  newGame,
  onPitchOf,
  phaseOf,
  scoreOf,
  withoutLastGoal,
  type GameState,
} from '../game-day-model';
import {
  autoFillFairly,
  belowAverage,
  benchOf,
  placeName,
  placeOrSwap,
  placesOf,
  rowsOf,
  type TeamSheetPlayer,
} from '../lineup-model';
import { homePathOf, workspaceKindOf } from '../workspace-kind';

const player = (
  id: string,
  minutes: number,
  availability: TeamSheetPlayer['availability'] = 'available',
  jersey = 1,
): TeamSheetPlayer => ({
  personId: id,
  displayName: `Player ${id.toUpperCase()}`,
  jerseyNumber: jersey,
  availability,
  minutesThisSeason: minutes,
  gamesThisSeason: minutes > 0 ? 1 : 0,
});

describe('Phase 8 item 2: lineup rules', () => {
  const players = [
    player('a', 100, 'available', 2),
    player('b', 25, 'available', 3),
    player('c', 70, 'available', 4),
    player('d', 10, 'unavailable', 5),
    player('e', 0, 'no_response', 6),
    player('f', 25, 'available', 1),
  ];

  it('a formation names its places from the goalkeeper up', () => {
    expect(placesOf('2-3-1')).toBe(7);
    expect(rowsOf('2-3-1')).toEqual([
      { line: 0, slots: [1] },
      { line: 1, slots: [2, 3] },
      { line: 2, slots: [4, 5, 6] },
      { line: 3, slots: [7] },
    ]);
    expect(placeName('2-3-1', 1)).toBe('Goalkeeper');
    expect(placeName('2-3-1', 3)).toBe('Defender 2');
    expect(placeName('2-3-1', 5)).toBe('Midfielder 2');
    expect(placeName('2-3-1', 7)).toBe('Forward');
  });

  it('only Going players are on the bench, the fewest minutes this season first', () => {
    const bench = benchOf(players, { 1: 'a' });
    // f and b share 25 minutes: the lower jersey number first.
    expect(bench.map((p) => p.personId)).toEqual(['f', 'b', 'c']);
  });

  it('▲ marks a player below the team average', () => {
    expect(belowAverage(player('x', 25), 40)).toBe(true);
    expect(belowAverage(player('x', 40), 40)).toBe(false);
  });

  it('a bench player takes a place (whoever stood there goes to the bench); two places swap', () => {
    const placed = placeOrSwap(
      { 1: 'a' },
      { kind: 'bench', personId: 'b' },
      { kind: 'slot', slot: 1 },
    );
    expect(placed).toEqual({ 1: 'b' });
    const swapped = placeOrSwap(
      { 1: 'a', 2: 'b' },
      { kind: 'slot', slot: 1 },
      { kind: 'slot', slot: 2 },
    );
    expect(swapped).toEqual({ 1: 'b', 2: 'a' });
    const moved = placeOrSwap({ 1: 'a' }, { kind: 'slot', slot: 1 }, { kind: 'slot', slot: 4 });
    expect(moved).toEqual({ 4: 'a' });
    const benched = placeOrSwap(
      { 1: 'a', 2: 'b' },
      { kind: 'slot', slot: 2 },
      { kind: 'bench', personId: '' },
    );
    expect(benched).toEqual({ 1: 'a' });
  });

  it('"Auto-fill fairly" keeps the goalkeeper and starts the fewest minutes', () => {
    const filled = autoFillFairly(players, { 1: 'a' }, '1-1');
    expect(filled).toEqual({ 1: 'a', 2: 'f', 3: 'b' });
    // Without a keeper, the fairest player keeps goal too.
    expect(autoFillFairly(players, {}, '1-1')).toEqual({ 1: 'f', 2: 'b', 3: 'c' });
  });
});

describe('Phase 8 item 3: the live game', () => {
  const start = '2026-11-21T17:00:00.000Z';
  const at = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000);
  const game = (patch: Partial<GameState> = {}): GameState => ({
    ...newGame(['a', 'b']),
    startedAt: start,
    ...patch,
  });

  it('the clock runs in each half and stands still at half time and after the end', () => {
    expect(phaseOf(newGame([]))).toBe('before');
    expect(minuteOf(game(), at(12))).toBe(12);
    const half = game({ halfTimeAt: at(25).toISOString() });
    expect(phaseOf(half)).toBe('half_time');
    expect(minuteOf(half, at(35))).toBe(25);
    const second = { ...half, secondHalfAt: at(30).toISOString() };
    expect(minuteOf(second, at(40))).toBe(35);
    expect(minuteOf({ ...second, endedAt: at(55).toISOString() }, at(90))).toBe(50);
  });

  it('the score and the − button follow the timeline', () => {
    const g = game({
      events: [
        { kind: 'goal', minute: 5, personId: 'a', assistPersonId: 'b' },
        { kind: 'opponent_goal', minute: 9 },
        { kind: 'goal', minute: 20, personId: 'b', assistPersonId: null },
      ],
    });
    expect(scoreOf(g, 'home')).toEqual({ home: 2, away: 1 });
    expect(scoreOf(g, 'away')).toEqual({ home: 1, away: 2 });
    const less = withoutLastGoal(g, true)!;
    expect(scoreOf(less, 'home')).toEqual({ home: 1, away: 1 });
    expect(withoutLastGoal(game(), false)).toBeNull();
  });

  it('a substitution changes who is on the pitch and splits the minutes', () => {
    const g = game({
      events: [{ kind: 'substitution', minute: 30, offPersonId: 'b', onPersonId: 'c' }],
    });
    expect(onPitchOf(g)).toEqual(['a', 'c']);
    expect([...minutesPlayed(g, 50)].sort((x, y) => x.personId.localeCompare(y.personId))).toEqual([
      { personId: 'a', minutes: 50 },
      { personId: 'b', minutes: 30 },
      { personId: 'c', minutes: 20 },
    ]);
  });
});

describe('Phase 8 item 7: field readiness', () => {
  const resource = (
    id: string,
    kind: ResourceStatus['kind'],
    parent: string | null = null,
    restrictions: ResourceStatus['restrictions'] = [],
  ): ResourceStatus =>
    ({
      resourceId: id,
      name: id === 'p1' ? 'Field 1' : id === 'p2' ? 'Field 2' : id,
      kind,
      parentResourceId: parent,
      inventoryStatus: 'active',
      conflictUnitIds: [],
      status: restrictions.length > 0 ? 'restricted' : 'in_service',
      restrictions,
    }) as ResourceStatus;
  const event = (id: string, resourceId: string, start: string, end: string) =>
    ({
      id,
      facilityId: 'f',
      kind: 'game',
      title: `Game ${id}`,
      status: 'published',
      resourceIds: [resourceId],
      scheduledStart: start,
      scheduledEnd: end,
    }) as unknown as ScheduledEvent;
  const prep = (resourceId: string, items: FieldPreparation['checkedItems'], ready = false) =>
    ({
      id: `prep-${resourceId}`,
      resourceId,
      checkedItems: items,
      status: ready ? 'ready' : 'in_progress',
    }) as FieldPreparation;
  const resources = [
    resource('p1', 'pitch'),
    resource('p1n', 'subdivision', 'p1'),
    resource('p2', 'pitch'),
    resource('court', 'room'),
  ];
  const now = new Date('2026-11-21T16:50:00.000Z');
  const events = [
    event('late', 'p2', '2026-11-21T19:00:00.000Z', '2026-11-21T20:00:00.000Z'),
    event('soon', 'p1n', '2026-11-21T17:00:00.000Z', '2026-11-21T18:00:00.000Z'),
  ];

  it('a half shares its pitch; only pitches are prepared, ordered by first use', () => {
    expect(pitchOf('p1n', resources)?.resourceId).toBe('p1');
    expect(pitchOf('court', resources)).toBeUndefined();
    const days = fieldDays(resources, events, [], now);
    expect(days.map((d) => d.pitch.resourceId)).toEqual(['p1', 'p2']);
  });

  it('SPK-READY-001: a pitch not ready 15 minutes before its first use is the manager’s issue', () => {
    const notReady = fieldIssues(fieldDays(resources, events, [prep('p1', ['lines'])], now), now);
    expect(notReady.map((i) => [i.pitch.resourceId, i.progress.done])).toEqual([['p1', 1]]);
    // 16 minutes before, not yet; once ready, never.
    const early = new Date('2026-11-21T16:44:00.000Z');
    expect(fieldIssues(fieldDays(resources, events, [], early), early)).toEqual([]);
    const ready = [prep('p1', ['lines', 'goals_anchored', 'nets', 'corner_flags'], true)];
    expect(fieldIssues(fieldDays(resources, events, ready, now), now)).toEqual([]);
    // A closed pitch is the restriction's business.
    const closed = [
      resource('p1', 'pitch', null, [
        {
          restrictionId: 'r',
          kind: 'closed',
          reason: 'Irrigation',
          interval: { start: now.toISOString(), end: now.toISOString() },
          taskId: null,
          resourceId: 'p1',
          affectedConflictUnitIds: [],
        },
      ]),
      resource('p1n', 'subdivision', 'p1'),
    ];
    expect(fieldIssues(fieldDays(closed, events, [], now), now)).toEqual([]);
  });

  it('the Field check of a start reads its pitch’s preparation (urgent within 15 minutes)', () => {
    const day = {
      facilityId: 'f',
      date: '2026-11-21',
      timezone: 'UTC',
      checklist: [],
      items: [prep('p1', ['lines', 'nets'])],
    } as never;
    expect(preparationForEvent(events[1]!, resources, day, now)).toMatchObject({
      pitchName: 'Field 1',
      progress: { ready: false, done: 2, total: 4 },
      urgent: true,
    });
    expect(preparationForEvent(events[0]!, resources, day, now)).toMatchObject({ urgent: false });
    // Not readable (undefined day): the restriction-only check stays.
    expect(preparationForEvent(events[1]!, resources, undefined, now)).toBeNull();
  });
});

describe('Phase 8: the home per role', () => {
  it('opens the coach week, the referee home or the crew fields; Today for those who run the facility', () => {
    expect(workspaceKindOf(['coach'])).toBe('coach');
    expect(homePathOf(['coach'])).toBe('/workspace/week');
    expect(homePathOf(['official'])).toBe('/workspace/referee');
    expect(homePathOf(['facilities_operator'])).toBe('/workspace/fields');
    expect(homePathOf(['general_manager', 'facilities_operator'])).toBe('/today');
    expect(homePathOf(['front_desk'])).toBe('/today');
  });
});
