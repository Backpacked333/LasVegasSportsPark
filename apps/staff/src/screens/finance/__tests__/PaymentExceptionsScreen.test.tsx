/**
 * SCR-S-36 payment attempts and unknown outcomes (SPK-PAY-007, §4.11, SPK-AT-006, DEC-019,
 * DEC-039): the finance operator queue grouped by kind with age and owner, "no unknown outcomes"
 * said plainly, reconciliation from provider evidence (never a retry of payment), the same key on
 * a retry after no answer, still-unresolved results as recovery required, checkout recovery and
 * compensation with a reason, and not-found answers; payment attempts by state (FIN-02) and
 * provider events with their signature verification state and never a payload (K-08, §4.12);
 * keyset paging of the exception queue (K-10) and the payer found by name (ID-03).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ADULT_ID,
  CHECKOUT_ID,
  PAYMENT_ID,
  REFUND_ID,
  apiError,
  checkout,
  exception,
  nameRoutes,
  ok,
  paymentAttempt,
  paymentDetail,
  peopleSearch,
  personMatch,
  providerEvent,
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
    'GET /payments/{id}': ok(paymentDetail(UNKNOWN)),
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
    expect(
      within(unmatched).getByRole('link', { name: 'Open the provider events' }),
    ).toHaveAttribute('href', '/finance/payments?view=events');
    expect(screen.getByText(/depends on DEC-039/)).toBeInTheDocument();
    // SCR-S-36: the default is the API's active set (open and acknowledged), so no status.
    const query = app.fake.requests.find((r) => r.route === '/exceptions')?.query;
    expect(query).toMatchObject({ queue: 'finance_operator' });
    expect(query?.['status']).toBeUndefined();
  });

  it('shows an acknowledged unknown outcome and a finance exception of an unlisted kind', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /exceptions': ok({
          items: [
            exception({ status: 'acknowledged' }),
            exception({
              id: '0192f1a0-0000-7000-8000-00000000e9e9',
              category: 'finance.refund_review',
              title: 'A refund needs review',
            }),
          ],
          nextCursor: null,
        }),
      }),
    });
    render(app.at('/finance/payments'));
    const unknown = await screen.findByRole('region', { name: 'Unknown payment outcomes' });
    expect(within(unknown).getByText('acknowledged')).toBeInTheDocument();
    const other = screen.getByRole('region', { name: 'Finance exceptions of another kind' });
    expect(within(other).getByText(/A refund needs review/)).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Provider events from fake' })).toHaveAttribute(
      'href',
      '/finance/payments?view=events&provider=fake',
    );
    expect(screen.getByText('No refund has been requested for this payment.')).toBeVisible();
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
        'GET /payments': ok({ items: [], nextCursor: null }),
      }),
    });
    render(app.at('/finance/payments?view=attempts'));
    await user.type(await screen.findByLabelText('Payment attempt reference'), 'not-a-reference');
    await user.click(screen.getByRole('button', { name: 'Open the attempt' }));
    expect(screen.getByText('Enter a payment attempt reference.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Payment attempt reference'));
    await user.type(screen.getByLabelText('Payment attempt reference'), PAYMENT_ID);
    await user.click(screen.getByRole('button', { name: 'Open the attempt' }));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });
  it('FIN-02: lists payment attempts by state, unknown first by default, with age and owner', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /payments': (request) =>
          fakeResponse(200, {
            items:
              request.query.status === 'unknown'
                ? [UNKNOWN]
                : [
                    paymentAttempt({
                      id: '0192f1a0-0000-7000-8000-000000001109',
                      purpose: 'obligation',
                    }),
                  ],
            nextCursor: null,
          }),
      }),
    });
    render(app.at('/finance/payments'));
    await user.click(await screen.findByRole('button', { name: 'Payment attempts' }));
    expect(screen.getByRole('button', { name: 'Payment attempts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const list = await screen.findByRole('list', { name: 'Payment attempts' });
    expect(within(list).getByText('Attempt unknown: reconcile before any retry')).toBeVisible();
    expect(within(list).getByText(/2 hours ago\): reconcile before anything else/)).toBeVisible();
    expect(within(list).getByRole('link', { name: /^\$125\.00 · checkout/ })).toHaveAttribute(
      'href',
      `/finance/payments/${PAYMENT_ID}`,
    );
    expect(await within(list).findByText('Sam Rivera')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/payments')?.query).toMatchObject({
      status: 'unknown',
    });
    await user.selectOptions(screen.getByLabelText('Attempt state'), '');
    await user.selectOptions(screen.getByLabelText('Purpose'), 'obligation');
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Payment attempts' })).getByText(
          'Attempt succeeded',
        ),
      ).toBeInTheDocument(),
    );
    expect(app.fake.requests.filter((r) => r.route === '/payments').at(-1)?.query).toEqual({
      limit: '50',
      purpose: 'obligation',
    });
  });

  it('says there are no unknown payment outcomes, and shows an attempts list the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /payments': ok({ items: [], nextCursor: null }) }),
    });
    const { unmount } = render(app.at('/finance/payments?view=attempts'));
    expect(await screen.findByRole('heading', { name: 'No unknown outcomes' })).toBeVisible();
    unmount();
    app.fake.set(
      'GET /payments',
      apiError(403, 'ACCESS_DENIED', { details: { action: 'finance.read_payment' } }),
    );
    await app.queryClient.resetQueries();
    render(app.at('/finance/payments?view=attempts'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('K-08: lists provider events with signature verification and processing state, never a payload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /provider-events': (request) =>
          fakeResponse(
            200,
            request.query.cursor === 'e2'
              ? {
                  items: [
                    providerEvent({
                      id: '0192f1a0-0000-7000-8000-000000001409',
                      providerEventId: 'evt_2',
                      signatureVerified: false,
                      status: 'failed',
                      attempts: 3,
                      lastError: 'No matching attempt',
                      processedAt: null,
                    }),
                  ],
                  nextCursor: null,
                }
              : { items: [{ ...providerEvent(), payload: { card: 'secret' } }], nextCursor: 'e2' },
          ),
      }),
    });
    render(app.at('/finance/payments?view=events&provider=fake'));
    const list = await screen.findByRole('list', { name: 'Provider events' });
    expect(within(list).getByText('Signature verified')).toBeInTheDocument();
    expect(within(list).getByText('Event processed')).toBeInTheDocument();
    expect(within(list).getByText(/Provider event evt_1/)).toBeInTheDocument();
    // §4.14: nothing from a payload is rendered, even if one were sent.
    expect(screen.queryByText(/secret/)).toBeNull();
    expect(screen.getByLabelText('Provider')).toHaveValue('fake');
    expect(app.fake.requests.find((r) => r.route === '/provider-events')?.query).toMatchObject({
      provider: 'fake',
    });
    await user.click(screen.getByRole('button', { name: 'Load more provider events' }));
    expect(await within(list).findByText('Signature not verified')).toBeInTheDocument();
    expect(within(list).getByText('Event failed')).toBeInTheDocument();
    expect(within(list).getByText('Last error: No matching attempt')).toBeInTheDocument();
  });

  it('shows provider events the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /provider-events': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'core.view_provider_events' },
        }),
      }),
    });
    render(app.at('/finance/payments?view=events'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('SPK-PAY-008: an attempt lists its earlier refunds and what is still refundable', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /payments/{id}': ok(
          paymentDetail(
            {},
            {
              refundableMinor: 10000,
              refunds: [
                {
                  id: REFUND_ID,
                  status: 'unknown',
                  amountMinor: 2500,
                  currency: 'USD',
                  requestedAt: '2026-10-24T09:00:00.000Z',
                },
              ],
            },
          ),
        ),
      }),
    });
    render(app.at(`/finance/payments/${PAYMENT_ID}`));
    expect(await screen.findByText(/Still refundable: \$100\.00/)).toBeInTheDocument();
    const refunds = screen.getByRole('list', { name: 'Refunds of this payment' });
    expect(within(refunds).getByText('Refund unknown: reservation retained')).toBeVisible();
    expect(within(refunds).getByRole('link', { name: /\$25\.00 requested/ })).toHaveAttribute(
      'href',
      `/finance/refunds/${REFUND_ID}`,
    );
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

  it('K-10 (§4.5): pages the exception queue, says counts are of what is loaded, and loads the rest', async () => {
    const user = userEvent.setup();
    const later = exception({
      id: '0192f1a0-0000-7000-8000-000000001209',
      category: 'finance.unknown_refund_outcome',
      title: 'A refund result is unknown',
      affected: { type: 'refund_attempt', id: REFUND_ID },
    });
    const app = createTestApp({
      routes: routes({
        'GET /exceptions': (request) =>
          fakeResponse(
            200,
            request.query.cursor === 'x2'
              ? { items: [later], nextCursor: null }
              : { items: [exception()], nextCursor: 'x2' },
          ),
      }),
    });
    render(app.at('/finance/payments'));
    const refunds = await screen.findByRole('region', { name: 'Unknown refund outcomes' });
    // An empty group is not claimed empty while more pages exist.
    expect(within(refunds).getByText('None loaded so far.')).toBeInTheDocument();
    expect(screen.getByText(/Counts are of the exceptions loaded so far/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more finance exceptions' }));
    expect(await within(refunds).findByText('A refund result is unknown')).toBeInTheDocument();
    expect(screen.queryByText(/Counts are of the exceptions loaded so far/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more finance exceptions' })).toBeNull();
    const queries = app.fake.requests.filter((r) => r.route === '/exceptions').map((r) => r.query);
    expect(queries.map((q) => q['cursor'] ?? null)).toEqual([null, 'x2']);
    expect(queries[0]).toMatchObject({ queue: 'finance_operator', limit: '50' });
  });

  it('K-10: an empty first page with more to load is not shown as no unknown outcomes', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /exceptions': ok({ items: [], nextCursor: 'x2' }),
      }),
    });
    render(app.at('/finance/payments'));
    expect(
      await screen.findByRole('button', { name: 'Load more finance exceptions' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No unknown outcomes' })).toBeNull();
  });

  it('ID-03: finds the payer of payment attempts by name; a search the viewer may not use is not available', async () => {
    const user = userEvent.setup();
    let allowed = true;
    const app = createTestApp({
      routes: routes({
        'GET /payments': ok({ items: [UNKNOWN], nextCursor: null }),
        'GET /people': (request) =>
          allowed
            ? peopleSearch([personMatch(ADULT_ID, 'Sam', 'Rivera')])(request)
            : fakeResponse(403, {
                code: 'ACCESS_DENIED',
                message: 'Not permitted.',
                correlationId: 'c',
                nextAction: 'contact_support_or_request_access',
              }),
      }),
    });
    render(app.at('/finance/payments?view=attempts'));
    const finder = await screen.findByRole('group', { name: 'Find the payer' });
    await user.type(within(finder).getByLabelText(/^Find the payer/), 'Riv{Enter}');
    await user.click(
      await within(finder).findByRole('button', { name: 'Use Sam Rivera as the payer' }),
    );
    expect(screen.getByLabelText(/^Payer reference/)).toHaveValue(ADULT_ID);
    // The reference shows whose record it is.
    const field = screen.getByLabelText(/^Payer reference/).closest('.rf-field')!.parentElement!;
    await waitFor(() => expect(field).toHaveTextContent('Payer: Sam Rivera'));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/payments').at(-1)?.query).toMatchObject({
        payerPersonId: ADULT_ID,
      }),
    );
    // Without the lookup permission the search says so and the reference stays usable.
    allowed = false;
    await user.clear(screen.getByLabelText(/^Payer reference/));
    const again = await screen.findByRole('group', { name: 'Find the payer' });
    await user.type(within(again).getByLabelText(/^Find the payer/), 'Lee{Enter}');
    expect(await within(again).findByText(/Person search is not available to you/)).toBeVisible();
  });
});
