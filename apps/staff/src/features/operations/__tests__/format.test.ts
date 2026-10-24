/**
 * SPK-SCHED-008: a `datetime-local` value entered on an operations screen is read in the facility's
 * zone when it is known, never silently in the device zone, and the hint names the clock used.
 */
import { describe, expect, it } from 'vitest';
import { inputZoneHint, instantFromZonedInput } from '../format';

describe('instantFromZonedInput (SPK-SCHED-008)', () => {
  it('reads the wall time in the facility zone', () => {
    // 09:00 in Los Angeles on 24 Oct 2026 (PDT, UTC-7) is 16:00 UTC.
    expect(instantFromZonedInput('2026-10-24T09:00', 'America/Los_Angeles')).toBe(
      '2026-10-24T16:00:00.000Z',
    );
    // The same wall time in another facility zone is a different instant.
    expect(instantFromZonedInput('2026-10-24T09:00', 'Europe/London')).toBe(
      '2026-10-24T08:00:00.000Z',
    );
  });

  it('resolves a repeated wall time to its first occurrence and a skipped one forward', () => {
    // 01:30 happens twice in Los Angeles on 1 Nov 2026 (PDT, then PST).
    expect(instantFromZonedInput('2026-11-01T01:30', 'America/Los_Angeles')).toBe(
      '2026-11-01T08:30:00.000Z',
    );
    // 02:30 never happens on 8 Mar 2026.
    expect(instantFromZonedInput('2026-03-08T02:30', 'America/Los_Angeles')).toBe(
      '2026-03-08T10:30:00.000Z',
    );
  });

  it('returns null for an empty or invalid value', () => {
    expect(instantFromZonedInput('', 'America/Los_Angeles')).toBeNull();
    expect(instantFromZonedInput('not-a-date', 'America/Los_Angeles')).toBeNull();
  });

  it('names the clock in the hint', () => {
    expect(inputZoneHint('America/Los_Angeles')).toBe('Facility time, America/Los_Angeles.');
    expect(inputZoneHint(null)).toMatch(/^Your device time/);
  });
});
