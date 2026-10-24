/**
 * SCR-C-33 cancellation preview (SPK-REG-010, SPK-PAY-008, SPK-PAY-009, §4.9, SPK-UX-008): the
 * money consequence and everything else the preview states is shown before commitment; the
 * command carries expectedRevision, a reason and one idempotency key per intent; a changed
 * consequence is never committed unseen.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  IDS,
  accountRoutes,
  cancellationPreview,
  consequence,
  createRouterMock,
  enrollment,
} from '../../../features/money/testing/fixtures';
import {
  createMoneyTestApp as createTestApp,
  settleApps,
} from '../../../features/money/testing/money-test-app';
import { CancelEnrollmentScreen } from '../CancelEnrollmentScreen';

const mockRouter = createRouterMock();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => mockRouter,
}));

const CANCELED = enrollment({
  status: 'canceled',
  revision: 4,
  canceledAt: '2026-10-24T12:00:00.000Z',
  cancellationReason: 'Moving away',
  cancellationConsequence: consequence(),
});

function routes(overrides: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...accountRoutes(),
    'GET /enrollments/{id}': { status: 200, body: enrollment() },
    'GET /enrollments/{id}/cancellation-preview': { status: 200, body: cancellationPreview() },
    'POST /enrollments/{id}/cancel': { status: 200, body: CANCELED },
    ...overrides,
  };
}

function renderCancel(options: Parameters<typeof createTestApp>[0] = {}) {
  const app = createTestApp({ routes: routes(), ...options });
  render(<CancelEnrollmentScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
  return app;
}

const cancels = (app: ReturnType<typeof createTestApp>) =>
  app.fake.requests.filter((r) => r.method === 'POST' && r.route === '/enrollments/{id}/cancel');

async function fillAndConfirm(reason = 'Moving away') {
  fireEvent.changeText(await screen.findByLabelText('Reason for canceling'), reason);
  fireEvent.press(screen.getByRole('checkbox', { name: 'I understand: Refund of $60.00' }));
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Cancel registration' }));
  });
}

describe('SCR-C-33 CancelEnrollmentScreen', () => {
  afterEach(settleApps);

  it('SPK-REG-010: shows participation, affected dates, capacity, money and approval before anything is committed', async () => {
    const app = renderCancel();
    expect(await screen.findByLabelText('Activity: Autumn U10 League')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Participant: Sam')).toBeOnTheScreen();
    expect(screen.getByLabelText('Affected dates: Sep 5, 2026 to Nov 28, 2026')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Your place: Released, so someone else can take it'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Approval: No approval needed')).toBeOnTheScreen();
    expect(screen.getByLabelText('Refund of $60.00')).toBeOnTheScreen();
    expect(
      screen.getByText('The cancellation policy grants a refund of 50% of the price.'),
    ).toBeOnTheScreen();
    // Nothing is sent and confirm stays disabled until the consequence is acknowledged.
    expect(screen.getByRole('button', { name: 'Cancel registration' })).toBeDisabled();
    expect(cancels(app)).toHaveLength(0);
  });

  it('§4.9: confirms with expectedRevision, the reason and an idempotency key, then shows "Canceled" with the recorded consequence', async () => {
    let canceled = false;
    const app = renderCancel({
      routes: routes({
        'GET /enrollments/{id}': () => fakeResponse(200, canceled ? CANCELED : enrollment()),
        'POST /enrollments/{id}/cancel': () => {
          canceled = true;
          return fakeResponse(200, CANCELED);
        },
      }),
    });
    await fillAndConfirm();
    expect(await screen.findByLabelText('Canceled')).toBeOnTheScreen();
    // The refreshed record is canceled; the success view stays.
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.method === 'GET' && r.route === '/enrollments/{id}'),
      ).toHaveLength(2),
    );
    expect(screen.getByTestId('cancel-success')).toBeOnTheScreen();
    expect(screen.getByLabelText('Recorded money consequence: Refund of $60.00')).toBeOnTheScreen();
    const [sent] = cancels(app);
    expect(sent?.body).toEqual({ expectedRevision: 3, reason: 'Moving away' });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('validation failure: a missing reason is a field message and sends nothing', async () => {
    const app = renderCancel();
    await fillAndConfirm('   ');
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter a reason for canceling\./);
    expect(cancels(app)).toHaveLength(0);
  });

  it('stale version: if the money consequence changed at confirm time, nothing is committed and it must be acknowledged again', async () => {
    let current = cancellationPreview();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': () => fakeResponse(200, current),
      }),
    });
    render(<CancelEnrollmentScreen enrollmentId={IDS.enrollment} />, { wrapper: app.wrapper });
    fireEvent.changeText(await screen.findByLabelText('Reason for canceling'), 'Moving away');
    fireEvent.press(screen.getByRole('checkbox', { name: 'I understand: Refund of $60.00' }));
    current = cancellationPreview({ financialConsequence: consequence({ amountMinor: 3000 }) });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel registration' }));
    });
    expect(
      await screen.findByLabelText(
        'The money consequence changed since you reviewed it. Review it again.',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Refund of $30.00')).toBeOnTheScreen();
    expect(
      screen.getByRole('checkbox', { name: 'I understand: Refund of $30.00' }),
    ).not.toBeChecked();
    expect(cancels(app)).toHaveLength(0);
    // The typed reason is kept.
    expect(screen.getByLabelText('Reason for canceling')).toHaveDisplayValue('Moving away');
  });

  it('STALE_REVISION: says the record changed, offers Reload and keeps the reason', async () => {
    renderCancel({
      routes: routes({
        'POST /enrollments/{id}/cancel': () =>
          fakeResponse(
            409,
            apiErrorBody('STALE_REVISION', {
              message: 'The record changed since it was loaded.',
              nextAction: 'reload_and_retry',
            }),
          ),
      }),
    });
    await fillAndConfirm();
    expect(await screen.findByLabelText('This changed since you opened it')).toBeOnTheScreen();
    expect(screen.getByText(/Error code: STALE_REVISION/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Reason for canceling')).toHaveDisplayValue('Moving away');
  });

  it('§4.9: with no answer, "Check again" repeats the same intent with the same idempotency key', async () => {
    let attempts = 0;
    const app = renderCancel({
      routes: routes({
        'POST /enrollments/{id}/cancel': () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError('Network request failed');
          return fakeResponse(200, CANCELED);
        },
      }),
    });
    await fillAndConfirm();
    expect(await screen.findByLabelText('No answer yet')).toBeOnTheScreen();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByLabelText('Canceled')).toBeOnTheScreen();
    const keys = cancels(app).map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a cancellation the API does not permit has no confirm button', async () => {
    renderCancel({
      routes: routes({
        'GET /enrollments/{id}': { status: 200, body: enrollment({ status: 'completed' }) },
        'GET /enrollments/{id}/cancellation-preview': {
          status: 200,
          body: cancellationPreview({ status: 'completed', permitted: false }),
        },
      }),
    });
    expect(await screen.findByLabelText('Cannot be canceled')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Cancel registration' })).toBeNull();
  });

  it('review_required: says the facility decides any refund or credit, with the API explanation', async () => {
    renderCancel({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': {
          status: 200,
          body: cancellationPreview({
            financialConsequence: consequence({
              kind: 'review_required',
              amountMinor: null,
              explanation:
                'The cancellation policy states no refund or credit share; finance reviews it.',
            }),
          }),
        },
      }),
    });
    expect(
      await screen.findByLabelText('Any refund or credit is decided by the facility after review'),
    ).toBeOnTheScreen();
    expect(screen.getByText(/finance reviews it\./)).toBeOnTheScreen();
  });

  it('permission restriction: ACCESS_DENIED on the preview reads "Not available"', async () => {
    renderCancel({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': () =>
          fakeResponse(403, apiErrorBody('PARTICIPANT_AUTHORITY_REQUIRED')),
      }),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Cancel registration' })).toBeNull();
  });

  it('offline: confirm is disabled and says it needs a connection', async () => {
    const app = renderCancel();
    fireEvent.changeText(await screen.findByLabelText('Reason for canceling'), 'Moving away');
    fireEvent.press(screen.getByRole('checkbox', { name: 'I understand: Refund of $60.00' }));
    act(() => app.sources.setReachable(false));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel registration' })).toBeDisabled(),
    );
    expect(screen.getByText('Needs a connection.')).toBeOnTheScreen();
  });
});
