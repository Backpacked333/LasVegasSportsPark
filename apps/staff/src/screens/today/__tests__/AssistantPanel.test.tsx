/**
 * SCR-S-50 Operational assistant (SPK-AUTO-001 to SPK-AUTO-005, SPK-AT-026): optional and closed by
 * default (Today never waits on it); a disabled assistant says so and Today keeps working; answers
 * list supporting records with freshness and keep missing evidence visible; recommendations show
 * the command they would run and are approved, rejected (with a reason) and applied as separate
 * commands with the expected revision; denials stay inside the panel.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, todayFeed } from '../../../testing/test-app';
import { assistantRequest, exceptionItem, recommendation } from './fixtures';

const DISABLED = () =>
  fakeResponse(
    503,
    apiErrorBody('INTEGRATION_UNAVAILABLE', {
      message: 'The assistant is not enabled.',
      nextAction: 'retry_later',
      details: { capability: 'automation', reason: 'disabled' },
    }),
  );

/** `GET /recommendations?status=…` answering with the given items of that status. */
function byStatus(items: ReturnType<typeof recommendation>[], nextCursor: string | null = null) {
  return (req: { query: Record<string, string> }) =>
    fakeResponse(200, {
      items: items.filter((r) => !req.query['status'] || r.status === req.query['status']),
      nextCursor,
    });
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Assistant (optional)' }));
  return screen.getByRole('region', { name: 'Operational assistant (optional)' });
}

