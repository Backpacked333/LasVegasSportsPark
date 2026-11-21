/**
 * Week by use (handoff S 2b; INTERACTIONS 2b row 1; SPK-REPORT-003, SPK-SCHED-003, SPK-SCHED-008):
 * every space by the seven local days of the week (Monday to Sunday), each cell the share of the
 * space's open hours booked, with what the day holds written in it: how many bookings, a conflict,
 * a closure ("Closed", or "Until 1 PM", hatched). Today's column is outlined. Selecting a cell opens
 * that space and day in the day timeline (S 1b).
 *
 * - The share comes from reporting's utilization read (`GET /v1/reports/utilization`, one local day
 *   per read, its per-resource rows: reserved over available unit-hours, buffers included, closures
 *   and operating hours applied by reporting). The heatmap report (`/reports/utilization-heatmap`)
 *   answers by weekday and hour over the whole facility, so it gives the week's total, not a space's
 *   day. Utilization is shown to the roles that may read it (reporting.view_utilization); for others
 *   the cells keep their bookings, conflicts and closures and say the share is not available, and
 *   are toned by bookings only. Nothing is guessed.
 * - Cells matching an open "Find a free slot" search are outlined and say the first match.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo, type CSSProperties } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import type { FacilityContext } from '../../features/schedule-facilities/facility-scope';
import { orderedInventory } from '../../features/schedule-facilities/inventory';
import { useActionAllowed } from '../../features/schedule-facilities/permission';
import { addDaysToLocalDate, localDaysWindow } from '../../features/schedule-facilities/time';
import { useApi } from '../../providers/AppProviders';
import {
  byRowRank,
  heatCells,
  heatStep,
  shortClock,
  weekDates,
  type Conflict,
  type HeatCell,
  type SlotMatch,
  type TimelineBlock,
} from './schedule-model';

type Resource = Schema<'Resource'>;
type Closure = Schema<'Closure'>;
type Report = Schema<'ReportResponse'>;

const DAY = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short' });

function dayHead(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${DAY.format(new Date(Date.UTC(y, m - 1, d)))} ${d}`;
}

/** Rates per `resourceId|date` from the utilization rows (reserved / available unit-hours). */
export function ratesFrom(
  reports: readonly { date: string; report: Report | undefined }[],
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const { date, report } of reports) {
    for (const row of report?.rows ?? []) {
      const id = row.resourceId;
      const available = Number(row.availableUnitHours);
      const reserved = Number(row.reservedUnitHours);
      if (typeof id !== 'string') continue;
      out.set(
        `${id}|${date}`,
        Number.isFinite(available) && available > 0 && Number.isFinite(reserved)
          ? reserved / available
          : null,
      );
    }
  }
  return out;
}

function cellLabel(cell: HeatCell, space: string, date: string, known: boolean): string {
  const parts = [`${space}, ${dayHead(date)}`];
  if (cell.closure) parts.push(`${cell.closure.label}: ${cell.closure.reason}`);
  if (known) {
    parts.push(
      cell.rate === null ? 'share booked not available' : `${Math.round(cell.rate * 100)}% booked`,
    );
  }
  parts.push(`${cell.bookings} booking${cell.bookings === 1 ? '' : 's'}`);
  if (cell.conflicts > 0)
    parts.push(`${cell.conflicts} conflict${cell.conflicts === 1 ? '' : 's'}`);
  return `${parts.join(', ')}. Open the day`;
}

/**
 * The week's share of open hours booked over every space, from reporting's heatmap read
 * (`GET /v1/reports/utilization-heatmap`, weekday by hour, summed); null when not readable.
 */
