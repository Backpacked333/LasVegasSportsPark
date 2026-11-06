/**
 * Page-header counts for one facility-local day ("41 activities · 1 restriction"), from
 * `GET /v1/facilities/{id}/day-summary` (SPK-SCHED-008: midnight to midnight in the facility's
 * zone). A section the viewer's roles may not read comes back null and is left out, never shown as
 * 0; while loading, after a failure, or with no facility chosen (and more than one in scope),
 * nothing extra is shown (the screens below report their own data).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { useFacilityOptions } from './facility-scope';

export type FacilityDaySummary = Schema<'FacilityDaySummary'>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function useFacilityDaySummary(facilityId: string | null | undefined, date?: string) {
  return useApiQuery({
    path: '/facilities/{id}/day-summary',
    request: { path: { id: facilityId ?? '' }, query: date ? { date } : {} },
    enabled: !!facilityId,
  });
}

/** The counts as one line of text parts (activities, restrictions, closures, open tasks). */
export function daySummaryParts(
  summary: FacilityDaySummary,
  include: { activities?: boolean; tasks?: boolean } = {},
): string[] {
  const parts: string[] = [];
  if (summary.schedule && include.activities !== false) {
    parts.push(plural(summary.schedule.activities.total, 'activity', 'activities'));
  }
  if (summary.restrictions) {
    parts.push(plural(summary.restrictions.active, 'active restriction'));
  }
  if (summary.schedule && summary.schedule.closures.active > 0) {
    parts.push(plural(summary.schedule.closures.active, 'closure'));
  }
  if (summary.maintenance && include.tasks) {
    parts.push(plural(summary.maintenance.openTasks, 'open task'));
  }
  return parts;
}

/** "Today · 41 activities · 1 active restriction", for the facility chosen in the header. */
export function DaySummaryLine({
  facilityId,
  include,
}: {
  facilityId?: string | null;
  include?: { activities?: boolean; tasks?: boolean };
}) {
  const { facilityId: chosen } = useApp();
  const { options } = useFacilityOptions();
  // the facility chosen in the header, else the only one in the viewer's scope
  const only = options.length === 1 ? (options[0]?.id ?? null) : null;
  const id = facilityId === undefined ? (chosen ?? only) : facilityId;
  const summary = useFacilityDaySummary(id);
  if (!summary.data) return null;
  const parts = daySummaryParts(summary.data, include);
  if (parts.length === 0) return null;
  return (
    <span className="day-summary" data-testid="day-summary">
      {' · '}
      Today: {parts.join(' · ')}
    </span>
  );
}
