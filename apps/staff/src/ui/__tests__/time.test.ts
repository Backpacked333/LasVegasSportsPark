/**
 * SPK-SCHED-008 and SPK-UX-010: every staff date-and-time field names the clock it is read in, in
 * one wording across the dashboard ("Facility time (X)." or "Your device's time zone (X)."). The
 * device here is in America/New_York.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceTimeZone, deviceZonePhrase, inputZoneHint, knownTimeZone } from '../time';

describe('SPK-SCHED-008 / SPK-UX-010 the clock of a date-and-time field, in one wording', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('SPK-SCHED-008: names the facility zone when known, otherwise the device zone by name', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(inputZoneHint('America/Los_Angeles')).toBe('Facility time (America/Los_Angeles).');
    expect(inputZoneHint(null)).toBe("Your device's time zone (America/New_York).");
    expect(inputZoneHint(undefined)).toBe("Your device's time zone (America/New_York).");
    // A zone the platform does not know is never shown as the facility's clock.
    expect(knownTimeZone('Not/AZone')).toBeNull();
    expect(inputZoneHint('Not/AZone')).toBe("Your device's time zone (America/New_York).");
  });

  it('SPK-UX-010: the device clock reads the same in a hint and inside a sentence', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(deviceTimeZone()).toBe('America/New_York');
    expect(deviceZonePhrase()).toBe("your device's time zone (America/New_York)");
    expect(`From midnight in ${deviceZonePhrase()}.`).toBe(
      "From midnight in your device's time zone (America/New_York).",
    );
  });
});
