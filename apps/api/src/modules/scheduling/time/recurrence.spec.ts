import { describe, expect, it } from 'vitest';
import {
  localTimeOf,
  minutesSinceMidnight,
  requestedLocalOf,
  resolveLocal,
  toLocal,
} from './local-time';
import { candidateDates, describesMoreThan, materializeOccurrences } from './recurrence';

const LA = 'America/Los_Angeles';
// 2026: spring forward Sunday 2026-03-08 02:00 PST → 03:00 PDT; fall back Sunday 2026-11-01 02:00 PDT → 01:00 PST.

describe('SPK-SCHED-008 local time resolution across daylight-saving transitions', () => {
  it('resolves an ordinary local time exactly', () => {
    const r = resolveLocal('2026-06-15', '18:30', LA);
    expect(r).toEqual({ instant: new Date('2026-06-16T01:30:00.000Z'), resolution: 'exact' });
    expect(localTimeOf(LA, r!.instant)).toBe('18:30');
  });

  it('shifts a nonexistent spring-forward time forward by the gap (02:30 → 03:30 PDT)', () => {
    const r = resolveLocal('2026-03-08', '02:30', LA);
    expect(r?.resolution).toBe('shifted_forward');
    expect(r?.instant.toISOString()).toBe('2026-03-08T10:30:00.000Z');
    expect(localTimeOf(LA, r!.instant)).toBe('03:30');
  });

  it('skips a nonexistent time when the series says so', () => {
    expect(
      resolveLocal('2026-03-08', '02:30', LA, { nonexistent: 'skip', ambiguous: 'first' }),
    ).toBe(null);
  });

  it('takes the first occurrence of an ambiguous fall-back time by default and the second on request', () => {
    const first = resolveLocal('2026-11-01', '01:30', LA);
    expect(first).toEqual({ instant: new Date('2026-11-01T08:30:00.000Z'), resolution: 'first' });
    const second = resolveLocal('2026-11-01', '01:30', LA, {
      nonexistent: 'shift_forward',
      ambiguous: 'second',
    });
    expect(second).toEqual({ instant: new Date('2026-11-01T09:30:00.000Z'), resolution: 'second' });
    expect(localTimeOf(LA, first!.instant)).toBe('01:30');
    expect(localTimeOf(LA, second!.instant)).toBe('01:30');
  });

  it('R3-TRACE-A-08 / SPK-SCHED-008: a resolved start reads back as the local time it was asked for (a shifted 02:30 stands for 02:30, not 03:30)', () => {
    for (const [date, time, policy] of [
      ['2026-03-08', '02:30', { nonexistent: 'shift_forward', ambiguous: 'first' }],
      ['2026-03-08', '02:00', { nonexistent: 'shift_forward', ambiguous: 'first' }],
      ['2026-03-08', '03:30', { nonexistent: 'shift_forward', ambiguous: 'first' }],
      ['2026-11-01', '01:30', { nonexistent: 'shift_forward', ambiguous: 'first' }],
      ['2026-11-01', '01:30', { nonexistent: 'shift_forward', ambiguous: 'second' }],
      ['2026-06-15', '18:30', { nonexistent: 'shift_forward', ambiguous: 'first' }],
    ] as const) {
      const r = resolveLocal(date, time, LA, policy)!;
      expect(requestedLocalOf(LA, r.instant, r.resolution)).toEqual({ date, time });
    }
    // the same instant read as an exact start is its own wall-clock time
    expect(requestedLocalOf(LA, new Date('2026-03-08T10:30:00.000Z'), 'exact')).toEqual({
      date: '2026-03-08',
      time: '03:30',
    });
  });

  it('keeps the same wall-clock time on both sides of a transition', () => {
    const before = resolveLocal('2026-03-07', '19:00', LA)!;
    const after = resolveLocal('2026-03-09', '19:00', LA)!;
    expect(before.instant.toISOString()).toBe('2026-03-08T03:00:00.000Z'); // PST (-8)
    expect(after.instant.toISOString()).toBe('2026-03-10T02:00:00.000Z'); // PDT (-7)
    expect(toLocal(LA, after.instant)).toMatchObject({ hour: 19, minute: 0, weekday: 1 });
    expect(minutesSinceMidnight(LA, after.instant)).toBe(19 * 60);
  });

  it('handles UTC and east-of-Greenwich zones', () => {
    expect(resolveLocal('2026-01-01', '00:00', 'UTC')?.instant.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(resolveLocal('2026-07-01', '09:00', 'Europe/Berlin')?.instant.toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
  });
});

describe('SPK-SCHED-007 recurrence materialization', () => {
  it('generates weekly occurrences with stable indexes and honours until, exceptions and weekdays', () => {
    const occurrences = materializeOccurrences(
      {
        frequency: 'weekly',
        interval: 1,
        byWeekday: [2, 4], // Tue, Thu
        startDate: '2026-03-03', // Tuesday
        until: '2026-03-19',
      },
      {
        localStartTime: '19:00',
        durationMinutes: 60,
        timezone: LA,
        exceptions: ['2026-03-12'],
        maxOccurrences: 100,
      },
    );
    expect(occurrences.map((o) => [o.occurrenceIndex, o.localDate])).toEqual([
      [0, '2026-03-03'],
      [1, '2026-03-05'],
      [2, '2026-03-10'],
      // index 3 (2026-03-12) is an exception and keeps its index unused
      [4, '2026-03-17'],
      [5, '2026-03-19'],
    ]);
    // the Tuesday after spring-forward keeps 19:00 local even though the UTC hour changed
    expect(occurrences[0]?.start.toISOString()).toBe('2026-03-04T03:00:00.000Z');
    expect(occurrences[2]?.start.toISOString()).toBe('2026-03-11T02:00:00.000Z');
    expect(occurrences.every((o) => o.end.getTime() - o.start.getTime() === 3_600_000)).toBe(true);
    expect(occurrences.every((o) => o.dstResolution === 'exact')).toBe(true);
  });

  it('records the DST resolution on occurrences that fall into a gap or an overlap', () => {
    const occurrences = materializeOccurrences(
      { frequency: 'weekly', interval: 1, byWeekday: [0], startDate: '2026-03-01', count: 3 },
      { localStartTime: '02:30', durationMinutes: 30, timezone: LA, maxOccurrences: 100 },
    );
    expect(occurrences.map((o) => o.dstResolution)).toEqual(['exact', 'shifted_forward', 'exact']);
    const fallBack = materializeOccurrences(
      { frequency: 'daily', interval: 1, startDate: '2026-10-31', count: 3 },
      {
        localStartTime: '01:30',
        durationMinutes: 30,
        timezone: LA,
        policy: { nonexistent: 'shift_forward', ambiguous: 'second' },
        maxOccurrences: 100,
      },
    );
    expect(fallBack.map((o) => o.dstResolution)).toEqual(['exact', 'second', 'exact']);
    expect(fallBack[1]?.start.toISOString()).toBe('2026-11-01T09:30:00.000Z');
  });

  it('counts candidates before exceptions and respects the materialization cap', () => {
    const rule = { frequency: 'daily' as const, interval: 2, startDate: '2026-01-01', count: 5 };
    expect(candidateDates(rule, 100).map((c) => c.localDate)).toEqual([
      '2026-01-01',
      '2026-01-03',
      '2026-01-05',
      '2026-01-07',
      '2026-01-09',
    ]);
    expect(candidateDates({ ...rule, count: undefined, until: '2030-01-01' }, 3)).toHaveLength(3);
  });

  it('R3-TIME-MONEY-04 / SPK-SCHED-007: a rule whose until date describes more dates than the cap is detected, not truncated silently', () => {
    // daily from 2026-11-01 through 2027-12-31: 426 dates; the cap of 366 would end on 2027-11-01
    const long = {
      frequency: 'daily' as const,
      interval: 1,
      startDate: '2026-11-01',
      until: '2027-12-31',
    };
    expect(candidateDates(long, 366).at(-1)?.localDate).toBe('2027-11-01');
    expect(describesMoreThan(long, 366)).toBe(true);
    // exactly at the cap is allowed: 2026-11-01 through 2027-11-01 is 366 dates
    expect(describesMoreThan({ ...long, until: '2027-11-01' }, 366)).toBe(false);
    expect(describesMoreThan({ ...long, until: '2027-11-02' }, 366)).toBe(true);
    // count is bounded by the rule itself
    const counted = {
      frequency: 'daily' as const,
      interval: 1,
      startDate: '2026-11-01',
      count: 366,
    };
    expect(describesMoreThan(counted, 366)).toBe(false);
    // weekly rules count every listed weekday; until far in the future enumerates only cap + 1
    const weekly = {
      frequency: 'weekly' as const,
      interval: 1,
      byWeekday: [1, 3, 5],
      startDate: '2026-11-02',
      until: '9999-12-31',
    };
    expect(describesMoreThan(weekly, 52)).toBe(true);
    expect(describesMoreThan({ ...weekly, until: '2027-04-23' }, 75)).toBe(false);
    expect(candidateDates({ ...weekly, until: '2027-04-23' }, 1000)).toHaveLength(75);
  });
});
