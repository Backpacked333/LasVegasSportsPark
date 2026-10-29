/**
 * SCR-S-50 Operational assistant (SPK-AUTO-001 to SPK-AUTO-005, SPK-AT-026): optional and closed by
 * default (Today never waits on it); a disabled assistant says so and Today keeps working; answers
 * list supporting records with freshness and keep missing evidence visible; recommendations show
 * the command they would run and are approved, rejected (with a reason) and applied as separate
 * commands with the expected revision; denials stay inside the panel.
 */
import { apiErrorBody, capabilityDisabledBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, mePermissions, todayFeed } from '../../../testing/test-app';
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

/** The organization has turned the assistant on (AUT-02, DEC-016); every switch starts off. */
const ASSISTANT_ON = { 'GET /me/permissions': mePermissions({ enabled: ['assistant'] }) };

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Assistant (optional)' }));
  return screen.getByRole('region', { name: 'Operational assistant (optional)' });
}

const APPLY_OPERATION = '0192f1a0-0000-7000-8000-0000000000b7';

/** An approved recommendation whose apply has no known outcome (its operation recovery_required). */
function unknownApply(overrides: Record<string, unknown> = {}) {
  const base = recommendation();
  return recommendation({
    status: 'approved',
    revision: 5,
    apply: {
      ...base.apply,
      state: 'running',
      operationId: APPLY_OPERATION,
      lastError: {
        code: 'APPLY_OUTCOME_UNKNOWN',
        message: 'The owning module did not report an outcome; its records must be checked.',
        details: { outcome: 'unknown', operationId: APPLY_OPERATION },
      },
    },
    ...overrides,
  });
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
        ...ASSISTANT_ON,
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
        ...ASSISTANT_ON,
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
        ...ASSISTANT_ON,
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
        ...ASSISTANT_ON,
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
    const unknown = unknownApply();
    const app = createTestApp({
      routes: { ...ASSISTANT_ON, 'GET /recommendations': byStatus([unknown]) },
    });
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
        ...ASSISTANT_ON,
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

  it('DEC-016: with the organization’s assistant switch off, existing recommendations stay listed and only rejecting is offered', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /recommendations': byStatus([recommendation()]) },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const off = await within(panel).findByTestId('assistant-capability-off');
    expect(within(off).getByText('Assistant turned off')).toBeInTheDocument();
    expect(within(off).getByText(/DEC-016/)).toBeInTheDocument();
    expect(within(off).getByText(/can still be rejected/)).toBeInTheDocument();
    expect(within(panel).queryByRole('form', { name: 'Ask the assistant' })).toBeNull();
    const card = await within(panel).findByRole('listitem', {
      name: 'Tell U12 families about the pitch change',
    });
    expect(within(card).queryByRole('button', { name: /^Approve recommendation/ })).toBeNull();
    expect(within(card).getByRole('button', { name: /^Reject recommendation/ })).toBeEnabled();
    expect(within(card).getByText(/Approving and applying are turned off/)).toBeInTheDocument();
  });

  it('DEC-016: an approval answered CAPABILITY_DISABLED shows the turned-off state, not a failure', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        ...ASSISTANT_ON,
        'GET /recommendations': byStatus([recommendation()]),
        'POST /recommendations/{id}/approve': () =>
          fakeResponse(403, capabilityDisabledBody('assistant')),
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: /^Approve recommendation/ }));
    const card = within(panel).getByRole('listitem', {
      name: 'Tell U12 families about the pitch change',
    });
    expect(await within(card).findByText('Assistant turned off')).toBeInTheDocument();
    expect(
      within(card).getByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/),
    ).toBeInTheDocument();
    expect(within(card).queryByText('Not available to you')).toBeNull();
  });

  it('AUT-03: a settler records the reconciled outcome of an unknown apply with evidence, a reason and the expected revision', async () => {
    const user = userEvent.setup();
    const settled = recommendation({
      status: 'applied',
      revision: 6,
      apply: {
        ...recommendation().apply,
        state: 'applied',
        settlements: [
          {
            id: '0192f1a0-0000-7000-8000-0000000000b8',
            applyOperationId: APPLY_OPERATION,
            outcome: 'applied',
            evidence: 'Notification n-7 sent',
            reason: 'Delivery log checked',
            policyReferences: [],
            settledBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Staff GM' },
            settledAt: '2026-10-24T12:00:00.000Z',
            auditRecordId: '0192f1a0-0000-7000-8000-0000000000ba',
          },
        ],
      },
    });
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['automation.settle_apply'] }),
        'GET /recommendations': byStatus([unknownApply()]),
        'POST /recommendations/{id}/settle-apply': { status: 200, body: settled },
      },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const form = await within(panel).findByRole('form', {
      name: 'Record the reconciled outcome: Tell U12 families about the pitch change',
    });
    await user.click(within(form).getByRole('button', { name: 'Record outcome' }));
    expect(
      within(form).getByText('Choose what the owning module’s records show.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/recommendations/{id}/settle-apply')).toBe(
      false,
    );
    await user.click(within(form).getByLabelText(/^applied: /));
    await user.type(within(form).getByLabelText(/^Evidence/), 'Notification n-7 sent');
    await user.type(within(form).getByLabelText(/^Reason/), 'Delivery log checked');
    await user.click(within(form).getByRole('button', { name: 'Record outcome' }));
    expect(
      await within(panel).findByText('Outcome recorded. Recommendation applied; apply applied.'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/recommendations/{id}/settle-apply');
    expect(post?.body).toEqual({
      expectedRevision: 5,
      outcome: 'applied',
      evidence: 'Notification n-7 sent',
      reason: 'Delivery log checked',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('AUT-03: STALE_REVISION on a settlement offers Reload; without the role no settlement is offered', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['automation.settle_apply'] }),
        'GET /recommendations': byStatus([unknownApply()]),
        'POST /recommendations/{id}/settle-apply': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    const { unmount } = render(app.at('/today'));
    const panel = await openPanel(user);
    const form = await within(panel).findByRole('form', { name: /^Record the reconciled outcome/ });
    await user.click(within(form).getByLabelText(/^not_applied: /));
    await user.type(within(form).getByLabelText(/^Evidence/), 'Refund r-1 failed');
    await user.type(within(form).getByLabelText(/^Reason/), 'Provider report');
    await user.click(within(form).getByRole('button', { name: 'Record outcome' }));
    expect(await within(form).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // The typed evidence stays for the next attempt.
    expect(within(form).getByLabelText(/^Evidence/)).toHaveValue('Refund r-1 failed');
    unmount();

    const other = createTestApp({
      routes: { 'GET /recommendations': byStatus([unknownApply()]) },
    });
    render(other.at('/today'));
    const otherPanel = await openPanel(user);
    expect(await within(otherPanel).findByText('Apply outcome: unknown')).toBeInTheDocument();
    expect(
      within(otherPanel).queryByRole('form', { name: /^Record the reconciled outcome/ }),
    ).toBeNull();
  });

  it('AUT-03: recorded settlements are listed with their evidence and who recorded them', async () => {
    const user = userEvent.setup();
    const released = recommendation({
      status: 'approved',
      revision: 7,
      apply: {
        ...recommendation().apply,
        lastError: {
          code: 'APPLY_SETTLED_NOT_APPLIED',
          message:
            'Reconciled: the command did not take effect. The recommendation may be applied again.',
          details: { outcome: 'not_applied' },
        },
        settlements: [
          {
            id: '0192f1a0-0000-7000-8000-0000000000bb',
            applyOperationId: APPLY_OPERATION,
            outcome: 'not_applied',
            evidence: 'No notification was sent',
            reason: 'Delivery log empty',
            policyReferences: [],
            settledBy: { kind: 'staff', accountId: null, personId: null, actorLabel: 'Staff GM' },
            settledAt: '2026-10-24T11:00:00.000Z',
            auditRecordId: '0192f1a0-0000-7000-8000-0000000000bc',
          },
        ],
      },
    });
    const app = createTestApp({
      routes: { ...ASSISTANT_ON, 'GET /recommendations': byStatus([released]) },
    });
    render(app.at('/today'));
    const panel = await openPanel(user);
    const settlements = await within(panel).findByRole('region', { name: 'Reconciled outcomes' });
    expect(within(settlements).getByText('Outcome: not_applied')).toBeInTheDocument();
    expect(within(settlements).getByText('Evidence: No notification was sent')).toBeInTheDocument();
    expect(within(settlements).getByText(/Staff GM at/)).toBeInTheDocument();
    // Released: it may be applied again, and the outcome is never shown as unknown.
    expect(within(panel).queryByText('Apply outcome: unknown')).toBeNull();
    expect(within(panel).getByRole('button', { name: /^Apply recommendation/ })).toBeEnabled();
  });
});
