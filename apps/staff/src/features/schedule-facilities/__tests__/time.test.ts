/**
 * SPK-SCHED-008: facility-local display and entry in the facility's IANA zone, with daylight-saving
 * gaps and overlaps reported instead of guessed (Los Angeles: clocks go back on 2026-11-01 and
 * forward on 2026-03-08).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDaysToLocalDate,
  formatRange,
  localDateOf,
  localDaysWindow,
  localTimeOf,
  occupiedRange,
  offsetMinutesAt,
  readZonedInput,
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

/**
 * `readZonedInput` reads every staff `datetime-local` field that has no occurrence chooser (roster,
 * availability, qualifications, message scheduling). The device here is in America/New_York and the
 * facility in America/Los_Angeles, so a facility time read on the device clock would be three hours
 * early.
 */
describe('SPK-SCHED-008 readZonedInput: a typed time in a named clock, never guessed', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('SPK-SCHED-008: reads a typed time in the facility zone, not the device zone', () => {
    vi.stubEnv('TZ', 'America/New_York');
    // 18:00 Pacific standard time is 02:00Z the next day; the New York device would say 23:00Z.
    expect(readZonedInput('2026-11-07T18:00', LA)).toEqual({ iso: '2026-11-08T02:00:00.000Z' });
    expect(readZonedInput('2026-10-24T09:00', 'Europe/London')).toEqual({
      iso: '2026-10-24T08:00:00.000Z',
    });
    // No facility zone, or one the platform does not know: the device's zone, which the hint names.
    expect(readZonedInput('2026-11-07T18:00', null)).toEqual({ iso: '2026-11-07T23:00:00.000Z' });
    expect(readZonedInput('2026-11-07T18:00', 'Not/AZone')).toEqual({
      iso: '2026-11-07T23:00:00.000Z',
    });
  });

  it('SPK-SCHED-008: "Ambiguous or nonexistent times require resolution": a repeated or skipped time is refused, not guessed', () => {
    vi.stubEnv('TZ', 'America/New_York');
    // 01:30 happens twice in Los Angeles on 1 November 2026 (PDT, then PST): neither is picked.
    expect(readZonedInput('2026-11-01T01:30', LA)).toEqual({
      error:
        '01:30 happens twice on this date in America/Los_Angeles (clocks go back). Choose a time outside the repeated hour.',
    });
    // 02:30 never happens there on 8 March 2026: it is not moved to 03:30, that time is offered.
    expect(readZonedInput('2026-03-08T02:30', LA)).toEqual({
      error:
        '02:30 does not exist on this date in America/Los_Angeles (clocks go forward). Choose another time, for example 03:30.',
    });
    // The device's zone resolves the same way when it is the clock.
    expect(readZonedInput('2026-11-01T01:30', null)).toEqual({
      error:
        '01:30 happens twice on this date in America/New_York (clocks go back). Choose a time outside the repeated hour.',
    });
    // The hours either side of the change are single instants.
    expect(readZonedInput('2026-11-01T00:59', LA)).toEqual({ iso: '2026-11-01T07:59:00.000Z' });
    expect(readZonedInput('2026-11-01T02:00', LA)).toEqual({ iso: '2026-11-01T10:00:00.000Z' });
  });

  it('SPK-SCHED-008: an empty field is no time; an unreadable one is a field error', () => {
    expect(readZonedInput('', LA)).toEqual({});
    expect(readZonedInput('  ', null)).toEqual({});
    expect(readZonedInput('not a time', LA)).toEqual({ error: 'Enter a valid date and time.' });
    expect(readZonedInput('2026-02-30T10:00', LA)).toEqual({
      error: 'Enter a valid date and time.',
    });
  });
});
