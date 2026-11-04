/**
 * SCR-C-32 one enrollment (SPK-REG-003, SPK-REG-010, SPK-PAY-006, SPK-PLACE-002, §4.11, §4.10):
 * the record with what the API lets the customer read around it, the linked records of a transfer,
 * and the entry to the SCR-C-33 previews by record state.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  consequence,
  createRouterMock,
  enrollment,
  installmentPlan,
  offering,
  order,
} from '../../../features/money/testing/fixtures';
import { formatDay } from '../../../features/money/format';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { EnrollmentDetailScreen } from '../EnrollmentDetailScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

function routes(record: unknown, overrides: Record<string, FakeHandler> = {}) {
  return {
    ...accountRoutes(),
    'GET /enrollments/{id}': { status: 200, body: record },
    'GET /offerings/{id}': { status: 200, body: offering() },
    ...overrides,
  };
}

function renderDetail(record: unknown, overrides: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: routes(record, overrides) });
  render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-32 EnrollmentDetailScreen', () => {
  afterEach(settleApps);

  beforeEach(() => mockRouter.push.mockClear());

  it('SPK-PAY-006: a confirmed enrollment with a future installment reads "Confirmed. Next payment due <date>."', async () => {
    const plan = installmentPlan();
    renderDetail(enrollment({ orderRef: IDS.order }), {
      'GET /orders/{id}': { status: 200, body: order() },
      'GET /installment-plans/{id}': { status: 200, body: plan },
    });
    const due = formatDay(plan.installments[1]!.dueAt);
    expect(await screen.findByLabelText(`Confirmed. Next payment due ${due}.`)).toBeOnTheScreen();
    expect(screen.getByLabelText('Still to pay: $80.00')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Registration pending')).toBeNull();
  });

  it('SPK-PLACE-002: a confirmed enrollment whose placement cannot be read is never plain "Confirmed"', async () => {
    renderDetail(enrollment({ placementRequestId: '0192f1a0-0000-7000-8000-00000000fe01' }), {
      'GET /placement-requests/{id}': () =>
        fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
    });
    expect(
      await screen.findByLabelText('Confirmed. Placement status not available yet.'),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Confirmed')).toBeNull();
  });

  it('SPK-UX-008: a failed order read shows its code, not "not available to this account"', async () => {
    renderDetail(enrollment({ orderRef: IDS.order }), {
      'GET /orders/{id}': () =>
        fakeResponse(
          500,
          apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
        ),
    });
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(screen.queryByText(/not available to this account/)).toBeNull();
  });

  it('§4.11: a pending enrollment whose checkout needs recovery says the payment was received', async () => {
    renderDetail(enrollment({ status: 'pending', lastOperationId: IDS.operation }), {
      'GET /operations/{id}': {
        status: 200,
        body: {
          id: IDS.operation,
          kind: 'registration.checkout',
          status: 'recovery_required',
          correlationId: null,
          result: null,
          error: null,
          createdAt: '2026-10-24T11:00:00.000Z',
          updatedAt: '2026-10-24T11:00:00.000Z',
          completedAt: null,
        },
      },
    });
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/do not pay\s+again/)).toBeOnTheScreen();
  });

  it('R3-SCREEN-STATES-04 §4.11: a checkout in recovery behind twenty newer checkouts is found, as on the list', async () => {
    const BASKET = '0192f1a0-0000-7000-8000-00000000a501';
    const checkout = (n: number, status: string, basketId: string) => ({
      id: `0192f1a0-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`,
      basketId,
      status,
      enrollmentIds: [],
    });
    const all = [
      ...Array.from({ length: 25 }, (_, n) =>
        checkout(n, 'completed', `0192f1a0-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`),
      ),
      checkout(999, 'recovery_required', BASKET),
    ];
    renderDetail(enrollment({ status: 'pending', pendingReason: 'payment', basketId: BASKET }), {
      // Newest first with the API's `status` filter (money-reads.service myCheckouts).
      'GET /me/registration-checkouts': (req) => {
        const matching = req.query.status ? all.filter((c) => c.status === req.query.status) : all;
        return fakeResponse(200, {
          items: matching.slice(0, Number(req.query.limit ?? 50)),
          nextCursor: null,
        });
      },
    });
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
  });

  it('R3-SCREEN-STATES-04 §4.11: when page 2 of the checkouts in recovery fails, the record never says the payment is not finished', async () => {
    const BASKET = '0192f1a0-0000-7000-8000-00000000a501';
    const checkout = (n: number, basketId: string) => ({
      id: `0192f1a0-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`,
      basketId,
      status: 'recovery_required',
      enrollmentIds: [],
    });
    const recovering = [
      ...Array.from({ length: 20 }, (_, n) =>
        checkout(n, `0192f1a0-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`),
      ),
      checkout(999, BASKET),
    ];
    let secondPageFails = true;
    renderDetail(enrollment({ status: 'pending', pendingReason: 'payment', basketId: BASKET }), {
      'GET /me/registration-checkouts': (req) => {
        const start = req.query.cursor ? Number(req.query.cursor) : 0;
        if (start > 0 && secondPageFails) {
          return fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
          );
        }
        const end = start + Number(req.query.limit ?? 50);
        return fakeResponse(200, {
          items: recovering.slice(start, end),
          nextCursor: end < recovering.length ? String(end) : null,
        });
      },
    });
    const unknown = await screen.findByTestId('enrollment-recovery-unknown');
    expect(
      await within(unknown).findByText(/Error code: INTEGRATION_UNAVAILABLE/),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Registration pending: payment status not known yet'),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/payment for this registration is not finished/)).toBeNull();
    expect(screen.queryByText(/Open it from Discover/)).toBeNull();

    secondPageFails = false;
    fireEvent.press(within(unknown).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByLabelText('Payment received. We are completing your registration.'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/do not pay\s+again/)).toBeOnTheScreen();
    expect(screen.queryByTestId('enrollment-recovery-unknown')).toBeNull();
  });

  it('R3-SCREEN-STATES-04 §4.11: a failed read of the last operation is shown on the record instead of "payment not finished"', async () => {
    const OPERATION = '0192f1a0-0000-7000-8000-00000000a803';
    renderDetail(
      enrollment({ status: 'pending', pendingReason: 'payment', lastOperationId: OPERATION }),
      {
        'GET /me/registration-checkouts': { status: 200, body: { items: [], nextCursor: null } },
        'GET /operations/{id}': () =>
          fakeResponse(
            500,
            apiErrorBody('INTERNAL_ERROR', { nextAction: 'retry_or_contact_support' }),
          ),
      },
    );
    const unknown = await screen.findByTestId('enrollment-recovery-unknown');
    expect(await within(unknown).findByText(/Error code: INTERNAL_ERROR/)).toBeOnTheScreen();
    expect(within(unknown).getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    expect(screen.queryByText(/payment for this registration is not finished/)).toBeNull();
  });

  it('SPK-REG-010: a transferred enrollment links to the new one, and history is kept', async () => {
    const next = enrollment({
      id: IDS.enrollmentB,
      offeringId: IDS.offeringB,
      transferredFromEnrollmentId: IDS.enrollment,
    });
    renderDetail(
      enrollment({ status: 'transferred', transferredToEnrollmentId: IDS.enrollmentB }),
      {
        'GET /enrollments/{id}': (req) =>
          fakeResponse(
            200,
            req.params.id === IDS.enrollmentB
              ? next
              : enrollment({ status: 'transferred', transferredToEnrollmentId: IDS.enrollmentB }),
          ),
        'GET /offerings/{id}': (req) =>
          fakeResponse(
            200,
            req.params.id === IDS.offeringB
              ? offering({ id: IDS.offeringB, name: 'Sunday League' })
              : offering(),
          ),
      },
    );
    expect(await screen.findByLabelText('Transferred to Sunday League')).toBeOnTheScreen();
    expect(screen.getByText(/attendance history is kept/)).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: /^Transferred to Sunday League/ }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${IDS.enrollmentB}`);
    // A terminal record offers no change.
    expect(screen.queryByRole('button', { name: 'Review cancellation' })).toBeNull();
  });

  it('a canceled enrollment shows the money consequence the API recorded', async () => {
    renderDetail(
      enrollment({
        status: 'canceled',
        canceledAt: '2026-10-20T10:00:00.000Z',
        cancellationReason: 'Moving away',
        cancellationConsequence: consequence(),
      }),
    );
    expect(await screen.findByLabelText('Refund of $60.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason: Moving away')).toBeOnTheScreen();
    expect(screen.getByText(/cannot show their\s+progress yet/)).toBeOnTheScreen();
  });

  it('offers cancellation and transfer for a confirmed enrollment, and cancellation only while pending', async () => {
    renderDetail(enrollment());
    fireEvent.press(await screen.findByRole('button', { name: 'Review cancellation' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${IDS.enrollment}/cancel`);
    fireEvent.press(screen.getByRole('button', { name: 'Review a transfer' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/enrollments/${IDS.enrollment}/transfer`);
  });

  it('a pending enrollment can be canceled but not transferred (EnrollmentMachine)', async () => {
    renderDetail(enrollment({ status: 'pending' }));
    expect(await screen.findByLabelText('Registration pending')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Review cancellation' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Review a transfer' })).toBeNull();
  });

  it('§4.10: an enrollment this account may not see reads "Not available" with no detail', async () => {
    const app = createTestApp({
      routes: {
        ...accountRoutes(),
        'GET /enrollments/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
      },
    });
    render(<EnrollmentDetailScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Review cancellation' })).toBeNull();
  });
});
