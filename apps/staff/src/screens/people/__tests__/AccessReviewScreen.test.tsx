/**
 * SCR-S-22 Disputed access review (SPK-IAM-005, DEC-004): the queue says open reviews cannot be
 * listed and shows escalated ones from support cases; opening a review needs a reason and an
 * explicit owner; decisions carry the expected revision; a restriction states its end explicitly;
 * STALE_REVISION offers Reload and keeps the note; a review the viewer may not see is not
 * available; offline is read-only.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { OTHER_ID, PERSON_ID, REVIEW_ID, accessReview, person } from './fixtures';

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
  it('says open reviews cannot be listed and shows only escalated ones from support cases', async () => {
    const app = createTestApp({
      routes: {
        'GET /cases': {
          status: 200,
          body: {
            items: [
              caseRow('0192f1a0-0000-7000-8000-000000000a01', {
                type: 'access_review',
                id: REVIEW_ID,
              }),
              caseRow('0192f1a0-0000-7000-8000-000000000a02', null),
            ],
            nextCursor: null,
          },
        },
      },
    });
    render(app.at('/people/access-reviews'));
    expect(
      await screen.findByText('The list of open reviews is not available yet'),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Escalated access reviews' });
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: 'Case a01' })).toHaveAttribute('href', PATH);
    expect(app.fake.requests.find((r) => r.route === '/cases')?.query).toMatchObject({
      category: 'access',
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
    await user.selectOptions(within(form).getByLabelText(/^Decision/), 'restrict');
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
});
