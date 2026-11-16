import { describe, expect, it } from 'vitest';
import { dueTimeOf, sameInstant } from './due-time';

const ZONE = 'America/Los_Angeles';

describe('due time of a sequence step (SPK-COMMS-009, SPK-SCHED-008)', () => {
  it('SPK-COMMS-009: seven days before a season that starts on a date, at the facility-local time', () => {
    const due = dueTimeOf({ date: '2027-01-10' }, -7, '09:00', ZONE);
    // 2027-01-03 09:00 Pacific standard time
    expect(due.dueAt.toISOString()).toBe('2027-01-03T17:00:00.000Z');
    // the anchor is the start of the season's first day in the facility zone
    expect(due.anchorAt.toISOString()).toBe('2027-01-10T08:00:00.000Z');
  });

  it('one day after registration opens counts from the local date of that instant', () => {
    // 2026-12-01 20:30 Pacific is already 2026-12-02 in UTC: the local date is what counts
    const due = dueTimeOf({ at: new Date('2026-12-02T04:30:00Z') }, 1, '08:15', ZONE);
    expect(due.anchorAt.toISOString()).toBe('2026-12-02T04:30:00.000Z');
    expect(due.dueAt.toISOString()).toBe('2026-12-02T16:15:00.000Z');
  });

  it('SPK-SCHED-008: the due time keeps its wall-clock time across a daylight-saving change', () => {
    // Pacific time moves to daylight time on 2027-03-14
    const before = dueTimeOf({ date: '2027-03-20' }, -7, '09:00', ZONE);
    const after = dueTimeOf({ date: '2027-03-20' }, -1, '09:00', ZONE);
    expect(before.dueAt.toISOString()).toBe('2027-03-13T17:00:00.000Z');
    expect(after.dueAt.toISOString()).toBe('2027-03-19T16:00:00.000Z');
  });

  it('a time inside the spring-forward gap moves past it', () => {
    const due = dueTimeOf({ date: '2027-03-14' }, 0, '02:30', ZONE);
    expect(due.dueAt.toISOString()).toBe('2027-03-14T10:30:00.000Z');
  });

  it('sameInstant compares instants and treats two absent values as equal', () => {
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, new Date(0))).toBe(false);
    expect(sameInstant('2027-01-03T17:00:00Z', new Date('2027-01-03T17:00:00.000Z'))).toBe(true);
    expect(sameInstant('2027-01-03T17:00:00Z', '2027-01-03T17:00:01Z')).toBe(false);
  });
});
