/**
 * SCR-S-47 provider events (§4.12 inbox, §4.14): `GET /v1/provider-events` newest first with the
 * API's cursor and filters, each event's status and signature check as text with a glyph, attempts
 * and last error, never a payload; empty, ACCESS_DENIED (not available) and offline states.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { page, providerEvent } from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp } from '../../../testing/test-app';

function app(routes: Record<string, FakeHandler> = {}, online = true) {
  return createTestApp({
    online,
    routes: {
      'GET /provider-events': page([
        providerEvent(1),
        providerEvent(2, {
          status: 'dead',
          signatureVerified: false,
          attempts: 5,
          lastError: 'Handler timed out',
          processedAt: null,
          eventType: 'payment.refunded',
        }),
      ]),
      ...routes,
    },
  });
}

describe('SCR-S-47 ProviderEventsScreen', () => {
  it('§4.12: lists events with status, signature check, attempts and last error, never a payload', async () => {
    render(app().at('/admin/provider-events'));
    const list = await screen.findByRole('list', { name: 'Provider events' });
    const processed = within(list).getByRole('listitem', {
      name: 'fake-payments · payment.succeeded',
    });
    expect(within(processed).getByText('processed')).toBeInTheDocument();
    expect(within(processed).getByText('signature verified')).toBeInTheDocument();
    expect(
      within(processed).getByText(
        `Provider event evt_1 · received ${formatInstant('2026-10-24T12:00:00.000Z')} · processed ${formatInstant('2026-10-24T12:00:00.000Z')} · 1 attempt`,
      ),
    ).toBeInTheDocument();
    const dead = within(list).getByRole('listitem', { name: 'fake-payments · payment.refunded' });
    expect(within(dead).getByText('dead')).toBeInTheDocument();
    expect(within(dead).getByText('signature not verified')).toBeInTheDocument();
    expect(within(dead).getByText('Last error: Handler timed out')).toBeInTheDocument();
    expect(within(dead).getByText(/Its retries are exhausted/)).toBeInTheDocument();
    expect(screen.getByText(/Their payloads are never shown here/)).toBeInTheDocument();
  });

  it('filters by provider, status and event type on request and loads more with the cursor', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /provider-events': (request) =>
        request.query.cursor
          ? fakeResponse(200, { items: [providerEvent(3)], nextCursor: null })
          : fakeResponse(200, { items: [providerEvent(1)], nextCursor: 'next' }),
    });
    render(test.at('/admin/provider-events'));
    await screen.findByRole('list', { name: 'Provider events' });
    await user.click(screen.getByRole('button', { name: 'Load more provider events' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Provider events' })).getAllByRole('listitem'),
      ).toHaveLength(2),
    );
    const form = screen.getByRole('form', { name: 'Filter provider events' });
    await user.type(within(form).getByLabelText('Provider'), 'fake-payments');
    await user.selectOptions(within(form).getByLabelText('Status'), 'failed');
    await user.type(within(form).getByLabelText('Event type'), 'payment.failed');
    await user.click(within(form).getByRole('button', { name: 'Show events' }));
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) =>
            r.route === '/provider-events' &&
            r.query.provider === 'fake-payments' &&
            r.query.status === 'failed' &&
            r.query.eventType === 'payment.failed',
        ),
      ).toBe(true),
    );
  });

  it('validates the received period before sending', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/provider-events'));
    const form = await screen.findByRole('form', { name: 'Filter provider events' });
    await user.type(within(form).getByLabelText('Received from'), '2026-10-24T10:00');
    await user.type(within(form).getByLabelText('Received before'), '2026-10-24T09:00');
    await user.click(within(form).getByRole('button', { name: 'Show events' }));
    expect(within(form).getByText('The end must be after the start.')).toBeInTheDocument();
    expect(test.fake.requests.some((r) => r.route === '/provider-events' && r.query.from)).toBe(
      false,
    );
  });

  it('says so when no event matches', async () => {
    render(app({ 'GET /provider-events': page([]) }).at('/admin/provider-events'));
    expect(await screen.findByRole('heading', { name: 'No provider events' })).toBeInTheDocument();
  });

  it('shows provider events the API refuses as not available to the viewer', async () => {
    render(
      app({
        'GET /provider-events': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You may not read provider events.' }),
          ),
      }).at('/admin/provider-events'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/You may not read provider events\./)).toBeInTheDocument();
  });

  it('shows a failed read with its code and a retry', async () => {
    render(
      app({
        'GET /provider-events': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      }).at('/admin/provider-events'),
    );
    expect(await screen.findByText(/Error code: INTERNAL_ERROR/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('offline with nothing loaded: says so instead of an empty list', async () => {
    render(app({}, false).at('/admin/provider-events'));
    expect((await screen.findAllByText('You are offline')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'No provider events' })).toBeNull();
  });
});
