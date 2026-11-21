/**
 * The pure rules of the redesigned Today (S 1a, S 1d): next-hour starts, the board axis and space
 * state, the KPI derivations, folding and ordering the issues, snooze and the median.
 */
import { describe, expect, it } from 'vitest';
import {
  boardAxis,
  canSnooze,
  issueCards,
  median,
  nextHourStarts,
  orderIssues,
  peakBand,
  shortName,
  spaceNow,
  spacesInUse,
  startsIn,
  type ResourceStatus,
  type ScheduledEvent,
  type TodayItem,
} from '../today-model';

const NOW = new Date('2026-10-24T16:00:00.000Z'); // 9:00 AM in Los Angeles
const FACILITY = {
  timezone: 'America/Los_Angeles',
  window: { start: '2026-10-24T07:00:00.000Z', end: '2026-10-25T07:00:00.000Z' },
};

function ev(
  id: string,
  start: string,
  end: string,
  extra: Partial<ScheduledEvent> = {},
): ScheduledEvent {
  return {
    id,
    facilityId: 'f',
    kind: 'game',
    title: id,
    format: null,
    sport: null,
    seriesId: null,
    occurrenceIndex: null,
    scheduledStart: start,
    scheduledEnd: end,
    timezone: 'America/Los_Angeles',
    setupMinutes: 0,
    cleanupMinutes: 0,
    dstResolution: 'exact',
    status: 'published',
    publishedRevision: 1,
    revision: 1,
    sourceType: null,
    sourceId: null,
    resourceIds: ['r1'],
    commitments: [],
    canceledAt: null,
    cancelReason: null,
    createdAt: start,
    updatedAt: start,
    ...extra,
  } as ScheduledEvent;
}

function res(id: string, extra: Partial<ResourceStatus> = {}): ResourceStatus {
  return {
    resourceId: id,
    name: id,
    kind: 'pitch',
    parentResourceId: null,
    inventoryStatus: 'active',
    conflictUnitIds: [],
    status: 'in_service',
    restrictions: [],
    ...extra,
  } as ResourceStatus;
}

function item(extra: Partial<TodayItem>): TodayItem {
  return {
    id: 'i',
    source: 'exception',
    group: 'other',
    category: 'x',
    title: 't',
    severity: 'warning',
    facilityId: null,
    affected: null,
    ownerQueue: 'q',
    status: 'open',
    openedAt: null,
    ageMinutes: null,
    deadlineAt: null,
    overdue: false,
    revision: 1,
    nextActions: [],
    history: [],
    details: {},
    ...extra,
  } as TodayItem;
}

