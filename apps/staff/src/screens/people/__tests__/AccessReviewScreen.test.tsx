/**
 * SCR-S-22 Disputed access review (SPK-IAM-005, DEC-004): the queue lists reviews from
 * `GET /v1/access-reviews` with the decisions each allows, filtered and paged by the API; escalated
 * reviews come from support cases filtered by origin; opening a review needs a reason and an
 * explicit owner; only the API's `allowedDecisions` are offered; decisions carry the expected
 * revision; a restriction states its end explicitly; STALE_REVISION offers Reload and keeps the
 * note; a review the viewer may not see is not available; offline is read-only.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  GRANT_ID,
  OTHER_ID,
  PERSON_ID,
  REVIEW_ID,
  accessReview,
  authority,
  person,
  personNames,
  reviewSummary,
} from './fixtures';

const READER = mePermissions({ actions: ['identity.read_access_review'] });

const PATH = `/people/access-reviews/${REVIEW_ID}`;

function caseRow(id: string, origin: unknown) {
  return {
    id,
    facilityId: null,
    category: 'access',
    priority: 'high',
    status: 'open',
    title: `Case ${id.slice(-3)}`,
    description: null,
    subject: { personId: PERSON_ID, householdId: null },
    owner: { personId: null, queue: 'support_operator' },
    relatedRecords: [],
    origin,
    dueAt: null,
    overdue: false,
    resolution: null,
    resolvedAt: null,
    closedAt: null,
    openedBy: { kind: 'system', accountId: null, personId: null, actorLabel: 'system' },
    allowedEvents: [],
    revision: 1,
    createdAt: '2026-10-24T11:00:00.000Z',
    updatedAt: '2026-10-24T11:00:00.000Z',
  };
}

describe('SCR-S-22 AccessReviewsScreen', () => {
  it('SPK-IAM-005: lists open reviews with status, owner, restrictions and the decisions each allows', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /access-reviews': {
          status: 200,
          body: { items: [reviewSummary()], nextCursor: null },
        },
        'GET /cases': { status: 200, body: { items: [], nextCursor: null } },
      },
    });
    render(app.at('/people/access-reviews'));
    const list = await screen.findByRole('list', { name: 'Access reviews' });
    expect(within(list).getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', PATH);
    expect(within(list).getByText('Status: open')).toBeInTheDocument();
    expect(within(list).getByText('Restriction in force')).toBeInTheDocument();
    expect(
      within(list).getByText(
        /2 permission\(s\) restricted now · decisions available: restrict, lift, escalate, decide, note, reassign/,
      ),
    ).toBeInTheDocument();
    expect(within(list).getByText(/owner support_operator \(unassigned\)/)).toBeInTheDocument();
    // Default: the API's "not closed"; no status sent.
    expect(app.fake.requests.find((r) => r.route === '/access-reviews')?.query).toEqual({
      limit: '25',
    });
  });

  it('filters by status and owning role through the API and pages with its cursor', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /access-reviews': (req) =>
          fakeResponse(
            200,
            req.query['cursor'] === 'r-2'
              ? {
                  items: [
                    reviewSummary({
                      id: '0192f1a0-0000-7000-8000-000000000202',
                      subjectDisplayName: null,
                      status: 'escalated',
                    }),
                  ],
                  nextCursor: null,
                }
              : { items: [reviewSummary()], nextCursor: 'r-2' },
          ),
        'GET /cases': { status: 200, body: { items: [], nextCursor: null } },
      },
    });
    render(app.at('/people/access-reviews'));
    await screen.findByRole('list', { name: 'Access reviews' });
    await user.click(screen.getByRole('button', { name: 'Load more access reviews' }));
    expect(await screen.findByText('Status: escalated')).toBeInTheDocument();
    // A subject the viewer may not view is never guessed.
    expect(screen.getByText('Subject not available to you')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Review status'), 'escalated');
    await user.selectOptions(screen.getByLabelText('Owning role'), 'general_manager');
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) =>
            r.route === '/access-reviews' &&
            r.query['status'] === 'escalated' &&
            r.query['ownerRole'] === 'general_manager',
        ),
      ).toBe(true),
    );
  });

  it('says when no review is open', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /access-reviews': { status: 200, body: { items: [], nextCursor: null } },
        'GET /cases': { status: 200, body: { items: [], nextCursor: null } },
      },
    });
    render(app.at('/people/access-reviews'));
    expect(await screen.findByText('No reviews')).toBeInTheDocument();
    expect(screen.getByText('None escalated')).toBeInTheDocument();
  });

  it('shows the queue as not available to roles that do not decide reviews, without asking', async () => {
    const app = createTestApp({
      routes: { 'GET /cases': { status: 200, body: { items: [], nextCursor: null } } },
    });
    render(app.at('/people/access-reviews'));
    expect(await screen.findByText(/The review queue is for review owners/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/access-reviews')).toBe(false);
    // A review started elsewhere still opens by its reference.
    expect(screen.getByRole('form', { name: 'Open a review by reference' })).toBeInTheDocument();
  });

  it('lists escalated reviews from support cases filtered by origin, each linking to its review', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /access-reviews': { status: 200, body: { items: [], nextCursor: null } },
        'GET /cases': {
          status: 200,
          body: {
            items: [
              caseRow('0192f1a0-0000-7000-8000-000000000a01', {
                type: 'access_review',
                id: REVIEW_ID,
              }),
            ],
            nextCursor: null,
          },
        },
      },
    });
    render(app.at('/people/access-reviews'));
    const list = await screen.findByRole('list', { name: 'Escalated access reviews' });
    expect(within(list).getByRole('link', { name: 'Case a01' })).toHaveAttribute('href', PATH);
    expect(within(list).getByRole('link', { name: 'Open the support case' })).toHaveAttribute(
      'href',
      '/admin/cases/0192f1a0-0000-7000-8000-000000000a01',
    );
    expect(app.fake.requests.find((r) => r.route === '/cases')?.query).toEqual({
      origin: 'access_review',
      limit: '25',
    });
  });

  it('shows escalated reviews outside the viewer’s scope as not available', async () => {
    const app = createTestApp({
      routes: { 'GET /cases': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')) },
    });
    render(app.at('/people/access-reviews'));
    const section = await screen.findByRole('region', { name: 'Escalated to support' });
    await waitFor(() => expect(within(section).getByText('Not available')).toBeInTheDocument());
  });
});

describe('SCR-S-22 OpenAccessReviewScreen', () => {
  it('requires a reason and an explicit owner, then opens the review for the subject', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': { status: 200, body: person() },
        'POST /access-reviews': { status: 201, body: accessReview() },
        'GET /access-reviews/{id}': { status: 200, body: accessReview() },
      },
    });
    render(app.at(`/people/access-reviews/new?subject=${PERSON_ID}`));
    const form = await screen.findByRole('form', { name: 'Open an access review' });
    expect(within(form).getByLabelText(/Person whose access is disputed/)).toHaveValue(PERSON_ID);
    await user.click(within(form).getByRole('button', { name: 'Open review' }));
    expect(within(form).getByText('Say what access is disputed and why.')).toBeInTheDocument();
    expect(within(form).getByText('Choose who owns the review.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/access-reviews')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason/), 'Two guardians disagree');
    await user.selectOptions(within(form).getByLabelText(/Review owner/), 'support_operator');
    await user.click(within(form).getByRole('button', { name: 'Add an evidence reference' }));
    await user.type(within(form).getByLabelText(/Evidence 1 type/), 'court_order');
    await user.type(within(form).getByLabelText(/Evidence 1 reference/), 'CO-2026-17');
    await user.click(within(form).getByRole('button', { name: 'Open review' }));
    expect(await screen.findByRole('heading', { name: 'Access review' })).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/access-reviews');
    expect(post?.body).toEqual({
      subjectPersonId: PERSON_ID,
      reason: 'Two guardians disagree',
      ownerRole: 'support_operator',
      parties: [],
      evidence: [{ type: 'court_order', reference: 'CO-2026-17' }],
    });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });
});

describe('SCR-S-22 AccessReviewScreen', () => {
  it('shows the review, its parties, evidence references and decision history', async () => {
    const app = createTestApp({
      routes: { 'GET /access-reviews/{id}': { status: 200, body: accessReview() } },
    });
    render(app.at(PATH));
    expect(await screen.findByText('Status: open')).toBeInTheDocument();
    expect(screen.getByText('Two guardians disagree about pickup')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Parties' })).getByText('Second guardian'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Evidence references' })).getByText('CO-2026-17'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Decision history' })).getByText(
        'Opened at the front desk',
      ),
    ).toBeInTheDocument();
  });

  it('SPK-IAM-005: a restriction states its end explicitly and carries the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': { status: 200, body: accessReview() },
        'GET /people/{id}': { status: 200, body: person(OTHER_ID) },
        'POST /access-reviews/{id}/decisions': {
          status: 200,
          body: accessReview({ revision: 3 }),
        },
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByRole('combobox', { name: /^Decision/ }), 'restrict');
    await user.type(within(form).getByLabelText(/Person holding the permissions/), OTHER_ID);
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(within(form).getByText('Choose when the restriction ends.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/access-reviews/{id}/decisions')).toBe(false);
    await user.click(within(form).getByLabelText('When it is lifted by a later decision'));
    await user.type(within(form).getByLabelText(/^Note/), 'Pickup suspended pending documents');
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(
      await screen.findByText('Decision recorded: restrict. Review status: open.'),
    ).toBeInTheDocument();
    const post = app.fake.requests.find((r) => r.route === '/access-reviews/{id}/decisions');
    expect(post?.body).toEqual({
      kind: 'restrict',
      expectedRevision: 2,
      actorPersonId: OTHER_ID,
      note: 'Pickup suspended pending documents',
    });
  });

  it("SPK-IAM-005: a lift ends all of this review's restrictions by default, or only one person's", async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': { status: 200, body: accessReview() },
        'GET /people/{id}': { status: 200, body: person(OTHER_ID) },
        'POST /access-reviews/{id}/decisions': {
          status: 200,
          body: accessReview({ revision: 3 }),
        },
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByRole('combobox', { name: /^Decision/ }), 'lift');
    // Nothing is narrowed unless the reviewer chooses to.
    expect(within(form).getByLabelText('All restrictions placed by this review')).toBeChecked();
    expect(within(form).queryByLabelText(/Person holding the permissions/)).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    await screen.findByText('Decision recorded: lift. Review status: open.');
    const posts = () =>
      app.fake.requests.filter((r) => r.route === '/access-reviews/{id}/decisions');
    expect(posts()[0]?.body).toEqual({ kind: 'lift', expectedRevision: 2 });

    await user.click(within(form).getByLabelText(/^Only the restrictions on one person/));
    await user.type(within(form).getByLabelText(/Person holding the permissions/), OTHER_ID);
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.body).toEqual({
      kind: 'lift',
      expectedRevision: 2,
      actorPersonId: OTHER_ID,
    });
  });

  it('SPK-IAM-006: chooses the permissions to restrict from the subject’s authority, each with its holder and state', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': mePermissions({ actions: ['identity.read_authority'] }),
        'GET /access-reviews/{id}': { status: 200, body: accessReview() },
        'GET /people/{id}/authority': { status: 200, body: authority() },
        'POST /access-reviews/{id}/decisions': {
          status: 200,
          body: accessReview({ revision: 3 }),
        },
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByRole('combobox', { name: /^Decision/ }), 'restrict');
    await user.click(within(form).getByLabelText('Specific permissions by reference'));
    const pay = await within(form).findByLabelText(
      'pay held by Sam Rivera · state suspended · under review',
    );
    expect(
      within(form).getByLabelText('view held by Sam Rivera · state effective'),
    ).not.toBeChecked();
    await user.click(pay);
    await user.click(within(form).getByLabelText('When it is lifted by a later decision'));
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    await screen.findByText('Decision recorded: restrict. Review status: open.');
    const post = app.fake.requests.find((r) => r.route === '/access-reviews/{id}/decisions');
    expect(post?.body).toEqual({
      kind: 'restrict',
      expectedRevision: 2,
      grantIds: [`${GRANT_ID.slice(0, -1)}9`],
    });
  });

  it('enters permission references where the subject’s authority is not readable, validated before sending', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { 'GET /access-reviews/{id}': { status: 200, body: accessReview() } },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByRole('combobox', { name: /^Decision/ }), 'lift');
    await user.click(within(form).getByLabelText(/^Only the permissions chosen/));
    await user.type(within(form).getByLabelText(/^Permission references/), 'not-a-reference');
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(within(form).getByText('Choose or enter one or more permissions.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/access-reviews/{id}/decisions')).toBe(false);
    expect(app.fake.requests.some((r) => r.route === '/people/{id}/authority')).toBe(false);
  });

  it('reports STALE_REVISION with "Reload", re-reads the review and keeps the note', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': { status: 200, body: accessReview() },
        'POST /access-reviews/{id}/decisions': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByLabelText(/^Decision/), 'note');
    await user.type(within(form).getByLabelText(/^Note/), 'Called the second guardian');
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const reads = app.fake.requests.filter((r) => r.route === '/access-reviews/{id}').length;
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/access-reviews/{id}').length).toBe(
        reads + 1,
      ),
    );
    expect(within(form).getByLabelText(/^Note/)).toHaveValue('Called the second guardian');
  });

  it('shows INVALID_TRANSITION from the API with its code (the client does not guess the lifecycle)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': { status: 200, body: accessReview({ status: 'closed' }) },
        'POST /access-reviews/{id}/decisions': () =>
          fakeResponse(
            409,
            apiErrorBody('INVALID_TRANSITION', { nextAction: 'reload_current_state' }),
          ),
      },
    });
    render(app.at(PATH));
    const form = await screen.findByRole('form', { name: 'Record a decision' });
    await user.selectOptions(within(form).getByLabelText(/^Decision/), 'escalate');
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByText(/Error code: INVALID_TRANSITION/)).toBeInTheDocument();
  });

  it('shows a review the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      },
    });
    render(app.at(PATH));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Record a decision' })).toBeNull();
  });

  it('is read-only offline', async () => {
    const app = createTestApp({
      routes: { 'GET /access-reviews/{id}': { status: 200, body: accessReview() } },
    });
    render(app.at(PATH));
    await screen.findByRole('form', { name: 'Record a decision' });
    act(() => app.connectivity.set(false));
    expect(
      await screen.findByText('Offline: this review is read-only until you reconnect.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record decision' })).toBeNull();
  });

  it('SPK-IAM-005: offers only the decisions the API allows now, and none to a reader who may not decide', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /access-reviews/{id}': {
          status: 200,
          body: accessReview({ status: 'decided', allowedDecisions: ['lift', 'close', 'note'] }),
        },
      },
    });
    const { unmount } = render(app.at(PATH));
    const select = await screen.findByRole('combobox', { name: /^Decision/ });
    const options = within(select)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value)
      .filter(Boolean);
    expect(options).toEqual(['lift', 'close', 'note']);
    await user.selectOptions(select, 'close');
    unmount();

    const reader = createTestApp({
      routes: {
        'GET /access-reviews/{id}': {
          status: 200,
          body: accessReview({ allowedDecisions: [] }),
        },
      },
    });
    render(reader.at(PATH));
    expect(
      await screen.findByText('No decision on this review is available to you now.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Record a decision' })).toBeNull();
  });

  it('names the subject and parties from the API, and marks decisions the system recorded', async () => {
    const app = createTestApp({
      routes: {
        'GET /person-names': personNames(),
        'GET /access-reviews/{id}': {
          status: 200,
          body: accessReview({
            decisions: [
              {
                id: 'd-2',
                sequence: 2,
                kind: 'lift',
                note: null,
                affectedGrantIds: ['0192f1a0-0000-7000-8000-000000000501'],
                effectiveFrom: null,
                effectiveTo: null,
                bySystem: true,
                occurredAt: '2026-10-24T12:00:00.000Z',
              },
            ],
          }),
        },
      },
    });
    render(app.at(PATH));
    const facts = await screen.findByLabelText('Review');
    expect(await within(facts).findByRole('link', { name: 'Alex Rivera' })).toHaveAttribute(
      'href',
      `/people/${PERSON_ID}`,
    );
    const parties = screen.getByRole('list', { name: 'Parties' });
    expect(within(parties).getByRole('link', { name: 'Sam Rivera' })).toHaveAttribute(
      'href',
      `/people/${OTHER_ID}`,
    );
    expect(
      screen.getByText(/1 permission\(s\) affected · recorded by the system/),
    ).toBeInTheDocument();
  });
});