describe('SCR-S-50 AssistantPanel', () => {
  it('SPK-AUTO-005: is closed by default and asks nothing of the API until opened', async () => {
    const app = createTestApp({ routes: { 'GET /today': todayFeed([exceptionItem()]) } });
    render(app.at('/today'));
    await screen.findByRole('list', { name: 'Open issues' });
    expect(screen.getByRole('button', { name: 'Assistant (optional)' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(app.fake.requests.some((r) => r.route?.startsWith('/recommendations'))).toBe(false);
  });

  it('SPK-AUTO-005: a disabled assistant says it is turned off and Today keeps working', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /today': todayFeed([exceptionItem()]), 'GET /recommendations': DISABLED },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    expect(await within(panel).findByText('Assistant turned off')).toBeInTheDocument();
    expect(within(panel).getByText(/product owner \(DEC-016\)/)).toBeInTheDocument();
    expect(within(panel).queryByRole('form', { name: 'Ask the assistant' })).toBeNull();
    // The rest of Today is unaffected.
    expect(screen.getByText('Payment outcome unknown for checkout')).toBeInTheDocument();
  });

  it('shows a temporary outage with its code and a retry, not as turned off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /recommendations': () =>
          fakeResponse(503, apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' })),
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    expect(
      await within(panel).findByText(/Error code: INTEGRATION_UNAVAILABLE/),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(panel).queryByText('Assistant turned off')).toBeNull();
  });

  it('SPK-AUTO-002: an answer names its records with freshness; missing evidence stays visible', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /recommendations': { status: 200, body: { items: [], nextCursor: null } },
        'POST /assistant/requests': {
          status: 201,
          body: assistantRequest({ status: 'processing', response: null, evidence: [] }),
        },
        'GET /assistant/requests/{id}': {
          status: 200,
          body: assistantRequest({
            missingEvidence: [
              {
                recordType: 'person',
                recordId: null,
                source: null,
                reason: 'not_available',
                description: 'A referenced person is not available.',
              },
            ],
          }),
        },
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const ask = await within(panel).findByRole('form', { name: 'Ask the assistant' });
    await user.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(within(panel).getByText('Write a question for the assistant.')).toBeInTheDocument();
    await user.type(within(ask).getByLabelText(/Question/), 'Summarize today');
    await user.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(
      await within(panel).findByText('Two issues are open; one payment outcome is unknown.'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/assistant/requests');
    expect(post?.body).toEqual({ prompt: 'Summarize today', attachments: [], context: [] });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
    const records = within(panel).getByRole('list', { name: 'Supporting records' });
    expect(within(records).getByText('Freshness: live')).toBeInTheDocument();
    const missing = within(panel).getByRole('region', { name: 'Missing evidence' });
    expect(within(missing).getByText('A referenced person is not available.')).toBeInTheDocument();
    expect(within(missing).getByText('Missing: not_available')).toBeInTheDocument();
  });

  it('sends the selected facility with the question', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /recommendations': { status: 200, body: { items: [], nextCursor: null } },
        'POST /assistant/requests': { status: 201, body: assistantRequest() },
      },
    });
    render(app.at('/today'));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Facility' }), FACILITY_A);
    const panel = await openPanel(user);
    const ask = await within(panel).findByRole('form', { name: 'Ask the assistant' });
    await user.type(within(ask).getByLabelText(/Question/), 'Any blockers?');
    await user.click(within(ask).getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(app.fake.requests.find((r) => r.route === '/assistant/requests')?.body).toMatchObject({
        facilityId: FACILITY_A,
      }),
    );
  });

  it('SPK-AUTO-003: a recommendation shows what applying would run and is reviewed before anything runs', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /recommendations': byStatus([recommendation()]),
        'POST /recommendations/{id}/reject': {
          status: 200,
          body: recommendation({ status: 'rejected', revision: 3 }),
        },
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const card = await within(panel).findByRole('listitem', {
      name: 'Tell U12 families about the pitch change',
    });
    expect(within(card).getByText('Status: proposed')).toBeInTheDocument();
    expect(within(card).getByText('Changes records when applied')).toBeInTheDocument();
    const command = within(card).getByLabelText('Command to apply');
    expect(within(command).getByText('communications.send')).toBeInTheDocument();
    expect(within(command).getByText('Pitch change')).toBeInTheDocument();
    // Stale evidence is flagged, missing evidence listed.
    expect(within(card).getByText('Freshness: stale')).toBeInTheDocument();
    expect(within(card).getByText('A referenced fixture is not available.')).toBeInTheDocument();
    // Nothing to apply until approved.
    expect(within(card).queryByRole('button', { name: /^Apply/ })).toBeNull();
    // Rejecting needs a reason.
    await user.click(within(card).getByRole('button', { name: /^Reject recommendation/ }));
    expect(
      within(card).getByText('Write why this recommendation is rejected.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/recommendations/{id}/reject')).toBe(false);
    await user.type(within(card).getByLabelText(/Reason for rejecting/), 'Wrong audience');
    await user.click(within(card).getByRole('button', { name: /^Reject recommendation/ }));
    expect(await within(card).findByText('Recommendation rejected.')).toBeInTheDocument();
    const reject = app.fake.requests.find((r) => r.route === '/recommendations/{id}/reject');
    expect(reject?.body).toEqual({ expectedRevision: 2, reason: 'Wrong audience' });
  });

  it('approves and then applies with the reviewer’s expected revision', async () => {
    const user = userEvent.setup();
    const approved = recommendation({ status: 'approved', revision: 3 });
    const app = createTestApp({
      routes: {
        'GET /recommendations': byStatus([recommendation()]),
        'POST /recommendations/{id}/approve': { status: 200, body: approved },
        'POST /recommendations/{id}/apply': {
          status: 200,
          body: recommendation({
            status: 'applied',
            revision: 4,
            apply: {
              ...approved.apply,
              state: 'applied',
              record: { type: 'notification', id: 'n-1' },
            },
          }),
        },
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const card = await within(panel).findByRole('listitem', {
      name: 'Tell U12 families about the pitch change',
    });
    await user.click(within(card).getByRole('button', { name: /^Approve recommendation/ }));
    expect(await within(card).findByText('Recommendation approved.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: /^Apply recommendation/ }));
    expect(await within(card).findByText('Apply applied.')).toBeInTheDocument();
    const approve = app.fake.requests.find((r) => r.route === '/recommendations/{id}/approve');
    const apply = app.fake.requests.find((r) => r.route === '/recommendations/{id}/apply');
    expect(approve?.body).toEqual({ expectedRevision: 2 });
    expect(apply?.body).toEqual({ expectedRevision: 3 });
    expect(apply?.headers['idempotency-key']).not.toBe(approve?.headers['idempotency-key']);
  });

  it('SPK-AT-026: an apply the reviewer may not run is shown as not available to them', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /recommendations': byStatus([recommendation({ status: 'approved' })]),
        'POST /recommendations/{id}/apply': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'communications.send denied' }),
          ),
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: /^Apply recommendation/ }));
    expect(await within(panel).findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('SPK-AUTO-004: an apply whose outcome is unknown is never shown as "Not applied" and cannot be applied again', async () => {
    const user = userEvent.setup();
    const unknown = recommendation({
      status: 'approved',
      apply: {
        state: 'running',
        operationId: null,
        record: null,
        lastError: {
          code: 'APPLY_OUTCOME_UNKNOWN',
          message: 'The owning module did not report an outcome; its records must be checked.',
          details: { outcome: 'unknown' },
        },
      },
    });
    const app = createTestApp({ routes: { 'GET /recommendations': byStatus([unknown]) } });
    render(app.at('/today'));
    const panel = await openPanel(user);
    expect(await within(panel).findByText('Apply outcome: unknown')).toBeInTheDocument();
    expect(within(panel).getByText(/Do not apply this again/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Not applied/)).toBeNull();
    expect(within(panel).queryByRole('button', { name: /^Apply recommendation/ })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/recommendations/{id}/apply')).toBe(false);
  });

  it('"Awaiting review" never says none while more recommendations wait beyond the page', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /recommendations': byStatus([], 'cursor-2') },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    expect(await within(panel).findByTestId('more-awaiting')).toBeInTheDocument();
    expect(within(panel).queryByText('No recommendations are waiting for review.')).toBeNull();
    const statuses = app.fake.requests
      .filter((r) => r.route === '/recommendations')
      .map((r) => r.query['status'])
      .sort();
    expect(statuses).toEqual(['approved', 'proposed']);
  });

  it('two copies of one recommendation stay current: approving one updates the other', async () => {
    const user = userEvent.setup();
    let approved = false;
    const rec = recommendation();
    const app = createTestApp({
      routes: {
        'GET /recommendations': byStatus([rec]),
        'GET /recommendations/{id}': () =>
          fakeResponse(200, approved ? recommendation({ status: 'approved', revision: 3 }) : rec),
        'POST /assistant/requests': {
          status: 201,
          body: assistantRequest({ recommendations: [rec] }),
        },
        'POST /recommendations/{id}/approve': () => {
          approved = true;
          return fakeResponse(200, recommendation({ status: 'approved', revision: 3 }));
        },
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    await user.type(await within(panel).findByLabelText(/^Question/), 'What needs review?');
    await user.click(within(panel).getByRole('button', { name: 'Ask' }));
    const answer = await within(panel).findByRole('list', { name: 'Proposals from this answer' });
    await user.click(within(answer).getByRole('button', { name: /^Approve recommendation/ }));
    const awaiting = within(panel).getByRole('list', { name: 'Recommendations awaiting review' });
    await waitFor(() => expect(within(awaiting).getByText('Status: approved')).toBeInTheDocument());
    expect(within(awaiting).queryByRole('button', { name: /^Approve recommendation/ })).toBeNull();
  });
});
