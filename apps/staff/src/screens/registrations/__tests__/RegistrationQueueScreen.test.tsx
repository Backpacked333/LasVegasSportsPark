/**
 * SCR-S-24 registration queue and approvals (SPK-REG-002, SPK-REG-003, SPK-REG-007, DEC-066):
 * the queue with age and explainable eligibility reasons, approve and decline with the expected
 * revision, a reason required for decline and override, stale and permission answers, keyset
 * paging with "Load more", the review deadline pending DEC-028 and the API's decision permissions.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  APPLICATION_ID,
  apiError,
  application,
  eligibility,
  nameRoutes,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';

/** The API's two waiting states: eligible ones await review, ineligible ones stay submitted. */
const ELIGIBLE = application({ status: 'awaiting_review', eligibility: eligibility(true) });
const byStatus =
  (awaiting: unknown[], submitted: unknown[]): FakeHandler =>
  (request) =>
    fakeResponse(200, {
      items:
        request.query.status === 'awaiting_review'
          ? awaiting
          : request.query.status === 'submitted'
            ? submitted
            : [],
      nextCursor: null,
    });
const QUEUE = byStatus([], [application()]);

async function openQueue(routes: Record<string, FakeHandler> = {}, queue: FakeHandler = QUEUE) {
  const app = createTestApp({ routes: { ...nameRoutes(), 'GET /applications': queue, ...routes } });
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
    expect(within(card).getByText('submitted')).toBeInTheDocument();
    expect(within(card).getByText('Not eligible')).toBeInTheDocument();
    // An ineligible application is not approved without an override (SPK-REG-002).
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull();
    const reasons = within(card).getByRole('list', { name: 'Eligibility: reasons' });
    expect(within(reasons).getByText('Blocking')).toBeInTheDocument();
    expect(within(reasons).getByText(/older than the age band/)).toBeInTheDocument();
    expect(within(reasons).getByText(/required action choose other offering/)).toBeInTheDocument();
    // DEC-028: no deadline is invented.
    expect(within(card).getByText(/Review deadline: pending DEC-028/)).toBeInTheDocument();
    // The default queue asks for both waiting states.
    const statuses = app.fake.requests
      .filter((r) => r.route === '/applications')
      .map((r) => r.query['status']);
    expect(statuses).toEqual(expect.arrayContaining(['awaiting_review', 'submitted']));
  });

  it('SPK-REG-007: approves with the expected revision and an idempotency key', async () => {
    const user = userEvent.setup();
    const { app, card } = await openQueue(
      { 'POST /applications/{id}/accept': ok(application({ status: 'accepted' })) },
      byStatus([ELIGIBLE], []),
    );
    const approve = within(card).getByRole('button', { name: 'Approve' });
    // SPK-UX-009: the button is described by the application it acts on.
    expect(approve).toHaveAttribute('aria-describedby', `application-${APPLICATION_ID}`);
    await user.click(approve);
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
    const { app, card } = await openQueue(
      {
        'POST /applications/{id}/accept': apiError(409, 'STALE_REVISION', {
          message: 'The record changed since it was loaded.',
          nextAction: 'reload_and_retry',
        }),
      },
      byStatus([ELIGIBLE], []),
    );
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await within(card).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const reads = app.fake.requests.filter((r) => r.route === '/applications').length;
    await user.click(within(card).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/applications').length).toBeGreaterThan(
        reads,
      ),
    );
  });

  it('says the queue is clear when nothing waits, and names a hidden participant as not available', async () => {
    const app = createTestApp({
      routes: {
        ...nameRoutes(),
        'GET /applications': (request) =>
          fakeResponse(200, {
            items:
              request.query.status === 'awaiting_review' || request.query.status === 'submitted'
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

  it('§4.5: pages the queue with the API cursor and keeps loaded applications when Load more fails', async () => {
    const user = userEvent.setup();
    const second = application({
      id: '0192f1a0-0000-7000-8000-000000000602',
      participantPersonId: '0192f1a0-0000-7000-8000-000000000302',
      submittedAt: '2026-10-24T10:00:00.000Z',
    });
    let fail = true;
    const queue: FakeHandler = (request) => {
      if (request.query.status !== 'submitted')
        return fakeResponse(200, { items: [], nextCursor: null });
      if (request.query.cursor === 'c2') {
        if (fail) {
          fail = false;
          return fakeResponse(503, {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Try later',
            correlationId: 'c',
            nextAction: 'retry_later',
          });
        }
        return fakeResponse(200, { items: [second], nextCursor: null });
      }
      return fakeResponse(200, { items: [application()], nextCursor: 'c2' });
    };
    const { app } = await openQueue({}, queue);
    await user.click(
      await screen.findByRole('button', { name: 'Load more submitted applications' }),
    );
    expect(await screen.findByText(/Error code: SERVICE_UNAVAILABLE/)).toBeInTheDocument();
    const cards = () =>
      screen.getByRole('list', { name: 'Applications' }).querySelectorAll(':scope > li');
    expect(cards()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Load more submitted applications' }));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Load more submitted applications' })).toBeNull();
    const cursors = app.fake.requests
      .filter((r) => r.route === '/applications' && r.query.status === 'submitted')
      .map((r) => r.query.cursor ?? null);
    expect(cursors).toEqual([null, 'c2', 'c2']);
  });

  it('SPK-UX-005: says which decision permissions the API lists for this principal', async () => {
    const { app } = await openQueue({
      'GET /me/permissions': mePermissions({
        actions: [
          'enrollment.review_application',
          {
            id: 'enrollment.override_eligibility',
            facilityIds: ['0192f1a0-0000-7000-8000-00000000fa01'],
          },
        ],
      }),
    });
    const line = await screen.findByLabelText('Decision permissions');
    await waitFor(() =>
      expect(line).toHaveTextContent(
        'enrollment.review_application (held in every facility); overriding eligibility needs enrollment.override_eligibility (held in some facilities)',
      ),
    );
    expect(app.fake.requests.some((r) => r.route === '/me/permissions')).toBe(true);
  });

  it('SPK-UX-005: a principal without the permissions is told so; the API still decides', async () => {
    await openQueue();
    const line = await screen.findByLabelText('Decision permissions');
    await waitFor(() =>
      expect(line).toHaveTextContent('enrollment.review_application (not held by your roles)'),
    );
  });
});
