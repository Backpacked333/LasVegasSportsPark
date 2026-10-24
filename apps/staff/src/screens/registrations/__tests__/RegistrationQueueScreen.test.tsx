/**
 * SCR-S-24 registration queue and approvals (SPK-REG-002, SPK-REG-003, SPK-REG-007, DEC-066):
 * the queue with age and explainable eligibility reasons, approve and decline with the expected
 * revision, a reason required for decline and override, stale and permission answers.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  APPLICATION_ID,
  apiError,
  application,
  nameRoutes,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';

const QUEUE = ok({ items: [application()], nextCursor: null });

async function openQueue(routes: Record<string, FakeHandler> = {}) {
  const app = createTestApp({ routes: { ...nameRoutes(), 'GET /applications': QUEUE, ...routes } });
  render(app.at('/registrations/queue'));
  const list = await screen.findByRole('list', { name: 'Applications' });
  const card = within(list).getAllByRole('listitem')[0]!;
  return { app, card };
}

describe('SCR-S-24 RegistrationQueueScreen', () => {
  it('SPK-REG-002: lists applications awaiting review with their age, participant and eligibility reasons', async () => {
    const { app, card } = await openQueue();
    expect(await within(card).findByText('Alex Rivera')).toBeInTheDocument();
    expect(await within(card).findByText('Spring academy U10')).toBeInTheDocument();
    expect(within(card).getByText(/submitted 3 hours ago by Sam Rivera/)).toBeInTheDocument();
    expect(within(card).getByText('awaiting_review')).toBeInTheDocument();
    expect(within(card).getByText('Not eligible')).toBeInTheDocument();
    const reasons = within(card).getByRole('list', { name: 'Eligibility: reasons' });
    expect(within(reasons).getByText('Blocking')).toBeInTheDocument();
    expect(within(reasons).getByText(/older than the age band/)).toBeInTheDocument();
    expect(within(reasons).getByText(/required action choose other offering/)).toBeInTheDocument();
    expect(
      within(card).getByText(/Review deadline and resolver: not available/),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/applications')?.query).toMatchObject({
      status: 'awaiting_review',
    });
  });

  it('SPK-REG-007: approves with the expected revision and an idempotency key', async () => {
    const user = userEvent.setup();
    const { app, card } = await openQueue({
      'POST /applications/{id}/accept': ok(application({ status: 'accepted' })),
    });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Application now accepted.')).toBeInTheDocument();
    const accept = app.fake.requests.find((r) => r.route === '/applications/{id}/accept');
    expect(accept?.params).toEqual({ id: APPLICATION_ID });
    expect(accept?.body).toEqual({ expectedRevision: 3 });
    expect(accept?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('requires a reason to decline, then sends it', async () => {
    const user = userEvent.setup();
    const { app, card } = await openQueue({
      'POST /applications/{id}/decline': ok(
        application({ status: 'declined', decisionReason: 'Group full' }),
      ),
    });
    await user.click(within(card).getByRole('button', { name: 'Decline…' }));
    const form = within(card).getByRole('form', { name: 'Decline the application' });
    await user.click(within(form).getByRole('button', { name: 'Decline the application' }));
    expect(within(form).getByText(/A reason is required/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/applications/{id}/decline')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason for declining/), 'Group full');
    await user.click(within(form).getByRole('button', { name: 'Decline the application' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/applications/{id}/decline')?.body).toEqual(
        {
          expectedRevision: 3,
          reason: 'Group full',
        },
      ),
    );
  });

  it('DEC-066: an override names the pending authority decision and shows ACCESS_DENIED as not available', async () => {
    const user = userEvent.setup();
    const { card } = await openQueue({
      'POST /applications/{id}/override-eligibility': apiError(403, 'ACCESS_DENIED', {
        nextAction: 'contact_support_or_request_access',
        details: { action: 'enrollment.override_eligibility' },
      }),
    });
    await user.click(within(card).getByRole('button', { name: 'Override eligibility…' }));
    expect(within(card).getByText(/pending DEC-066/)).toBeInTheDocument();
    await user.type(
      within(card).getByLabelText(/^Reason for the override/),
      'Birthday is one day late',
    );
    await user.click(within(card).getByRole('button', { name: 'Override eligibility' }));
    expect(await within(card).findByText('Not available to you')).toBeInTheDocument();
    expect(within(card).getByText(/enrollment\.override_eligibility/)).toBeInTheDocument();
  });

  it('reports a withdrawn application as a stale version and reloads the queue', async () => {
    const user = userEvent.setup();
    const { app, card } = await openQueue({
      'POST /applications/{id}/accept': apiError(409, 'STALE_REVISION', {
        message: 'The record changed since it was loaded.',
        nextAction: 'reload_and_retry',
      }),
    });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/applications')).toHaveLength(2),
    );
  });

  it('says the queue is clear when nothing waits, and names a hidden participant as not available', async () => {
    const app = createTestApp({
      routes: {
        ...nameRoutes(),
        'GET /applications': (request) =>
          fakeResponse(200, {
            items:
              request.query.status === 'awaiting_review'
                ? []
                : [
                    application({
                      status: 'accepted',
                      participantPersonId: '0192f1a0-0000-7000-8000-0000000003ff',
                    }),
                  ],
            nextCursor: null,
          }),
      },
    });
    const user = userEvent.setup();
    render(app.at('/registrations/queue'));
    expect(await screen.findByRole('heading', { name: 'Queue clear' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Applications'), 'accepted');
    expect(await screen.findByText('Participant not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
