/**
 * SCR-S-35 obligations and orders (SPK-PAY-002, SPK-PAY-004, SPK-PAY-005, SPK-PAY-006,
 * SPK-REG-003): the four figures shown consistently with any excess, per customer and per team,
 * the order with its price basis, installment plans with failed installments as a financial state,
 * a recovery-required order with its owner, and permission and not-found answers; keyset paging,
 * the live payment attempt (FIN-01), the order list and order page with their payment attempts
 * (FIN-02, SPK-PAY-011); an order the viewer may not read never shows its attempts (§4.10); the
 * customer and payer found by name (ID-03).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  OBLIGATION_ID,
  ORDER_ID,
  PAYMENT_ID,
  apiError,
  installmentPlan,
  nameRoutes,
  obligation,
  ok,
  order,
  paymentAttempt,
  peopleSearch,
  personMatch,
} from '../../../features/registration-finance/__tests__/fixtures';

const TEAM_ENTRY_ID = '0192f1a0-0000-7000-8000-000000001010';
const TEAM = obligation({
  id: `${OBLIGATION_ID.slice(0, -1)}2`,
  debtor: { kind: 'team_entry', personId: null, teamEntryId: TEAM_ENTRY_ID },
  mode: 'team_with_contributions',
  orderId: null,
  description: 'Autumn league team fee',
  totals: {
    amountMinor: 60000,
    receivedMinor: 20000,
    allocatedMinor: 20000,
    remainingMinor: 40000,
    excessMinor: 0,
    currency: 'USD',
  },
  contributions: [
    {
      id: '0192f1a0-0000-7000-8000-000000001011',
      requestedPersonId: ADULT_ID,
      amountMinor: 5000,
      currency: 'USD',
      status: 'paid',
      paidAt: null,
    },
  ],
});

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /obligations': ok({ items: [obligation(), TEAM], nextCursor: null }),
    'GET /obligations/{id}': ok(obligation()),
    'GET /orders/{id}': ok(order()),
    'GET /installment-plans/{id}': ok(installmentPlan()),
    'GET /team-entries/{id}': ok({ entry: {}, team: { name: 'Riverside Rovers' } }),
    ...extra,
  };
}

function figure(scope: HTMLElement, term: string): string {
  const row = within(scope).getByText(term).closest('div') as HTMLElement;
  return row.querySelector('dd')?.textContent ?? '';
}

describe('SCR-S-35 ObligationsScreen', () => {
  it('SPK-PAY-004: shows total, received, allocated and remaining the same way, with any excess', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/finance/obligations'));
    const list = await screen.findByRole('list', { name: 'Obligations' });
    const [individual, team] = within(list).getAllByRole('listitem');
    const figures = within(individual!).getByLabelText('Figures: Spring academy U10 installments');
    expect(figure(figures, 'Total obligation')).toBe('$125.00');
    expect(figure(figures, 'Received')).toBe('$60.00');
    expect(figure(figures, 'Allocated')).toBe('$50.00');
    expect(figure(figures, 'Remaining')).toBe('$75.00');
    expect(figure(figures, 'Excess held per the overpayment policy')).toBe('$10.00');
    expect(await within(individual!).findByText('Sam Rivera')).toBeInTheDocument();
    expect(within(individual!).getByText(/Individual player billing/)).toBeInTheDocument();
    expect(within(individual!).getByText('open')).toBeInTheDocument();
    expect(await within(team!).findByText('Riverside Rovers')).toBeInTheDocument();
    expect(within(team!).queryByText('Excess held per the overpayment policy')).toBeNull();
    expect(screen.getByText(/pending DEC-008, DEC-073/)).toBeInTheDocument();
  });

  it('narrows to one customer by reference', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at('/finance/obligations'));
    await screen.findByRole('list', { name: 'Obligations' });
    await user.type(screen.getByLabelText('Customer reference'), ADULT_ID);
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/obligations').at(-1)?.query,
      ).toMatchObject({
        debtorPersonId: ADULT_ID,
        status: 'open',
      }),
    );
  });

  it('SPK-PAY-006: an obligation shows its order lines and the installment plan with a failed installment as a financial state', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/finance/obligations/${OBLIGATION_ID}`));
    expect(
      await screen.findByRole('heading', { name: 'Spring academy U10 installments' }),
    ).toBeInTheDocument();
    const lines = await screen.findByRole('table', { name: 'Order lines' });
    expect(within(lines).getAllByText('$125.00').length).toBeGreaterThan(0);
    expect(await within(lines).findByText('Alex Rivera')).toBeInTheDocument();
    const installments = await screen.findByRole('table', { name: 'Installments' });
    expect(
      within(installments).getByText('Financial state failed installment'),
    ).toBeInTheDocument();
    expect(within(installments).getByText('Last failure: card_declined')).toBeInTheDocument();
    expect(
      screen.getByText(/Participation consequences are evaluated separately/),
    ).toBeInTheDocument();
    expect(screen.getByText('3 attempts, every 24 hours')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Record a cash or external tender/ })).toHaveAttribute(
      'href',
      `/finance/reconciliation?obligation=${OBLIGATION_ID}`,
    );
  });

  it('lists team contributions without copying the debt, and a recovery-required order with its owner', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations/{id}': ok({ ...TEAM, orderId: '0192f1a0-0000-7000-8000-000000000705' }),
        'GET /orders/{id}': ok(
          order({ fulfillmentStatus: 'recovery_required', installmentPlanId: null }),
        ),
      }),
    });
    render(app.at(`/finance/obligations/${TEAM.id}`));
    const contributions = await screen.findByRole('list', { name: 'Contributions' });
    expect(await within(contributions).findByText('Sam Rivera')).toBeInTheDocument();
    expect(within(contributions).getByText('paid')).toBeInTheDocument();
    expect(await screen.findByText('Fulfillment recovery_required')).toBeInTheDocument();
    expect(screen.getByText(/Owner: finance\s+operator queue/)).toBeInTheDocument();
  });

  it('shows obligations the viewer may not read, and an unknown obligation, as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'finance.read_obligation' },
        }),
        'GET /obligations/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      }),
    });
    const { unmount } = render(app.at('/finance/obligations'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    unmount();
    render(app.at(`/finance/obligations/${OBLIGATION_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Order lines' })).toBeNull();
  });

  it('§4.5: pages obligations with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /obligations': (request) =>
          fakeResponse(
            200,
            request.query.cursor === 'o2'
              ? { items: [TEAM], nextCursor: null }
              : { items: [obligation()], nextCursor: 'o2' },
          ),
      }),
    });
    render(app.at('/finance/obligations'));
    const list = await screen.findByRole('list', { name: 'Obligations' });
    expect(within(list).queryByText('Autumn league team fee')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Load more obligations' }));
    expect(await within(list).findByText('Autumn league team fee')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more obligations' })).toBeNull();
  });

  it('FIN-01: a payment still on its way with an unknown outcome is never shown as paid', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /obligations': ok({
          items: [
            obligation({
              liveAttempt: {
                id: PAYMENT_ID,
                status: 'unknown',
                amountMinor: 7500,
                currency: 'USD',
                unknownSince: '2026-10-24T10:00:00.000Z',
                createdAt: '2026-10-24T09:59:00.000Z',
              },
            }),
          ],
          nextCursor: null,
        }),
      }),
    });
    render(app.at('/finance/obligations'));
    const live = await screen.findByRole('group', { name: 'Payment on its way' });
    expect(
      within(live).getByText('Attempt unknown: reconcile before any retry'),
    ).toBeInTheDocument();
    expect(within(live).getByText(/2 hours ago\): do not take payment again/)).toBeInTheDocument();
    // Money records carry no facility: the time is UTC, named.
    expect(
      within(live).getByText(/Outcome unknown since Sat, Oct 24, 2026, 10:00 AM UTC/),
    ).toBeInTheDocument();
    expect(within(live).getByRole('link', { name: 'Open the payment attempt' })).toHaveAttribute(
      'href',
      `/finance/payments/${PAYMENT_ID}`,
    );
  });

  it('SPK-PAY-011: lists orders by payment and fulfillment state and opens one', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /orders': ok({
          items: [order({ fulfillmentStatus: 'recovery_required', installmentPlanId: null })],
          nextCursor: null,
        }),
      }),
    });
    render(app.at('/finance/obligations'));
    await user.click(await screen.findByRole('button', { name: 'Orders' }));
    expect(screen.getByRole('button', { name: 'Orders' })).toHaveAttribute('aria-pressed', 'true');
    const list = await screen.findByRole('list', { name: 'Orders' });
    expect(within(list).getByText('Fulfillment recovery_required')).toBeInTheDocument();
    expect(within(list).getByText('Payment paid')).toBeInTheDocument();
    expect(within(list).getByText(/Owner: finance operator\s+queue/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /^Order 0192f1a0: \$125\.00/ })).toHaveAttribute(
      'href',
      `/finance/orders/${ORDER_ID}`,
    );
    await user.selectOptions(screen.getByLabelText('Fulfillment state'), 'recovery_required');
    await user.type(screen.getByLabelText('Created from (UTC day)'), '2026-10-01');
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/orders').at(-1)?.query).toMatchObject({
        fulfillmentStatus: 'recovery_required',
        from: '2026-10-01T00:00:00.000Z',
      }),
    );
  });

  it('an order list the viewer may not read is not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /orders': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'finance.read_order' },
        }),
      }),
    });
    render(app.at('/finance/obligations'));
    await user.click(await screen.findByRole('button', { name: 'Orders' }));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('an order page shows its lines, obligations and payment attempts', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /payments': ok({
          items: [paymentAttempt({ status: 'unknown', unknownSince: '2026-10-24T11:00:00.000Z' })],
          nextCursor: null,
        }),
      }),
    });
    render(app.at(`/finance/orders/${ORDER_ID}`));
    expect(await screen.findByRole('table', { name: 'Order lines' })).toBeInTheDocument();
    const obligations = await screen.findByRole('list', { name: 'Obligations of the order' });
    expect(within(obligations).getByRole('link', { name: 'Obligation 0192f1a0' })).toHaveAttribute(
      'href',
      `/finance/obligations/${OBLIGATION_ID}`,
    );
    const attempts = await screen.findByRole('list', { name: 'Payment attempts of the order' });
    expect(within(attempts).getByText('Attempt unknown: reconcile before any retry')).toBeVisible();
    expect(screen.getByTestId('state-recovery')).toHaveTextContent('Do not take payment again');
    expect(app.fake.requests.find((r) => r.route === '/payments')?.query).toMatchObject({
      orderId: ORDER_ID,
    });
  });

  it('an obligation lists its payment attempts; a viewer without the finance read sees them as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /payments': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'finance.read_payment' },
        }),
      }),
    });
    render(app.at(`/finance/obligations/${OBLIGATION_ID}`));
    const panel = (await screen.findByRole('heading', { name: 'Payment attempts' })).closest(
      'section',
    ) as HTMLElement;
    expect(await within(panel).findByText('Not available')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/payments')?.query).toMatchObject({
      obligationId: OBLIGATION_ID,
    });
  });

  it('§4.10: an order the viewer may not read shows only "not available", never its payment attempts', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /orders/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
        'GET /payments': ok({ items: [], nextCursor: null }),
      }),
    });
    render(app.at(`/finance/orders/${ORDER_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payment attempts' })).toBeNull();
    expect(screen.queryByText(/No payment attempt/)).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/payments')).toBe(false);
  });

  it('ID-03: finds the customer and the order payer by name; the search may be not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people': (request) =>
          request.query.query === 'Lee'
            ? fakeResponse(403, {
                code: 'ACCESS_DENIED',
                message: 'Not permitted.',
                correlationId: 'c',
                nextAction: 'contact_support_or_request_access',
              })
            : peopleSearch([personMatch(ADULT_ID, 'Sam', 'Rivera')])(request),
        'GET /orders': ok({ items: [order()], nextCursor: null }),
      }),
    });
    render(app.at('/finance/obligations'));
    const finder = await screen.findByRole('group', { name: 'Find the customer' });
    await user.type(within(finder).getByLabelText(/^Find the customer/), 'Rivera{Enter}');
    await user.click(
      await within(finder).findByRole('button', { name: 'Use Sam Rivera as the customer' }),
    );
    expect(screen.getByLabelText('Customer reference')).toHaveValue(ADULT_ID);
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/obligations').at(-1)?.query,
      ).toMatchObject({ debtorPersonId: ADULT_ID }),
    );
    await user.click(screen.getByRole('button', { name: 'Orders' }));
    const payer = await screen.findByRole('group', { name: 'Find the payer' });
    await user.type(within(payer).getByLabelText(/^Find the payer/), 'Lee{Enter}');
    expect(await within(payer).findByText(/Person search is not available to you/)).toBeVisible();
    await user.clear(within(payer).getByLabelText(/^Find the payer/));
    await user.type(within(payer).getByLabelText(/^Find the payer/), 'Rivera{Enter}');
    await user.click(
      await within(payer).findByRole('button', { name: 'Use Sam Rivera as the payer' }),
    );
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/orders').at(-1)?.query).toMatchObject({
        payerPersonId: ADULT_ID,
      }),
    );
  });
});
