/**
 * The four KPI tiles of S 1a (S 1d shows the first two), each with a second line that answers
 * "is that bad?":
 *
 * - Checked in: arrivals recorded today (`GET /v1/facilities/{id}/occupancy`) of those expected
 *   (`GET /v1/reports/expected-arrivals`, MET-004), with a bar;
 * - Spaces in use: top-level spaces with an activity now, of all, how many closed, and the
 *   busiest two hours of the day ("Peak 4-6 PM: all 8 booked");
 * - Open issues: what "Needs action" lists, how many block a start in the next hour, and the
 *   oldest one's age;
 * - Taken today: sales of the facility day by source (`GET /v1/reports/sales-by-product-line`,
 *   point of sale and online), with payment outcomes still unknown from the Today feed.
 *
 * A figure the viewer may not read shows "Not available to you" (never zero, §4.10); a changed
 * figure flashes for 1 s (`Flash`).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { Flash } from '../../ui/Flash';
import { Kpi, KpiRow } from '../../ui/Page';
import { Skeleton } from '../../ui/Skeleton';
import { localClock, type IssueCard, type TodayFacility } from './today-model';

type Report = Schema<'ReportResponse'>;

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

function hourWord(instant: number, timeZone: string, meridiem: boolean): string {
  const { h } = localClock(new Date(instant), timeZone);
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return meridiem ? `${twelve} ${h < 12 ? 'AM' : 'PM'}` : String(twelve);
}

export function salesOf(report: Report | undefined): {
  total: number;
  pos: number;
  online: number;
  currency: string;
} | null {
  if (!report) return null;
  let pos = 0;
  let online = 0;
  let currency = 'USD';
  for (const row of report.rows) {
    const minor = typeof row['salesMinor'] === 'number' ? row['salesMinor'] : 0;
    if (typeof row['currency'] === 'string') currency = row['currency'];
    if (typeof row['source'] === 'string' && row['source'].startsWith('point_of_sale'))
      pos += minor;
    else online += minor;
  }
  return { total: pos + online, pos, online, currency };
}

export function TodayKpis({
  facility,
  cards,
  space,
  peak,
  unknownOutcomes,
  phone = false,
}: {
  facility: TodayFacility;
  cards: readonly IssueCard[];
  space: { inUse: number; total: number; closed: number } | null;
  peak: { start: number; booked: number; total: number } | null;
  unknownOutcomes: number;
  phone?: boolean;
}) {
  const occupancy = useApiQuery({
    path: '/facilities/{id}/occupancy',
    request: { path: { id: facility.facilityId } },
    refetchInterval: 60_000,
  });
  const expected = useApiQuery({
    path: '/reports/expected-arrivals',
    request: { query: { facilityId: facility.facilityId, date: facility.localDate } },
    staleTime: 5 * 60_000,
  });
  const sales = useApiQuery({
    path: '/reports/sales-by-product-line',
    request: {
      query: { facilityId: facility.facilityId, from: facility.localDate, to: facility.localDate },
    },
    enabled: !phone,
    refetchInterval: 60_000,
  });

  const arrived = occupancy.data?.arrivals.people ?? null;
  const expectedCount =
    expected.data?.values.find(
      (v) => v.metric === 'MET-004' && Object.keys(v.dimensions).length === 0,
    )?.value ?? null;
  const pct =
    arrived !== null && expectedCount
      ? Math.min(100, Math.round((arrived / expectedCount) * 100))
      : 0;

  const blocking = cards.filter((c) => c.blocking);
  const firstBlock = blocking.find((c) => c.startAt);
  const oldest = Math.max(0, ...cards.map((c) => c.item?.ageMinutes ?? 0));
  const taken = salesOf(sales.data);

  const pending = (q: { isPending: boolean; error: unknown }) => q.isPending && !q.error;

  return (
    <KpiRow label="Today at a glance">
      <Kpi
        icon="how_to_reg"
        tone="success"
        label="Checked in"
        value={
          pending(occupancy) ? (
            <Skeleton width={56} height={28} />
          ) : arrived === null ? (
            '—'
          ) : (
            <Flash value={arrived}>{arrived}</Flash>
          )
        }
        sub={
          occupancy.error
            ? 'Not available to you'
            : expectedCount !== null
              ? phone
                ? `/ ${expectedCount}`
                : `of ${expectedCount} expected today`
              : phone
                ? null
                : 'expected count not available'
        }
        footer={
          phone || expectedCount === null || arrived === null ? null : (
            <span
              className="kpi-bar"
              role="progressbar"
              aria-label="Checked in of expected"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${pct}%` }} />
            </span>
          )
        }
      />
      <Kpi
        icon="stadium"
        tone="info"
        label="Spaces in use"
        value={
          space ? (
            <Flash value={space.inUse}>{space.inUse}</Flash>
          ) : (
            <Skeleton width={40} height={28} />
          )
        }
        sub={
          space
            ? phone
              ? `/ ${space.total}`
              : `of ${space.total}${space.closed > 0 ? ` · ${space.closed} closed` : ''}`
            : null
        }
        footer={
          phone || !peak ? null : (
            <span className="kpi-foot">
              Peak {hourWord(peak.start, facility.timezone, false)}–
              {hourWord(peak.start + 2 * 3_600_000, facility.timezone, true)}:{' '}
              {peak.booked === peak.total
                ? `all ${peak.total} booked`
                : `${peak.booked} of ${peak.total} booked`}
            </span>
          )
        }
      />
      {phone ? null : (
        <Kpi
          icon="report"
          tone="danger"
          label="Open issues"
          value={<Flash value={cards.length}>{cards.length}</Flash>}
          sub={
            firstBlock ? (
              <span className="kpi-bad">
                <span aria-hidden="true">✕</span> {blocking.length}{' '}
                {blocking.length === 1 ? 'blocks' : 'block'} a{' '}
                {new Intl.DateTimeFormat('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: facility.timezone,
                })
                  .format(new Date(firstBlock.startAt!))
                  .replace(/\s?[AP]M$/, '')}{' '}
                start
              </span>
            ) : cards.length === 0 ? (
              'nothing waiting'
            ) : (
              'none blocks a start'
            )
          }
          footer={
            cards.length > 0 && oldest > 0 ? (
              <span className="kpi-foot">Oldest open {oldest} min</span>
            ) : null
          }
        />
      )}
      {phone ? null : (
        <Kpi
          icon="payments"
          tone="warning"
          label="Taken today"
          value={
            pending(sales) ? (
              <Skeleton width={90} height={28} />
            ) : taken ? (
              <Flash value={taken.total}>{money(taken.total, taken.currency)}</Flash>
            ) : (
              '—'
            )
          }
          sub={
            sales.error ? (
              'Not available to you'
            ) : unknownOutcomes > 0 ? (
              <span>
                <span aria-hidden="true">▲</span> {unknownOutcomes}{' '}
                {unknownOutcomes === 1 ? 'outcome' : 'outcomes'} unknown
              </span>
            ) : null
          }
          footer={
            taken ? (
              <span className="kpi-foot">
                POS {money(taken.pos, taken.currency)} · online{' '}
                {money(taken.online, taken.currency)}
              </span>
            ) : null
          }
        />
      )}
    </KpiRow>
  );
}
