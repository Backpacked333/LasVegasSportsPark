/**
 * SCR-S-02 Exception detail (SPK-UX-006, §4.9, SPK-UX-008): the lifecycle verbs the API lists, each
 * with the expected revision and one idempotency key per intent; resolve and close need a note;
 * STALE_REVISION offers Reload and keeps the note; the affected record's own state is shown and a
 * record in recovery says so; a protected NOT_FOUND is not available; offline is read-only.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { EXCEPTION_ID, PAYMENT_ID, operationalException, paymentAttempt } from './fixtures';

const PATH = `/today/exceptions/${EXCEPTION_ID}`;

function routes(overrides: Record<string, unknown> = {}) {
  return {
    'GET /exceptions/{id}': { status: 200, body: operationalException(overrides) },
    'GET /payments/{id}': { status: 200, body: paymentAttempt('unknown') },
  };
}

describe('SCR-S-02 ExceptionDetailScreen', () => {
  it('SPK-UX-006: shows severity, owner, deadline, history and the affected record’s own state', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    expect(
      await screen.findByRole('heading', { name: 'Payment outcome unknown for checkout' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Severity: critical')).toBeInTheDocument();
    expect(screen.getByText('Status: open')).toBeInTheDocument();
    const facts = screen.getByLabelText('Exception details');
    expect(within(facts).getByText('finance')).toBeInTheDocument();
    const affected = screen.getByRole('region', { name: 'Affected record' });
    expect(within(affected).getByText(PAYMENT_ID)).toBeInTheDocument();
    // The payment attempt's state comes from finance, beside the exception.
    expect(await within(affected).findByText('State: unknown')).toBeInTheDocument();
    expect(
      within(affected).getByText(/closing or resolving here does not change that/),
    ).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Resolution history' });
    expect(within(history).getByText(/exceptions.opened by system/)).toBeInTheDocument();
    expect(
      screen.getByText('Closing does not mark the affected payment, booking or delivery resolved.'),
    ).toBeInTheDocument();
  });

  it('acknowledges with the expected revision and names the resulting state', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'POST /exceptions/{id}/acknowledge': {
          status: 200,
          body: operationalException({ status: 'acknowledged', revision: 5 }),
        },
      },
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText('Exception acknowledged. State: acknowledged.'),
    ).toBeInTheDocument();
    const ack = app.fake.requests.find((r) => r.route === '/exceptions/{id}/acknowledge');
    expect(ack?.body).toEqual({ expectedRevision: 4 });
    expect(ack?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('requires a resolution note before resolving, then sends it as the reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'POST /exceptions/{id}/resolve': {
          status: 200,
          body: operationalException({ status: 'resolved', revision: 5 }),
        },
      },
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));
    expect(
      screen.getByText('Write what was done, so the resolution history explains it.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Resolution note/)).toHaveAttribute('aria-invalid', 'true');
    expect(app.fake.requests.some((r) => r.route === '/exceptions/{id}/resolve')).toBe(false);
    await user.type(screen.getByLabelText(/Resolution note/), 'Provider confirmed the payment');
    await user.click(screen.getByRole('button', { name: 'Mark resolved' }));
    expect(
      await screen.findByText('Exception marked resolved. State: resolved.'),
    ).toBeInTheDocument();
    const resolve = app.fake.requests.find((r) => r.route === '/exceptions/{id}/resolve');
    expect(resolve?.body).toEqual({
      expectedRevision: 4,
      reason: 'Provider confirmed the payment',
    });
  });

  it('reports STALE_REVISION on close with "Reload", which re-reads the exception and keeps the note', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'POST /exceptions/{id}/close': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    render(app.at(PATH));
    await user.type(await screen.findByLabelText(/Resolution note/), 'Duplicate of another');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const reads = app.fake.requests.filter((r) => r.route === '/exceptions/{id}').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/exceptions/{id}').length).toBe(
        reads + 1,
      ),
    );
    expect(screen.getByLabelText(/Resolution note/)).toHaveValue('Duplicate of another');
  });

  it('retries the same intent with the same idempotency key after a retryable failure', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        ...routes(),
        'POST /exceptions/{id}/acknowledge': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(200, operationalException({ status: 'acknowledged', revision: 5 }));
        },
      },
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText(/Error code: INTEGRATION_UNAVAILABLE/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Exception acknowledged. State: acknowledged.'),
    ).toBeInTheDocument();
    const keys = app.fake.requests
      .filter((r) => r.route === '/exceptions/{id}/acknowledge')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows ACCESS_DENIED on a command as not available to you, with the missing scope', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...routes(),
        'POST /exceptions/{id}/acknowledge': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'This exception belongs to a queue outside your scope.',
            }),
          ),
      },
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/a queue outside your scope/)).toBeInTheDocument();
  });

  it('offers no workflow buttons when the API lists none for the viewer', async () => {
    const app = createTestApp({ routes: routes({ nextActions: [] }) });
    render(app.at(PATH));
    expect(
      await screen.findByText(/Acknowledging, resolving and closing it are not available to you/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('shows a protected NOT_FOUND as not available, without any exception details', async () => {
    const app = createTestApp({
      routes: {
        'GET /exceptions/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      },
    });
    render(app.at(PATH));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(/NOT_FOUND/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('is read-only offline', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    await screen.findByRole('button', { name: 'Acknowledge' });
    act(() => app.connectivity.set(false));
    expect(
      await screen.findByText('Offline: this exception is read-only until you reconnect.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });
});
