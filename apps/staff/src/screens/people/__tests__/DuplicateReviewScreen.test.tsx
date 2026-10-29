/**
 * SCR-S-23 Duplicate review and merge (SPK-IAM-007, SPK-AT-024): the candidates come from
 * `GET /v1/duplicate-candidates` by status, paged, with both names (a child by given name only);
 * flagging validates two different references, leaves the score to the API and opens the
 * candidate; the candidate review (`GET /v1/duplicate-candidates/{id}`) compares both records;
 * merging needs an explicit survivor and a reason, carries the expected revision and follows the
 * merge operation, showing `recovery_required`; dismissing needs a reason; STALE_REVISION re-reads
 * the candidate; merge and dismiss are offered by role; a refusal keeps the input and shows the
 * API's code; migration duplicates are a pending decision.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  CANDIDATE_ID,
  CHILD_ID,
  OPERATION_ID,
  OTHER_ID,
  PERSON_ID,
  candidate,
  candidateDetail,
  duplicateSide,
  person,
} from './fixtures';

const DETAIL = `/people/duplicates/${CANDIDATE_ID}`;
const READER = mePermissions({ actions: ['identity.read_duplicates'] });
const DECIDER = mePermissions({
  actions: ['identity.read_duplicates', 'identity.merge_persons', 'identity.dismiss_duplicate'],
});

function queueRow(overrides: Record<string, unknown> = {}) {
  const {
    dateOfBirth: _a,
    accountLinked: _b,
    contactPointKinds: _c,
    ...a
  } = duplicateSide(PERSON_ID);
  const {
    dateOfBirth: _d,
    accountLinked: _e,
    contactPointKinds: _f,
    ...b
  } = duplicateSide(CHILD_ID);
  return { ...candidate({ personBId: CHILD_ID }), personA: a, personB: b, ...overrides };
}

function detailRoutes(extra: Record<string, unknown> = {}) {
  return {
    'GET /me/permissions': DECIDER,
    'GET /duplicate-candidates/{id}': { status: 200, body: candidateDetail() },
    ...extra,
  };
}

function candidateReads(app: ReturnType<typeof createTestApp>) {
  return app.fake.requests.filter((r) => r.route === '/duplicate-candidates/{id}').length;
}

describe('SCR-S-23 DuplicateReviewScreen (queue)', () => {
  it('SPK-IAM-007: lists open candidates with both names, reasons and score, each opening its review', async () => {
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /duplicate-candidates': {
          status: 200,
          body: { items: [queueRow()], nextCursor: null },
        },
      },
    });
    render(app.at('/people/duplicates'));
    const list = await screen.findByRole('list', { name: 'Duplicate candidates' });
    // §4.14: the child is named by given name only.
    const link = within(list).getByRole('link', { name: 'Alex Rivera and Mia' });
    expect(link).toHaveAttribute('href', DETAIL);
    expect(within(list).queryByText(/Mia Rivera/)).toBeNull();
    expect(within(list).getByText(/Same name and date of birth · score 50/)).toBeInTheDocument();
    expect(within(list).getByText('Status: open')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/duplicate-candidates')?.query).toEqual({
      status: 'open',
      limit: '25',
    });
    expect(screen.getByText(/depends on DEC-014, DEC-067, DEC-068/)).toBeInTheDocument();
  });

  it('filters by status through the API and pages with its cursor; says when there are none', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /me/permissions': READER,
        'GET /duplicate-candidates': (req) =>
          fakeResponse(
            200,
            req.query['status'] === 'merged'
              ? { items: [], nextCursor: null }
              : req.query['cursor'] === 'c-2'
                ? {
                    items: [queueRow({ id: '0192f1a0-0000-7000-8000-000000000302', score: 80 })],
                    nextCursor: null,
                  }
                : { items: [queueRow()], nextCursor: 'c-2' },
          ),
      },
    });
    render(app.at('/people/duplicates'));
    await screen.findByRole('list', { name: 'Duplicate candidates' });
    await user.click(screen.getByRole('button', { name: 'Load more candidates' }));
    expect(await screen.findByText(/score 80/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Candidate status'), 'merged');
    expect(await screen.findByText('No candidates')).toBeInTheDocument();
    expect(screen.getByText('No duplicate candidate is merged.')).toBeInTheDocument();
  });

  it('shows the queue as not available to roles without the read, and still allows flagging', async () => {
    const app = createTestApp();
    render(app.at('/people/duplicates'));
    expect(
      await screen.findByText(/The candidate list is not available to your role/),
    ).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/duplicate-candidates')).toBe(false);
    expect(screen.getByRole('form', { name: 'Flag a possible duplicate' })).toBeInTheDocument();
  });

  it('validates two different references before flagging', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': (req: { params: Record<string, string> }) =>
          fakeResponse(200, person(req.params['id'])),
      },
    });
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const form = await screen.findByRole('form', { name: 'Flag a possible duplicate' });
    expect(within(form).getByLabelText(/Record A reference/)).toHaveValue(PERSON_ID);
    await user.type(within(form).getByLabelText(/Record B reference/), PERSON_ID);
    await user.click(within(form).getByRole('button', { name: 'Flag for review' }));
    expect(within(form).getByText('Choose two different records.')).toBeInTheDocument();
    expect(within(form).getByText('Give at least one reason, one per line.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/duplicate-candidates')).toBe(false);
  });

  it('flags a pair, leaves the score to the API and opens the candidate it returns', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: {
        'GET /people/{id}': (req: { params: Record<string, string> }) =>
          fakeResponse(200, person(req.params['id'])),
        'POST /duplicate-candidates': { status: 201, body: candidate() },
        ...detailRoutes(),
      },
    });
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const form = await screen.findByRole('form', { name: 'Flag a possible duplicate' });
    await user.type(within(form).getByLabelText(/Record B reference/), OTHER_ID);
    await user.type(within(form).getByLabelText(/Why they may be the same person/), 'Same name');
    await user.click(within(form).getByRole('button', { name: 'Flag for review' }));
    expect(await screen.findByRole('region', { name: 'Candidate' })).toBeInTheDocument();
    const flag = app.fake.requests.find((r) => r.route === '/duplicate-candidates');
    expect(flag?.body).toEqual({
      personAId: PERSON_ID,
      personBId: OTHER_ID,
      reasons: ['Same name'],
    });
    expect(flag?.body).not.toHaveProperty('score');
    expect(flag?.headers['idempotency-key']).toMatch(/^key-/);
  });
});

describe('SCR-S-23 DuplicateCandidateScreen', () => {
  it('SPK-IAM-007: compares both records and merges with an explicit survivor and the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /duplicate-candidates/{id}/merge': {
          status: 201,
          body: {
            id: '0192f1a0-0000-7000-8000-000000000901',
            survivorPersonId: PERSON_ID,
            mergedPersonId: OTHER_ID,
            candidateId: CANDIDATE_ID,
            moved: { enrollments: 2, paymentAttempts: 1, unverifiedGrantsDropped: 1 },
            operationId: OPERATION_ID,
            occurredAt: '2026-10-24T12:00:00.000Z',
          },
        },
        'GET /operations/{id}': {
          status: 200,
          body: {
            id: OPERATION_ID,
            kind: 'identity.merge_persons',
            status: 'recovery_required',
            correlationId: null,
            result: null,
            error: null,
            createdAt: '2026-10-24T12:00:00.000Z',
            updatedAt: '2026-10-24T12:00:00.000Z',
            completedAt: '2026-10-24T12:00:00.000Z',
          },
        },
      }),
    });
    render(app.at(DETAIL));
    const review = await screen.findByRole('region', { name: 'Candidate' });
    const a = within(review).getByRole('region', { name: 'Record A' });
    const b = within(review).getByRole('region', { name: 'Record B' });
    expect(within(a).getByRole('link', { name: 'Alex Rivera' })).toBeInTheDocument();
    expect(within(a).getByText('1990-04-02')).toBeInTheDocument();
    expect(within(a).getByText('Linked')).toBeInTheDocument();
    expect(within(b).getByRole('link', { name: 'Sam Rivera' })).toBeInTheDocument();
    expect(within(b).getByText('None')).toBeInTheDocument();
    expect(within(b).getByText('email')).toBeInTheDocument();
    // Survivor and reason are required.
    await user.click(within(review).getByRole('button', { name: 'Merge records' }));
    expect(within(review).getByText('Choose which record survives.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/duplicate-candidates/{id}/merge')).toBe(
      false,
    );
    await user.click(within(review).getByLabelText('Record A survives'));
    await user.type(within(review).getByLabelText(/^Reason/), 'Confirmed at the desk');
    await user.click(within(review).getByRole('button', { name: 'Merge records' }));
    const outcome = await screen.findByRole('region', { name: 'Merge outcome' });
    expect(within(outcome).getByText('enrollments')).toBeInTheDocument();
    expect(await within(outcome).findByText('Operation: recovery_required')).toBeInTheDocument();
    expect(within(outcome).getByText(/The merge needs attention/)).toBeInTheDocument();
    const merge = app.fake.requests.find((r) => r.route === '/duplicate-candidates/{id}/merge');
    expect(merge?.body).toEqual({
      survivorPersonId: PERSON_ID,
      reason: 'Confirmed at the desk',
      expectedRevision: 1,
    });
    expect(merge?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('§4.14: compares a child by given name, kind and status only', async () => {
    const app = createTestApp({
      routes: detailRoutes({
        'GET /duplicate-candidates/{id}': {
          status: 200,
          body: candidateDetail({ personB: duplicateSide(CHILD_ID) }),
        },
      }),
    });
    render(app.at(DETAIL));
    const b = await screen.findByRole('region', { name: 'Record B' });
    expect(within(b).getByRole('link', { name: 'Mia' })).toBeInTheDocument();
    expect(within(b).getByText('Kept on the record, not shown here')).toBeInTheDocument();
    expect(within(b).queryByText('2018-01-01')).toBeNull();
    expect(within(b).queryByText(/Rivera/)).toBeNull();
  });

  it('shows a refused merge with the API’s code and keeps the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /duplicate-candidates/{id}/merge': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              message: 'The survivor must be the adult record.',
              nextAction: 'correct_input',
            }),
          ),
      }),
    });
    render(app.at(DETAIL));
    const review = await screen.findByRole('region', { name: 'Candidate' });
    await user.click(within(review).getByLabelText('Record B survives'));
    await user.type(within(review).getByLabelText(/^Reason/), 'Same family');
    await user.click(within(review).getByRole('button', { name: 'Merge records' }));
    expect(await within(review).findByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
    expect(within(review).getByText('The survivor must be the adult record.')).toBeInTheDocument();
    expect(within(review).getByLabelText(/^Reason/)).toHaveValue('Same family');
    expect(within(review).getByLabelText('Record B survives')).toBeChecked();
  });

  it('dismisses a candidate with a reason and re-reads it', async () => {
    const user = userEvent.setup();
    let dismissed = false;
    const app = createTestApp({
      routes: detailRoutes({
        'GET /duplicate-candidates/{id}': () =>
          fakeResponse(200, candidateDetail(dismissed ? { status: 'dismissed', revision: 2 } : {})),
        'POST /duplicate-candidates/{id}/dismiss': () => {
          dismissed = true;
          return fakeResponse(200, candidate({ status: 'dismissed', revision: 2 }));
        },
      }),
    });
    render(app.at(DETAIL));
    const review = await screen.findByRole('region', { name: 'Candidate' });
    await user.click(within(review).getByRole('button', { name: 'Not the same person' }));
    expect(
      within(review).getByText('Write why these records are different people.'),
    ).toBeInTheDocument();
    await user.type(within(review).getByLabelText(/^Reason/), 'Twins');
    await user.click(within(review).getByRole('button', { name: 'Not the same person' }));
    expect(await within(review).findByText('Candidate dismissed.')).toBeInTheDocument();
    await waitFor(() => expect(within(review).getByText('Status: dismissed')).toBeInTheDocument());
    expect(within(review).queryByRole('button', { name: 'Merge records' })).toBeNull();
    const req = app.fake.requests.find((r) => r.route === '/duplicate-candidates/{id}/dismiss');
    expect(req?.body).toEqual({ reason: 'Twins', expectedRevision: 1 });
  });

  it('STALE_REVISION offers Reload, which re-reads the candidate', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: detailRoutes({
        'POST /duplicate-candidates/{id}/dismiss': () =>
          fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' })),
      }),
    });
    render(app.at(DETAIL));
    const review = await screen.findByRole('region', { name: 'Candidate' });
    await user.type(within(review).getByLabelText(/^Reason/), 'Twins');
    await user.click(within(review).getByRole('button', { name: 'Not the same person' }));
    expect(await within(review).findByText(/Error code: STALE_REVISION/)).toBeInTheDocument();
    const before = candidateReads(app);
    await user.click(within(review).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(candidateReads(app)).toBe(before + 1));
  });

  it('offers merge only to roles that may merge, and nothing to roles that may neither merge nor dismiss', async () => {
    const dismissOnly = createTestApp({
      routes: detailRoutes({
        'GET /me/permissions': mePermissions({
          actions: ['identity.read_duplicates', 'identity.dismiss_duplicate'],
        }),
      }),
    });
    const first = render(dismissOnly.at(DETAIL));
    const review = await screen.findByRole('region', { name: 'Candidate' });
    expect(
      await within(review).findByRole('button', { name: 'Not the same person' }),
    ).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: 'Merge records' })).toBeNull();
    expect(within(review).queryByLabelText('Record A survives')).toBeNull();
    first.unmount();

    const reader = createTestApp({ routes: detailRoutes({ 'GET /me/permissions': READER }) });
    render(reader.at(DETAIL));
    expect(
      await screen.findByText('Merging and dismissing candidates are not available to you.'),
    ).toBeInTheDocument();
  });

  it('shows a candidate the viewer may not read as not available, and a malformed address without a request', async () => {
    const app = createTestApp({
      routes: detailRoutes({
        'GET /duplicate-candidates/{id}': () => fakeResponse(403, apiErrorBody('ACCESS_DENIED')),
      }),
    });
    const first = render(app.at(DETAIL));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Candidate' })).toBeNull();
    first.unmount();

    const malformed = createTestApp();
    render(malformed.at('/people/duplicates/not-a-reference'));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(malformed.fake.requests.some((r) => r.route === '/duplicate-candidates/{id}')).toBe(
      false,
    );
  });

  it('offers the candidate’s audit history to roles that may read the audit log', async () => {
    const app = createTestApp({
      routes: detailRoutes({
        'GET /me/permissions': mePermissions({
          actions: ['identity.read_duplicates', 'core.view_audit'],
        }),
      }),
    });
    render(app.at(DETAIL));
    const audit = await screen.findByRole('region', { name: 'Audit history' });
    expect(within(audit).getByRole('button', { name: 'Show audit history' })).toBeInTheDocument();
  });
});