export function useWeekRate(
  facilityId: string,
  dates: readonly string[],
  enabled: boolean,
): number | null {
  const week = useApiQuery({
    path: '/reports/utilization-heatmap',
    request: { query: { facilityId, from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' } },
    enabled: enabled && dates.length > 0,
  });
  return useMemo(() => {
    const rows = week.data?.rows ?? [];
    let available = 0;
    let reserved = 0;
    for (const r of rows) {
      available += Number(r.availableUnitHours) || 0;
      reserved += Number(r.reservedUnitHours) || 0;
    }
    return available > 0 ? reserved / available : null;
  }, [week.data]);
}

export function WeekHeatmap({
  facility,
  resources,
  date,
  today,
  blocks,
  conflicts,
  closures,
  matches = [],
  onOpenDay,
}: {
  facility: FacilityContext;
  resources: readonly Resource[];
  date: string;
  today: string;
  blocks: readonly TimelineBlock[];
  conflicts: ReadonlyMap<string, Conflict>;
  closures: readonly Closure[];
  matches?: readonly SlotMatch[];
  onOpenDay: (date: string, resourceId?: string) => void;
}) {
  const api = useApi();
  const tz = facility.timezone;
  const dates = useMemo(() => weekDates(date), [date]);
  const mayRead = useActionAllowed('reporting.view_utilization', facility.id);
  const reads = useQueries({
    queries: dates.map((d) => ({
      queryKey: [
        'api',
        '/reports/utilization',
        { query: { facilityId: facility.id, from: d, to: d } },
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/reports/utilization', {
            query: { facilityId: facility.id, from: d, to: d },
            signal,
          })
        ).data,
      enabled: mayRead,
      staleTime: 60_000,
    })),
  });
  const weekRate = useWeekRate(facility.id, dates, mayRead);
  const rates = ratesFrom(dates.map((d, i) => ({ date: d, report: reads[i]?.data })));
  const known = mayRead && reads.some((r) => r.isSuccess);
  const spaces = byRowRank(orderedInventory(resources))
    .filter((r) => r.depth === 0)
    .map((r) => r.resource);
  const cells = heatCells({
    resources: spaces.length > 0 ? spaces : resources,
    inventory: resources,
    dates,
    blocks,
    conflicts,
    closures,
    rates,
    timeZone: tz,
    dayWindow: (d) => {
      const w = localDaysWindow(d, 1, tz);
      return { start: Date.parse(w.start), end: Date.parse(w.end) };
    },
  });
  // Without the share, cells are toned by how busy the day is among the week's cells.
  const most = Math.max(1, ...cells.map((c) => c.bookings));
  const cols = { '--heat-cols': String(dates.length) } as CSSProperties;

  return (
    <section className="card card-flush heat" aria-labelledby="heat-title" style={cols}>
      <h3 id="heat-title" className="visually-hidden">
        Week of {dayHead(dates[0] ?? date)}: share of open hours booked
      </h3>
      {weekRate !== null ? (
        <p className="visually-hidden" data-testid="week-rate">
          {Math.round(weekRate * 100)}% booked this week
        </p>
      ) : null}
      <div className="heat-scroll">
        <table className="heat-grid">
          <thead>
            <tr>
              <th scope="col" className="heat-space">
                Space
              </th>
              {dates.map((d) => (
                <th key={d} scope="col" data-today={d === today || undefined}>
                  {dayHead(d)}
                  {d === today ? ' · today' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spaces.map((space) => (
              <tr key={space.id}>
                <th scope="row" className="heat-space">
                  {space.name}
                </th>
                {dates.map((d, i) => {
                  const cell = cells.find((c) => c.resourceId === space.id && c.date === d);
                  if (!cell) return <td key={d} />;
                  const step = known
                    ? heatStep(cell.rate)
                    : heatStep(cell.bookings === 0 ? 0 : 0.4 + (cell.bookings / most) * 0.55);
                  const match = matches.find((m) => m.resourceId === space.id && m.date === d);
                  return (
                    <td key={d}>
                      <button
                        type="button"
                        className="heat-cell"
                        data-step={step ?? undefined}
                        data-closed={cell.closure ? true : undefined}
                        data-today={d === today || undefined}
                        data-match={match ? true : undefined}
                        aria-label={cellLabel(cell, space.name, d, known)}
                        onClick={() => onOpenDay(d, space.id)}
                      >
                        <span className="heat-top" aria-hidden="true">
                          {cell.closure ? (
                            <b>▲ {cell.closure.label}</b>
                          ) : known ? (
                            <b>{cell.rate === null ? '—' : `${Math.round(cell.rate * 100)}%`}</b>
                          ) : null}
                        </span>
                        <span className="heat-bottom" aria-hidden="true">
                          {match ? (
                            <b className="heat-match">
                              Match: {shortClock(match.start, tz)}–{shortClock(match.end, tz)}
                            </b>
                          ) : cell.closure ? (
                            cell.closure.reason
                          ) : (
                            <>
                              {cell.bookings}
                              {i === 0 ? ` booking${cell.bookings === 1 ? '' : 's'}` : ''}
                              {cell.conflicts > 0 ? (
                                <span className="heat-issue">
                                  {' '}
                                  ✕ {cell.conflicts} conflict{cell.conflicts === 1 ? '' : 's'}
                                </span>
                              ) : null}
                            </>
                          )}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-foot heat-foot">
        {known ? (
          <span className="heat-legend">
            Share of open hours booked
            <span className="heat-scale" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((s) => (
                <i key={s} data-step={s} />
              ))}
            </span>
            0 → 100%
            {weekRate !== null ? ` · ${Math.round(weekRate * 100)}% this week` : ''}
          </span>
        ) : (
          <span className="heat-legend">
            Shaded by bookings. The share of open hours booked is shown to schedulers and managers.
          </span>
        )}
        <span>Select a cell to open that day</span>
      </div>
      <p className="visually-hidden">
        Week {dayHead(dates[0] ?? date)} to {dayHead(addDaysToLocalDate(dates[0] ?? date, 6))}.
      </p>
    </section>
  );
}