describe('next hour (S 1a readiness strip)', () => {
  it('keeps published starts from now to an hour ahead, by start', () => {
    const events = [
      ev('later', '2026-10-24T17:00:00Z', '2026-10-24T18:00:00Z'),
      ev('b', '2026-10-24T16:15:00Z', '2026-10-24T17:00:00Z'),
      ev('a', '2026-10-24T16:00:00Z', '2026-10-24T17:00:00Z'),
      ev('draft', '2026-10-24T16:10:00Z', '2026-10-24T17:00:00Z', { status: 'draft' }),
      ev('block', '2026-10-24T16:10:00Z', '2026-10-24T17:00:00Z', { kind: 'maintenance' }),
      ev('running', '2026-10-24T15:30:00Z', '2026-10-24T16:30:00Z'),
    ];
    expect(nextHourStarts(events, NOW).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('says when it starts', () => {
    expect(startsIn('2026-10-24T16:14:00Z', NOW)).toBe('Starts in 14 min');
    expect(startsIn('2026-10-24T16:00:00Z', NOW)).toBe('Starting now');
    expect(startsIn('2026-10-24T15:57:00Z', NOW)).toBe('Started 3 min ago');
  });
});

describe('field board (S 1a)', () => {
  it('runs from 8 AM to 8 PM, or wider when the day is', () => {
    const axis = boardAxis(FACILITY, []);
    expect(new Date(axis.start).toISOString()).toBe('2026-10-24T15:00:00.000Z');
    expect(new Date(axis.end).toISOString()).toBe('2026-10-25T03:00:00.000Z');
    const wide = boardAxis(FACILITY, [ev('x', '2026-10-24T13:30:00Z', '2026-10-24T14:30:00Z')]);
    expect(new Date(wide.start).toISOString()).toBe('2026-10-24T13:00:00.000Z');
  });

  it('knows what a space does now and next, counting its halves', () => {
    const events = [
      ev('now', '2026-10-24T15:30:00Z', '2026-10-24T16:30:00Z', { resourceIds: ['half'] }),
      ev('next', '2026-10-24T17:00:00Z', '2026-10-24T18:00:00Z'),
    ];
    const state = spaceNow(res('r1'), events, NOW, ['half']);
    expect(state.current?.id).toBe('now');
    expect(state.next?.id).toBe('next');
    expect(state.progress).toBe(50);
    expect(state.minutesLeft).toBe(30);
  });

  it('counts spaces in use, closed ones, and the busiest two hours', () => {
    const resources = [
      res('r1'),
      res('r2', {
        restrictions: [
          {
            restrictionId: 'x',
            kind: 'closed',
            reason: 'repair',
            interval: { start: '2026-10-24T15:00:00Z', end: '2026-10-24T20:00:00Z' },
            taskId: null,
            resourceId: 'r2',
            affectedConflictUnitIds: [],
          },
        ],
      }),
      res('half', { parentResourceId: 'r1', kind: 'subdivision' }),
    ];
    const events = [
      ev('now', '2026-10-24T15:30:00Z', '2026-10-24T16:30:00Z', { resourceIds: ['half'] }),
    ];
    expect(spacesInUse(resources, events, NOW)).toEqual({ inUse: 1, total: 2, closed: 1 });
    const axis = boardAxis(FACILITY, events);
    expect(peakBand(resources, events, axis)).toMatchObject({ booked: 1, total: 2 });
    expect(peakBand(resources, [], axis)).toBeNull();
  });
});

describe('needs action (S 1a)', () => {
  const game = ev('g', '2026-10-24T16:15:00Z', '2026-10-24T17:15:00Z', {
    sourceType: 'fixture',
    sourceId: 'fx',
  });

  it('folds the officials message a referee issue already shows, and marks blocking starts', () => {
    const staffing = item({
      id: 'staff',
      category: 'workforce.uncovered_assignment',
      severity: 'high',
      affected: { type: 'fixture', id: 'fx' },
    });
    const readinessOnlyOfficials = item({
      id: 'ready1',
      source: 'readiness',
      severity: 'high',
      details: {
        fixtureId: 'fx',
        issues: [
          { code: 'required_officials_not_accepted', severity: 'blocking', message: '0 of 1' },
        ],
      },
    });
    const cards = issueCards([staffing, readinessOnlyOfficials], [game], NOW);
    expect(cards.map((c) => c.id)).toEqual(['staff']);
    expect(cards[0]).toMatchObject({ kind: 'staffing', blocking: true, eventId: 'g' });

    const withRosters = item({
      id: 'ready2',
      source: 'readiness',
      severity: 'high',
      details: {
        fixtureId: 'fx',
        issues: [
          { code: 'required_officials_not_accepted', severity: 'blocking', message: '0 of 1' },
          {
            code: 'insufficient_eligible_roster',
            severity: 'blocking',
            message: 'Lions has 6 players',
          },
        ],
      },
    });
    const two = issueCards([staffing, withRosters], [game], NOW);
    expect(two[1]).toMatchObject({
      kind: 'readiness',
      messages: ['Lions has 6 players'],
      title: 'g is not ready',
    });
  });

  it('orders an escalated issue first, then blocking, then by start, then by severity', () => {
    const cards = issueCards(
      [
        item({ id: 'money', group: 'financial', severity: 'critical' }),
        item({ id: 'later', severity: 'warning', details: { eventId: 'g2' } }),
        item({
          id: 'block',
          category: 'workforce.uncovered_assignment',
          severity: 'high',
          affected: { type: 'fixture', id: 'fx' },
        }),
      ],
      [game, ev('g2', '2026-10-24T18:00:00Z', '2026-10-24T19:00:00Z')],
      NOW,
    );
    expect(orderIssues(cards, new Set()).map((c) => c.id)).toEqual(['block', 'later', 'money']);
    expect(orderIssues(cards, new Set(['money'])).map((c) => c.id)[0]).toBe('money');
  });

  it('INTERACTIONS 1a row 7: blocking issues cannot be snoozed in the last 15 minutes', () => {
    const [card] = issueCards(
      [
        item({
          category: 'workforce.uncovered_assignment',
          severity: 'high',
          affected: { type: 'fixture', id: 'fx' },
        }),
      ],
      [game],
      NOW,
    );
    expect(canSnooze(card!, NOW)).toBe(false);
    expect(canSnooze(card!, new Date('2026-10-24T15:55:00Z'))).toBe(true);
  });

  it('works out the median time to act and short names', () => {
    expect(median([])).toBeNull();
    expect(median([9, 1, 6])).toBe(6);
    expect(median([2, 4, 6, 9])).toBe(5);
    expect(shortName('Taylor Nguyen')).toBe('T. Nguyen');
    expect(shortName('Jordan Sample-Lindqvist')).toBe('J. Sample-Lindqvist');
    expect(shortName('Cher')).toBe('Cher');
  });
});
