/**
 * SCR-S-37 refunds and credits (SPK-PAY-008, SPK-PAY-009, SPK-AT-007, DEC-009, DEC-058): reserve
 * before execution, the amount in minor units, partial refunds with what remains, over-refund and
 * concurrent reservation answers, an unknown refund keeping its reservation until reconciled, and
 * credits with owner, uses, expiry, balance, source and history.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  CREDIT_ID,
  PAYMENT_ID,
  REFUND_ID,
  apiError,
  credit,
  nameRoutes,
  ok,
  paymentAttempt,
  refund,
} from '../../../features/registration-finance/__tests__/fixtures';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /payments/{id}': ok(paymentAttempt()),
    'GET /refunds/{id}': ok(refund()),
    'GET /credits': ok({ items: [credit()], nextCursor: null }),
    'GET /credits/{id}': ok(credit()),
    ...extra,
  };
}

const REFUNDS_PATH = `/finance/payments/${PAYMENT_ID}/refunds`;

async function requestRefund(user: ReturnType<typeof userEvent.setup>, amount: string) {
  const form = await screen.findByRole('form', { name: 'Request a refund' });
  await user.type(within(form).getByLabelText(/^Refund amount \(USD\)/), amount);
  await user.type(within(form).getByLabelText(/^Reason for the refund/), 'Missed the first week');
  await user.click(within(form).getByRole('button', { name: 'Reserve and request the refund' }));
}

describe('SCR-S-37 RefundsScreen', () => {
  it('SPK-PAY-008: reserves and requests a partial refund in minor units and shows what remains', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /payments/{id}/refunds': ok(refund(), 201) }),
    });
    render(app.at(REFUNDS_PATH));
    await requestRefund(user, '25');
    expect(await screen.findByText(/\$100\.00 still refundable/)).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/payments/{id}/refunds');
    expect(call?.body).toEqual({ amountMinor: 2500, reason: 'Missed the first week' });
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
    const figures = screen.getByLabelText('Refundable amount of the payment');
    expect(within(figures).getByText('$125.00')).toBeInTheDocument();
    expect(screen.getByText('Reservation settled')).toBeInTheDocument();
  });

  it('§4.9: after no answer the form is locked and Try again resends the same request with the same key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/refunds': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('connection dropped');
          return fakeResponse(201, refund());
        },
      }),
    });
    render(app.at(REFUNDS_PATH));
    await requestRefund(user, '25');
    expect(await screen.findByTestId('request-locked')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Request a refund' });
    // The amount cannot be edited while the outcome is unknown.
    expect(within(form).getByLabelText(/^Refund amount \(USD\)/)).toBeDisabled();
    expect(
      within(form).getByRole('button', { name: 'Reserve and request the refund' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/\$100\.00 still refundable/)).toBeInTheDocument();
    const [first, second] = app.fake.requests.filter((r) => r.route === '/payments/{id}/refunds');
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('refuses an amount that is not a positive amount before sending, and shows an over-refund with the available amount', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/refunds': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The refund exceeds the refundable amount.',
          nextAction: 'resolve_conflict',
          details: {
            code: 'REFUND_EXCEEDS_REFUNDABLE',
            availableMinor: 10000,
            capturedMinor: 12500,
            refundedMinor: 2500,
          },
        }),
      }),
    });
    render(app.at(REFUNDS_PATH));
    await requestRefund(user, '12.345');
    expect(screen.getByText(/Enter a positive amount in USD/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/payments/{id}/refunds')).toBe(false);
    const amount = screen.getByLabelText(/^Refund amount \(USD\)/);
    await user.clear(amount);
    await user.type(amount, '200');
    await user.click(screen.getByRole('button', { name: 'Reserve and request the refund' }));
    expect(await screen.findByText('The refund exceeds the refundable amount')).toBeInTheDocument();
    expect(screen.getByText(/Available to refund: \$100\.00/)).toBeInTheDocument();
    expect(amount).toHaveValue('200');
  });

  it('SPK-AT-007: a concurrent reservation is REFUND_PENDING, shown as recovery with the reserved amount', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/refunds': apiError(409, 'REFUND_PENDING', {
          message: 'A refund is pending on these funds.',
          nextAction: 'await_refund_resolution',
          details: { availableMinor: 0, reservedMinor: 10000 },
        }),
      }),
    });
    render(app.at(REFUNDS_PATH));
    await requestRefund(user, '50');
    expect(await screen.findByText('Recovery required: a refund is pending')).toBeInTheDocument();
    expect(
      screen.getByText(/Reserved by pending refunds: \$100\.00\. Still available: \$0\.00/),
    ).toBeInTheDocument();
  });

  it('shows a missing refund permission as not available to the viewer', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/refunds': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
          details: { action: 'finance.refund' },
        }),
      }),
    });
    render(app.at(REFUNDS_PATH));
    await requestRefund(user, '25');
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/finance\.refund/)).toBeInTheDocument();
  });

  it('does not offer a refund of a payment that did not succeed', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /payments/{id}': ok(paymentAttempt({ status: 'failed' })) }),
    });
    render(app.at(REFUNDS_PATH));
    expect(await screen.findByRole('heading', { name: 'Nothing to refund' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Request a refund' })).toBeNull();
  });
});

describe('SCR-S-37 RefundScreen', () => {
  it('keeps an unknown refund’s reservation and reconciles it from provider evidence', async () => {
    const user = userEvent.setup();
    const unknown = refund({
      status: 'unknown',
      reservationStatus: 'reserved',
      unknownSince: '2026-10-24T11:00:00.000Z',
      resolvedAt: null,
      refundable: {
        capturedMinor: 12500,
        refundedMinor: 0,
        reservedMinor: 2500,
        availableMinor: 10000,
        currency: 'USD',
      },
    });
    const app = createTestApp({
      routes: routes({
        'GET /refunds/{id}': ok(unknown),
        'POST /refunds/{id}/reconcile': ok(refund(), 201),
      }),
    });
    render(app.at(`/finance/refunds/${REFUND_ID}`));
    expect(await screen.findByText('Refund unknown: reservation retained')).toBeInTheDocument();
    expect(screen.getByText('Amount reserved')).toBeInTheDocument();
    expect(screen.getByText(/The reserved amount stays held/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile from provider evidence' }));
    expect(await screen.findByText(/Refund now Refund succeeded/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/refunds/{id}/reconcile')?.headers[
        'idempotency-key'
      ],
    ).toMatch(/^key-/);
  });
});

describe('SCR-S-37 CreditsScreen', () => {
  it('SPK-PAY-009: lists a person’s credits with owner, uses, expiry, balance, source and history, and approves one', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /credits': ok({
          items: [
            credit(),
            credit({
              id: `${CREDIT_ID.slice(0, -1)}4`,
              status: 'active',
              sourceKind: 'goodwill',
              remainingMinor: 400,
              permittedUses: ['registration'],
              redemptions: [
                {
                  id: '0192f1a0-0000-7000-8000-000000001105',
                  kind: 'redeem',
                  amountMinor: 600,
                  referenceType: 'checkout',
                  referenceId: CREDIT_ID,
                  redeemedAt: '2026-10-22T10:00:00.000Z',
                },
              ],
            }),
          ],
          nextCursor: null,
        }),
        'POST /credits/{id}/approve': ok(
          credit({ status: 'active', approvedAt: '2026-10-24T12:00:00.000Z' }),
          201,
        ),
      }),
    });
    render(app.at('/finance/credits'));
    expect(
      await screen.findByRole('heading', { name: 'Choose a credit owner' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Credit owner reference/), ADULT_ID);
    const list = await screen.findByRole('list', { name: 'Credits' });
    const [pending, active] = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.parentElement === list);
    expect(within(pending!).getByText('pending_approval')).toBeInTheDocument();
    expect(within(pending!).getByText('No date set (expiry rules pending)')).toBeInTheDocument();
    expect(within(pending!).getByText(/overpayment/)).toBeInTheDocument();
    expect(
      within(active!).getByRole('link', { name: /Credit \$4\.00 remaining of \$10\.00/ }),
    ).toBeInTheDocument();
    expect(
      within(within(active!).getByRole('list', { name: 'Redemption history' })).getByText(
        /Redeemed \$6\.00/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(pending!).getByRole('button', { name: 'Approve the credit of $10.00' }),
    );
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/credits/{id}/approve')).toBe(true),
    );
    expect(app.fake.requests.find((r) => r.route === '/credits/{id}/approve')?.body).toEqual({
      expectedRevision: 1,
    });
  });

  it('issues a goodwill credit with the uses and expiry finance entered', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /credits': ok(credit({ sourceKind: 'goodwill', status: 'active' }), 201),
      }),
    });
    render(app.at('/finance/credits'));
    await user.click(await screen.findByText('Issue a credit'));
    const form = screen.getByRole('form', { name: 'Issue a credit' });
    const f = within(form);
    await user.click(f.getByRole('button', { name: 'Issue the credit' }));
    expect(f.getByText('Choose at least one permitted use.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/credits' && r.method === 'POST')).toBe(
      false,
    );
    await user.type(f.getByLabelText(/^Owner reference/), ADULT_ID);
    await user.type(f.getByLabelText(/^Credit amount/), '10');
    await user.type(f.getByLabelText(/^Credit currency/), 'USD');
    await user.type(f.getByLabelText(/^Expires at the end of/), '2027-06-30');
    await user.selectOptions(f.getByLabelText(/^Source/), 'goodwill');
    await user.click(f.getByLabelText('Obligations'));
    await user.type(f.getByLabelText(/^Reason for the credit/), 'Field closure');
    await user.click(f.getByRole('button', { name: 'Issue the credit' }));
    expect(await f.findByText(/Credit issued: \$10\.00, active/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/credits' && r.method === 'POST')?.body,
    ).toEqual({
      ownerPersonId: ADULT_ID,
      amountMinor: 1000,
      currency: 'USD',
      permittedUses: ['obligation'],
      sourceKind: 'goodwill',
      reason: 'Field closure',
      expiresAt: '2027-07-01T00:00:00.000Z',
    });
    expect(screen.getByText(/pending DEC-009, DEC-058/)).toBeInTheDocument();
  });

  it('shows a credit the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /credits/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      }),
    });
    render(app.at(`/finance/credits/${CREDIT_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
});
