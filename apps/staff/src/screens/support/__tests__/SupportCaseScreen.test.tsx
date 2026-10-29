/**
 * SCR-S-49 Support cases (SPK-SUPPORT-001, SPK-SUPPORT-002, SPK-SUPPORT-003): the queue with
 * filters and paging; opening a case needs a category; the case shows owner, category, related
 * records with their own state, history and actions; status changes are exactly the API's
 * `allowedEvents` with the expected revision; a note is history only; STALE_REVISION offers
 * Reload; an unknown action outcome says not to repeat it; a case the viewer may not see is not
 * available. Stage 3: the queue filters by origin (the customer's own requests) and marks customer
 * requests; the subject is named (and a merged subject links to its surviving record); ending a
 * case while related records or operations recover needs an acknowledgment with a reason, sent as
 * `acknowledgeOpenRecovery` (the API refuses RELATED_RECORD_IN_RECOVERY otherwise, listing the
 * operations); the case's audit history is offered to roles that may read the audit log.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, mePermissions, staffMe } from '../../../testing/test-app';
import { CHECKOUT_ID, EXCEPTION_ID, operationalException } from '../../today/__tests__/fixtures';

const CASE_ID = '0192f1a0-0000-7000-8000-000000000c01';
const SUBJECT_ID = '0192f1a0-0000-7000-8000-000000000101';
const SURVIVOR_ID = '0192f1a0-0000-7000-8000-000000000109';
const OPERATION_ID = '0192f1a0-0000-7000-8000-000000000c0f';
const ACTOR = { kind: 'staff', accountId: null, personId: null, actorLabel: 'Support Sam' };

function names(...people: [string, string, string][]) {
  return {
    status: 200,
    body: {
      items: people.map(([personId, givenName, familyName]) => ({
        personId,
        canonicalPersonId: personId,
        givenName,
        familyName,
        displayName: `${givenName} ${familyName}`,
        kind: 'adult',
      })),
    },
  };
}

function supportCase(overrides: Record<string, unknown> = {}) {
  return {
    id: CASE_ID,
    facilityId: FACILITY_A,
    category: 'payment',
    priority: 'high',
    status: 'open',
    title: 'Charged but not registered',
    description: 'Customer says the card was charged.',
    subject: { personId: SUBJECT_ID, householdId: null, canonicalPersonId: SUBJECT_ID },
    owner: { personId: null, queue: 'support_operator' },
    relatedRecords: [{ type: 'checkout', id: CHECKOUT_ID }],
    origin: { type: 'operational_exception', id: EXCEPTION_ID },
    dueAt: '2026-10-24T18:00:00.000Z',
    overdue: false,
    resolution: null,
    resolvedAt: null,
    closedAt: null,
    openedBy: ACTOR,
    openedVia: 'staff',
    allowedEvents: ['wait_customer', 'wait_internal', 'resolve', 'close'],
    revision: 3,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T11:00:00.000Z',
    events: [
      {
        id: 'ev-1',
        sequence: 1,
        kind: 'status',
        body: null,
        fromStatus: null,
        toStatus: 'open',
        caseActionId: null,
        details: {},
        actor: ACTOR,
        occurredAt: '2026-10-24T10:00:00.000Z',
      },
      {
        id: 'ev-2',
        sequence: 2,
        kind: 'note',
        body: 'Called the customer back',
        fromStatus: null,
        toStatus: null,
        caseActionId: null,
        details: {},
        actor: ACTOR,
        occurredAt: '2026-10-24T10:30:00.000Z',
      },
    ],
    actions: [
      {
        id: 'act-1',
        caseId: CASE_ID,
        actionId: 'finance.refund',
        via: 'helper',
        status: 'unknown',
        commandOperationId: null,
        auditRecordId: null,
        supportOperationId: null,
        record: null,
        input: {},
        error: null,
        note: null,
        actor: ACTOR,
        requestedAt: '2026-10-24T10:45:00.000Z',
        completedAt: null,
        revision: 1,
      },
    ],
    ...overrides,
  };
}

function detailRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /cases/{id}': { status: 200, body: supportCase() },
    'GET /exceptions/{id}': { status: 200, body: operationalException() },
    'GET /registration-checkouts/{id}': {
      status: 200,
      body: { id: CHECKOUT_ID, status: 'recovery_required' },
    },
    'GET /person-names': names(
      [SUBJECT_ID, 'Alex', 'Rivera'],
      [SURVIVOR_ID, 'Alexandra', 'Rivera'],
    ),
    ...extra,
  };
}

describe('SCR-S-49 SupportCasesScreen', () => {
  it('lists cases with owner, category, priority and status as text, filtered by the API', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /cases': { status: 200, body: { items: [supportCase()], nextCursor: null } },
      },
    });
    render(app.at('/admin/cases'));
    const list = await screen.findByRole('list', { name: 'Support cases' });
    const row = within(list)
      .getByRole('link', { name: 'Charged but not registered' })
      .closest('li');
    expect(within(row as HTMLElement).getByText('Status: open')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Priority: high')).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText(/payment · owner support_operator/),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), 'waiting_customer');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/cases' && r.query['status'] === 'waiting_customer',
        ),
      ).toBe(true),
    );
  });

  it('SPK-SUPPORT-002: filters customer-originated requests through the API and marks them', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /cases': {
          status: 200,
          body: { items: [supportCase({ openedVia: 'customer', origin: null })], nextCursor: null },
        },
      },
    });
    render(app.at('/admin/cases'));
    const list = await screen.findByRole('list', { name: 'Support cases' });
    expect(within(list).getByText('Customer request')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Origin'), 'customer');
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/cases' && r.query['origin'] === 'customer'),
      ).toBe(true),
    );
  });

  it('filters "assigned to me" with the viewer’s person id from GET /me', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /cases': { status: 200, body: { items: [], nextCursor: null } } },
    });
    render(app.at('/admin/cases'));
    await screen.findByText(/No cases match/);
    await user.click(screen.getByLabelText('Assigned to me'));
    const personId = staffMe().body.principal.personId;
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.route === '/cases' && r.query['ownerPersonId'] === personId,
        ),
      ).toBe(true),
    );
  });

  it('pages with the API cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /cases': (req) =>
          fakeResponse(200, {
            items: [
              supportCase(
                req.query['cursor'] === 'n-2'
                  ? { id: '0192f1a0-0000-7000-8000-000000000c02', title: 'Second page case' }
                  : {},
              ),
            ],
            nextCursor: req.query['cursor'] === 'n-2' ? null : 'n-2',
          }),
      },
    });
    render(app.at('/admin/cases'));
    await user.click(await screen.findByRole('button', { name: 'Show more cases' }));
    const more = await screen.findByRole('list', { name: 'More support cases' });
    expect(within(more).getByText('Second page case')).toBeInTheDocument();
  });

  it('shows ACCESS_DENIED as not available', async () => {
    const app = createTestApp({
      routes: { 'GET /cases': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')) },
    });
    render(app.at('/admin/cases'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
  });

  it('is reachable from the Administration area', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /cases': { status: 200, body: { items: [], nextCursor: null } } },
    });
    render(app.at('/admin'));
    await user.click(await screen.findByRole('link', { name: 'Support cases' }));
    expect(await screen.findByRole('heading', { name: 'Support cases' })).toBeInTheDocument();
  });
});

describe('SCR-S-49 OpenCaseScreen', () => {
  it('requires a category and opens the case for the subject from the person record', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')),
        'POST /cases': { status: 201, body: supportCase() },
        ...detailRoutes(),
      },
    });
    render(app.at(`/admin/cases/new?subject=${SUBJECT_ID}`));
    const form = await screen.findByRole('form', { name: 'Open a support case' });
    await user.type(within(form).getByLabelText(/^Title/), 'Charged but not registered');
    await user.click(within(form).getByRole('button', { name: 'Open case' }));
    expect(within(form).getByText('Choose a category.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/cases' && r.method === 'POST')).toBe(false);
    await user.selectOptions(within(form).getByLabelText(/^Category/), 'payment');
    await user.click(within(form).getByRole('button', { name: 'Open case' }));
    expect(
      await screen.findByRole('heading', { name: 'Charged but not registered' }),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/cases' && r.method === 'POST');
    expect(post?.body).toEqual({
      category: 'payment',
      priority: 'normal',
      title: 'Charged but not registered',
      subjectPersonId: SUBJECT_ID,
      relatedRecords: [],
    });
  });
});

describe('SCR-S-49 SupportCaseScreen', () => {
  it('SPK-SUPPORT-002: shows owner, category, related records with their own state, history and actions', async () => {
    const app = createTestApp({ routes: detailRoutes() });
    render(app.at(`/admin/cases/${CASE_ID}`));
    expect(
      await screen.findByRole('heading', { name: 'Charged but not registered' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Status: open')).toBeInTheDocument();
    const facts = screen.getByLabelText('Case');
    expect(within(facts).getByText('support_operator')).toBeInTheDocument();
    expect(await within(facts).findByRole('link', { name: 'Alex Rivera' })).toHaveAttribute(
      'href',
      `/people/${SUBJECT_ID}`,
    );
    expect(within(facts).getByText('staff')).toBeInTheDocument();
    // The related checkout is in recovery: shown beside the case.
    const related = screen.getByRole('list', { name: 'Related records' });
    expect(await within(related).findByText('State: recovery_required')).toBeInTheDocument();
    // The origin exception and its own status.
    expect(await screen.findByText('Exception status: open')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Case history' });
    expect(within(history).getByText('Called the customer back')).toBeInTheDocument();
    const actions = screen.getByRole('list', { name: 'Linked actions' });
    expect(within(actions).getByText('Action: unknown')).toBeInTheDocument();
    expect(within(actions).getByText(/Do not repeat this action/)).toBeInTheDocument();
  });

  it('offers exactly the allowed events; resolving needs a resolution and sends the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'GET /exceptions/{id}': { status: 200, body: operationalException({ status: 'resolved' }) },
        'GET /registration-checkouts/{id}': {
          status: 200,
          body: { id: CHECKOUT_ID, status: 'completed' },
        },
        'POST /cases/{id}/transition': {
          status: 200,
          body: supportCase({
            status: 'resolved',
            revision: 4,
            allowedEvents: ['reopen', 'close'],
          }),
        },
      }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Status' });
    expect(within(panel).queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(
      within(panel).getByRole('button', { name: 'Wait for the customer' }),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Resolve' }));
    expect(within(panel).getByText('Choose how the case was resolved.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/cases/{id}/transition')).toBe(false);
    await user.selectOptions(within(panel).getByLabelText(/^Resolution$/), 'information_provided');
    await user.type(within(panel).getByLabelText(/Resolution summary/), 'Explained the hold');
    await user.click(within(panel).getByRole('button', { name: 'Resolve' }));
    expect(await within(panel).findByText('Case updated. State: resolved.')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/cases/{id}/transition');
    expect(post?.body).toEqual({
      event: 'resolve',
      expectedRevision: 3,
      resolution: { kind: 'information_provided', summary: 'Explained the hold' },
    });
  });

  it('SCR-S-49 recovery state: a related record in recovery is named beside Resolve and Close, and ending the case needs an acknowledgment', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /cases/{id}/transition': {
          status: 200,
          body: supportCase({ status: 'closed', revision: 4, allowedEvents: [] }),
        },
      }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Status' });
    const notice = await within(panel).findByRole('list', { name: 'Records still in recovery' });
    expect(within(notice).getByText(/Checkout .*: state recovery_required/)).toBeInTheDocument();
    expect(within(notice).getByText(/Origin exception .*: state open/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(
      within(panel).getByText(
        'Confirm that the case may end while its related records are still in recovery.',
      ),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/cases/{id}/transition')).toBe(false);
    await user.click(
      within(panel).getByLabelText(/I understand these records are still in recovery/),
    );
    // The acknowledgment needs a reason, recorded on the audit record.
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(
      within(panel).getByText('Write why the case may end while these records recover.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/cases/{id}/transition')).toBe(false);
    await user.type(
      within(panel).getByLabelText(/Why the case may end now/),
      'Finance owns the recovery',
    );
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(await within(panel).findByText('Case updated. State: closed.')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/cases/{id}/transition');
    expect(post?.body).toEqual({
      event: 'close',
      expectedRevision: 3,
      acknowledgeOpenRecovery: true,
      reason: `Finance owns the recovery. Still in recovery: checkout ${CHECKOUT_ID} (recovery_required), operational_exception ${EXCEPTION_ID} (open)`,
    });
  });

  it('SUP-04: an ending the API refuses with RELATED_RECORD_IN_RECOVERY lists its operations and is sent again only with an acknowledgment', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: {
        'GET /cases/{id}': {
          status: 200,
          body: supportCase({ relatedRecords: [], origin: null }),
        },
        'GET /person-names': names([SUBJECT_ID, 'Alex', 'Rivera']),
        'POST /cases/{id}/transition': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                409,
                apiErrorBody('RESOURCE_CONFLICT', {
                  message: 'A record related to this case is still in recovery.',
                  details: {
                    code: 'RELATED_RECORD_IN_RECOVERY',
                    operations: [
                      {
                        operationId: OPERATION_ID,
                        kind: 'finance.refund',
                        status: 'recovery_required',
                      },
                    ],
                  },
                }),
              )
            : fakeResponse(200, supportCase({ status: 'closed', revision: 4, allowedEvents: [] }));
        },
      },
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Status' });
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(await within(panel).findByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
    const notice = await within(panel).findByRole('list', { name: 'Records still in recovery' });
    expect(
      within(notice).getByText(/Operation finance.refund .*: state recovery_required/),
    ).toBeInTheDocument();
    await user.click(
      within(panel).getByLabelText(/I understand these records are still in recovery/),
    );
    await user.type(within(panel).getByLabelText(/Why the case may end now/), 'Refund reconciled');
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(await within(panel).findByText('Case updated. State: closed.')).toBeInTheDocument();
    const posts = app.fake.requests.filter((r) => r.route === '/cases/{id}/transition');
    expect(posts[0]?.body).toEqual({ event: 'close', expectedRevision: 3 });
    expect(posts[1]?.body).toEqual({
      event: 'close',
      expectedRevision: 3,
      acknowledgeOpenRecovery: true,
      reason: `Refund reconciled. Still in recovery: operation ${OPERATION_ID} (recovery_required)`,
    });
    // A changed intent (the acknowledgment) is a new idempotency key.
    expect(posts[1]?.headers['idempotency-key']).not.toBe(posts[0]?.headers['idempotency-key']);
  });

  it('SCR-S-49: steps that do not end the case need no acknowledgment while records are in recovery', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /cases/{id}/transition': {
          status: 200,
          body: supportCase({ status: 'waiting_customer', revision: 4 }),
        },
      }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Status' });
    await within(panel).findByRole('list', { name: 'Records still in recovery' });
    await user.click(within(panel).getByRole('button', { name: 'Wait for the customer' }));
    expect(
      await within(panel).findByText('Case updated. State: waiting_customer.'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/cases/{id}/transition');
    expect(post?.body).toEqual({ event: 'wait_customer', expectedRevision: 3 });
  });

  it('reports STALE_REVISION with "Reload", which re-reads the case', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /cases/{id}/transition': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Status' });
    await user.click(within(panel).getByRole('button', { name: 'Wait for the customer' }));
    expect(await within(panel).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const reads = app.fake.requests.filter((r) => r.route === '/cases/{id}').length;
    await user.click(within(panel).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/cases/{id}').length).toBe(reads + 1),
    );
  });

  it('SPK-SUPPORT-003: a note is history only and is sent as a note', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({ 'POST /cases/{id}/notes': { status: 201, body: supportCase() } }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Add a note' });
    expect(
      within(panel).getByText(/It is never a refund, a permission change or a transfer/),
    ).toBeInTheDocument();
    await user.type(within(panel).getByLabelText(/^Note/), 'Refund requested in Finance');
    await user.click(within(panel).getByRole('button', { name: 'Add note' }));
    expect(await within(panel).findByText('Note added to the history.')).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/cases/{id}/notes');
    expect(post?.body).toEqual({ body: 'Refund requested in Finance' });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('links a command only with its operation reference', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: detailRoutes() });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const panel = await screen.findByRole('region', { name: 'Link a command you ran' });
    await user.type(within(panel).getByLabelText(/^Action id/), 'finance.refund');
    await user.click(within(panel).getByRole('button', { name: 'Link command' }));
    expect(
      within(panel).getByText('Enter the operation reference the command returned.'),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/cases/{id}/actions')).toBe(false);
  });

  it('shows a case the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: { 'GET /cases/{id}': () => fakeResponse(404, apiErrorBody('NOT_FOUND')) },
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Status' })).toBeNull();
  });

  it('SPK-SUPPORT-002: a customer’s own request says so, and a merged subject links to the surviving record', async () => {
    const app = createTestApp({
      routes: detailRoutes({
        'GET /cases/{id}': {
          status: 200,
          body: supportCase({
            openedVia: 'customer',
            subject: { personId: SUBJECT_ID, householdId: null, canonicalPersonId: SURVIVOR_ID },
          }),
        },
      }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    expect(await screen.findByText('Customer request')).toBeInTheDocument();
    expect(screen.getByText(/The customer opened this request/)).toBeInTheDocument();
    const facts = screen.getByLabelText('Case');
    expect(within(facts).getByText('customer request')).toBeInTheDocument();
    expect(await within(facts).findByRole('link', { name: 'Alexandra Rivera' })).toHaveAttribute(
      'href',
      `/people/${SURVIVOR_ID}`,
    );
    expect(within(facts).getByText(/merged into/)).toBeInTheDocument();
  });

  it('a subject the viewer may not view is named as not available, never by id', async () => {
    const app = createTestApp({
      routes: detailRoutes({ 'GET /person-names': { status: 200, body: { items: [] } } }),
    });
    render(app.at(`/admin/cases/${CASE_ID}`));
    const facts = await screen.findByLabelText('Case');
    expect(await within(facts).findByText('a person not available to you')).toBeInTheDocument();
    expect(within(facts).queryByText(SUBJECT_ID)).toBeNull();
  });

  it('offers the case’s audit history only to roles that may read the audit log', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'GET /me/permissions': mePermissions({ actions: ['core.view_audit'] }),
        'GET /audit-records': { status: 200, body: { items: [], nextCursor: null } },
      }),
    });
    const first = render(app.at(`/admin/cases/${CASE_ID}`));
    const audit = await screen.findByRole('region', { name: 'Audit history' });
    await user.click(within(audit).getByRole('button', { name: 'Show audit history' }));
    expect(await within(audit).findByText('No audited actions')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/audit-records')?.query).toMatchObject({
      targetType: 'support_case',
      targetId: CASE_ID,
    });
    first.unmount();

    const plain = createTestApp({ routes: detailRoutes() });
    render(plain.at(`/admin/cases/${CASE_ID}`));
    await screen.findByRole('heading', { name: 'Charged but not registered' });
    expect(screen.queryByRole('region', { name: 'Audit history' })).toBeNull();
  });
});
