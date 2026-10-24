/**
 * SCR-S-36 payment attempts and unknown outcomes (SPK-PAY-007, §4.11, SPK-AT-006, DEC-019,
 * DEC-039): the finance operator queue grouped by kind with age and owner, "no unknown outcomes"
 * said plainly, reconciliation from provider evidence (never a retry of payment), the same key on
 * a retry after no answer, still-unresolved results as recovery required, checkout recovery and
 * compensation with a reason, and not-found answers.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  CHECKOUT_ID,
  PAYMENT_ID,
  apiError,
  checkout,
  exception,
  nameRoutes,
  ok,
  paymentAttempt,
} from '../../../features/registration-finance/__tests__/fixtures';

const UNKNOWN = paymentAttempt({
  status: 'unknown',
  evidenceSource: null,
  providerReference: null,
  unknownSince: '2026-10-24T10:00:00.000Z',
  resolvedAt: null,
});

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
          overdue: true,
        }),
        exception({
          id: '0192f1a0-0000-7000-8000-000000001203',
          category: 'finance.unmatched_provider_event',
          severity: 'high',
          title: 'A payment event from the provider matches no recorded attempt',
          affected: { type: 'inbox_event', id: '0192f1a0-0000-7000-8000-000000001204' },
        }),
      ],
      nextCursor: null,
    }),
    'GET /payments/{id}': ok(UNKNOWN),
    ...extra,
  };
}

describe('SCR-S-36 PaymentExceptionsScreen', () => {
  it('groups the finance operator queue with severity, status, age, owner and the record to act on', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at('/finance/payments'));
    const unknown = await screen.findByRole('region', { name: 'Unknown payment outcomes' });
    const row = within(unknown).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Severity critical')).toBeInTheDocument();
    expect(within(row).getByText('open')).toBeInTheDocument();
    expect(
      within(row).getByText(/Opened 3 hours ago · owner queue finance operator/),
    ).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open the payment attempt' })).toHaveAttribute(
      'href',
      `/finance/payments/${PAYMENT_ID}`,
    );
    const recovery = screen.getByRole('region', { name: 'Checkouts needing recovery' });
    expect(within(recovery).getByText('Overdue')).toBeInTheDocument();
    expect(
      within(recovery).getByRole('link', { name: 'Open the checkout recovery' }),
    ).toBeInTheDocument();
    const unmatched = screen.getByRole('region', {
      name: 'Provider events without a matching attempt',
    });
    expect(within(unmatched).getByText(/the inbox is not published/)).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-039/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/exceptions')?.query).toMatchObject({
      queue: 'finance_operator',
      status: 'open',
    });
  });

  it('says plainly when there are no unknown outcomes', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /exceptions': ok({ items: [], nextCursor: null }) }),
    });
    render(app.at('/finance/payments'));
    expect(await screen.findByRole('heading', { name: 'No unknown outcomes' })).toBeInTheDocument();
  });

  it('SPK-PAY-007: reconciles an unknown attempt from provider evidence, never offering a payment retry', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/reconcile': ok(
          paymentAttempt({ evidenceSource: 'reconciliation' }),
          201,
        ),
      }),
    });
    render(app.at(`/finance/payments/${PAYMENT_ID}`));
    expect(
      await screen.findByText('Attempt unknown: reconcile before any retry'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Do\s+not charge the customer again/)).toBeInTheDocument();
    expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|pay again/i })).toBeNull();
    expect(screen.getByText('Provider events not available')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile from provider evidence' }));
    expect(await screen.findByText('Resolved: Attempt succeeded.')).toBeInTheDocument();
    const call = app.fake.requests.find((r) => r.route === '/payments/{id}/reconcile');
    expect(call?.body).toBeUndefined();
    expect(call?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('keeps the same idempotency key when retrying after no answer, and reports a still-unknown result', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /payments/{id}/reconcile': () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
          return fakeResponse(201, UNKNOWN);
        },
      }),
    });
    render(app.at(`/finance/payments/${PAYMENT_ID}`));
    await user.click(
      await screen.findByRole('button', { name: 'Reconcile from provider evidence' }),
    );
    expect(await screen.findByText('No connection')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Still unresolved/)).toBeInTheDocument();
    const keys = app.fake.requests
      .filter((r) => r.route === '/payments/{id}/reconcile')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(keys[1]);
  });

  it('opens an attempt by reference and shows one the viewer may not see as not available', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /payments/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      }),
    });
    render(app.at('/finance/payments'));
    await user.type(await screen.findByLabelText('Payment attempt reference'), 'not-a-reference');
    await user.click(screen.getByRole('button', { name: 'Open the attempt' }));
    expect(screen.getByText('Enter a payment attempt reference.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Payment attempt reference'));
    await user.type(screen.getByLabelText('Payment attempt reference'), PAYMENT_ID);
    await user.click(screen.getByRole('button', { name: 'Open the attempt' }));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
});

describe('SCR-S-36 CheckoutRecoveryScreen', () => {
  const RECOVERY = checkout({
    status: 'recovery_required',
    payment: paymentAttempt(),
    enrollmentIds: [],
    failure: { code: 'CAPACITY_UNAVAILABLE', details: null },
    recovery: {
      reasonCode: 'CAPACITY_UNAVAILABLE',
      message: 'The hold expired before the payment succeeded.',
      plan: 'credit',
      refundAttemptId: null,
      creditId: null,
      exceptionId: null,
    },
    nextAction: 'finance_review',
  });

  it('says what is known and compensates only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /registration-checkouts/{id}': ok(RECOVERY),
        'POST /registration-checkouts/{id}/compensate': ok(
          { ...RECOVERY, status: 'compensated' },
          201,
        ),
      }),
    });
    render(app.at(`/finance/checkouts/${CHECKOUT_ID}`));
    expect(
      await screen.findByText('Recovery required: received money plus incomplete fulfillment'),
    ).toBeInTheDocument();
    expect(screen.getByText('The hold expired before the payment succeeded.')).toBeInTheDocument();
    expect(screen.getByText('Finance operator queue')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Compensate with/)).toHaveValue('credit');
    await user.click(screen.getByRole('button', { name: 'Compensate the checkout' }));
    expect(screen.getByText(/A reason is required/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Reason/), 'Group full; family chose a credit');
    await user.click(screen.getByRole('button', { name: 'Compensate the checkout' }));
    expect(await screen.findByText('Checkout now Compensated.')).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/registration-checkouts/{id}/compensate')?.body,
    ).toEqual({
      method: 'credit',
      reason: 'Group full; family chose a credit',
      expectedRevision: 1,
    });
  });

  it('retries fulfillment and shows REFUND_PENDING as recovery', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /registration-checkouts/{id}': ok(RECOVERY),
        'POST /registration-checkouts/{id}/recover': apiError(409, 'REFUND_PENDING', {
          nextAction: 'await_refund_resolution',
          details: { availableMinor: 0, reservedMinor: 12500 },
        }),
      }),
    });
    render(app.at(`/finance/checkouts/${CHECKOUT_ID}`));
    await user.type(await screen.findByLabelText(/^Reason/), 'Capacity was added');
    await user.click(screen.getByRole('button', { name: 'Retry fulfillment' }));
    expect(await screen.findByText('Recovery required: a refund is pending')).toBeInTheDocument();
    expect(screen.getByText(/Reserved by pending refunds: \$125\.00/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/registration-checkouts/{id}/recover')?.body,
      ).toEqual({
        reason: 'Capacity was added',
        expectedRevision: 1,
      }),
    );
  });
});
