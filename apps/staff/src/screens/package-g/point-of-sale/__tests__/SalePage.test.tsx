/**
 * SCR-S-55 Point of sale, one sale (Package G; §3.16 POS, SPK-PAY-001, SPK-PAY-002, SPK-PAY-007,
 * SPK-PAY-008, SPK-PAY-012, DEC-019, DEC-057): lines at the product's price with approved charges,
 * cash and external tenders, a card tender whose unknown outcome leaves the sale open and is never
 * shown as paid, the same key on retry after no answer, returns within what was paid, void, and
 * the receipt.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ID,
  CUSTOMER_ID,
  LINE_ID,
  PRODUCT_ID,
  RETURN_ID,
  SALE_ID,
  apiError,
  baseRoutes,
  line,
  ok,
  page,
  paidSale,
  permissions,
  product,
  receipt,
  sale,
  saleWithLine,
  tender,
} from '../../../../features/pos-access-accounting/__tests__/fixtures';
import { createTestApp } from '../../../../testing/test-app';

const SALE_PATH = `/finance/point-of-sale/sales/${SALE_ID}`;
const SELLER = ['finance.operate_register', 'finance.approve_pos_return'];

/** A sale read that answers `current()` each time, so a command can change what is read next. */
function saleRoutes(current: () => unknown, extra: Record<string, FakeHandler> = {}) {
  return {
    ...baseRoutes(),
    'GET /me/permissions': permissions(['point_of_sale'], SELLER),
    'GET /pos-sales/{id}': () => fakeResponse(200, current()),
    'GET /pos-products': page([product()]),
    ...extra,
  };
}

