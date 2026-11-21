/**
 * The waitlist offer's clock (redesign handoff 2e row 1; SPK-REG-008, SPK-SCHED-008): the time
 * left in big plain units (hours and minutes, or minutes and seconds under an hour) and the exact
 * deadline on the facility's clock. The deadline is the API's (`expiresAt`, DEC-006 waitlist
 * policy); the countdown is a guide, read from the injected clock. Pure.
 */
import { formatDay, formatTime, localDayKey } from '../today/time';

export interface OfferClock {
  ended: boolean;
  /** The two tiles: [value, unit] pairs, e.g. [["23","hours"],["41","min"]]. */
  tiles: [string, string][];
  /** Ticks every second under an hour, every minute otherwise. */
  tickMs: number;
  /** "23 hours 41 minutes left" for screen readers. */
  spoken: string;
}

export function offerClock(expiresAt: string, now: Date): OfferClock {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  if (left === 0) return { ended: true, tiles: [], tickMs: 60_000, spoken: 'The offer has ended' };
  if (left < 3600) {
    const minutes = Math.floor(left / 60);
    const seconds = left % 60;
    return {
      ended: false,
      tiles: [
        [String(minutes), 'min'],
        [String(seconds).padStart(2, '0'), 'sec'],
      ],
      tickMs: 1000,
      spoken: `${minutes} minutes ${seconds} seconds left`,
    };
  }
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  return {
    ended: false,
    tiles: [
      [String(hours), hours === 1 ? 'hour' : 'hours'],
      [String(minutes), 'min'],
    ],
    tickMs: 30_000,
    spoken: `${hours} ${hours === 1 ? 'hour' : 'hours'} ${minutes} minutes left`,
  };
}

/**
 * "Fri 9:41 AM" within the coming week, "Sat, Dec 5, 9:41 AM" after it, "today 9:41 AM" today:
 * the deadline on the facility's clock.
 */
export function deadlineWords(expiresAt: string, now: Date, zone: string): string {
  const time = formatTime(expiresAt, zone);
  const days = Math.round(
    (Date.parse(`${localDayKey(expiresAt, zone)}T12:00:00Z`) -
      Date.parse(`${localDayKey(now, zone)}T12:00:00Z`)) /
      86_400_000,
  );
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) return `${formatDay(expiresAt, zone).split(',')[0]} ${time}`;
  return `${formatDay(expiresAt, zone)}, ${time}`;
}
