import {
  errors,
  type ActorSnapshot,
  type MetricDefinition,
  type MetricUnitValue,
  type MetricValue,
  type Principal,
} from '@sportspark/contracts';
import type { MetricDefinitionsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { addDays, compareLocalDates, resolveLocal, toLocal } from '../scheduling';

export type MetricDefinitionRow = Selectable<MetricDefinitionsTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

export function ms(value: Date | string): number {
  return new Date(value).getTime();
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Hours with four decimals: deterministic, readable, and exact for quarter-hour data. */
export function hours(milliseconds: number): number {
  return Math.round((milliseconds / HOUR_MS) * 10_000) / 10_000;
}

/** A ratio with four decimals, or null when there is no denominator (G13: unavailable, not zero). */
export function ratio(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function actorOf(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof v['kind'] === 'string' ? v['kind'] : 'unknown',
    accountId: typeof v['accountId'] === 'string' ? v['accountId'] : null,
    personId: typeof v['personId'] === 'string' ? v['personId'] : null,
    staffRoles: Array.isArray(v['staffRoles']) ? (v['staffRoles'] as string[]) : [],
    sessionId: typeof v['sessionId'] === 'string' ? v['sessionId'] : null,
    actorLabel: typeof v['actorLabel'] === 'string' ? v['actorLabel'] : 'unknown',
  };
}

export function toMetricDefinition(row: MetricDefinitionRow): MetricDefinition {
  return {
    id: row.id,
    metricKey: row.metric_key,
    version: row.version,
    name: row.name,
    reportKeys: row.report_keys as MetricDefinition['reportKeys'],
    businessQuestion: row.business_question,
    grain: row.grain,
    numerator: row.numerator,
    denominator: row.denominator,
    timeBasis: row.time_basis,
    exclusions: row.exclusions,
    dimensions: row.dimensions,
    currency: row.currency,
    freshness: row.freshness,
    accessScope: row.access_scope,
    unit: row.unit,
    requirementIds: row.requirement_ids,
    pendingDecisions: row.pending_decisions,
    definitionHash: row.definition_hash,
    status: row.status,
    recordedAt: iso(row.recorded_at),
    supersededAt: isoOrNull(row.superseded_at),
  };
}

/** A metric value; `value` null requires the reason (G13). */
export function metricValue(
  metric: string,
  label: string,
  unit: MetricUnitValue,
  value: number | null,
  options: {
    currency?: string | null;
    dimensions?: Record<string, string>;
    unavailableReason?: string | null;
  } = {},
): MetricValue {
  return {
    metric,
    label,
    value,
    unit,
    currency: options.currency ?? null,
    dimensions: options.dimensions ?? {},
    unavailableReason: value === null ? (options.unavailableReason ?? 'not available') : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Facility-local days (SPK-SCHED-008; metric dictionary G4: the operating day runs midnight to
// midnight local time until Operations answers DEC-001)
// ---------------------------------------------------------------------------------------------

export interface LocalDay {
  date: string;
  weekday: number;
  start: number;
  end: number;
}

export function localDay(timezone: string, date: string): LocalDay {
  const start = resolveLocal(date, '00:00', timezone)?.instant;
  const end = resolveLocal(addDays(date, 1), '00:00', timezone)?.instant;
  if (!start || !end)
    throw errors.validation(`The date ${date} cannot be resolved in ${timezone}.`);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { date, weekday, start: start.getTime(), end: end.getTime() };
}

export function localDays(timezone: string, from: string, to: string, maxDays: number): LocalDay[] {
  if (compareLocalDates(from, to) > 0) {
    throw errors.validation('The range must not end before it starts.', { from, to });
  }
  const days: LocalDay[] = [];
  for (let d = from; compareLocalDates(d, to) <= 0; d = addDays(d, 1)) {
    days.push(localDay(timezone, d));
    if (days.length > maxDays) {
      throw errors.validation(`A report may span at most ${maxDays} days.`, { from, to });
    }
  }
  return days;
}

/** Instant of a local wall-clock time; a nonexistent local time moves forward (DST gap). */
export function localInstant(timezone: string, date: string, time: string): number {
  const resolved = resolveLocal(date, time, timezone);
  if (!resolved) throw errors.validation(`The local time ${date} ${time} cannot be resolved.`);
  return resolved.instant.getTime();
}

export function localDateOfInstant(timezone: string, instant: Date | number): string {
  const l = toLocal(timezone, new Date(instant));
  return `${String(l.year).padStart(4, '0')}-${String(l.month).padStart(2, '0')}-${String(l.day).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday, in the facility's zone. */
export function toLocalWeekday(timezone: string, instant: Date | number): number {
  return toLocal(timezone, new Date(instant)).weekday;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? 'unknown';
}

/** `HH:MM-HH:MM` start-time band of an instant (band width from the policy). */
export function timeBand(timezone: string, instant: Date | number, bandMinutes: number): string {
  const l = toLocal(timezone, new Date(instant));
  const minute = l.hour * 60 + l.minute;
  const start = Math.floor(minute / bandMinutes) * bandMinutes;
  const end = Math.min(start + bandMinutes, 24 * 60);
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${fmt(start)}-${fmt(end)}`;
}

export function localTimeLabel(timezone: string, instant: Date | number): string {
  const l = toLocal(timezone, new Date(instant));
  return `${String(l.hour).padStart(2, '0')}:${String(l.minute).padStart(2, '0')}`;
}

/** Program age band label from catalog's configured band (DEC-003), or `unspecified`. */
export function ageBandLabel(band: Record<string, unknown> | null | undefined): string {
  if (!band) return 'unspecified';
  const min = typeof band['minAgeYears'] === 'number' ? band['minAgeYears'] : null;
  const max = typeof band['maxAgeYears'] === 'number' ? band['maxAgeYears'] : null;
  if (min === null && max === null) return 'unspecified';
  if (min !== null && max !== null) return `${min}-${max}`;
  return min !== null ? `${min}+` : `up to ${max}`;
}

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

export function sumBy<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((sum, item) => sum + value(item), 0);
}
