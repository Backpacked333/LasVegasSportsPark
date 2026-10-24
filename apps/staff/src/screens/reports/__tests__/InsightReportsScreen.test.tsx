/**
 * SCR-S-44 Utilization, economics, demand and retention: SPK-REPORT-003 (weighting left to the
 * disclosed default unless chosen), SPK-REPORT-004 (no per-hour figure without an explicit
 * allocation method, margin only with agreed cost inputs, DEC-085 pending), SPK-REPORT-005 (cohort
 * required), SPK-REPORT-006 (observed and forecast apart), DEC-045 (no invented targets).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOW_ISO,
  metricDefinition,
  ok,
  reportResponse,
  uuid,
} from '../../../features/insight-admin/__tests__/fixtures';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';

const COST_INPUT = {
  id: uuid(1001),
  facilityId: FACILITY_A,
  resourceId: null,
  basis: 'per_activity_hour',
  amountMinor: 1250,
  currency: 'USD',
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  description: 'Field lighting and line marking',
  approvalReference: 'FIN-REF-1',
  approvedBy: {
    kind: 'staff',
    accountId: null,
    personId: null,
    actorLabel: 'staff:finance_operator',
  },
  recordedAt: NOW_ISO,
  status: 'active',
  withdrawnAt: null,
  withdrawnReason: null,
  revision: 3,
};

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /reports/metric-definitions': ok({
        items: [metricDefinition('MET-064', 'Reserved hours')],
      }),
      'GET /reports/cost-inputs': ok({ items: [COST_INPUT] }),
      ...routes,
    },
  });
}

/** Waits until the facility scope from `GET /me` and the Today feed has loaded into the form. */
async function ready(facilityReport = true) {
  if (facilityReport) {
    await within(await screen.findByLabelText('Facility (required)')).findByRole('option', {
      name: 'North Park 1',
    });
  } else {
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'North Park 1' }).length).toBeGreaterThan(0),
    );
  }
}

