/**
 * The redesigned schedule's model (S 1b, S 3e, S 2b, S 5a): blocks from events and open drafts,
 * conflicts, free gaps, the clash a move would meet, lanes, the week's cells and the free-slot
 * search (SPK-SCHED-002, SPK-SCHED-003, SPK-SCHED-005, SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { describe, expect, it } from 'vitest';
import {
  HALF_A,
  HALF_B,
  INVENTORY,
  PITCH,
  ROOM,
  closure,
  event,
} from '../../../features/schedule-facilities/test-fixtures';
import {
  buildBlocks,
  clashAt,
  conflictCount,
  findConflicts,
  freeGaps,
  heatCells,
  heatStep,
  kindCounts,
  lanesOf,
  noMatchMessage,
  passesFilter,
  regularsOf,
  slotMatches,
  weekDates,
  type TimelineBlock,
} from '../schedule-model';

const TZ = 'America/Los_Angeles';
const at = (iso: string) => Date.parse(iso);

/** 2026-10-24 (a Saturday) in Los Angeles: 09:00 PDT is 16:00Z. */
const GAME = event({
  id: 'e-game',
  title: 'Desert Foxes v Lions',
  resourceIds: [PITCH],
  scheduledStart: '2026-10-24T16:00:00.000Z',
  scheduledEnd: '2026-10-24T17:00:00.000Z',
});
const RENTAL = event({
  id: 'e-rental',
  title: 'Lee rental',
  kind: 'rental',
  resourceIds: [HALF_B],
  scheduledStart: '2026-10-24T19:00:00.000Z',
  scheduledEnd: '2026-10-24T20:30:00.000Z',
});

function draft(
  over: Partial<Schema<'ScheduleDraft'>> & { changes: Schema<'ScheduleDraft'>['changes'] },
): Schema<'ScheduleDraft'> {
  return {
    id: 'd-1',
    facilityId: 'f',
    name: 'Skills clinic',
    status: 'editing',
    author: { kind: 'staff', accountId: null, actorLabel: 'Sam' },
    baseRevision: { capturedAt: '2026-10-24T12:00:00.000Z', eventRevisions: {} },
    validationResults: null,
    lastSavedAt: '2026-10-24T12:00:00.000Z',
    validatedAt: null,
    publishedAt: null,
    publicationGroupId: null,
    revision: 3,
    createdAt: '2026-10-24T12:00:00.000Z',
    updatedAt: '2026-10-24T12:00:00.000Z',
    ...over,
  };
}

const CLINIC = draft({
  changes: [
    {
      sequence: 1,
      kind: 'create',
      targetEventId: null,
      baseEventRevision: null,
      proposed: {
        kind: 'session',
        title: 'Skills clinic',
        scheduledStart: '2026-10-24T18:00:00.000Z',
        scheduledEnd: '2026-10-24T19:30:00.000Z',
      },
      resourceIds: [HALF_B],
    },
  ],
});

