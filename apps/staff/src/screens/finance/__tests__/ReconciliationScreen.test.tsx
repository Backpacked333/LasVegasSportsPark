/**
 * SCR-S-38 reconciliation (SPK-PAY-010, SPK-PAY-011, SPK-PAY-012, SPK-REPORT-002, DEC-009,
 * DEC-022): categories kept apart and never netted, payment volume not shown as revenue, the
 * append-only subledger, a settlement discrepancy raised to its owner, a cash tender with
 * evidence, an empty period, and the permission restriction.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp } from '../../../testing/test-app';
import {
  OBLIGATION_ID,
  apiError,
  ok,
  reconciliationReport,
} from '../../../features/registration-finance/__tests__/fixtures';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return { 'GET /finance/reconciliation-report': ok(reconciliationReport()), ...extra };
}

describe('SCR-S-38 ReconciliationScreen', () => {
  it('SPK-PAY-011: reports each category apart, never as revenue, with the subledger as posted', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/finance/reconciliation'));
    expect(await screen.findByText(/Enter a period/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Report currency/), 'usd');
    expect(await screen.findByText(/Payment volume is not revenue/)).toBeInTheDocument();
    for (const name of [
      'Orders',
      'Obligations',
      'Customer receipts',
      'Refunds',
      'Credits',
      'Processor fees',
      'Disputes',
      'Cash',
    ]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    const receipts = screen.getByRole('region', { name: 'Customer receipts' });
    expect(within(receipts).getByText('$250.00')).toBeInTheDocument();
    expect(within(receipts).getByText('$125.00')).toBeInTheDocument();
    const settlements = screen.getByRole('list', { name: 'Settlements' });
    expect(within(settlements).getByText('discrepancy')).toBeInTheDocument();
    expect(within(settlements).getByText(/difference -\$5\.00/)).toBeInTheDocument();
    const ledger = screen.getByRole('table', { name: 'Subledger balances' });
    expect(within(ledger).getByText('Deferred revenue')).toBeInTheDocument();
    expect(within(ledger).getByText('-$375.00')).toBeInTheDocument();
    expect(screen.getByText(/1 unknown payment outcome/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open them' })).toHaveAttribute(
      'href',
      '/finance/payments',
    );
    expect(screen.getByText(/depends on DEC-022/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/finance/reconciliation-report')?.query,
    ).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-25T00:00:00.000Z',
      currency: 'USD',
    });
  });

  it('says so when the period has no movements', async () => {
    const user = userEvent.setup();
    const empty = reconciliationReport({
      orders: { count: 0, totalMinor: 0, paidCount: 0 },
      obligations: { openCount: 0, openRemainingMinor: 0, settledCount: 0 },
      receipts: { processorMinor: 0, cashMinor: 0, count: 0, excessMinor: 0 },
      refunds: { succeededMinor: 0, reservedMinor: 0, unknownCount: 0 },
      credits: { issuedMinor: 0, redeemedMinor: 0, pendingApprovalMinor: 0 },
      processorFeesMinor: 0,
      disputes: { count: 0, note: '' },
      settlements: [],
      cash: { recordedMinor: 0, unreconciledMinor: 0 },
      exceptions: { unknownPayments: 0, recoveryRequiredCheckouts: 0 },
      ledger: [],
    });
    const app = createTestApp({
      routes: routes({ 'GET /finance/reconciliation-report': ok(empty) }),
    });
    render(app.at('/finance/reconciliation'));
    await user.type(await screen.findByLabelText(/^Report currency/), 'USD');
    expect(await screen.findByRole('heading', { name: 'No movements' })).toBeInTheDocument();
  });

  it('records a cash drawer count; a discrepancy goes to the finance operator queue without netting', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /settlement-reconciliations': ok(reconciliationReport().settlements[0], 201),
      }),
    });
    render(app.at('/finance/reconciliation'));
    await user.click(await screen.findByText('Record a settlement or cash drawer count'));
    const form = screen.getByRole('form', { name: 'Record a settlement or cash drawer count' });
    const f = within(form);
    await user.selectOptions(f.getByLabelText(/^What is reconciled/), 'cash_drawer');
    await user.selectOptions(await f.findByLabelText(/^Facility/), FACILITY_A);
    await user.type(f.getByLabelText(/^First day/), '2026-10-23');
    await user.type(f.getByLabelText(/^Last day/), '2026-10-23');
    await user.type(f.getByLabelText(/^Settlement currency/), 'USD');
    await user.type(f.getByLabelText(/^Reported total/), '120.00');
    await user.click(f.getByRole('button', { name: 'Reconcile' }));
    expect(await f.findByText(/never netted against other differences/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/settlement-reconciliations')?.body).toEqual({
      kind: 'cash_drawer',
      // SPK-SCHED-008: the facility's local day (America/Los_Angeles, PDT), not a UTC day.
      periodStart: '2026-10-23T07:00:00.000Z',
      periodEnd: '2026-10-24T07:00:00.000Z',
      currency: 'USD',
      reportedMinor: 12000,
      facilityId: FACILITY_A,
    });
    expect(f.getByLabelText(/^First day \(facility time, America\/Los_Angeles\)/)).toBeVisible();
  });

  it('SPK-SCHED-008: a cash drawer day across the daylight-saving change is the facility day (25 hours)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /settlement-reconciliations': ok(reconciliationReport().settlements[0], 201),
      }),
    });
    render(app.at('/finance/reconciliation'));
    await user.click(await screen.findByText('Record a settlement or cash drawer count'));
    const form = screen.getByRole('form', { name: 'Record a settlement or cash drawer count' });
    const f = within(form);
    await user.selectOptions(f.getByLabelText(/^What is reconciled/), 'cash_drawer');
    await user.selectOptions(await f.findByLabelText(/^Facility/), FACILITY_A);
    await user.type(f.getByLabelText(/^First day/), '2026-11-01');
    await user.type(f.getByLabelText(/^Last day/), '2026-11-01');
    await user.type(f.getByLabelText(/^Settlement currency/), 'USD');
    await user.type(f.getByLabelText(/^Reported total/), '120.00');
    await user.click(f.getByRole('button', { name: 'Reconcile' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/settlement-reconciliations')?.body,
      ).toMatchObject({
        periodStart: '2026-11-01T07:00:00.000Z',
        periodEnd: '2026-11-02T08:00:00.000Z',
      }),
    );
  });

  it('SPK-PAY-012: records a cash tender with evidence against the obligation it came from', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /cash-tenders': ok(
          {
            id: '0192f1a0-0000-7000-8000-000000001401',
            facilityId: FACILITY_A,
            tenderKind: 'cash',
            payerPersonId: '0192f1a0-0000-7000-8000-000000000302',
            amountMinor: 7500,
            currency: 'USD',
            obligationId: OBLIGATION_ID,
            checkoutId: null,
            evidence: { reference: 'R-77' },
            recordedByPersonId: '0192f1a0-0000-7000-8000-000000000303',
            recordedAt: '2026-10-24T12:00:00.000Z',
            status: 'recorded',
            reconciliationId: null,
            receipt: null,
            overpaymentCreditId: null,
          },
          201,
        ),
      }),
    });
    render(app.at(`/finance/reconciliation?obligation=${OBLIGATION_ID}`));
    const form = await screen.findByRole('form', { name: 'Record a cash or external tender' });
    const f = within(form);
    expect(f.getByLabelText(/^Obligation reference/)).toHaveValue(OBLIGATION_ID);
    expect(screen.getAllByText(/depends on DEC-009/).length).toBeGreaterThan(0);
    await user.click(f.getByRole('button', { name: 'Record the tender' }));
    expect(f.getByText('Enter the evidence reference.')).toBeInTheDocument();
    await user.selectOptions(await f.findByLabelText(/^Tender facility/), FACILITY_A);
    await user.type(f.getByLabelText(/^Tender amount/), '75');
    await user.type(f.getByLabelText(/^Tender currency/), 'USD');
    await user.type(f.getByLabelText(/^Evidence reference/), 'R-77');
    await user.click(f.getByRole('button', { name: 'Record the tender' }));
    expect(await f.findByText(/Tender recorded: \$75\.00/)).toBeInTheDocument();
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/cash-tenders')?.body).toEqual({
        obligationId: OBLIGATION_ID,
        facilityId: FACILITY_A,
        tenderKind: 'cash',
        amountMinor: 7500,
        currency: 'USD',
        evidence: { reference: 'R-77' },
      }),
    );
  });

  it('shows a report the viewer may not read as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /finance/reconciliation-report': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'finance.read_reconciliation' },
        }),
      }),
    });
    render(app.at('/finance/reconciliation'));
    await user.type(await screen.findByLabelText(/^Report currency/), 'USD');
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Subledger balances' })).toBeNull();
  });
});
