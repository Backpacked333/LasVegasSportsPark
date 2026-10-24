/**
 * SCR-C-25 a player's own contribution (SPK-PAY-004, SPK-PAY-007, SPK-CAP-002, SPK-AT-022): the
 * own line with team totals only, paying from a development payment method (release builds show
 * DEC-019 pending), processing and unknown outcomes that never offer paying again, and the
 * not-available state for another person's request.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import {
  IDS,
  contributionRequest,
  obligation,
  paymentAttempt,
} from '../../../features/teams/testing/fixtures';
import { createTeamsTestApp } from '../../../features/teams/testing/teams-test-app';
import { ContributionScreen } from '../ContributionScreen';

const outcome = (status: string, overrides = {}) => ({
  payment: paymentAttempt({ status: status as never }),
  receipt: null,
  obligation: obligation(),
  overpaymentCreditId: null,
  ...overrides,
});

function renderContribution(routes: Record<string, unknown> = {}) {
  const app = createTeamsTestApp({
    routes: {
      'GET /contribution-requests/{id}': { status: 200, body: contributionRequest() },
      ...(routes as Record<string, never>),
    },
  });
  render(<ContributionScreen requestId={IDS.contribution} />, { wrapper: app.wrapper });
  return app;
}

describe('SCR-C-25 ContributionScreen', () => {
  it('SPK-CAP-002: shows the player’s own amount and the team totals, never other players’ payments', async () => {
    renderContribution();
    expect(await screen.findByLabelText('Your amount: $75.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Requested')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('From your captain: Your share of the Fall team fee.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText(
        'Team total $900.00, received $300.00, allocated $300.00, remaining $600.00',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Pat Player')).toBeNull();
  });

  it('pays with a development payment method and shows "Paid"', async () => {
    const app = renderContribution({
      'POST /contribution-requests/{id}/pay': { status: 201, body: outcome('succeeded') },
    });
    fireEvent.press(await screen.findByRole('radio', { name: 'Development payment: succeeds' }));
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Pay $75.00' }));
    });
    expect(await screen.findByLabelText('Paid')).toBeOnTheScreen();
    expect(app.bodiesOf('POST', '/contribution-requests/{id}/pay')).toEqual([
      { paymentMethodToken: 'pm_fake_visa' },
    ]);
    expect(app.keysOf('POST', '/contribution-requests/{id}/pay')[0]).toMatch(/^key-/);
    await app.settle();
  });

  it('SPK-PAY-007: "Payment processing" is re-read, and paying is not offered again', async () => {
    const app = renderContribution({
      'POST /contribution-requests/{id}/pay': { status: 201, body: outcome('processing') },
      'GET /payments/{id}': { status: 200, body: paymentAttempt({ status: 'processing' }) },
    });
    fireEvent.press(
      await screen.findByRole('radio', { name: 'Development payment: processing, outcome later' }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Pay $75.00' }));
    });
    expect(await screen.findByLabelText('Payment processing')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Pay $75.00' })).toBeNull();
    app.fake.set('GET /payments/{id}', {
      status: 200,
      body: paymentAttempt({ status: 'succeeded' }),
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByLabelText('Paid')).toBeOnTheScreen();
    await app.settle();
  });

  it('SPK-PAY-007: an unknown outcome says not to pay again and hides the payment form', async () => {
    renderContribution({
      'POST /contribution-requests/{id}/pay': () =>
        fakeResponse(
          409,
          apiErrorBody('PAYMENT_OUTCOME_UNKNOWN', {
            message: 'The payment outcome is not known yet.',
            nextAction: 'await_reconciliation',
          }),
        ),
    });
    fireEvent.press(
      await screen.findByRole('radio', {
        name: 'Development payment: times out after the money was taken',
      }),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Pay $75.00' }));
    });
    expect(
      await screen.findByText('Do not pay again. The outcome is being confirmed.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('No answer yet: this may already have been recorded'),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Pay $75.00' })).toBeNull();
  });

  it('§4.10: another person’s contribution request is not available', async () => {
    renderContribution({
      'GET /contribution-requests/{id}': () =>
        fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
    });
    expect(await screen.findByLabelText('Not available')).toBeOnTheScreen();
    expect(screen.queryByText(/NOT_FOUND|\$75/)).toBeNull();
  });

  it('a paid contribution offers no payment', async () => {
    renderContribution({
      'GET /contribution-requests/{id}': {
        status: 200,
        body: contributionRequest({ status: 'paid', paidAt: '2026-10-23T12:00:00.000Z' }),
      },
    });
    expect(await screen.findByLabelText('Paid on Oct 23, 2026')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
  });
});
