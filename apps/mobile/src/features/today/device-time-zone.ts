/**
 * The device's IANA time zone (SPK-SCHED-008 fallback). Kept in its own module so tests can
 * replace it and stay deterministic whatever zone the test machine runs in.
 */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
