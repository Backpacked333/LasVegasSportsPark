import { z } from './zod';

/** Instants are ISO-8601 UTC strings on the wire; the database stores timestamptz (SPK-SCHED-008). */
export const Instant = z.iso.datetime({ offset: true });
export type Instant = z.infer<typeof Instant>;

export const IanaTimezone = z.string().refine(isIanaTimezone, 'must be a valid IANA timezone');
export type IanaTimezone = z.infer<typeof IanaTimezone>;

export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Half-open interval [start, end) as used by PostgreSQL tstzrange. */
export const IntervalSchema = z
  .object({ start: Instant, end: Instant })
  .refine((v) => new Date(v.start).getTime() < new Date(v.end).getTime(), {
    message: 'start must be before end',
  });
export type Interval = z.infer<typeof IntervalSchema>;

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return (
    new Date(a.start).getTime() < new Date(b.end).getTime() &&
    new Date(b.start).getTime() < new Date(a.end).getTime()
  );
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();
}

/**
 * Expand an interval by preparation and cleanup buffers to obtain the occupied interval
 * (SPK-SCHED-003): a game ending at 19:00 with a ten-minute turnover occupies until 19:10.
 */
export function occupiedInterval(
  scheduled: Interval,
  buffers: { setupMinutes: number; cleanupMinutes: number },
): Interval {
  return {
    start: addMinutes(scheduled.start, -buffers.setupMinutes),
    end: addMinutes(scheduled.end, buffers.cleanupMinutes),
  };
}
