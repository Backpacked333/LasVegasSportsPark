/**
 * SCR-S-35 obligations and orders (SPK-PAY-002, SPK-PAY-004, SPK-PAY-005, SPK-PAY-006,
 * SPK-REG-003): the four figures shown consistently with any excess, per customer and per team,
 * the order with its price basis, installment plans with failed installments as a financial state,
 * a recovery-required order with its owner, and permission and not-found answers.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  OBLIGATION_ID,
  apiError,
  installmentPlan,
  nameRoutes,
  obligation,
  ok,
  order,
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
});
