/**
 * SCR-S-48 Reconciliation report read by id (§5.5): levels and sign-offs as recorded; a report
 * already decided offers no further sign-off; a protected report is not available.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  REPORT_1,
  ok,
  reconciliationReport,
} from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

describe('SCR-S-48 ReconciliationReportScreen', () => {
  it('shows recorded sign-offs and offers none once the report is decided', async () => {
    render(
      createTestApp({
        routes: {
          'GET /import-reconciliation-reports/{id}': ok(
            reconciliationReport({
              approvalStatus: 'approved',
              approvals: [
                {
                  area: 'finance',
                  decision: 'approved',
                  approverPersonId: REPORT_1,
                  approverRole: 'finance_operator',
                  reason: 'Explained',
                  acknowledgedDiscrepancies: 1,
                  decidedAt: '2026-10-22T11:00:00.000Z',
                },
              ],
            }),
          ),
        },
      }).at(`/admin/migration/reconciliation/${REPORT_1}`),
    );
    expect(await screen.findByText('sign-off approved')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recorded sign-offs' })).toHaveTextContent(
      'Finance: approved by Finance operator',
    );
    expect(screen.queryByRole('form', { name: 'Record an area sign-off' })).toBeNull();
  });

  it('shows a report the viewer may not see as not available', async () => {
    render(
      createTestApp({
        routes: {
          'GET /import-reconciliation-reports/{id}': () =>
            fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
        },
      }).at(`/admin/migration/reconciliation/${REPORT_1}`),
    );
    expect(await screen.findByTestId('state-unavailable')).toBeInTheDocument();
  });
});
