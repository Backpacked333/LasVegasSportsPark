/**
 * Staff S 4e "Manager · this week at a glance" (SPK-REPORT-001, SPK-REPORT-004, SPK-REPORT-007,
 * SPK-PAY-011): periods, comparisons and reasons from the reports; the chart opens a day's
 * bookings; Worth a look carries next actions; Export stores a run and downloads its CSV.
 */
import { fakeResponse, type FakeRequest } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setFileSaver, type DownloadedFile } from '../../../../features/insight-admin/download';
import { createTestApp } from '../../../../testing/test-app';
import {
  change,
  closureReason,
  noShowRate,
  periodOf,
  previousOf,
  rangeLabel,
  salesOf,
  salesReason,
  seriesOf,
} from '../week-model';

function report(values: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>> = []) {
  return {
    report: { key: 'x', title: 'x', requirementIds: [], accessAction: 'x', exportAction: 'x' },
    runId: null,
    asOf: '2026-10-24T12:00:00.000Z',
    producedAt: '2026-10-24T12:00:00.000Z',
    scope: { facilityId: null, timezone: null, from: null, to: null },
    parameters: {},
    freshness: { class: 'F1', pointInTime: 'full', note: '' },
    settings: [],
    metrics: [],
    disclosures: [],
    values: values.map((v) => ({
      unit: 'minor_units',
      currency: 'USD',
      dimensions: {},
      unavailableReason: null,
      label: '',
      ...v,
    })),
    columns: [],
    rows,
  };
}

const sale = (line: string, minor: number, source = 'registration') => ({
  metric: 'MET-109',
  label: `Sales: ${line}`,
  value: minor,
  dimensions: { source, productLine: line },
});

