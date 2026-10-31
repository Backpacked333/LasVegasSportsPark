/**
 * SPK-SCHED-008: facility-local display and entry in the facility's IANA zone, with daylight-saving
 * gaps and overlaps reported instead of guessed (Los Angeles: clocks go back on 2026-11-01 and
 * forward on 2026-03-08).
 */
import { describe, expect, it } from 'vitest';
import {
  addDaysToLocalDate,
  formatRange,
  localDateOf,
  localDaysWindow,
  localTimeOf,
  occupiedRange,
  offsetMinutesAt,
  resolveLocal,
  weekdayOfLocalDate,
} from '../time';

const LA = 'America/Los_Angeles';

describe('SPK-SCHED-008 facility-local time', () => {
  it('shows an instant in the facility zone, not the browser zone', () => {
    expect(localDateOf('2026-10-25T01:30:00.000Z', LA)).toBe('2026-10-24');
    expect(localTimeOf('2026-10-25T01:30:00.000Z', LA)).toBe('18:30');
    expect(offsetMinutesAt('2026-10-25T01:30:00.000Z', LA)).toBe(-420);
    expect(offsetMinutesAt('2026-11-02T01:30:00.000Z', LA)).toBe(-480);
  });

  it('resolves an ordinary local time to one instant', () => {
    expect(resolveLocal('2026-10-24', '18:00', LA)).toEqual({
      kind: 'exact',
      instant: '2026-10-25T01:00:00.000Z',
    });
  });

  it('reports a local time that occurs twice when clocks go back (ambiguous)', () => {
    expect(resolveLocal('2026-11-01', '01:30', LA)).toEqual({
      kind: 'ambiguous',
      earlier: '2026-11-01T08:30:00.000Z',
      later: '2026-11-01T09:30:00.000Z',
    });
  });

  it('reports a local time that does not exist when clocks go forward (nonexistent)', () => {
    expect(resolveLocal('2026-03-08', '02:30', LA)).toEqual({
      kind: 'nonexistent',
      shiftedForward: '2026-03-08T10:30:00.000Z',
    });
    expect(localTimeOf('2026-03-08T10:30:00.000Z', LA)).toBe('03:30');
  });

  it('rejects malformed input', () => {
    expect(resolveLocal('2026-02-30', '10:00', LA).kind).toBe('invalid');
    expect(resolveLocal('2026-10-24', '25:00', LA).kind).toBe('invalid');
  });

  it('builds local-day windows that follow daylight saving (a 25-hour day on 2026-11-01)', () => {
    const w = localDaysWindow('2026-11-01', 1, LA);
    expect(w).toEqual({ start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z' });
    expect(addDaysToLocalDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(weekdayOfLocalDate('2026-10-24')).toBe(6);
  });

  it('names the zone on both ends when daylight saving changes inside a range', () => {
    const text = formatRange('2026-11-01T08:00:00.000Z', '2026-11-01T10:00:00.000Z', LA);
    expect(text).toMatch(/01:00 PDT to 02:00 PST$/);
  });

  it('SPK-SCHED-003: the occupied interval includes setup and cleanup buffers', () => {
    expect(occupiedRange('2026-10-25T01:00:00.000Z', '2026-10-25T02:00:00.000Z', 15, 10)).toEqual({
      start: '2026-10-25T00:45:00.000Z',
      end: '2026-10-25T02:10:00.000Z',
    });
  });
});
