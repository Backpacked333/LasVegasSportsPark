import { createHash } from 'node:crypto';
import { addDays, localDateOf, resolveLocal, weekdayOf } from '../../scheduling';

/**
 * Facility-local date arithmetic for Package G terms, expiries and benefit periods
 * (SPK-SCHED-008: local behaviour derives from the facility's zone; daylight-saving transitions
 * are resolved by the scheduling helpers).
 */

const DAY_MS = 86_400_000;

/** The instant local midnight starts `date` in `timezone`. */
export function localDayStart(date: string, timezone: string): Date {
  const resolved = resolveLocal(date, '00:00', timezone);
  if (!resolved) throw new Error(`local midnight of ${date} in ${timezone} does not resolve`);
  return resolved.instant;
}

/** The next local midnight after `date` (the end of that local day). */
export function localMidnightAfter(date: string, timezone: string): Date {
  return localDayStart(addDays(date, 1), timezone);
}

export function addWholeDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/**
 * The benefit period an instant falls in (SPK-COND-001): `week:<first local date of the week>`
 * for a weekly limit starting on ISO weekday `weekStartsOn` (1 Monday … 7 Sunday),
 * `month:<YYYY-MM>` for a monthly one, `term` for a whole-term one.
 */
export function benefitPeriodKey(
  limit: { period: 'week' | 'month' | 'membership_term'; weekStartsOn?: number },
  instant: Date,
  timezone: string,
): string {
  if (limit.period === 'membership_term') return 'term';
  const date = localDateOf(timezone, instant);
  if (limit.period === 'month') return `month:${date.slice(0, 7)}`;
  const isoWeekday = ((weekdayOf(date) + 6) % 7) + 1; // 1 Monday … 7 Sunday
  const back = (isoWeekday - (limit.weekStartsOn ?? 1) + 7) % 7;
  return `week:${addDays(date, -back)}`;
}

/**
 * A stable identifier for a fact that has no event of its own (a renewal notice), so the
 * communications de-duplication on `sourceEventId` holds across replays: a version-8 UUID from
 * the SHA-256 of the name.
 */
export function stableId(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
