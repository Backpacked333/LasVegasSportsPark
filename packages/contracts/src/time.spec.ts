import { describe, expect, it } from 'vitest';
import { intervalsOverlap, isIanaTimezone, occupiedInterval } from './time';

describe('time', () => {
  it('validates IANA timezones', () => {
    expect(isIanaTimezone('America/Los_Angeles')).toBe(true);
    expect(isIanaTimezone('Mars/Olympus')).toBe(false);
  });

  it('extends the occupied interval by setup and cleanup buffers (SPK-SCHED-003)', () => {
    const occupied = occupiedInterval(
      { start: '2026-10-23T18:00:00.000Z', end: '2026-10-23T19:00:00.000Z' },
      { setupMinutes: 0, cleanupMinutes: 10 },
    );
    expect(occupied.end).toBe('2026-10-23T19:10:00.000Z');
    expect(
      intervalsOverlap(occupied, {
        start: '2026-10-23T19:00:00.000Z',
        end: '2026-10-23T20:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      intervalsOverlap(occupied, {
        start: '2026-10-23T19:10:00.000Z',
        end: '2026-10-23T20:00:00.000Z',
      }),
    ).toBe(false);
  });
});
