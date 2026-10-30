/**
 * One rental or party and its cancellation (Package G; ENR-13, SPK-COND-003, SPK-REG-010, §4.9,
 * §4.10, SPK-UX-008): status and what is outstanding as the API states them, times in the
 * facility's zone, the hold and its basket; the consequence is shown before anything is sent (a
 * request holds nothing, a hold releases its basket unless it is being paid, a paid booking binds
 * the previewed money consequence); one idempotency key per intent; NOT_FOUND is not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import {
  cancellationPreview,
  consequence,
  createRouterMock,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { basket, booking, G, ok } from '../../../features/package-g/__tests__/fixtures';
import { BookingDetailScreen } from '../BookingDetailScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

type App = ReturnType<typeof createTestApp>;

function renderDetail(routes: Record<string, FakeHandler>) {
  const app = createTestApp({ routes });
  render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: app.wrapper });
  return app;
}

const cancels = (app: App) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/bookings/{id}/cancel');

async function openCancel(reason = 'Plans changed') {
  fireEvent.press(await screen.findByRole('button', { name: 'Cancel this booking' }));
  fireEvent.changeText(await screen.findByLabelText('Reason for canceling'), reason);
}

async function confirmCancel() {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Cancel booking' }));
  });
}

const PAID = booking({ status: 'confirmed', outstanding: [], revision: 4 });

describe('Package G BookingDetailScreen (SPK-COND-003)', () => {
  afterEach(settleApps);
  beforeEach(() => jest.clearAllMocks());

  it('shows a held booking: status, what is outstanding, times in the facility zone, terms, and the basket to pay in', async () => {
    renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket()),
    });
    expect(await screen.findByRole('header', { name: 'Court rental' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Held for you: pay to confirm')).toBeOnTheScreen();
    expect(
      screen.getByText(
        /Your payment, in your basket\. The booking is confirmed only when it is paid\./,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Sat, Oct 24, 10:00 AM to 11:00 AM PDT: Court 1'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Access conditions: Enter by the north gate.')).toBeOnTheScreen();
    expect(
      await screen.findByLabelText(
        "Held until: Oct 24, 2026, 5:20 AM PDT. The facility's system releases the time then.",
      ),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Go to basket' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${G.basket}`);
  });

  it('SPK-COND-003: a paid booking still waiting for its staff says so and is not "Confirmed"', async () => {
    renderDetail({
      'GET /bookings/{id}': ok(booking({ status: 'awaiting_staff', outstanding: ['staffing'] })),
    });
    expect(await screen.findByLabelText('Paid: staff still being arranged')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Confirmed')).toBeNull();
    expect(screen.getByText(/assigns the staff this booking needs/)).toBeOnTheScreen();
  });

  it('a request: withdrawing it says nothing was reserved or charged, and sends the reason, expectedRevision and one key', async () => {
    const requested = booking({
      status: 'requested',
      outstanding: ['approval'],
      basketId: null,
      enrollmentId: null,
      occurrences: [{ ...booking().occurrences[0]!, eventId: null }],
    });
    const app = renderDetail({
      'GET /bookings/{id}': ok(requested),
      'POST /bookings/{id}/cancel': ok({
        ...requested,
        status: 'canceled',
        outstanding: [],
        revision: 2,
      }),
    });
    expect(
      await screen.findByLabelText(
        'Sat, Oct 24, 10:00 AM to 11:00 AM PDT: Court 1. Not reserved until the request is approved',
      ),
    ).toBeOnTheScreen();
    await openCancel();
    expect(
      screen.getByText('Your request is withdrawn. Nothing was reserved or charged.'),
    ).toBeOnTheScreen();
    await confirmCancel();
    expect(await screen.findByTestId('booking-canceled')).toBeOnTheScreen();
    expect(screen.getByLabelText('Canceled')).toBeOnTheScreen();
    const [sent] = cancels(app);
    expect(sent?.body).toEqual({ reason: 'Plans changed', expectedRevision: 1 });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('validation failure: a missing reason is a field message and sends nothing', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket()),
    });
    await openCancel('   ');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeEnabled(),
    );
    await confirmCancel();
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter a reason for canceling\./);
    expect(cancels(app)).toHaveLength(0);
  });

  it('a held booking whose basket is being paid offers no cancel until the payment outcome is known', async () => {
    renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket({ status: 'checking_out' })),
    });
    await openCancel();
    expect(
      await screen.findByLabelText('A payment for this booking may be on its way'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    // The hold itself says the payment is in progress and never asks to pay again.
    expect(
      screen.getByLabelText('Payment in progress: open the basket for its outcome'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Go to basket' })).toBeNull();
    fireEvent.press(
      within(screen.getByTestId('cancel-payment-in-progress')).getByRole('button', {
        name: 'Open the basket',
      }),
    );
    expect(mockRouter.push).toHaveBeenCalledWith(`/registration/basket/${G.basket}`);
  });

  it.each(['held', 'open'] as const)(
    'a held booking with an unpaid (%s) basket: canceling releases the hold and the basket, sending the reason, expectedRevision and one key',
    async (status) => {
      const app = renderDetail({
        'GET /bookings/{id}': ok(booking({ revision: 3 })),
        'GET /baskets/{id}': ok(basket({ status })),
        'POST /bookings/{id}/cancel': ok(
          booking({ status: 'canceled', outstanding: [], revision: 4, endReason: 'Plans changed' }),
        ),
      });
      await openCancel();
      expect(
        await screen.findByText(
          'The time held for you is released and your basket is emptied. Nothing has been charged for this booking.',
        ),
      ).toBeOnTheScreen();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeEnabled(),
      );
      await confirmCancel();
      expect(await screen.findByTestId('booking-canceled')).toBeOnTheScreen();
      expect(screen.getByText('Everything this booking held has been released.')).toBeOnTheScreen();
      expect(screen.getByLabelText('Canceled')).toBeOnTheScreen();
      const sent = cancels(app);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.params.id).toBe(G.booking);
      expect(sent[0]?.body).toEqual({ reason: 'Plans changed', expectedRevision: 3 });
      expect(sent[0]?.headers['idempotency-key']).toMatch(/^key-/);
    },
  );

  it('a held booking whose basket checkout already completed is never "nothing charged": no release is offered and the booking is read again', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket({ status: 'fulfilled', holdExpiresAt: null })),
    });
    expect(
      await screen.findByLabelText('Payment received: this booking is being updated'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Pay to confirm')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to basket' })).toBeNull();
    // The booking reads `held` until the API records the payment: it is read again once.
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/bookings/{id}')).toHaveLength(2),
    );
    await openCancel();
    expect(await screen.findByTestId('cancel-payment-received')).toBeOnTheScreen();
    expect(screen.queryByText(/Nothing has been charged/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    await confirmCancel();
    expect(cancels(app)).toHaveLength(0);
    // Read again once per outcome, never in a loop.
    await settleApps();
    expect(app.fake.requests.filter((r) => r.route === '/bookings/{id}')).toHaveLength(2);
  });

  it('a held booking whose hold already ended has nothing left to cancel', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': ok(basket({ status: 'expired', holdExpiresAt: null })),
    });
    expect(
      await screen.findByLabelText('The time held for this booking was released'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Go to basket' })).toBeNull();
    await openCancel();
    expect(await screen.findByTestId('cancel-hold-ended')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    expect(cancels(app)).toHaveLength(0);
  });

  it('the cancel panel never acts on the cached basket: it waits for its own read, reads again at confirm, and sends nothing once a checkout started', async () => {
    let reads = 0;
    let release: (() => void) | null = null;
    const app = renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': () => {
        reads += 1;
        if (reads === 1) return fakeResponse(200, basket());
        if (reads === 2) {
          return new Promise<Response>((resolve) => {
            release = () => resolve(fakeResponse(200, basket()));
          });
        }
        return fakeResponse(200, basket({ status: 'checking_out' }));
      },
    });
    expect(await screen.findByRole('button', { name: 'Go to basket' })).toBeOnTheScreen();
    await openCancel();
    // The cached basket says `held`, but the panel's own read has not answered yet.
    expect(await screen.findByText('Checking that no payment has started…')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    await waitFor(() => expect(release).not.toBeNull());
    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeEnabled(),
    );
    // A checkout starts meanwhile: the confirm-time read finds it and nothing is sent.
    await confirmCancel();
    expect(
      await screen.findByLabelText('A payment for this booking may be on its way'),
    ).toBeOnTheScreen();
    expect(reads).toBe(3);
    expect(cancels(app)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
  });

  it('a failed basket read blocks the release and shows its code with "Try again"', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(booking()),
      'GET /baskets/{id}': {
        status: 503,
        body: apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-b' }),
      },
    });
    await openCancel();
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-b/),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    expect(cancels(app)).toHaveLength(0);
  });

  it('SPK-REG-010: a paid booking shows the previewed money consequence and sends it as acceptedConsequence', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(PAID),
      'GET /enrollments/{id}/cancellation-preview': ok(
        cancellationPreview({ enrollmentId: G.enrollment }),
      ),
      'POST /bookings/{id}/cancel': ok({ ...PAID, status: 'canceled', revision: 5 }),
    });
    await openCancel();
    expect(await screen.findByLabelText('Refund of $60.00')).toBeOnTheScreen();
    expect(
      screen.getByText('The cancellation policy grants a refund of 50% of the price.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).toBeDisabled();
    fireEvent.press(screen.getByRole('checkbox', { name: 'I understand: Refund of $60.00' }));
    await confirmCancel();
    expect(await screen.findByText('What you accepted: Refund of $60.00.')).toBeOnTheScreen();
    const preview = app.fake.requests.find(
      (r) => r.route === '/enrollments/{id}/cancellation-preview',
    );
    expect(preview?.params.id).toBe(G.enrollment);
    expect(cancels(app)[0]?.body).toEqual({
      reason: 'Plans changed',
      expectedRevision: 4,
      acceptedConsequence: { kind: 'refund', amountMinor: 6000, currency: 'USD' },
    });
  });

  it('a changed consequence (CONSEQUENCE_CHANGED) is never committed unseen: it is shown again to acknowledge', async () => {
    let current = cancellationPreview({ enrollmentId: G.enrollment });
    renderDetail({
      'GET /bookings/{id}': ok(PAID),
      'GET /enrollments/{id}/cancellation-preview': () => fakeResponse(200, current),
      'POST /bookings/{id}/cancel': () => {
        current = cancellationPreview({
          enrollmentId: G.enrollment,
          financialConsequence: consequence({ amountMinor: 3000 }),
        });
        return fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', { details: { code: 'CONSEQUENCE_CHANGED' } }),
        );
      },
    });
    await openCancel();
    fireEvent.press(
      await screen.findByRole('checkbox', { name: 'I understand: Refund of $60.00' }),
    );
    await confirmCancel();
    expect(
      await screen.findByLabelText(
        'The money consequence changed since you reviewed it. Review it again.',
      ),
    ).toBeOnTheScreen();
    expect(await screen.findByLabelText('Refund of $30.00')).toBeOnTheScreen();
    expect(
      screen.getByRole('checkbox', { name: 'I understand: Refund of $30.00' }),
    ).not.toBeChecked();
  });

  it('stale version: the consequence is read again at confirm time; if that read fails nothing is sent', async () => {
    let reads = 0;
    const app = renderDetail({
      'GET /bookings/{id}': ok(PAID),
      'GET /enrollments/{id}/cancellation-preview': () => {
        reads += 1;
        return reads === 1
          ? fakeResponse(200, cancellationPreview({ enrollmentId: G.enrollment }))
          : fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { correlationId: 'c-p' }));
      },
    });
    await openCancel();
    fireEvent.press(
      await screen.findByRole('checkbox', { name: 'I understand: Refund of $60.00' }),
    );
    await confirmCancel();
    expect(
      await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE\. Reference: c-p/),
    ).toBeOnTheScreen();
    expect(cancels(app)).toHaveLength(0);
  });

  it('STALE_REVISION keeps the reason and offers "Reload", which reads the booking again', async () => {
    const app = renderDetail({
      'GET /bookings/{id}': ok(
        booking({ status: 'requested', basketId: null, enrollmentId: null }),
      ),
      'POST /bookings/{id}/cancel': {
        status: 409,
        body: apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }),
      },
    });
    await openCancel('Moving away');
    await confirmCancel();
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason for canceling')).toHaveDisplayValue('Moving away');
    fireEvent.press(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/bookings/{id}')).toHaveLength(2),
    );
  });

  it('§4.9: with no answer, "Check again" repeats the same intent with the same idempotency key', async () => {
    let attempts = 0;
    const requested = booking({ status: 'requested', basketId: null, enrollmentId: null });
    const app = renderDetail({
      'GET /bookings/{id}': ok(requested),
      'POST /bookings/{id}/cancel': () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Network request failed');
        return fakeResponse(200, { ...requested, status: 'canceled', revision: 2 });
      },
    });
    await openCancel();
    await confirmCancel();
    expect(await screen.findByLabelText('No answer yet')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByTestId('booking-canceled')).toBeOnTheScreen();
    const [first, second] = cancels(app);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  it('a declined request shows the reason and offers no cancellation', async () => {
    renderDetail({
      'GET /bookings/{id}': ok(
        booking({
          status: 'declined',
          outstanding: [],
          basketId: null,
          decisionReason: 'The courts are closed for resurfacing.',
        }),
      ),
    });
    expect(await screen.findByLabelText('Not approved')).toBeOnTheScreen();
    expect(screen.getByText('The courts are closed for resurfacing.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).toBeNull();
  });

  it('§4.10: a booking the API does not show is "not available", without implying it exists', async () => {
    renderDetail({
      'GET /bookings/{id}': {
        status: 404,
        body: apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' }),
      },
    });
    expect(await screen.findByTestId('state-unavailable')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Cancel this booking' })).toBeNull();
  });

  it('without a session it asks to sign in and reads nothing (§4.13)', async () => {
    const app = createTestApp({ session: null });
    render(<BookingDetailScreen bookingId={G.booking} />, { wrapper: app.wrapper });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeOnTheScreen();
    expect(screen.queryByText('Your session ended')).toBeNull();
    expect(app.fake.requests).toHaveLength(0);
  });

  it('a malformed booking id is "Link not available" without a request', async () => {
    const app = createTestApp();
    render(<BookingDetailScreen bookingId={null} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Link not available')).toBeOnTheScreen();
    expect(app.fake.requests).toHaveLength(0);
  });
});
