/**
 * SCR-S-01 Today shell (SPK-UX-006): every issue shows its title, severity (text, not colour),
 * affected record, owner queue, age, deadline and next actions as the API returns them; sources the
 * viewer may not read are listed as not available; the evaluation age is shown.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, todayFeed } from '../../../testing/test-app';

const ITEM = {
  id: 'exc-1',
  source: 'exception',
  group: 'financial',
  category: 'payment_outcome_unknown',
  title: 'Payment outcome unknown for checkout',
  severity: 'critical',
  facilityId: FACILITY_A,
  affected: { type: 'payment_attempt', id: 'pa-1' },
  ownerQueue: 'finance',
  status: 'open',
  openedAt: '2026-10-24T10:30:00.000Z',
  ageMinutes: 90,
  deadlineAt: null,
  overdue: true,
  nextActions: [{ action: 'reconcile', label: 'Reconcile payment', method: 'POST', href: null }],
  history: [],
  details: {},
};

describe('SCR-S-01 TodayScreen', () => {
  it('lists issues with severity text, owner, age and next actions', async () => {
    const feed = todayFeed([ITEM]);
    feed.body.sources = [
      { source: 'coverage', facilityId: null, status: 'not_permitted', count: 0 },
    ] as never;
    const app = createTestApp({ routes: { 'GET /today': feed } });
    render(app.at('/today'));
    const row = await screen.findByTestId('today-item-exc-1');
    expect(within(row).getByText('Payment outcome unknown for checkout')).toBeInTheDocument();
    expect(within(row).getByText('Severity: critical')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(
      within(row).getByText(
        /Affects payment_attempt · Owner: finance · North Park 1 · Open 1 h 30 min/,
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('Next: Reconcile payment')).toBeInTheDocument();
    expect(screen.getByText('Evaluated just now')).toBeInTheDocument();
    const notIncluded = screen.getByRole('region', { name: 'Issue sources not included' });
    expect(within(notIncluded).getByText('Not available to you')).toBeInTheDocument();
  });

  it('says there are no open issues when the feed is empty', async () => {
    const app = createTestApp();
    render(app.at('/today'));
    expect(await screen.findByRole('heading', { name: 'No open issues' })).toBeInTheDocument();
  });

  it('shows ACCESS_DENIED as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { nextAction: 'contact_support_or_request_access' }),
          ),
      },
    });
    render(app.at('/today'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(/ACCESS_DENIED/)).toBeNull();
  });

  it('shows other failures with their code and a retry', async () => {
    const app = createTestApp({
      routes: {
        'GET /today': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              nextAction: 'retry_later',
              correlationId: 'corr-t',
            }),
          ),
      },
    });
    render(app.at('/today'));
    expect(
      await screen.findByText('Error code: INTEGRATION_UNAVAILABLE. Reference: corr-t'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
