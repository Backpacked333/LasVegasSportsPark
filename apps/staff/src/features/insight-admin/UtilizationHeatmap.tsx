/**
 * The utilization heatmap (park UI redesign; `GET /v1/reports/utilization-heatmap`, MET-106 to
 * MET-108, SPK-REPORT-003/006): one cell per facility-local weekday and hour the report returns,
 * shaded by its utilization rate and always labelled with the rate in text (never colour alone,
 * SPK-UX-009). A cell the API did not return holds no time; a cell without available hours says
 * "no hours" rather than zero (G13). The rows of the report table below carry the same figures.
 */
import type { Schema } from '@sportspark/api-client';

type ReportResponse = Schema<'ReportResponse'>;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
/** Monday first: the API's weekday is 0 = Sunday. */
const ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function UtilizationHeatmap({ report }: { report: ReportResponse }) {
  const cells = new Map<string, { rate: number | null; reserved: number; available: number }>();
  let first = 24;
  let last = -1;
  for (const row of report.rows) {
    const weekday = Number(row['weekday']);
    const hour = Number(row['hour']);
    if (!Number.isInteger(weekday) || !Number.isInteger(hour)) continue;
    first = Math.min(first, hour);
    last = Math.max(last, hour);
    cells.set(`${weekday}:${hour}`, {
      rate: typeof row['utilizationRate'] === 'number' ? row['utilizationRate'] : null,
      reserved: Number(row['reservedUnitHours'] ?? 0),
      available: Number(row['availableUnitHours'] ?? 0),
    });
  }
  if (last < first) return null;
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  return (
    <section className="ia-section ia-heatmap" aria-label="Heatmap">
      <h4>Utilization by weekday and hour</h4>
      <div className="ia-heatmap-scroll">
        <table className="ia-heatmap-grid" aria-label="Utilization rate by weekday and hour">
          <thead>
            <tr>
              <th scope="col">Day</th>
              {hours.map((h) => (
                <th key={h} scope="col">
                  {hourLabel(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ORDER.map((weekday, index) => (
              <tr key={weekday}>
                <th scope="row">{WEEKDAYS[index]}</th>
                {hours.map((h) => {
                  const cell = cells.get(`${weekday}:${h}`);
                  const rate = cell?.rate ?? null;
                  const level = rate === null ? 0 : Math.min(4, Math.ceil(rate * 4));
                  return (
                    <td
                      key={h}
                      data-level={cell ? level : 'none'}
                      title={
                        cell
                          ? `${cell.reserved} of ${cell.available} unit-hours reserved`
                          : 'No time in this hour'
                      }
                    >
                      {!cell ? '' : rate === null ? 'no hours' : `${Math.round(rate * 100)}%`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
