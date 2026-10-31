/**
 * SCR-S-55 Point of sale, one sale (Package G; §3.16 POS, SPK-PAY-001, SPK-PAY-002, SPK-PAY-007,
 * SPK-PAY-008, SPK-PAY-012, DEC-019, DEC-057): lines at the product's price with approved charges,
 * cash and external tenders, card tenders that are unknown, processing or declined (never shown as
 * paid), a tender refused while a card outcome is unknown (reload, then a new intent), the same key
 * on retry after no answer, Reload after a stale refusal, returns within what was paid with card
 * refunds that are not final, void, and the receipt.
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
  REFUND_ID,
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
    expect(call?.body).toEqual({ productId: PRODUCT_ID, quantity: 2, expectedRevision: 1 });
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
    expect(call?.body).toEqual({ kind: 'cash', amountMinor: 542, expectedRevision: 1 });
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
      expectedRevision: 1,
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
      expectedRevision: 1,
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
      expectedRevision: 3,
    });
    // A definitive refusal ends the intent: the corrected return is a new key.
    expect(calls[1]?.headers['idempotency-key']).not.toBe(calls[0]?.headers['idempotency-key']);
    expect(screen.getByText('partially_returned')).toBeInTheDocument();
  });

  it('SPK-PAY-007: a card payment still processing is "not paid yet": no void, no receipt, never paid', async () => {
    const user = userEvent.setup();
    let current = saleWithLine({ customerPersonId: CUSTOMER_ID });
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/tenders': () => {
          current = saleWithLine({
            customerPersonId: CUSTOMER_ID,
            pendingMinor: 542,
            remainingMinor: 0,
            tenders: [
              tender({
                kind: 'card',
                status: 'pending',
                paymentAttemptId: ATTEMPT_ID,
                paymentStatus: 'processing',
                settledAt: null,
              }),
            ],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Card'));
    await user.selectOptions(
      await within(form).findByLabelText(/^Development card method/),
      'pm_fake_processing',
    );
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    const processing = await screen.findByTestId('state-processing');
    expect(processing).toHaveTextContent('Card payment in progress: not paid yet');
    expect(processing).toHaveTextContent('do not take the card again');
    expect(screen.getByText('open: not paid')).toBeInTheDocument();
    expect(screen.queryByText('paid')).toBeNull();
    expect(screen.queryByTestId('state-recovery')).toBeNull();
    expect(screen.queryByRole('link', { name: /Open the receipt/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void the sale' })).toBeNull();
    const tenders = screen.getByRole('table', { name: 'Tenders' });
    expect(within(tenders).getByText('card payment processing')).toBeInTheDocument();
  });

  it('SPK-PAY-007: a declined card says nothing was taken and the sale still has its amount to pay', async () => {
    const user = userEvent.setup();
    let current = saleWithLine({ customerPersonId: CUSTOMER_ID });
    const app = createTestApp({
      routes: saleRoutes(() => current, {
        'POST /pos-sales/{id}/tenders': () => {
          current = saleWithLine({
            customerPersonId: CUSTOMER_ID,
            tenders: [
              tender({
                kind: 'card',
                status: 'failed',
                paymentAttemptId: ATTEMPT_ID,
                paymentStatus: 'failed',
                failureReason: 'card_declined',
                settledAt: null,
              }),
            ],
          });
          return fakeResponse(201, current);
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Card'));
    await user.selectOptions(
      await within(form).findByLabelText(/^Development card method/),
      'pm_fake_decline',
    );
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    const outcome = await within(form).findByRole('status');
    expect(outcome).toHaveTextContent('card payment failed');
    expect(outcome).toHaveTextContent('The card payment did not go through: nothing was taken.');
    await waitFor(() =>
      expect(screen.getByRole('table', { name: 'Tenders' })).toHaveTextContent('card_declined'),
    );
    expect(screen.getByText('open: not paid')).toBeInTheDocument();
    expect(within(form).getByText('Remaining to pay: $5.42.')).toBeInTheDocument();
  });

  it('SPK-PAY-007: a tender refused because a card outcome is unknown can be reloaded; the rest is then paid as a new intent', async () => {
    const user = userEvent.setup();
    let reloaded = false;
    let cash = false;
    const unknownCard = tender({
      kind: 'card',
      amountMinor: 300,
      status: 'pending',
      paymentAttemptId: ATTEMPT_ID,
      paymentStatus: 'unknown',
      settledAt: null,
    });
    const app = createTestApp({
      routes: saleRoutes(
        () =>
          cash
            ? paidSale({ customerPersonId: CUSTOMER_ID })
            : reloaded
              ? saleWithLine({
                  customerPersonId: CUSTOMER_ID,
                  pendingMinor: 300,
                  remainingMinor: 242,
                  tenders: [unknownCard],
                })
              : saleWithLine({ customerPersonId: CUSTOMER_ID }),
        {
          'POST /pos-sales/{id}/tenders': (request) => {
            if ((request.body as { kind: string }).kind === 'card') {
              reloaded = true; // another terminal started a card payment meanwhile
              return fakeResponse(409, {
                code: 'PAYMENT_OUTCOME_UNKNOWN',
                message: 'The payment outcome is not yet known.',
                correlationId: 'c-unk',
                nextAction: 'await_reconciliation',
                details: { paymentAttemptId: ATTEMPT_ID },
              });
            }
            cash = true;
            return fakeResponse(201, paidSale({ customerPersonId: CUSTOMER_ID }));
          },
        },
      ),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Card'));
    await user.selectOptions(
      await within(form).findByLabelText(/^Development card method/),
      'pm_fake_visa',
    );
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    const recovery = await within(form).findByTestId('state-recovery');
    expect(recovery).toHaveTextContent('Recovery required: payment outcome unknown');
    expect(recovery).toHaveTextContent('Error code: PAYMENT_OUTCOME_UNKNOWN. Reference: c-unk');
    // The card intent stays locked: nothing can be changed and resent under another key.
    expect(within(form).getByLabelText(/^Amount \(USD\)/)).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Reload the sale' }));
    // The sale read again shows the card payment to reconcile; the form takes a new intent.
    const saleRecovery = await screen.findByRole('list', { name: 'Card payments to reconcile' });
    expect(
      within(saleRecovery).getByRole('link', {
        name: 'Open the payment attempt of $3.00 to reconcile it',
      }),
    ).toHaveAttribute('href', `/finance/payments/${ATTEMPT_ID}`);
    await waitFor(() => expect(form).toHaveTextContent('Remaining to pay: $2.42.'));
    expect(within(form).queryByTestId('state-recovery')).toBeNull();
    const amount = within(form).getByLabelText(/^Amount \(USD\)/);
    expect(amount).toBeEnabled();
    await user.click(within(form).getByLabelText('Cash'));
    await user.clear(amount);
    await user.type(amount, '2.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    expect(await screen.findByText('paid')).toBeInTheDocument();
    const [card, second] = app.fake.requests.filter((r) => r.route === '/pos-sales/{id}/tenders');
    expect(second?.body).toEqual({ kind: 'cash', amountMinor: 242, expectedRevision: 1 });
    expect(second?.headers['idempotency-key']).not.toBe(card?.headers['idempotency-key']);
  });

  it('a line refused because the sale was paid elsewhere offers Reload, which reads the sale again', async () => {
    const user = userEvent.setup();
    let paid = false;
    const app = createTestApp({
      routes: saleRoutes(() => (paid ? paidSale() : saleWithLine()), {
        'POST /pos-sales/{id}/lines': () => {
          paid = true;
          return fakeResponse(409, {
            code: 'INVALID_TRANSITION',
            message: 'PosSale cannot add_line from paid.',
            correlationId: 'c-line',
            nextAction: 'reload_current_state',
          });
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Add a line' });
    await within(form).findByRole('option', { name: 'Water bottle (WATER) · $2.50' });
    await user.selectOptions(within(form).getByLabelText(/^Product/), PRODUCT_ID);
    await user.click(within(form).getByRole('button', { name: 'Add to the sale' }));
    const stale = await within(form).findByTestId('state-stale');
    expect(stale).toHaveTextContent('Error code: INVALID_TRANSITION. Reference: c-line');
    await user.click(within(stale).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('paid')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add a line' })).toBeNull();
  });

  it.each([
    [
      'processing',
      'card refund processing',
      'The card refund is not final yet: its amount stays reserved until the provider confirms.',
    ],
    [
      'unknown',
      'card refund outcome unknown',
      'Recovery required: the card refund has no confirmed outcome. Do not refund again',
    ],
    ['failed', 'card refund failed', 'The card refund failed: the customer was not refunded.'],
  ] as const)(
    'SPK-PAY-008: a card return whose refund is %s shows its status and the refund link, never success',
    async (refundStatus, badge, text) => {
      const user = userEvent.setup();
      const cardPaid = paidSale({
        tenders: [
          tender({
            kind: 'card',
            paymentAttemptId: ATTEMPT_ID,
            paymentStatus: 'succeeded',
          }),
        ],
      });
      let current = cardPaid;
      const app = createTestApp({
        routes: saleRoutes(() => current, {
          'POST /pos-sales/{id}/returns': () => {
            current = paidSale({
              ...cardPaid,
              status: 'partially_returned',
              returnedMinor: 271,
              lines: [line({ returnedQuantity: 1 })],
              returns: [
                {
                  id: RETURN_ID,
                  amountMinor: 271,
                  tenderKind: 'card',
                  lines: [
                    {
                      saleLineId: LINE_ID,
                      quantity: 1,
                      amountMinor: 271,
                      baseMinor: 250,
                      charges: [{ code: 'TAX', kind: 'tax', amountMinor: 21 }],
                    },
                  ],
                  refundAttemptId: REFUND_ID,
                  refundStatus,
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
      await user.type(within(form).getByLabelText(/^Units of Water bottle to return/), '1');
      await user.selectOptions(within(form).getByLabelText(/^Refund by/), 'card');
      await user.type(within(form).getByLabelText(/^Reason for the return/), 'Damaged');
      await user.click(within(form).getByRole('button', { name: 'Approve and record the return' }));
      const outcome = await within(form).findByRole('status');
      expect(outcome).toHaveTextContent('Return of $2.71 recorded.');
      expect(outcome).toHaveTextContent(badge);
      expect(outcome).toHaveTextContent(text);
      expect(outcome).not.toHaveTextContent('succeeded');
      expect(within(outcome).getByRole('link', { name: 'Open the refund' })).toHaveAttribute(
        'href',
        `/finance/refunds/${REFUND_ID}`,
      );
      const returns = await screen.findByRole('table', { name: 'Returns' });
      expect(within(returns).getByText(badge)).toBeInTheDocument();
      expect(within(returns).getByRole('link', { name: 'Open the refund' })).toHaveAttribute(
        'href',
        `/finance/refunds/${REFUND_ID}`,
      );
    },
  );

  it('SPK-PAY-008: a card return larger than one card payment can refund shows what it can still refund', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const cardPaid = paidSale({
      tenders: [
        tender({
          kind: 'card',
          amountMinor: 300,
          paymentAttemptId: ATTEMPT_ID,
          paymentStatus: 'succeeded',
        }),
        tender({
          id: '0192f1a0-0000-7000-8000-00000000a306',
          kind: 'card',
          amountMinor: 242,
          paymentAttemptId: '0192f1a0-0000-7000-8000-00000000a307',
          paymentStatus: 'succeeded',
        }),
      ],
    });
    const app = createTestApp({
      routes: saleRoutes(() => cardPaid, {
        'POST /pos-sales/{id}/returns': () => {
          attempts += 1;
          return attempts === 1
            ? fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'The refund exceeds the refundable amount.',
                correlationId: 'c-ref',
                nextAction: 'resolve_conflict',
                details: {
                  code: 'REFUND_EXCEEDS_REFUNDABLE',
                  availableMinor: 300,
                  capturedMinor: 300,
                  refundedMinor: 0,
                },
              })
            : fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'No captured card payment of this sale can be refunded.',
                correlationId: 'c-ref2',
                nextAction: 'resolve_conflict',
                details: { code: 'REFUND_EXCEEDS_REFUNDABLE' },
              });
        },
      }),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Return lines' });
    await user.type(within(form).getByLabelText(/^Units of Water bottle to return/), '2');
    await user.selectOptions(within(form).getByLabelText(/^Refund by/), 'card');
    await user.type(within(form).getByLabelText(/^Reason for the return/), 'Damaged');
    await user.click(within(form).getByRole('button', { name: 'Approve and record the return' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('The return exceeds what one card payment can refund');
    expect(refusal).toHaveTextContent(
      'Still refundable to the card payment: $3.00. Captured: $3.00. Already refunded: $0.00.',
    );
    expect(refusal).toHaveTextContent('return fewer units in this return');
    expect(refusal).not.toHaveTextContent('No card payment of this sale can be refunded');
    expect(refusal).toHaveTextContent('Error code: RESOURCE_CONFLICT (REFUND_EXCEEDS_REFUNDABLE)');
    await user.click(within(form).getByRole('button', { name: 'Approve and record the return' }));
    await waitFor(() =>
      expect(within(form).getByTestId('state-validation')).toHaveTextContent(
        'No card payment of this sale can be refunded',
      ),
    );
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
    expect(call?.body).toEqual({ reason: 'Customer left', expectedRevision: 1 });
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

  it('DEC-016 / CAPABILITIES-01: while the switch is off an open sale offers no new line, but can still be paid or voided', async () => {
    const user = userEvent.setup();
    let current = saleWithLine();
    const app = createTestApp({
      routes: {
        ...saleRoutes(() => current, {
          'POST /pos-sales/{id}/tenders': () => {
            current = paidSale();
            return fakeResponse(201, current);
          },
        }),
        'GET /me/permissions': permissions([], SELLER),
      },
    });
    render(app.at(SALE_PATH));
    expect(await screen.findByTestId('state-turned-off')).toHaveTextContent(
      'Point of sale turned off',
    );
    await waitFor(() => expect(screen.getByRole('table', { name: 'Sale lines' })).toBeVisible());
    expect(screen.queryByRole('form', { name: 'Add a line' })).toBeNull();
    expect(screen.getByText(/no line is added to this sale/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void the sale' })).toBeInTheDocument();
    // A tender settles the existing sale; the API never gates it.
    const form = screen.getByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Cash'));
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '5.42');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    expect(await screen.findByText('paid')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/pos-sales/{id}/tenders')?.body).toEqual({
      kind: 'cash',
      amountMinor: 542,
      expectedRevision: saleWithLine().revision,
    });
  });

  it('§4.9 COMMANDS-04: a tender decided on a sale that changed meanwhile is refused as stale and offers Reload', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const app = createTestApp({
      routes: saleRoutes(
        () => {
          reads += 1;
          return saleWithLine();
        },
        {
          'POST /pos-sales/{id}/tenders': apiError(409, 'STALE_REVISION', {
            nextAction: 'reload_and_retry',
            details: { expectedRevision: saleWithLine().revision, currentRevision: 9 },
          }),
        },
      ),
    });
    render(app.at(SALE_PATH));
    const form = await screen.findByRole('form', { name: 'Take a tender' });
    await user.click(within(form).getByLabelText('Cash'));
    await user.type(within(form).getByLabelText(/^Amount \(USD\)/), '1.00');
    await user.click(within(form).getByRole('button', { name: 'Record the tender' }));
    await user.click(await within(form).findByRole('button', { name: /^Reload/ }));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    expect(app.fake.requests.find((r) => r.route === '/pos-sales/{id}/tenders')?.body).toEqual({
      kind: 'cash',
      amountMinor: 100,
      expectedRevision: saleWithLine().revision,
    });
  });
});