describe('week model', () => {
  it('periods are local dates: Monday to Sunday, compared with the week before', () => {
    const week = periodOf('week', '2026-10-24');
    expect(week.from).toBe('2026-10-19');
    expect(week.to).toBe('2026-10-25');
    expect(week.buckets.map((b) => b.short)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    expect(previousOf(week)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(rangeLabel('2026-11-16', '2026-11-22')).toBe('Nov 16–22');
    expect(rangeLabel('2026-11-30', '2026-12-06')).toBe('Nov 30–Dec 6');
    expect(periodOf('season', '2026-10-24').buckets).toHaveLength(13);
  });

  it('SPK-REPORT-004: sales grouped into programs, rentals and desk sales; the reason is the line that moved most', () => {
    expect(seriesOf('registration', 'camp')).toBe('programs');
    expect(seriesOf('registration', 'rental')).toBe('rentals');
    expect(seriesOf('point_of_sale_open_amount', 'lost_key')).toBe('desk');
    const now = salesOf(
      report([
        sale('camp', 50_000),
        sale('term', 20_000),
        sale('merchandise', 3_000, 'point_of_sale'),
      ]) as never,
    );
    const before = salesOf(report([sale('camp', 10_000), sale('term', 22_000)]) as never);
    expect(now.total).toBe(73_000);
    expect(now.bySeries).toEqual({ programs: 70_000, rentals: 0, desk: 3_000 });
    expect(salesReason(now, before)).toBe('camp sign-ups');
    expect(change(now.total, before.total, 'percent_change')).toEqual({
      glyph: '▲',
      text: '128%',
      tone: 'success',
    });
    expect(change(0.71, 0.712, 'points')).toEqual({ glyph: '●', text: 'Flat', tone: 'neutral' });
    expect(change(0.062, 0.044, 'points', false)).toEqual({
      glyph: '▲',
      text: '1.8 pts',
      tone: 'danger',
    });
  });

  it('no-shows are observed absences over attended plus absent; closures name the space', () => {
    expect(
      noShowRate(
        report([
          { metric: 'MET-007', label: 'Attended', value: 15, unit: 'count' },
          { metric: 'MET-007', label: 'Observed absent', value: 1, unit: 'count' },
        ]) as never,
      ),
    ).toBeCloseTo(1 / 16);
    expect(noShowRate(report([]) as never)).toBeNull();
    expect(
      closureReason(
        report(
          [],
          [{ resource: 'Field 4', closureUnitHours: 16, parentResourceId: null }],
        ) as never,
      ),
    ).toBe('Field 4 closed 2 days');
  });
});

function routes() {
  return {
    'GET /reports/sales-by-product-line': (request: FakeRequest) =>
      fakeResponse(
        200,
        request.query['from'] === '2026-10-12'
          ? report([sale('camp', 100_000), sale('term', 200_000)])
          : request.query['from'] === request.query['to']
            ? request.query['from'] === '2026-10-24'
              ? report([
                  sale('camp', 300_000),
                  sale('rental', 90_000),
                  sale('concession', 20_000, 'point_of_sale'),
                ])
              : report([])
            : report([
                sale('camp', 300_000),
                sale('rental', 90_000),
                sale('concession', 20_000, 'point_of_sale'),
              ]),
      ),
    'GET /reports/utilization': {
      status: 200,
      body: report([{ metric: 'MET-070', label: 'Utilization rate', value: 0.71, unit: 'ratio' }]),
    },
    'GET /reports/attendance': {
      status: 200,
      body: report([
        { metric: 'MET-007', label: 'Attended', value: 9, unit: 'count' },
        { metric: 'MET-007', label: 'Observed absent', value: 1, unit: 'count' },
      ]),
    },
    'GET /reports/waitlist-demand': {
      status: 200,
      body: report(
        [{ metric: 'MET-023', label: 'Offer acceptance rate', value: 0.72, unit: 'ratio' }],
        [{ offering: 'Little Kickers', waiting: 23, holdingOffer: 0 }],
      ),
    },
    'GET /reports/registration-funnel': { status: 200, body: report([], []) },
    'GET /incidents': { status: 200, body: [] },
    'GET /resources': { status: 200, body: [{ id: 'court-1', name: 'Court 1', kind: 'other' }] },
    'GET /resource-availability': {
      status: 200,
      body: {
        facilityId: 'f',
        window: { start: '', end: '' },
        durationMinutes: 60,
        stepMinutes: 60,
        resources: [
          {
            resourceId: 'court-1',
            name: 'Court 1',
            kind: 'other',
            parentResourceId: null,
            slots: [{ start: '2026-10-25T17:00:00.000Z', end: '2026-10-25T18:00:00.000Z' }],
          },
        ],
      },
    },
    'GET /bookings': { status: 200, body: { items: [], nextCursor: null } },
    'POST /reports/runs': { status: 201, body: { id: 'run-1', runId: 'run-1' } },
    'POST /reports/exports': {
      status: 201,
      body: { id: 'exp-1', reportRunId: 'run-1', downloadToken: 'tok', downloadPath: '/x' },
    },
    'GET /reports/exports/{id}/download': () =>
      fakeResponse(200, 'a,b\n1,2', {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="sales.csv"',
      }),
  };
}

async function open(app: ReturnType<typeof createTestApp>) {
  render(app.at('/reports/week'));
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Use North Park 1' }));
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('S 4e manager week', () => {
  it('SPK-REPORT-001: four numbers with a plain-words reason under each against last week', async () => {
    const app = createTestApp({ routes: routes() });
    await open(app);
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeInTheDocument();
    const kpis = screen.getByRole('list', { name: 'The numbers' });
    expect(await within(kpis).findByText('$4,100')).toBeInTheDocument();
    expect(within(kpis).getByText(/▲ 37% · camp sign-ups/)).toBeInTheDocument();
    expect(within(kpis).getByText('71%')).toBeInTheDocument();
    expect(within(kpis).getByText('10.0%')).toBeInTheDocument();
    // Desk check-in time has no data in the API: proposed, never a made-up number.
    expect(
      within(kpis).getByText(/Proposed · check-in time is not recorded yet/),
    ).toBeInTheDocument();
  });

  it("clicking a day of the chart opens that day's bookings on the schedule", async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    await open(app);
    const bars = await screen.findByRole('list', { name: 'Revenue by day' });
    const saturday = await within(bars).findByRole('button', { name: /^Sat: \$4,100/ });
    await user.click(saturday);
    expect(
      await screen.findByRole('region', { name: 'Calendar and resources' }),
    ).toBeInTheDocument();
  });

  it('Worth a look: families waiting → Add a session opens New booking on a free slot; Promote opens the composer', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    await open(app);
    const look = await screen.findByRole('region', { name: 'Worth a look' });
    expect(await within(look).findByText(/23 families are waiting/)).toBeInTheDocument();
    expect(within(look).getByText(/72% accepted/)).toBeInTheDocument();
    expect(within(look).getByRole('link', { name: 'Promote' })).toHaveAttribute(
      'href',
      '/communications/compose',
    );
    await user.click(await within(look).findByRole('button', { name: 'Add a session' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('SPK-REPORT-007: Export CSV stores a run of the sales report and downloads its export', async () => {
    const user = userEvent.setup();
    const saved: DownloadedFile[] = [];
    restore = setFileSaver((file) => saved.push(file));
    const app = createTestApp({ routes: routes() });
    await open(app);
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: /CSV of sales/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(app.fake.requests.find((r) => r.route === '/reports/runs')?.body).toEqual({
      report: 'sales_by_product_line',
      parameters: { facilityId: expect.any(String), from: '2026-10-19', to: '2026-10-25' },
    });
    expect(app.fake.requests.find((r) => r.route === '/reports/exports')?.body).toEqual({
      reportRunId: 'run-1',
      format: 'csv',
    });
    expect(saved[0]?.content).toBe('a,b\n1,2');
  });
});
