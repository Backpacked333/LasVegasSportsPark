/**
 * Finance overview (SPK-UX-005, SPK-PAY-007, SPK-PAY-001): money moved but not fulfilled is pinned
 * first with its owner, unknown provider outcomes are listed explicitly and open their record to
 * reconcile, past-due obligations come from the API's open obligations, and the month's
 * reconciliation uses the currency the loaded records carry (amounts are never added across
 * currencies).
 */
import { fakePermissions, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  CHECKOUT_ID,
  OBLIGATION_ID,
  PAYMENT_ID,
  exception,
  nameRoutes,
  obligation,
  ok,
  paymentAttempt,
  reconciliationReport,
} from '../../../features/registration-finance/__tests__/fixtures';

const empty = ok({ items: [], nextCursor: null });

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /exceptions': ok({
      items: [
        exception(),
        exception({
          id: '0192f1a0-0000-7000-8000-000000001202',
          category: 'finance.fulfillment_incomplete',
          title: 'Payment received but the registration could not be fulfilled',
          affected: { type: 'checkout', id: CHECKOUT_ID },
        }),
      ],
      nextCursor: null,
    }),
    'GET /payments': (request) =>
      fakeResponse(200, {
        items:
          request.query['status'] === 'unknown'
            ? [paymentAttempt({ status: 'unknown', unknownSince: '2026-10-24T10:00:00.000Z' })]
            : [],
        nextCursor: null,
      }),
    'GET /refunds': empty,
    'GET /obligations': ok({
      items: [obligation({ dueAt: '2026-10-01T00:00:00.000Z' })],
      nextCursor: 'more',
    }),
    'GET /finance/reconciliation-report': (request) =>
      fakeResponse(200, reconciliationReport({ currency: request.query['currency'] ?? '' })),
    ...extra,
  };
}

describe('Finance overview', () => {
  it('SPK-PAY-007: pins money moved but not fulfilled first, with its owner and record to act on', async () => {
    render(createTestApp({ routes: routes() }).at('/finance'));
    const list = await screen.findByRole('list', {
      name: 'Payment exceptions, money moved first',
    });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Money moved, not fulfilled');
    expect(rows[0]).toHaveTextContent(
      'Payment received but the registration could not be fulfilled',
    );
    expect(rows[0]).toHaveTextContent('Owner: finance operator');
    expect(
      within(rows[0]!).getByRole('link', { name: /Open the checkout recovery/ }),
    ).toHaveAttribute('href', `/finance/checkouts/${CHECKOUT_ID}`);
    expect(rows[1]).toHaveTextContent('Unknown payment outcomes');
  });

  it('SPK-PAY-007: lists unknown provider outcomes explicitly, each opening its attempt to reconcile', async () => {
    render(createTestApp({ routes: routes() }).at('/finance'));
    const list = await screen.findByRole('list', { name: 'Unknown provider outcomes' });
    expect(list).toHaveTextContent('do not take payment again until reconciled');
    expect(within(list).getByRole('link', { name: /Reconcile payment attempt/ })).toHaveAttribute(
      'href',
      `/finance/payments/${PAYMENT_ID}`,
    );
  });

  it('SPK-PAY-001: past-due obligations and open balances come from the API, marked as loaded so far', async () => {
    render(createTestApp({ routes: routes() }).at('/finance'));
    const table = await screen.findByRole('table', { name: 'Past-due obligations' });
    expect(table).toHaveTextContent('Spring academy U10 installments');
    expect(table).toHaveTextContent('$75.00');
    const kpis = screen.getByRole('group', { name: 'Finance at a glance' });
    // The API has more pages: the count says so.
    expect(kpis).toHaveTextContent('1+');
    // The reconciliation card reads the month in the records' currency.
    expect(await screen.findByRole('progressbar', { name: 'Settlements balanced' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Reconciliation' })).toHaveTextContent('USD');
  });

  it('SPK-COMMS-002: a finance operator reminds the debtor of a past-due obligation; a recent reminder is shown, not repeated', async () => {
    const reminders: unknown[] = [];
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': {
          status: 200,
          body: fakePermissions({ actions: ['finance.send_payment_reminder'] }),
        },
        'GET /obligations': ok({
          items: [
            obligation({ dueAt: '2026-10-01T00:00:00.000Z' }),
            obligation({
              id: '0192f1a0-0000-7000-8000-00000000a0b2',
              description: 'Winter league team fee',
              dueAt: '2026-10-02T00:00:00.000Z',
              lastReminderAt: '2026-10-24T11:00:00.000Z',
            }),
          ],
          nextCursor: null,
        }),
        'POST /obligations/{id}/reminders': (request) => {
          reminders.push(request.path);
          return fakeResponse(201, {
            id: '0192f1a0-0000-7000-8000-00000000a0c1',
            obligationId: OBLIGATION_ID,
            recipientPersonId: ADULT_ID,
            remainingMinor: 7500,
            currency: 'USD',
            dueAt: '2026-10-01T00:00:00.000Z',
            reason: null,
            requestedByPersonId: null,
            requestedAt: '2026-10-24T12:00:00.000Z',
          });
        },
      }),
    });
    render(app.at('/finance'));
    const table = await screen.findByRole('table', { name: 'Past-due obligations' });
    // The fee reminded an hour ago shows as reminded; only the other one can be reminded.
    expect(within(table).getByText('Reminded')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Remind all 1' })).toBeInTheDocument();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Remind about Spring academy U10 installments' }),
    );
    await waitFor(() => expect(reminders).toHaveLength(1));
    expect(await within(table).findAllByText('Reminded')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Remind all/ })).toBeNull();
  });

  it('without the reminder action, past-due rows offer no reminder', async () => {
    render(createTestApp({ routes: routes() }).at('/finance'));
    const table = await screen.findByRole('table', { name: 'Past-due obligations' });
    expect(within(table).queryByRole('button', { name: /Remind/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remind all/ })).toBeNull();
  });

  it('says plainly when there is nothing to reconcile and no money recorded', async () => {
    render(
      createTestApp({
        routes: {
          'GET /exceptions': empty,
          'GET /payments': empty,
          'GET /refunds': empty,
          'GET /obligations': empty,
        },
      }).at('/finance'),
    );
    expect(await screen.findByText('No payment exceptions')).toBeInTheDocument();
    expect(await screen.findByText('No unknown outcomes')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Reconciliation' })).toHaveTextContent(
      'No money is recorded yet',
    );
  });
});
