/**
 * SCR-S-48 Import batch and reconciliation: §5.4 (validation seals and verifies the checksum, a
 * mismatch is a validation failure; review needs every exception decided; apply is repeatable and
 * never charges or notifies; abort needs a reason), partial completion per row with reasons,
 * §5.5 four levels with discrepancies never netted and per-area sign-offs (DEC-067), every command
 * with an idempotency key and the expected revision, staged payloads never shown (§4.14), and a
 * protected batch shown as not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  BATCH_1,
  REPORT_1,
  importBatch,
  importException,
  importRow,
  ok,
  page,
  reconciliationReport,
} from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

function app(batch: ReturnType<typeof importBatch>, routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /import-batches/{id}': ok(batch),
      'GET /import-batches/{id}/rows': page([
        importRow(1),
        importRow(2, {
          plannedOutcome: 'exception',
          reasons: [
            { code: 'AMBIGUOUS_GUARDIAN', message: 'Guardianship is inferred, not documented.' },
          ],
        }),
      ]),
      'GET /import-exceptions': page([]),
      ...routes,
    },
  });
}

const at = `/admin/migration/batches/${BATCH_1}`;

describe('SCR-S-48 ImportBatchScreen', () => {
  it('shows what the batch retains and row outcomes without any staged payload', async () => {
    render(app(importBatch(BATCH_1, 'validated')).at(at));
    const summary = await screen.findByRole('region', { name: /legacy-registration snapshot/ });
    expect(within(summary).getByText('staging-v1.0')).toBeInTheDocument();
    expect(within(summary).getByText('matches the declared checksum')).toBeInTheDocument();
    expect(
      within(summary).getByText(/People: 2 · Open obligations: 1 · Open obligations \$25\.00/),
    ).toBeInTheDocument();
    expect(
      within(summary).getByText(/2 created, 0 matched, 0 updated, 0 skipped, 1 exceptions/),
    ).toBeInTheDocument();
    const rows = await screen.findByRole('region', { name: 'Staged rows' });
    expect(within(rows).getByText('P-2')).toBeInTheDocument();
    expect(
      within(rows).getByText('AMBIGUOUS_GUARDIAN: Guardianship is inferred, not documented.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Childname/)).toBeNull();
    expect(screen.queryByText(/2016-05-01/)).toBeNull();
  });

  it('validates with the expected revision and names a checksum mismatch', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'received'), {
      'POST /import-batches/{id}/validate': () =>
        fakeResponse(
          400,
          apiErrorBody('VALIDATION_FAILED', {
            nextAction: 'correct_input',
            message: 'The staged rows do not match the declared checksum.',
            details: {
              code: 'CHECKSUM_MISMATCH',
              declared: 'c'.repeat(64),
              computed: 'f'.repeat(64),
            },
          }),
        ),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Validate (seal and dry run)' }));
    expect(
      await screen.findByText(
        /Checksum mismatch: the staged rows do not match the declared checksum/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Validation failure')).toBeInTheDocument();
    const post = test.fake.requests.find((r) => r.route === '/import-batches/{id}/validate');
    expect(post?.body).toEqual({ expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('refuses to complete the review while exceptions are open and lets them be decided', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'validated'), {
      'GET /import-exceptions': page([importException('validation')]),
      'POST /import-batches/{id}/review': () =>
        fakeResponse(
          409,
          apiErrorBody('RESOURCE_CONFLICT', {
            nextAction: 'resolve_conflict',
            message: 'Every import exception must be decided before the review completes.',
            details: { code: 'OPEN_EXCEPTIONS', open: 1 },
          }),
        ),
      'POST /import-exceptions/{id}/decide': ok(
        importException('validation', { status: 'decided', decision: 'reject', revision: 5 }),
      ),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Complete the review' }));
    expect(await screen.findByText(/1 review exceptions are still open/)).toBeInTheDocument();

    const queue = screen.getByRole('list', { name: 'Review exceptions of this batch' });
    expect(within(queue).getByText(/Review owner: Support operator/)).toBeInTheDocument();
    await user.click(within(queue).getByRole('button', { name: 'Decide Validation error X-3' }));
    const form = screen.getByRole('form', { name: /Decide exception/ });
    // A validation error can only be rejected or deferred.
    expect(within(form).queryByRole('radio', { name: 'Accept' })).toBeNull();
    await user.click(within(form).getByRole('radio', { name: 'Reject' }));
    await user.type(within(form).getByLabelText('Reason (required)'), 'Bad source row');
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/import-exceptions/{id}/decide')?.body,
      ).toEqual({
        decision: 'reject',
        reason: 'Bad source row',
        expectedRevision: 4,
      }),
    );
  });

  it('accepts an ambiguous balance with the amount finance approved, in minor units', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'validated'), {
      'GET /import-exceptions': page([importException('ambiguous_balance')]),
      'POST /import-exceptions/{id}/decide': ok(
        importException('ambiguous_balance', { status: 'decided', decision: 'accept' }),
      ),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Decide Ambiguous balance X-3' }));
    const form = screen.getByRole('form', { name: /Decide exception/ });
    await user.click(within(form).getByRole('radio', { name: 'Accept' }));
    await user.type(within(form).getByLabelText('Currency of the approved amount'), 'USD');
    await user.type(within(form).getByLabelText('Opening amount finance approved'), '24.00');
    await user.type(
      within(form).getByLabelText('Reason (required)'),
      'Finance approved the corrected balance',
    );
    await user.click(within(form).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/import-exceptions/{id}/decide')?.body,
      ).toEqual({
        decision: 'accept',
        reason: 'Finance approved the corrected balance',
        expectedRevision: 4,
        resolution: { amountMinor: 2400 },
      }),
    );
  });

  it('applies a reviewed batch, repeatable and without charges, and reports the outcomes', async () => {
    const user = userEvent.setup();
    let applied = false;
    const test = app(importBatch(BATCH_1, 'reviewed'), {
      'GET /import-batches/{id}': () =>
        fakeResponse(200, importBatch(BATCH_1, applied ? 'applied' : 'reviewed')),
      'POST /import-batches/{id}/apply': () => {
        applied = true;
        return fakeResponse(200, importBatch(BATCH_1, 'applied'));
      },
    });
    render(test.at(at));
    expect(
      await screen.findByText(/no payment is taken and no notice is sent/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply the batch' }));
    expect(
      await screen.findByText(
        /Batch applied: 2 created, 0 matched, 0 updated, 1 skipped, 0 exceptions/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Reconcile this batch' })).toBeInTheDocument();
    expect(test.fake.requests.find((r) => r.route === '/import-batches/{id}/apply')?.body).toEqual({
      expectedRevision: 2,
    });
  });

  it('aborts only with a reason and the expected revision', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'received'), {
      'POST /import-batches/{id}/abort': ok(importBatch(BATCH_1, 'aborted')),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Abort the batch' }));
    await user.click(screen.getByRole('button', { name: 'Confirm abort' }));
    expect(screen.getByText('Enter the reason for aborting this batch.')).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Reason for aborting (required)'),
      'Wrong source snapshot',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm abort' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/import-batches/{id}/abort')?.body,
      ).toEqual({
        reason: 'Wrong source snapshot',
        expectedRevision: 2,
      }),
    );
  });

  it('reports a stale revision with Reload', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'validated'), {
      'POST /import-batches/{id}/review': () =>
        fakeResponse(
          409,
          apiErrorBody('STALE_REVISION', {
            nextAction: 'reload_and_retry',
            message: 'The batch changed.',
          }),
        ),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Complete the review' }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        test.fake.requests.filter((r) => r.route === '/import-batches/{id}').length,
      ).toBeGreaterThan(1),
    );
  });

  it('§5.5: reconciles at four levels, lists discrepancies unnetted and records an area sign-off', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'applied'), {
      'POST /import-batches/{id}/reconciliation-reports': {
        status: 201,
        body: reconciliationReport(),
      },
      'POST /import-reconciliation-reports/{id}/approvals': ok(
        reconciliationReport({ revision: 2 }),
      ),
    });
    render(test.at(at));
    await user.click(await screen.findByRole('button', { name: 'Reconcile this batch' }));
    const levels = await screen.findByRole('region', { name: 'Reconciliation levels' });
    for (const level of [
      '1. Control totals',
      '2. Record identity',
      '3. Relationships',
      '4. Operational outcomes',
    ]) {
      expect(within(levels).getByRole('rowheader', { name: level })).toBeInTheDocument();
    }
    const discrepancies = screen.getByRole('region', { name: 'Discrepancies' });
    expect(within(discrepancies).getByText('AMOUNT_MISMATCH')).toBeInTheDocument();
    expect(within(discrepancies).getByText('-$1.00')).toBeInTheDocument();
    expect(
      screen.getAllByTestId('pending-note').some((n) => n.textContent?.includes('DEC-067')),
    ).toBe(true);
    expect(
      screen.getByRole('link', { name: `Open reconciliation report ${REPORT_1.slice(0, 8)}` }),
    ).toBeInTheDocument();

    const signOff = screen.getByRole('form', { name: 'Record an area sign-off' });
    await user.selectOptions(within(signOff).getByLabelText('Area (required)'), 'finance');
    await user.click(within(signOff).getByRole('radio', { name: 'Approve' }));
    await user.type(
      within(signOff).getByLabelText('Reason'),
      'Difference explained by a late refund',
    );
    await user.click(within(signOff).getByRole('button', { name: 'Record sign-off' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/import-reconciliation-reports/{id}/approvals')
          ?.body,
      ).toEqual({
        area: 'finance',
        decision: 'approved',
        expectedRevision: 1,
        reason: 'Difference explained by a late refund',
      }),
    );
  });

  it('appends a chunk of rows to a received batch with the expected revision', async () => {
    const user = userEvent.setup();
    const test = app(importBatch(BATCH_1, 'received'), {
      'POST /import-batches/{id}/rows': ok(
        importBatch(BATCH_1, 'received', { rowCount: 4, revision: 3 }),
      ),
    });
    render(test.at(at));
    const input = await screen.findByLabelText('Next chunk of the snapshot');
    const chunk = {
      rows: [{ entityType: 'credit', externalId: 'C-1', payload: { amountMinor: 500 } }],
    };
    await user.upload(
      input,
      new File([JSON.stringify(chunk)], 'chunk-2.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('1 rows, 0 CSV documents ready to append')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Append chunk' }));
    expect(await screen.findByText('Chunk staged: the batch holds 4 rows')).toBeInTheDocument();
    const post = test.fake.requests.find(
      (r) => r.route === '/import-batches/{id}/rows' && r.method === 'POST',
    );
    expect(post?.body).toEqual({ rows: chunk.rows, csv: [], expectedRevision: 2 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('shows a batch the viewer may not see as not available', async () => {
    render(
      createTestApp({
        routes: {
          'GET /import-batches/{id}': () =>
            fakeResponse(
              404,
              apiErrorBody('NOT_FOUND', {
                nextAction: 'verify_reference',
                message: 'import batch not found',
              }),
            ),
        },
      }).at(at),
    );
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByText(/import batch not found/)).toBeNull();
  });
});
