import type { DstResolution, LocalDate, LocalTime, RecurrenceRule } from '@sportspark/contracts';
import {
  addDays,
  compareLocalDates,
  resolveLocal,
  weekdayOf,
  type DstPolicy,
  DEFAULT_DST_POLICY,
} from './local-time';

/**
 * Recurrence materialization (SPK-SCHED-007/008). Occurrence indexes are assigned to every
 * candidate date of the rule, before exceptions and skipped (nonexistent) times are removed, so
 * an occurrence keeps the same index when exceptions are added later and (organization, series,
 * occurrence_index) stays a stable identity.
 */

export interface MaterializedOccurrence {
  occurrenceIndex: number;
  localDate: LocalDate;
  start: Date;
  end: Date;
  dstResolution: DstResolution;
}

export interface MaterializeOptions {
  localStartTime: LocalTime;
  durationMinutes: number;
  timezone: string;
  policy?: DstPolicy;
  /** Local dates excluded from the series. */
  exceptions?: readonly LocalDate[];
  maxOccurrences: number;
}

/** Candidate local dates of a rule in order, each with its occurrence index. */
export function candidateDates(
  rule: RecurrenceRule,
  maxOccurrences: number,
): Array<{ occurrenceIndex: number; localDate: LocalDate }> {
  const out: Array<{ occurrenceIndex: number; localDate: LocalDate }> = [];
  const limit = Math.min(rule.count ?? Number.POSITIVE_INFINITY, maxOccurrences);
  const withinUntil = (date: LocalDate) =>
    rule.until === undefined || compareLocalDates(date, rule.until) <= 0;
  const push = (date: LocalDate): boolean => {
    if (out.length >= limit) return false;
    if (!withinUntil(date)) return false;
    out.push({ occurrenceIndex: out.length, localDate: date });
    return true;
  };

  if (rule.frequency === 'daily') {
    for (let i = 0; ; i += 1) {
      if (!push(addDays(rule.startDate, i * rule.interval))) break;
    }
    return out;
  }

  // weekly: weeks start on Sunday; the first week is the one containing startDate
  const weekdays = [...new Set(rule.byWeekday ?? [weekdayOf(rule.startDate)])].sort(
    (a, b) => a - b,
  );
  const weekStart = addDays(rule.startDate, -weekdayOf(rule.startDate));
  for (let week = 0; ; week += 1) {
    const base = addDays(weekStart, week * rule.interval * 7);
    if (!withinUntil(base) || out.length >= limit) break;
    let continueWeeks = true;
    for (const weekday of weekdays) {
      const date = addDays(base, weekday);
      if (compareLocalDates(date, rule.startDate) < 0) continue;
      if (!push(date)) {
        continueWeeks = false;
        break;
      }
    }
    if (!continueWeeks) break;
  }
  return out;
}

export function materializeOccurrences(
  rule: RecurrenceRule,
  options: MaterializeOptions,
): MaterializedOccurrence[] {
  const policy = options.policy ?? DEFAULT_DST_POLICY;
  const exceptions = new Set(options.exceptions ?? []);
  const result: MaterializedOccurrence[] = [];
  for (const candidate of candidateDates(rule, options.maxOccurrences)) {
    if (exceptions.has(candidate.localDate)) continue;
    const resolved = resolveLocal(
      candidate.localDate,
      options.localStartTime,
      options.timezone,
      policy,
    );
    if (!resolved) continue;
    result.push({
      occurrenceIndex: candidate.occurrenceIndex,
      localDate: candidate.localDate,
      start: resolved.instant,
      end: new Date(resolved.instant.getTime() + options.durationMinutes * 60_000),
      dstResolution: resolved.resolution,
    });
  }
  return result;
}
