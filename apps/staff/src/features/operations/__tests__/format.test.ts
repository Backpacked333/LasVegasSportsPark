/**
 * SPK-SCHED-008: a `datetime-local` value entered on an operations screen is read in the facility's
 * zone when it is known, never silently in the device zone; a time that happens twice or never on a
 * daylight-saving change is refused, never guessed; and the hint names the clock used, in the
 * dashboard's one wording (SPK-UX-010). The operations screens use the shared helpers.
 */
import { describe, expect, it } from 'vitest';
import { readZonedInput as sharedReadZonedInput } from '../../schedule-facilities/time';
import { inputZoneHint as sharedInputZoneHint } from '../../../ui/time';
import { inputZoneHint, readZonedInput } from '../format';

describe('operations date-and-time fields (SPK-SCHED-008, SPK-UX-010)', () => {
  it('are read and named by the shared helpers, not a copy with its own rules or words', () => {
    expect(readZonedInput).toBe(sharedReadZonedInput);
    expect(inputZoneHint).toBe(sharedInputZoneHint);
  });

  it('reads the wall time in the facility zone', () => {
    // 09:00 in Los Angeles on 24 Oct 2026 (PDT, UTC-7) is 16:00 UTC.
    expect(readZonedInput('2026-10-24T09:00', 'America/Los_Angeles')).toEqual({
      iso: '2026-10-24T16:00:00.000Z',
    });
  });

  it('refuses a repeated or skipped wall time instead of guessing one', () => {
    expect(readZonedInput('2026-11-01T01:30', 'America/Los_Angeles').error).toMatch(
      /happens twice on this date in America\/Los_Angeles/,
    );
    expect(readZonedInput('2026-03-08T02:30', 'America/Los_Angeles').error).toMatch(
      /does not exist on this date in America\/Los_Angeles/,
    );
  });

  it('names the clock in the hint', () => {
    expect(inputZoneHint('America/Los_Angeles')).toBe('Facility time (America/Los_Angeles).');
    expect(inputZoneHint(null)).toMatch(/^Your device's time zone/);
  });
});
