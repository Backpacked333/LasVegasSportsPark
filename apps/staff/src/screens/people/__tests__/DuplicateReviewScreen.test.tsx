/**
 * SCR-S-23 Duplicate review and merge (SPK-IAM-007, SPK-AT-024): the candidate list is not
 * available (no API read); flagging validates two different references and leaves the score to the
 * API; the review compares both records; merging needs an explicit survivor and a reason, carries
 * the expected revision and follows the merge operation, showing `recovery_required`; a refusal
 * keeps the input and shows the API's code; migration duplicates are a pending decision.
 */
import { apiErrorBody, fakeResponse } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import { CANDIDATE_ID, OPERATION_ID, OTHER_ID, PERSON_ID, candidate, person } from './fixtures';

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /people/{id}': (req: { params: Record<string, string> }) =>
      fakeResponse(200, person(req.params['id'])),
    'POST /duplicate-candidates': { status: 201, body: candidate() },
    ...extra,
  };
}

async function flagPair(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Flag a possible duplicate' });
  await user.type(within(form).getByLabelText(/Record B reference/), OTHER_ID);
  await user.type(within(form).getByLabelText(/Why they may be the same person/), 'Same name');
  await user.click(within(form).getByRole('button', { name: 'Flag for review' }));
  return screen.findByRole('region', { name: 'Candidate' });
}

describe('SCR-S-23 DuplicateReviewScreen', () => {
  it('says the candidate list is not available and names the pending migration decisions', async () => {
    const app = createTestApp();
    render(app.at('/people/duplicates'));
    expect(await screen.findByText('The candidate list is not available yet')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-014, DEC-067, DEC-068/)).toBeInTheDocument();
  });

  it('validates two different references before flagging', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const form = await screen.findByRole('form', { name: 'Flag a possible duplicate' });
    expect(within(form).getByLabelText(/Record A reference/)).toHaveValue(PERSON_ID);
    await user.type(within(form).getByLabelText(/Record B reference/), PERSON_ID);
    await user.click(within(form).getByRole('button', { name: 'Flag for review' }));
    expect(within(form).getByText('Choose two different records.')).toBeInTheDocument();
    expect(within(form).getByText('Give at least one reason, one per line.')).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/duplicate-candidates')).toBe(false);
  });

  it('SPK-IAM-007: flags, compares and merges with an explicit survivor and the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
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
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const review = await flagPair(user);
    const flag = app.fake.requests.find((r) => r.route === '/duplicate-candidates');
    expect(flag?.body).toEqual({
      personAId: PERSON_ID,
      personBId: OTHER_ID,
      reasons: ['Same name'],
    });
    expect(flag?.body).not.toHaveProperty('score');
    // Side-by-side comparison.
    const a = within(review).getByRole('region', { name: 'Record A' });
    const b = within(review).getByRole('region', { name: 'Record B' });
    expect(await within(a).findByRole('link', { name: 'Alex Rivera' })).toBeInTheDocument();
    expect(await within(b).findByRole('link', { name: 'Sam Rivera' })).toBeInTheDocument();
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

  it('shows a refused merge with the API’s code and keeps the input', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
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
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const review = await flagPair(user);
    await user.click(within(review).getByLabelText('Record B survives'));
    await user.type(within(review).getByLabelText(/^Reason/), 'Same family');
    await user.click(within(review).getByRole('button', { name: 'Merge records' }));
    expect(await within(review).findByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
    expect(within(review).getByText('The survivor must be the adult record.')).toBeInTheDocument();
    expect(within(review).getByLabelText(/^Reason/)).toHaveValue('Same family');
    expect(within(review).getByLabelText('Record B survives')).toBeChecked();
  });

  it('dismisses a candidate with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /duplicate-candidates/{id}/dismiss': {
          status: 200,
          body: candidate({ status: 'dismissed', revision: 2 }),
        },
      }),
    });
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const review = await flagPair(user);
    await user.type(within(review).getByLabelText(/^Reason/), 'Twins');
    await user.click(within(review).getByRole('button', { name: 'Not the same person' }));
    expect(await within(review).findByText('Candidate dismissed.')).toBeInTheDocument();
    expect(within(review).getByText('Status: dismissed')).toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: 'Merge records' })).toBeNull();
  });

  it('shows a record the viewer may not see as not available in the comparison', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /people/{id}': (req: { params: Record<string, string> }) =>
          req.params['id'] === OTHER_ID
            ? fakeResponse(404, apiErrorBody('NOT_FOUND'))
            : fakeResponse(200, person(req.params['id'])),
      }),
    });
    render(app.at(`/people/duplicates?personA=${PERSON_ID}`));
    const review = await flagPair(user);
    const b = within(review).getByRole('region', { name: 'Record B' });
    expect(await within(b).findByText('Not available')).toBeInTheDocument();
  });
});
