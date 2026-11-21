/**
 * Staff S 4e "Manager · this week at a glance" (desktop 1440, rail › Reports; SPK-REPORT-001
 * definitions, SPK-REPORT-002, SPK-REPORT-004, SPK-REPORT-007 exports, SPK-PAY-011).
 *
 * - Four numbers with a plain-words reason under each, against the previous period of the same
 *   length: sales (`GET /v1/reports/sales-by-product-line`, "sales as charged, not recognized
 *   revenue"), fields booked (`/reports/utilization`, the utilization rate, with the longest
 *   closure as the reason), desk check-in time (proposed: no check-in timing is recorded) and
 *   no-shows (`/reports/attendance`, observed absences over attended plus absent).
 * - Sales by day as stacked bars (programs, rentals, desk sales; the schedule's kind colours,
 *   glyph-free but every bar labelled and readable as text). Clicking a day opens its bookings on
 *   the schedule (`/schedule/calendar?date=`). Month and Season show weeks.
 * - "Worth a look": what the reports point at, each with its next action: families waiting
 *   (`/reports/waitlist-demand`) → "Add a session" opens New booking (the schedule's drawer) on
 *   the first free hour of a space tomorrow (`GET /v1/resource-availability`); applications
 *   waiting for a decision (`/reports/registration-funnel`) → Review; offers accepted → Details;
 *   injury reports of the period (`GET /v1/incidents`, managers who may read them) → Open.
 *   "Promote" opens the message composer; a "past players" audience is not in the API (a
 *   bulk-message composer is not specified yet), so it says so.
 * - Export: CSV stores a run of the sales report for the range and downloads its export
 *   (`POST /v1/reports/runs`, `POST /v1/reports/exports`, the one-time download); PDF prints the
 *   page (the browser's "Save as PDF").
 * Every figure the viewer may not read is shown as not available, never as zero (G13).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { useIntentSend } from '../../../api/useIntentSend';
import { downloadExport, saveFile } from '../../../features/insight-admin/download';
import { ReportsNav } from '../../../features/insight-admin/nav';
import {
  FacilityGate,
  type FacilityContext,
} from '../../../features/schedule-facilities/facility-scope';
import { useApi, useApp, useNow } from '../../../providers/AppProviders';
import { Icon } from '../../../ui/Icon';
import { SegmentedControl } from '../../../ui/SegmentedControl';
import { Skeleton } from '../../../ui/Skeleton';
import { useToast } from '../../../ui/Toast';
import { NewBookingDrawer, type BookingSlot } from '../../schedule/NewBookingDrawer';
import {
  SERIES,
  addDays,
  change,
  closureReason,
  metric,
  moneyText,
  mostAbsent,
  noShowRate,
  periodOf,
  previousOf,
  rangeLabel,
  salesOf,
  salesReason,
  type Range,
} from './week-model';
import './week.css';

type ReportResponse = Schema<'ReportResponse'>;

export function ManagerWeekScreen() {
  return (
    <section aria-label="This week" className="mw-screen">
      <ReportsNav />
      <FacilityGate purpose="see its week">
        {(facility) => <Week key={facility.id} facility={facility} />}
      </FacilityGate>
    </section>
  );
}

const RANGE_TITLE: Record<Range, string> = {
  week: 'This week',
  month: 'This month',
  season: 'This season',
};
const RANGE_COMPARE: Record<Range, string> = {
  week: 'last week',
  month: 'the 5 weeks before',
  season: 'the 13 weeks before',
};

function useReport(path: string, query: Record<string, unknown>, enabled = true) {
  return useApiQuery({
    path: path as '/reports/sales-by-product-line',
    request: { query: query as never },
    enabled,
    staleTime: 5 * 60_000,
  });
}

function Week({ facility }: { facility: FacilityContext }) {
  const api = useApi();
  const now = useNow(60 * 60_000);
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>('week');
  const today = facility.localDate ?? now.toISOString().slice(0, 10);
  const period = useMemo(() => periodOf(range, today), [range, today]);
  const before = previousOf(period);
  const base = { facilityId: facility.id };
  const sales = useReport('/reports/sales-by-product-line', { ...base, ...pick(period) });
  const salesBefore = useReport('/reports/sales-by-product-line', { ...base, ...before });
  const util = useReport('/reports/utilization', { ...base, ...pick(period) });
  const utilBefore = useReport('/reports/utilization', { ...base, ...before });
  const attendance = useReport('/reports/attendance', { ...base, ...pick(period) });
  const attendanceBefore = useReport('/reports/attendance', { ...base, ...before });
  const waitlist = useReport('/reports/waitlist-demand', { ...base, ...pick(period) });
  const funnel = useReport('/reports/registration-funnel', { ...base, ...pick(period) });
  const incidents = useApiQuery({ path: '/incidents', staleTime: 5 * 60_000 });
  const buckets = useQueries({
    queries: period.buckets.map((b) => ({
      queryKey: [
        'api',
        '/reports/sales-by-product-line',
        { query: { ...base, from: b.from, to: b.to } },
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/reports/sales-by-product-line', {
            query: { ...base, from: b.from, to: b.to },
            signal,
          })
        ).data,
      staleTime: 5 * 60_000,
    })),
  });

  const nowSales = salesOf(sales.data);
  const beforeSales = salesOf(salesBefore.data);
  const rate = metric(util.data, 'MET-070');
  const rateBefore = metric(utilBefore.data, 'MET-070');
  const noShows = noShowRate(attendance.data);
  const noShowsBefore = noShowRate(attendanceBefore.data);
  const salesChange = change(nowSales.total, beforeSales.total, 'percent_change');
  const rateChange = change(rate, rateBefore, 'points');
  const noShowChange = change(noShows, noShowsBefore, 'points', false);
  const bars = period.buckets.map((b, i) => ({
    ...b,
    totals: salesOf(buckets[i]?.data as ReportResponse | undefined),
    loading: !buckets[i]?.data && !buckets[i]?.error,
  }));
  const max = Math.max(1, ...bars.map((b) => b.totals.total));
  const best = bars.reduce<number | null>(
    (top, b, i) =>
      b.totals.total > 0 && (top === null || b.totals.total > bars[top]!.totals.total) ? i : top,
    null,
  );

  return (
    <div className="week">
      <header className="mw-head">
        <div>
          <p className="mw-kicker">
            {facility.name} · {rangeLabel(period.from, period.to)} vs {RANGE_COMPARE[range]}
          </p>
          <h1 className="mw-title">{RANGE_TITLE[range]}</h1>
        </div>
        <div className="mw-head-actions">
          <SegmentedControl
            label="Period"
            value={range}
            onChange={setRange}
            segments={[
              { value: 'week', label: 'Week' },
              { value: 'month', label: 'Month' },
              { value: 'season', label: 'Season' },
            ]}
          />
          <ExportMenu facility={facility} from={period.from} to={period.to} />
        </div>
      </header>

      <ul className="mw-kpis" aria-label="The numbers">
        <Kpi
          label="Revenue"
          loading={!sales.data && !sales.error}
          error={sales.error}
          value={sales.data ? moneyText(nowSales.total, nowSales.currency) : null}
          change={salesChange}
          reason={salesReason(nowSales, beforeSales)}
          note="Sales as charged, not recognized revenue."
        />
        <Kpi
          label="Fields booked"
          loading={!util.data && !util.error}
          error={util.error}
          value={rate !== null ? `${Math.round(rate * 100)}%` : null}
          change={rateChange}
          reason={closureReason(util.data)}
        />
        <li className="mw-kpi" data-tone="pending">
          <span className="mw-kpi-label">Check-in at the desk</span>
          <b className="mw-kpi-value">—</b>
          <span className="mw-kpi-reason" data-tone="pending">
            ◷ Proposed · check-in time is not recorded yet
          </span>
        </li>
        <Kpi
          label="No-shows"
          loading={!attendance.data && !attendance.error}
          error={attendance.error}
          value={noShows !== null ? `${(noShows * 100).toFixed(1)}%` : null}
          change={noShowChange}
          reason={mostAbsent(attendance.data)}
          alarm={noShowChange?.tone === 'danger'}
        />
      </ul>

      <div className="mw-grid">
        <section className="mw-card mw-chart" aria-labelledby="mw-chart-title">
          <header className="mw-card-head">
            <h2 id="mw-chart-title">Revenue by {range === 'week' ? 'day' : 'week'}</h2>
            <ul className="mw-legend" aria-label="Series">
              {SERIES.map((s) => (
                <li key={s.key} data-series={s.key}>
                  <i aria-hidden="true" />
                  {s.label}
                </li>
              ))}
            </ul>
          </header>
          <ol className="mw-bars" aria-label={`Revenue by ${range === 'week' ? 'day' : 'week'}`}>
            {bars.map((b, i) => {
              const total = b.totals.total;
              const label = `${b.label}: ${moneyText(total, b.totals.currency)}. ${SERIES.map(
                (s) => `${s.label} ${moneyText(b.totals.bySeries[s.key], b.totals.currency)}`,
              ).join(', ')}. Open the bookings.`;
              return (
                <li key={b.from}>
                  <button
                    type="button"
                    className="mw-bar"
                    data-best={best === i || undefined}
                    aria-label={label}
                    onClick={() =>
                      navigate(
                        range === 'week'
                          ? `/schedule/calendar?date=${b.from}`
                          : `/schedule/calendar?date=${b.from}&view=week`,
                      )
                    }
                  >
                    <span className="mw-bar-stack" aria-hidden="true">
                      {b.loading ? (
                        <Skeleton height="40%" radius={8} />
                      ) : (
                        SERIES.map((s) => (
                          <span
                            key={s.key}
                            data-series={s.key}
                            style={{ height: `${(b.totals.bySeries[s.key] / max) * 100}%` }}
                          />
                        ))
                      )}
                    </span>
                    <span className="mw-bar-label">
                      {b.short}
                      {best === i ? ` · ${moneyText(total, b.totals.currency)}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="caption mw-chart-note">
            Sales by the day an order was fulfilled or a sale paid, in the facility&apos;s time.
          </p>
        </section>

        <WorthALook
          facility={facility}
          waitlist={waitlist.data}
          funnel={funnel.data}
          incidents={incidents.data}
          incidentsError={!!incidents.error}
          from={period.from}
          to={period.to}
          range={range}
        />
      </div>
    </div>
  );
}

function pick(p: { from: string; to: string }) {
  return { from: p.from, to: p.to };
}

function Kpi({
  label,
  value,
  change: delta,
  reason,
  loading,
  error,
  note,
  alarm,
}: {
  label: string;
  value: string | null;
  change: ReturnType<typeof change>;
  reason: string | null;
  loading: boolean;
  error: unknown;
  note?: string;
  alarm?: boolean;
}) {
  return (
    <li className="mw-kpi" data-alarm={alarm || undefined}>
      <span className="mw-kpi-label">{label}</span>
      {loading ? (
        <Skeleton height={34} width="60%" />
      ) : (
        <b className="mw-kpi-value" data-alarm={alarm || undefined}>
          {value ?? 'Not available'}
        </b>
      )}
      {error ? (
        <span className="mw-kpi-reason">Not available to your role.</span>
      ) : delta || reason ? (
        <span className="mw-kpi-reason" data-tone={delta?.tone ?? 'neutral'} title={note}>
          {delta ? `${delta.glyph} ${delta.text}` : ''}
          {delta && reason ? ' · ' : ''}
          {reason ?? ''}
        </span>
      ) : null}
    </li>
  );
}

interface LookItem {
  key: string;
  tone: 'danger' | 'warning' | 'success' | 'neutral';
  glyph: string;
  text: React.ReactNode;
  action: React.ReactNode;
}

function WorthALook({
  facility,
  waitlist,
  funnel,
  incidents,
  incidentsError,
  from,
  to,
  range,
}: {
  facility: FacilityContext;
  waitlist: ReportResponse | undefined;
  funnel: ReportResponse | undefined;
  incidents: Schema<'Incident'>[] | undefined;
  incidentsError: boolean;
  from: string;
  to: string;
  range: Range;
}) {
  const [slot, setSlot] = useState<BookingSlot | null>(null);
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.id } },
    staleTime: 10 * 60_000,
  });
  const tomorrow = addDays(facility.localDate ?? from, 1);
  const free = useApiQuery({
    path: '/resource-availability',
    request: {
      query: {
        facilityId: facility.id,
        start: `${tomorrow}T15:00:00.000Z`,
        end: `${addDays(tomorrow, 1)}T05:00:00.000Z`,
        durationMinutes: 60,
      },
    },
    staleTime: 60_000,
  });
  const items: LookItem[] = [];
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  const inLine = (row: Record<string, unknown>) => num(row['waiting']) + num(row['holdingOffer']);
  const waiting = [...(waitlist?.rows ?? [])].sort((a, b) => inLine(b) - inLine(a))[0];
  if (waiting && inLine(waiting) > 0) {
    const firstFree = free.data?.resources.find((r) => r.slots.length > 0);
    const n = inLine(waiting);
    items.push({
      key: 'waiting',
      tone: 'warning',
      glyph: '▲',
      text: (
        <>
          <b>{str(waiting['offering'])}</b> is full; {n} {n === 1 ? 'family is' : 'families are'}{' '}
          waiting for a place.
        </>
      ),
      action: (
        <button
          type="button"
          className="mw-look-action"
          disabled={!firstFree}
          onClick={() => {
            const s = firstFree?.slots[0];
            if (firstFree && s) {
              setSlot({
                resourceId: firstFree.resourceId,
                start: new Date(s.start).getTime(),
                end: new Date(s.end).getTime(),
                held: false,
              });
            }
          }}
        >
          Add a session
        </button>
      ),
    });
  }
  const pending = [...(funnel?.rows ?? [])].sort(
    (a, b) => num(b['awaitingDecision']) - num(a['awaitingDecision']),
  )[0];
  if (pending && num(pending['awaitingDecision']) > 0) {
    items.push({
      key: 'pending',
      tone: 'danger',
      glyph: '✕',
      text: (
        <>
          <b>{str(pending['offering'])}</b>: {num(pending['awaitingDecision'])} applications are
          waiting for a decision.
        </>
      ),
      action: (
        <Link className="mw-look-action" to="/registrations">
          Review
        </Link>
      ),
    });
  }
  const offers = metric(waitlist, 'MET-023');
  const outstanding = metric(waitlist, 'MET-022') ?? 0;
  items.push({
    key: 'offers',
    tone: offers !== null && offers >= 0.5 ? 'success' : 'neutral',
    glyph: offers !== null && offers >= 0.5 ? '✓' : '●',
    text:
      offers !== null ? (
        <>
          Waitlist offers: {Math.round(offers * 100)}% accepted, {outstanding} still open.
        </>
      ) : (
        <>
          Waitlist offers: none answered {range === 'week' ? 'this week' : 'in the period'}
          {outstanding > 0 ? `, ${outstanding} still open` : ''}.
        </>
      ),
    action: (
      <Link className="mw-look-action" to="/registrations/waitlists">
        Details
      </Link>
    ),
  });
  if (!incidentsError) {
    const inRange = (incidents ?? []).filter(
      (i) =>
        i.kind === 'injury' &&
        i.occurredAt.slice(0, 10) >= from &&
        i.occurredAt.slice(0, 10) <= addDays(to, 1),
    );
    const open = inRange.filter((i) => i.status !== 'closed').length;
    const minor = inRange.every((i) => i.severity === 'low' || i.severity === 'medium');
    items.push({
      key: 'injuries',
      tone: open > 0 ? 'warning' : 'neutral',
      glyph: open > 0 ? '▲' : '●',
      text:
        inRange.length === 0 ? (
          <>No injury reports {range === 'week' ? 'this week' : 'in the period'}.</>
        ) : (
          <>
            {inRange.length} injury {inRange.length === 1 ? 'report' : 'reports'}
            {minor ? (inRange.length === 1 ? ', minor' : ', all minor') : ''}.{' '}
            {open === 0 ? 'None open.' : `${open} open.`}
          </>
        ),
      action: (
        <Link className="mw-look-action" to="/today">
          Open
        </Link>
      ),
    });
  }
  items.push({
    key: 'promote',
    tone: 'neutral',
    glyph: '●',
    text: (
      <>
        Fill the next season: tell past players what&apos;s coming.{' '}
        <span className="mw-proposed">◷ A “past players” audience is proposed</span>
      </>
    ),
    action: (
      <Link className="mw-look-action" to="/communications/compose">
        Promote
      </Link>
    ),
  });

  return (
    <section className="mw-card mw-look" aria-labelledby="mw-look-title">
      <header className="mw-card-head">
        <h2 id="mw-look-title">Worth a look</h2>
      </header>
      <ul className="mw-look-list">
        {items.map((item) => (
          <li key={item.key} data-tone={item.tone}>
            <span className="mw-look-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <p>{item.text}</p>
            {item.action}
          </li>
        ))}
      </ul>
      {slot && resources.data ? (
        <NewBookingDrawer
          facility={facility}
          resources={resources.data}
          slot={slot}
          onClose={() => setSlot(null)}
        />
      ) : null}
    </section>
  );
}

function ExportMenu({
  facility,
  from,
  to,
}: {
  facility: FacilityContext;
  from: string;
  to: string;
}) {
  const api = useApi();
  const { online, services } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { send } = useIntentSend([
    ['api', '/reports/runs'],
    ['api', '/reports/exports'],
  ]);
  const csv = async () => {
    setOpen(false);
    setBusy(true);
    try {
      const run = await send(`mw-run|${facility.id}|${from}|${to}`, 'post', '/reports/runs', {
        body: {
          report: 'sales_by_product_line',
          parameters: { facilityId: facility.id, from, to },
        },
      });
      const created = await send(`mw-export|${run.id}`, 'post', '/reports/exports', {
        body: { reportRunId: run.id, format: 'csv' },
      });
      const file = await downloadExport(
        {
          baseUrl: services.config.apiBaseUrl,
          sessionStore: services.sessionStore,
          clientInfo: api.clientInfo,
          fetch: services.fetch,
        },
        created.id,
        created.downloadToken,
        `sales-${from}-${to}.csv`,
      );
      saveFile(file);
      toast.show({
        tone: 'success',
        message: 'CSV downloaded. It is listed under Stored runs and exports.',
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.show({
        tone: 'error',
        message: `The export didn't download.${code ? ` Code ${code}` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mw-export">
      <button
        type="button"
        className="mw-export-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="download" size={18} />
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {open ? (
        <ul className="mw-export-menu" role="menu">
          <li role="none">
            <button type="button" role="menuitem" disabled={!online} onClick={() => void csv()}>
              CSV of sales for {rangeLabel(from, to)}
              {!online ? ' (needs a connection)' : ''}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                globalThis.print?.();
              }}
            >
              PDF (print this page)
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