describe('schedule model (S 1b)', () => {
  it('SPK-SCHED-005: a draft create is a dashed block; a draft move is a ghost at the proposed time', () => {
    const move = draft({
      id: 'd-2',
      name: 'Move: Desert Foxes v Lions',
      changes: [
        {
          sequence: 1,
          kind: 'move',
          targetEventId: GAME.id,
          baseEventRevision: 1,
          proposed: {
            scheduledStart: '2026-10-24T21:00:00.000Z',
            scheduledEnd: '2026-10-24T22:00:00.000Z',
          },
          resourceIds: [],
        },
      ],
    });
    const blocks = buildBlocks(
      [GAME, RENTAL],
      [CLINIC, move, draft({ id: 'd-3', status: 'published', changes: CLINIC.changes })],
    );
    expect(blocks.map((b) => [b.key, b.type, b.status])).toEqual([
      ['event:e-game', 'event', 'published'],
      ['event:e-rental', 'event', 'published'],
      ['draft:d-1:1', 'draft-create', 'draft'],
      ['draft:d-2:1', 'draft-change', 'draft'],
    ]);
    const ghost = blocks[3] as TimelineBlock;
    expect(ghost.start).toBe(at('2026-10-24T21:00:00.000Z'));
    expect(ghost.resourceIds).toEqual([PITCH]);
    expect(kindCounts(blocks)).toMatchObject({ league: 1, rental: 1, program: 1 });
  });

  it('a draft that overlaps a booking on shared ground is one conflict, named on both', () => {
    const blocks = buildBlocks([GAME, RENTAL], [CLINIC]);
    const conflicts = findConflicts(blocks, INVENTORY);
    expect(conflicts.get('draft:d-1:1')?.with).toBe('Lee rental');
    expect(conflicts.get('event:e-rental')?.with).toBe('Skills clinic');
    expect(conflicts.has('event:e-game')).toBe(false);
    expect(conflictCount(conflicts, blocks)).toBe(1);
    expect(passesFilter(blocks[0]!, { type: 'conflicts' }, conflicts)).toBe(false);
    expect(passesFilter(blocks[2]!, { type: 'drafts' }, conflicts)).toBe(true);
    // The later one of a clashing pair is drawn on the lower lane.
    expect(
      lanesOf(blocks.filter((b) => b.resourceIds.includes(HALF_B))).get('event:e-rental'),
    ).toBe(1);
  });

  it('SPK-SCHED-002: a whole-pitch booking holds its halves; free gaps of an hour or more start now', () => {
    const blocks = buildBlocks([GAME], []);
    const north = INVENTORY.find((r) => r.id === HALF_A)!;
    const window = { start: at('2026-10-24T15:00:00.000Z'), end: at('2026-10-24T21:00:00.000Z') };
    // At 08:20 local: the gap before the game is 40 minutes (shown nowhere), the afternoon is free.
    const gaps = freeGaps(north, blocks, [], INVENTORY, window, at('2026-10-24T15:20:00.000Z'));
    expect(gaps).toEqual([
      { resourceId: HALF_A, start: at('2026-10-24T17:00:00.000Z'), end: window.end },
    ]);
    // An applied closure on the north half removes its time.
    const closed = closure({
      id: 'c',
      resourceId: HALF_A,
      status: 'active',
      interval: { start: '2026-10-24T17:00:00.000Z', end: '2026-10-24T20:30:00.000Z' },
    });
    expect(freeGaps(north, blocks, [closed], INVENTORY, window, window.start)).toEqual([
      { resourceId: HALF_A, start: window.start, end: at('2026-10-24T16:00:00.000Z') },
    ]);
  });

  it('S 3e: a move onto shared ground names what it hits; a free slot has no clash', () => {
    const blocks = buildBlocks([GAME, RENTAL], []);
    const rental = blocks[1]!;
    const clash = clashAt(
      rental,
      {
        start: at('2026-10-24T16:30:00.000Z'),
        end: at('2026-10-24T18:00:00.000Z'),
        resourceIds: [HALF_B],
      },
      blocks,
      [],
      INVENTORY,
    );
    expect(clash?.title).toBe('Desert Foxes v Lions');
    expect(
      clashAt(
        rental,
        {
          start: at('2026-10-24T17:00:00.000Z'),
          end: at('2026-10-24T18:30:00.000Z'),
          resourceIds: [ROOM],
        },
        blocks,
        [],
        INVENTORY,
      ),
    ).toBeNull();
    // Its own place is never a clash.
    expect(
      clashAt(
        rental,
        { start: rental.start, end: rental.end + 15 * 60_000, resourceIds: [HALF_B] },
        blocks,
        [],
        INVENTORY,
      ),
    ).toBeNull();
  });
});