describe('SCR-S-55 SalePage', () => {
  it('SPK-PAY-001: adds a line with no price (the product’s price and approved charges apply)', async () => {
    const user = userEvent.setup();
    let current = sale();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/lines': () => {
          current = saleWithLine();
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByText('No lines yet. Add a product to the sale.')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Add a line' });
    await within(form).findByRole('option', { name: 'Water bottle (WATER) · $2.50' });
    await user.selectOptions(within(form).getByLabelText(/^Product/), PRODUCT_ID);
    const quantity = within(form).getByLabelText(/^Quantity/);
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(within(form).getByRole('button', { name: 'Add to the sale' }));
    const table = await screen.findByRole('table', { name: 'Sale lines' });
    expect(within(table).getByText('Sales tax (tax): $0.42')).toBeInTheDocument();
    expect(within(table).getByText('$5.42')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/lines');
    expect(call?.body).toEqual({ productId: PRODUCT_ID, quantity: 2 });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
    const totals = screen.getByLabelText('Sale totals');
    expect(within(totals).getByText('$0.42')).toBeInTheDocument();
  });

  it('DEC-057: a tax not approved refuses the line as a validation failure naming the tax', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: saleRoutes(() => sale(), {
        'POST /pos-sales/{id}/lines': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'A charge policy of this product has no approved version in effect.',
          nextAction: 'resolve_conflict',
          details: { code: 'CHARGE_POLICY_NOT_APPROVED', policyKey: 'sales-tax' },
        }),
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Add a line' });
    await within(form).findByRole('option', { name: 'Water bottle (WATER) · $2.50' });
    await user.selectOptions(within(form).getByLabelText(/^Product/), PRODUCT_ID);
    await user.click(within(form).getByRole('button', { name: 'Add to the sale' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('A tax or fee of this product is not approved');
    expect(refusal).toHaveTextContent('sales-tax has no approved version in effect (DEC-057)');
  });

  it('SPK-PAY-012: a cash tender that covers the total pays the sale and offers the receipt', async () => {
    const user = userEvent.setup();
    let current = saleWithLine();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/tenders': () => {
          current = paidSale();
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByText('open: not paid')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Take a tender' });
    expect(form).toHaveTextContent('Remaining to pay: $5.42.');
    await user.click(within(form).getByLabelText('Cash'));
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    expect(await screen.findByText('paid')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open the receipt of sale FD1-20261024-0001' }),
    ).toHaveAttribute('href', `${SALE_PATH}/receipt`);
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/tenders');
    expect(call?.body).toEqual({ kind: 'cash', amountMinor: 542 });
    // Paid: no more tender form, and no void.
    expect(screen.queryByRole('form', { name: 'Take a tender' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void the sale' })).toBeNull();
  });

  it('SPK-PAY-012: an external tender carries its evidence; more than remains is refused with the remaining amount', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: saleRoutes(() => saleWithLine(), {
        'POST /pos-sales/{id}/tenders': apiError(400, 'VALIDATION_FAILED', {
          message: 'The tender exceeds what remains to be paid.',
          nextAction: 'correct_input',
          details: { code: 'TENDER_EXCEEDS_REMAINING', remainingMinor: 542 },
        }),
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('External (recorded with evidence)'));
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '6');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    expect(within(form).getByText('Enter the evidence reference.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/^Evidence reference/), 'SLIP-77');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('The tender exceeds what remains to be paid');
    expect(refusal).toHaveTextContent('Remaining to pay: $5.42.');
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/tenders');
    expect(call?.body).toEqual({
      kind: 'external',
      amountMinor: 600,
      evidence: { reference: 'SLIP-77' },
    });
  });

  it('SPK-PAY-007: a card tender with an unknown outcome leaves the sale open, never paid, with the attempt to reconcile', async () => {
    const user = userEvent.setup();
    let current = saleWithLine({ customerPersonId: CUSTOMER_ID });
    const unknownCard = tender({
      kind: 'card',
      status: 'pending',
      paymentAttemptId: ATTEMPT_ID,
      paymentStatus: 'unknown',
      settledAt: null,
    });
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/tenders': () => {
          current = saleWithLine({
            customerPersonId: CUSTOMER_ID,
            pendingMinor: 542,
            remainingMinor: 0,
            tenders: [unknownCard],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Card'));
    const method = await within(form).findByLabelText(/^Development card method/);
    await user.selectOptions(method, 'pm_fake_timeout');
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    const recovery = await screen.findByTestId('state-recovery');
    expect(recovery).toHaveTextContent('Recovery required: card payment outcome unknown');
    expect(recovery).toHaveTextContent('Do not take the card again');
    expect(
      within(recovery).getByRole('link', {
        name: 'Open the payment attempt of $5.42 to reconcile it',
      }),
    ).toHaveAttribute('href', `/finance/payments/${ATTEMPT_ID}`);
    expect(screen.getByText('open: not paid')).toBeInTheDocument();
    expect(screen.queryByText('paid')).toBeNull();
    expect(screen.queryByRole('link', { name: /Open the receipt/ })).toBeNull();
    // A card was charged or is being charged: no void (SALE_HAS_CARD_TENDER).
    expect(screen.queryByRole('button', { name: 'Void the sale' })).toBeNull();
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/tenders');
    expect(call?.body).toEqual({
      kind: 'card',
      amountMinor: 542,
      paymentMethodToken: 'pm_fake_timeout',
    });
  });

  it('DEC-019: a sale without its customer cannot take a card', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: saleRoutes(() => saleWithLine()) });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Card'));
    expect(
      within(form).getByText(/A card tender needs the sale to name its customer/),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Record the tender' })).toBeDisabled();
  });

  it('§4.9: after no answer the tender form is locked and Try again resends the same request with the same key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    let current = saleWithLine();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/tenders': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('connection dropped');
          current = paidSale();
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Cash'));
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    expect(await within(form).findByTestId('state-offline')).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Amount \(USD\)/)).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('paid')).toBeInTheDocument();
    const [first, second] = app.fake.requests.filter((r) => r.route === '/pos-sales/{id}/tenders');
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('SPK-PAY-008: returns units within what was paid; more than was paid that way shows what is still refundable', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    let current = paidSale();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/returns': () => {
          attempts += 1;
          if (attempts === 1) {
            return fakeResponse(409, {
              code: 'RESOURCE_CONFLICT',
              message: 'The return exceeds what was paid by cash on this sale.',
              correlationId: 'c-ret',
              nextAction: 'resolve_conflict',
              details: { code: 'RETURN_EXCEEDS_TENDER', tenderKind: 'cash', availableMinor: 271 },
            });
          }
          current = paidSale({
            status: 'partially_returned',
            returnedMinor: 271,
            lines: [line({ returnedQuantity: 1 })],
            returns: [
              {
                id: RETURN_ID,
                amountMinor: 271,
                tenderKind: 'cash',
                lines: [
                  {
                    saleLineId: LINE_ID,
                    quantity: 1,
                    amountMinor: 271,
                    baseMinor: 250,
                    charges: [{ code: 'TAX', kind: 'tax', amountMinor: 21 }],
                  },
                ],
                refundAttemptId: null,
                refundStatus: null,
                registerSessionId: null,
                reason: 'Damaged',
                approvedByPersonId: '0192f1a0-0000-7000-8000-0000000000dd',
                returnedAt: '2026-10-24T12:00:00.000Z',
              },
            ],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Return lines' });
    await user.type(within(form).getByLabelText(/^Units of Water bottle to return/), '2');
    await user.selectOptions(within(form).getByLabelText(/^Refund by/), 'cash');
    await user.type(within(form).getByLabelText(/^Reason for the return/), 'Damaged');
    await user.click(within(form).getByRole('button', { name: 'Approve and record the return' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('Still refundable by cash: $2.71');
    const units = within(form).getByLabelText(/^Units of Water bottle to return/);
    await user.clear(units);
    await user.type(units, '1');
    await user.click(within(form).getByRole('button', { name: 'Approve and record the return' }));
    const returns = await screen.findByRole('table', { name: 'Returns' });
    expect(within(returns).getByText(/\$2\.71 by Cash/)).toBeInTheDocument();
    const calls = app.fake.requests.filter((r) => r.route === '/pos-sales/{id}/returns');
    expect(calls[1]?.body).toEqual({
      lines: [{ saleLineId: LINE_ID, quantity: 1 }],
      tenderKind: 'cash',
      reason: 'Damaged',
    });
    // A definitive refusal ends the intent: the corrected return is a new key.
    expect(calls[1]?.headers['idempotency-key']).not.toBe(calls[0]?.headers['idempotency-key']);
    expect(screen.getByText('partially_returned')).toBeInTheDocument();
  });

  it('voids an open sale with a reason', async () => {
    const user = userEvent.setup();
    let current = saleWithLine();
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/void': () => {
          current = saleWithLine({
            status: 'voided',
            voidReason: 'Customer left',
            voidedAt: '2026-10-24T12:00:00.000Z',
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    await user.click(await screen.findByRole('button', { name: 'Void the sale' }));
    const form = screen.getByRole('form', { name: 'Void the sale' });
    await user.type(within(form).getByLabelText(/^Reason for voiding/), 'Customer left');
    await user.click(within(form).getByRole('button', { name: 'Void the sale' }));
    expect(await screen.findByText('voided')).toBeInTheDocument();
    expect(screen.getByText('Customer left')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/pos-sales/{id}/void');
    expect(call?.body).toEqual({ reason: 'Customer left' });
  });

  it('SPK-PAY-002: the receipt lists lines, approved charges, tenders and the facility-local paid time', async () => {
    const app = createTestApp({
      routes: { ...saleRoutes(() => paidSale()), 'GET /pos-sales/{id}/receipt': ok(receipt()) },
    });
    render(app.at(`${SALE_PATH}/receipt`));
    const article = await screen.findByRole('article', {
      name: 'Receipt of sale FD1-20261024-0001',
    });
    expect(within(article).getByRole('table', { name: 'Receipt lines' })).toHaveTextContent(
      'Water bottle',
    );
    const totals = within(article).getByLabelText('Receipt totals');
    expect(within(totals).getByText('Sales tax (TAX)')).toBeInTheDocument();
    expect(within(totals).getByText('Paid by Cash (1)')).toBeInTheDocument();
    expect(within(article).getByText(/PDT/)).toBeInTheDocument();
  });

  it('an unpaid sale has no receipt: RECEIPT_NOT_AVAILABLE says so and links back', async () => {
    const app = createTestApp({
      routes: {
        ...saleRoutes(() => saleWithLine()),
        'GET /pos-sales/{id}/receipt': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The sale is not paid; it has no receipt.',
          nextAction: 'resolve_conflict',
          details: { code: 'RECEIPT_NOT_AVAILABLE' },
        }),
      },
    });
    render(app.at(`${SALE_PATH}/receipt`));
    expect(await screen.findByTestId('state-validation')).toHaveTextContent('The sale is not paid');
    expect(screen.getByRole('link', { name: 'Back to the sale' })).toHaveAttribute(
      'href',
      SALE_PATH,
    );
  });

  it('§4.10: a sale the API does not show is "not available" and offers no command', async () => {
    const app = createTestApp({
      routes: {
        ...saleRoutes(() => sale()),
        'GET /pos-sales/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByRole('form', { name: 'Add a line' })).toBeNull();
  });

  it('DEC-016: while the switch is off an open sale offers no new line or tender, but can be voided', async () => {
    const app = createTestApp({
      routes: {
        ...saleRoutes(() => saleWithLine()),
        'GET /me/permissions': permissions([], SELLER),
      },
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByTestId('state-turned-off')).toHaveTextContent(
      'Point of sale turned off',
    );
    await waitFor(() => expect(screen.getByRole('table', { name: 'Sale lines' })).toBeVisible());
    expect(screen.queryByRole('form', { name: 'Add a line' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Take a tender' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Void the sale' })).toBeInTheDocument();
  });
});
