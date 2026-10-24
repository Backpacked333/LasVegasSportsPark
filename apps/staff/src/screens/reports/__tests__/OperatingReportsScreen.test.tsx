/**
 * SCR-S-43 Operating reports: SPK-REPORT-001 (every metric definition visible), SPK-REPORT-002
 * (the twelve required reports), SPK-UX-008 states (validation failure, permission restriction,
 * partial figures marked, offline with age, processing, success) and SPK-UX-009 labels.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOW_ISO,
  RUN_1,
  metricDefinition,
  ok,
  reportResponse,
  reportRun,
} from '../../../features/insight-admin/__tests__/fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const DEFINITIONS = ok({
  items: [
    metricDefinition('MET-001', 'Published activities'),
    metricDefinition('MET-002', 'Changed activities'),
  ],
});

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /reports/metric-definitions': DEFINITIONS,
      'GET /reports/daily-schedule': ok(reportResponse('daily_schedule')),
      ...routes,
    },
  });
}

describe('SCR-S-43 OperatingReportsScreen', () => {
  it('SPK-REPORT-002: offers the twelve required operating reports', async () => {
    render(app().at('/reports'));
    const select = await screen.findByLabelText('Report (required)');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'Daily schedule',
      'Expected arrivals',
      'Attendance',
      'Match readiness',
      'Uncovered assignments',
      'Waitlist demand',
      'Registration funnel',
      'Enrollment and roster completeness',
      'Outstanding obligations',
      'Payment and refund reconciliation',
      'Maintenance restrictions',
      'Communication failures',
    ]);
  });

  it('SPK-REPORT-001: shows every definition field before the report runs', async () => {
    const test = app();
    render(test.at('/reports'));
    const section = await screen.findByRole('region', { name: 'What Daily schedule measures' });
    expect(within(section).getByText('MET-001 Published activities')).toBeInTheDocument();
    for (const field of [
      'Business question',
      'Grain',
      'Numerator',
      'Denominator',
      'Time basis',
      'Exclusions',
      'Dimensions',
      'Currency',
      'Freshness',
      'Access scope',
    ]) {
      expect(within(section).getAllByText(field).length).toBeGreaterThan(0);
    }
    expect(within(section).getAllByText('F1 live read').length).toBeGreaterThan(0);
    const request = test.fake.requests.find((r) => r.route === '/reports/metric-definitions');
    expect(request?.query).toEqual({ report: 'daily_schedule' });
  });

  it('runs the report for the facility and date, marks unavailable figures with their reason', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/reports'));
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
    await user.selectOptions(screen.getByLabelText('Facility (required)'), FACILITY_A);
    await user.click(screen.getByRole('button', { name: 'Show report' }));

    const report = await screen.findByRole('article', { name: 'Daily schedule' });
    const request = test.fake.requests.find((r) => r.route === '/reports/daily-schedule');
    expect(request?.query).toEqual({ facilityId: FACILITY_A, date: '2026-10-24' });

    expect(within(report).getByTestId('metric-MET-001')).toHaveTextContent('12');
    const missing = within(report).getByTestId('metric-MET-002');
    expect(within(missing).getByText('Not available')).toBeInTheDocument();
    expect(within(missing).getByText('change history is not captured yet')).toBeInTheDocument();
    expect(within(report).getByTestId('partial-figures')).toHaveTextContent(
      '1 of 2 figures are not available',
    );
    // Freshness per metric, in the facility's time zone (SPK-SCHED-008).
    expect(
      within(report).getAllByText(/freshness F1 live read as of Oct 24, 2026, 05:00 AM PDT/).length,
    ).toBe(2);
    expect(
      within(report).getByText('Times are facility local (America/Los_Angeles).'),
    ).toBeInTheDocument();
    const table = within(report).getByRole('region', { name: 'Daily schedule table' });
    expect(within(table).getByRole('columnheader', { name: 'First start' })).toBeInTheDocument();
    expect(within(table).getByText('Oct 24, 2026, 09:00 AM PDT')).toBeInTheDocument();
    expect(
      within(report).getByRole('region', { name: 'Definitions of the metrics in this report' }),
    ).toBeInTheDocument();
  });

  it('keeps the parameters and shows client validation before any request', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/reports?report=attendance'));
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
    const first = screen.getByLabelText('First date (required)');
    await user.clear(first);
    await user.type(first, '2026-10-30');
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(
      await screen.findByText('The last date must not be before the first date.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Last date (required)')).toHaveAttribute('aria-invalid', 'true');
    expect(test.fake.requests.some((r) => r.route === '/reports/attendance')).toBe(false);
    expect(first).toHaveValue('2026-10-30');
  });

  it('shows the API validation failure with its code and field messages', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /reports/daily-schedule': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'Report parameters failed validation.',
              nextAction: 'correct_input',
              details: [{ path: 'date', message: 'Invalid date', code: 'invalid_format' }],
            }),
          ),
      }).at('/reports'),
    );
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(
      await screen.findByText('Error code: VALIDATION_FAILED. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Fields to correct' })).toHaveTextContent(
      'date: Invalid date',
    );
  });

  it('shows an organization-wide report refused to facility-scoped staff as not available to them', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /reports/outstanding-obligations': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'This organization-wide report requires organization-wide access.',
              nextAction: 'contact_support_or_request_access',
            }),
          ),
      }).at('/reports?report=outstanding_obligations'),
    );
    expect(await screen.findByText(/Organization-wide report/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(
      screen.getByText('This organization-wide report requires organization-wide access.'),
    ).toBeInTheDocument();
  });

  it('stores the run with an idempotency key and links to its export', async () => {
    const user = userEvent.setup();
    const test = app({ 'POST /reports/runs': { status: 201, body: reportRun(RUN_1) } });
    render(test.at('/reports'));
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    await user.click(await screen.findByRole('button', { name: 'Store this run: Daily schedule' }));
    expect(await screen.findByText('Run stored')).toBeInTheDocument();
    const post = test.fake.requests.find((r) => r.route === '/reports/runs' && r.method === 'POST');
    // SPK-REPORT-007: the run is stored at the reviewed result's as-of instant.
    expect(post?.body).toEqual({
      report: 'daily_schedule',
      parameters: { facilityId: FACILITY_A, date: '2026-10-24', asOf: NOW_ISO },
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
    expect(screen.getByRole('link', { name: 'Export it' })).toHaveAttribute(
      'href',
      `/reports/exports?run=${RUN_1}`,
    );
  });

  it('shows the offline state with what is unavailable when there is no connection', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/reports'));
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
    act(() => test.connectivity.set(false));
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByTestId('state-offline-stale')).toHaveTextContent(
      'Needs a connection: running a report, storing a run.',
    );
  });

  it('labels the form, the report sub-navigation and the current page', async () => {
    render(app().at('/reports'));
    expect(await screen.findByRole('form', { name: 'Report parameters' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Reports screens' });
    expect(within(nav).getByRole('link', { name: 'Operating reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await waitFor(() => expect(screen.getByLabelText('Date (required)')).toHaveValue('2026-10-24'));
  });
});