describe('schedule model (S 2b)', () => {
  it('the week runs Monday to Sunday around the date, across a clock change', () => {
    expect(weekDates('2026-10-25')).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(weekDates('2026-10-26')[0]).toBe('2026-10-26');
  });

  it('heat cells: bookings per space and local day, the share booked, a closure written as "Until"', () => {
    const blocks = buildBlocks([GAME, RENTAL], []);
    const closed = closure({
      id: 'c',
      resourceId: ROOM,
      status: 'active',
      reason: 'Repair',
      interval: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-24T20:00:00.000Z' },
    });
    const cells = heatCells({
      resources: INVENTORY.filter((r) => r.parentResourceId === null),
      inventory: INVENTORY,
      dates: ['2026-10-24'],
      blocks,
      conflicts: new Map(),
      closures: [closed],
      rates: new Map([[`${PITCH}|2026-10-24`, 0.92]]),
      timeZone: TZ,
      dayWindow: () => ({
        start: at('2026-10-24T07:00:00.000Z'),
        end: at('2026-10-25T07:00:00.000Z'),
      }),
    });
    const pitch = cells.find((c) => c.resourceId === PITCH)!;
    expect(pitch).toMatchObject({ bookings: 2, rate: 0.92, closure: null });
    expect(heatStep(pitch.rate)).toBe(4);
    expect(cells.find((c) => c.resourceId === ROOM)?.closure).toEqual({
      label: 'Until 1 PM',
      reason: 'Repair',
    });
    expect(heatStep(null)).toBeNull();
    expect(heatStep(0.1)).toBe(0);
  });

  it('INTERACTIONS 2b row 3: the earliest start per space and day that fits the days, hours and space type', () => {
    const availability = [
      {
        resourceId: HALF_A,
        name: 'Pitch 1 North',
        kind: 'subdivision' as const,
        parentResourceId: PITCH,
        slots: [
          // Saturday 07:00 (before the hours asked), 09:00 and 09:30 PDT.
          { start: '2026-10-24T14:00:00.000Z', end: '2026-10-24T15:30:00.000Z' },
          { start: '2026-10-24T16:00:00.000Z', end: '2026-10-24T17:30:00.000Z' },
          { start: '2026-10-24T16:30:00.000Z', end: '2026-10-24T18:00:00.000Z' },
          // Monday 10:00 PDT (a weekday).
          { start: '2026-10-26T17:00:00.000Z', end: '2026-10-26T18:30:00.000Z' },
        ],
      },
      {
        resourceId: ROOM,
        name: 'Party room',
        kind: 'room' as const,
        parentResourceId: null,
        slots: [{ start: '2026-10-24T16:00:00.000Z', end: '2026-10-24T17:30:00.000Z' }],
      },
    ];
    const query = {
      spaceType: '7v7',
      lengthMinutes: 90,
      days: 'weekend' as const,
      between: [8, 14] as [number, number],
    };
    const matches = slotMatches(availability, INVENTORY, query, TZ, at('2026-10-24T12:00:00.000Z'));
    expect(matches).toEqual([
      {
        resourceId: HALF_A,
        resourceName: 'Pitch 1 North',
        date: '2026-10-24',
        start: at('2026-10-24T16:00:00.000Z'),
        end: at('2026-10-24T17:30:00.000Z'),
      },
    ]);
    expect(
      slotMatches(availability, INVENTORY, { ...query, days: 'weekdays' }, TZ, 0),
    ).toHaveLength(1);
    expect(noMatchMessage(query, '7v7 field')).toBe(
      'No free 90-min 7v7 field slot. Try 60 min or weekdays.',
    );
  });
});

describe('schedule model (S 5a)', () => {
  it('regulars: who books most, with what they usually book', () => {
    const occurrence = (start: string) => ({
      start,
      end: start,
      eventId: null,
      resources: [{ id: HALF_B, name: 'Field 5' }],
    });
    const booking = (id: string, booker: string, starts: string[]) =>
      ({
        id,
        kind: 'rental',
        offeringId: 'o-1',
        bookerPersonId: booker,
        status: 'confirmed',
        occurrences: starts.map(occurrence),
      }) as unknown as Schema<'Booking'>;
    const regulars = regularsOf(
      [
        booking('b1', 'p-garcia', ['2026-10-24T16:00:00.000Z', '2026-10-31T16:00:00.000Z']),
        booking('b2', 'p-lee', ['2026-10-22T16:00:00.000Z']),
      ],
      TZ,
    );
    expect(regulars.map((r) => [r.personId, r.habit])).toEqual([
      ['p-garcia', 'Rents Field 5 most Saturdays'],
      ['p-lee', 'Rents Field 5'],
    ]);
  });
});