describe('SCR-S-44 InsightReportsScreen', () => {
  it('DEC-045: shows no invented improvement target', async () => {
    render(app().at('/reports/insight'));
    const notes = await screen.findAllByTestId('pending-note');
    expect(notes[0]).toHaveTextContent('No improvement target or benchmark is shown');
    expect(notes[0]).toHaveTextContent('DEC-045');
  });

  it('SPK-REPORT-003: leaves weighting and buffers to the disclosed default unless chosen', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /reports/utilization': ok(
        reportResponse('utilization', {
          report: {
            ...reportResponse('utilization').report,
            key: 'utilization',
            title: 'Field utilization',
          },
          disclosures: ['Weighting: one conflict unit weighs one (U3).'],
        }),
      ),
    });
    render(test.at('/reports/insight?report=utilization'));
    await ready();
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(
      await screen.findByText('Weighting: one conflict unit weighs one (U3).'),
    ).toBeInTheDocument();
    const first = test.fake.requests.find((r) => r.route === '/reports/utilization');
    expect(first?.query).toEqual({ facilityId: FACILITY_A, from: '2026-10-24', to: '2026-10-24' });

    await user.selectOptions(screen.getByLabelText('Resource-equivalent weighting'), 'custom');
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText(/Enter space id and weight pairs/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Weights (required)'), 'abc:1,def:0.5');
    await user.selectOptions(screen.getByLabelText('Setup and cleanup buffers'), 'false');
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    await waitFor(() =>
      expect(test.fake.requests.filter((r) => r.route === '/reports/utilization')).toHaveLength(2),
    );
    const second = test.fake.requests.filter((r) => r.route === '/reports/utilization')[1];
    expect(second?.query).toMatchObject({
      weighting: 'custom',
      weights: 'abc:1,def:0.5',
      includeBuffers: 'false',
    });
  });

  it('SPK-REPORT-004: withholds per-hour figures until an allocation method is chosen', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /reports/economics': ok(
        reportResponse('economics', {
          report: { ...reportResponse('economics').report, key: 'economics', title: 'Economics' },
        }),
      ),
    });
    render(test.at('/reports/insight?report=economics'));
    await ready();
    const group = screen.getByRole('radiogroup', { name: 'Allocation method (required)' });
    for (const radio of within(group).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getAllByTestId('pending-note')[1]).toHaveTextContent('DEC-085');

    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByTestId('allocation-withheld')).toHaveTextContent(
      'Per-hour figures withheld',
    );
    expect(test.fake.requests.some((r) => r.route === '/reports/economics')).toBe(false);

    await user.click(within(group).getByRole('radio', { name: /Direct/ }));
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    await screen.findByRole('article', { name: 'Economics' });
    expect(test.fake.requests.find((r) => r.route === '/reports/economics')?.query).toMatchObject({
      allocationMethod: 'direct',
    });
  });

  it('SPK-REPORT-004: reports margin as withheld when agreed cost inputs are missing', async () => {
    const user = userEvent.setup();
    render(
      app({
        'GET /reports/economics': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message:
                'Contribution margin requires agreed cost inputs for every space and event day; it is never inferred from collections (SPK-REPORT-004).',
              nextAction: 'correct_input',
              details: { code: 'cost_inputs_required', missing: [{}, {}] },
            }),
          ),
      }).at('/reports/insight?report=economics'),
    );
    await ready();
    await user.click(screen.getByRole('radio', { name: /Pro rata/ }));
    await user.click(screen.getByLabelText('Include contribution margin'));
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('Margin withheld')).toBeInTheDocument();
    expect(screen.getByText(/\(2 missing\)/)).toBeInTheDocument();
    expect(
      screen.getByText('Error code: VALIDATION_FAILED. Reference: test-correlation-id'),
    ).toBeInTheDocument();
  });

  it('lists agreed cost inputs and records one in minor units with an idempotency key', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/cost-inputs': {
        status: 201,
        body: { ...COST_INPUT, id: uuid(1002), amountMinor: 900 },
      },
    });
    render(test.at('/reports/insight?report=economics'));
    const list = await screen.findByRole('list', { name: 'Agreed cost inputs' });
    expect(
      within(list).getByText('$12.50 per activity hour for the whole facility'),
    ).toBeInTheDocument();
    expect(within(list).getByText('active')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Record an agreed cost input' });
    await user.type(within(form).getByLabelText('Currency (required)'), 'usd');
    await user.type(within(form).getByLabelText('Amount per activity hour (required)'), '9');
    await user.type(within(form).getByLabelText('Effective from (required)'), '2026-11-01');
    await user.type(within(form).getByLabelText('Description (required)'), 'Groundskeeping');
    await user.type(within(form).getByLabelText('Approval reference (required)'), 'FIN-REF-2');
    await user.click(within(form).getByRole('button', { name: 'Record cost input' }));
    expect(
      await screen.findByText(/Cost input recorded: \$9\.00 per activity hour, active/),
    ).toBeInTheDocument();
    const post = test.fake.requests.find(
      (r) => r.route === '/reports/cost-inputs' && r.method === 'POST',
    );
    expect(post?.body).toEqual({
      facilityId: FACILITY_A,
      resourceId: null,
      basis: 'per_activity_hour',
      amountMinor: 900,
      currency: 'USD',
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
      description: 'Groundskeeping',
      approvalReference: 'FIN-REF-2',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('withdraws a cost input with the reason and the expected revision', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/cost-inputs/{id}/withdraw': ok({
        ...COST_INPUT,
        status: 'withdrawn',
        revision: 4,
      }),
    });
    render(test.at('/reports/insight?report=economics'));
    await user.click(
      await screen.findByRole('button', {
        name: 'Withdraw cost input Field lighting and line marking',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    expect(
      await screen.findByText('Enter the reason for withdrawing this cost input.'),
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Reason for withdrawing (required)'),
      'Agreement replaced',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/reports/cost-inputs/{id}/withdraw')?.body,
      ).toEqual({ reason: 'Agreement replaced', expectedRevision: 3 }),
    );
  });

  it('shows cost inputs as not available to staff the API refuses, without the record form', async () => {
    render(
      app({
        'GET /reports/cost-inputs': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
            }),
          ),
      }).at('/reports/insight?report=economics'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/Cost inputs are read and recorded by finance/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Record an agreed cost input' })).toBeNull();
  });

  it('SPK-REPORT-006: shows observed demand and the forecast as separate series', async () => {
    const user = userEvent.setup();
    const base = reportResponse('demand');
    const test = app({
      'GET /reports/demand': ok({
        ...base,
        report: { ...base.report, key: 'demand', title: 'Demand' },
        values: [
          {
            metric: 'MET-086',
            label: 'Registrations',
            value: 30,
            unit: 'count',
            currency: null,
            dimensions: { signal: 'registrations', series: 'observed' },
            unavailableReason: null,
          },
          {
            metric: 'MET-089',
            label: 'Demand forecast',
            value: 28,
            unit: 'count',
            currency: null,
            dimensions: { series: 'forecast' },
            unavailableReason: null,
          },
        ],
      }),
    });
    render(test.at('/reports/insight?report=demand'));
    await ready();
    await user.selectOptions(screen.getByLabelText('Forecast'), 'trailing_mean');
    await user.type(screen.getByLabelText('Preceding periods for the forecast'), '4');
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    const observed = await screen.findByRole('region', { name: 'Observed' });
    expect(within(observed).getByTestId('metric-MET-086')).toHaveTextContent('30');
    const forecast = screen.getByRole('region', {
      name: 'Forecast (a separate series, never combined with observed demand)',
    });
    expect(within(forecast).getByTestId('metric-MET-089')).toHaveTextContent('28');
    expect(test.fake.requests.find((r) => r.route === '/reports/demand')?.query).toMatchObject({
      forecastMethod: 'trailing_mean',
      forecastPeriods: '4',
    });
  });

  it('SPK-REPORT-005: requires a cohort and its comparison periods', async () => {
    const user = userEvent.setup();
    const base = reportResponse('retention');
    const test = app({
      'GET /reports/retention': ok({
        ...base,
        report: { ...base.report, key: 'retention', title: 'Retention' },
      }),
    });
    render(test.at('/reports/insight?report=retention'));
    await ready(false);
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    expect(await screen.findByText('Choose a cohort.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Cohort (required)'), 'households');
    await user.type(screen.getByLabelText('Anchor period first date (required)'), '2025-09-01');
    await user.type(screen.getByLabelText('Anchor period last date (required)'), '2025-12-31');
    await user.type(screen.getByLabelText('Comparison period first date (required)'), '2026-09-01');
    await user.type(screen.getByLabelText('Comparison period last date (required)'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Show report' }));
    await screen.findByRole('article', { name: 'Retention' });
    expect(test.fake.requests.find((r) => r.route === '/reports/retention')?.query).toEqual({
      cohort: 'households',
      anchorFrom: '2025-09-01',
      anchorTo: '2025-12-31',
      comparisonFrom: '2026-09-01',
      comparisonTo: '2026-12-31',
    });
  });
});
