/**
 * SCR-S-48 Migration imports: §5.4 batches retain source, timestamp, checksum, transformation
 * version and row outcomes; repeatable re-import marked (SPK-AT-024); staging from the extraction's
 * staging document with an idempotency key; staged personal data never shown; DEC-014 pending.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  BATCH_1,
  BATCH_2,
  importBatch,
  ok,
  page,
} from '../../../features/insight-admin/__tests__/fixtures';
import { createTestApp } from '../../../testing/test-app';

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /import-batches': page([
        importBatch(BATCH_1, 'applied'),
        importBatch(BATCH_2, 'received', { sameChecksumBatchIds: [BATCH_1] }),
      ]),
      ...routes,
    },
  });
}

const STAGING = {
  rows: [
    {
      entityType: 'person',
      externalId: 'P-1',
      payload: { givenName: 'Childname', familyName: 'Surname', dateOfBirth: '2016-05-01' },
    },
  ],
  controlTotals: { counts: { person: 1 }, amounts: [] },
  extraction: { tool: 'extract-script' },
};

function stagingFile(content: unknown = STAGING) {
  return new File(
    [typeof content === 'string' ? content : JSON.stringify(content)],
    'snapshot.json',
    {
      type: 'application/json',
    },
  );
}

describe('SCR-S-48 MigrationImportsScreen', () => {
  it('lists batches with source, snapshot, checksum, transformation, status and outcomes', async () => {
    render(app().at('/admin/migration'));
    const list = await screen.findByRole('list', { name: 'Import batches' });
    const [applied, received] = within(list).getAllByRole('listitem') as HTMLElement[];
    expect(within(applied!).getByText('applied')).toBeInTheDocument();
    expect(within(applied!).getByText(/transformation staging-v1\.0/)).toBeInTheDocument();
    expect(within(applied!).getByText(`Checksum ${'c'.repeat(64)}`)).toBeInTheDocument();
    expect(
      within(applied!).getByText(/2 created, 0 matched, 0 updated, 1 skipped, 0 exceptions/),
    ).toBeInTheDocument();
    expect(within(received!).getByText('received')).toBeInTheDocument();
    expect(within(received!).getByText('Re-import of the same snapshot')).toBeInTheDocument();
    expect(within(received!).getByRole('link')).toHaveAttribute(
      'href',
      `/admin/migration/batches/${BATCH_2}`,
    );
    expect(screen.getByTestId('pending-note')).toHaveTextContent('DEC-014');
  });

  it('says so when there is no batch yet', async () => {
    render(app({ 'GET /import-batches': page([]) }).at('/admin/migration'));
    expect(await screen.findByRole('heading', { name: 'No import batches' })).toBeInTheDocument();
  });

  it('stages a snapshot from the staging document and opens the new batch', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /import-batches': { status: 201, body: importBatch(BATCH_2, 'received') },
      'GET /import-batches/{id}': ok(importBatch(BATCH_2, 'received')),
      'GET /import-exceptions': page([]),
      'GET /import-batches/{id}/rows': page([]),
    });
    render(test.at('/admin/migration'));
    const form = await screen.findByRole('form', { name: 'Stage a snapshot' });
    await user.type(within(form).getByLabelText('Source system (required)'), 'legacy-registration');
    await user.type(
      within(form).getByLabelText('Snapshot taken at (required)'),
      '2026-10-20T08:00',
    );
    await user.type(
      within(form).getByLabelText('Transformation version (required)'),
      'staging-v1.0',
    );
    await user.upload(within(form).getByLabelText('Staging document (required)'), stagingFile());
    expect(
      await within(form).findByText('snapshot.json: 1 rows, 0 CSV documents'),
    ).toBeInTheDocument();
    // The staged personal data is sent, never displayed.
    expect(screen.queryByText(/Childname/)).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Stage snapshot' }));
    expect(await screen.findByRole('heading', { name: 'Import batch' })).toBeInTheDocument();
    const post = test.fake.requests.find(
      (r) => r.route === '/import-batches' && r.method === 'POST',
    );
    expect(post?.body).toMatchObject({
      sourceSystem: 'legacy-registration',
      transformationVersion: 'staging-v1.0',
      controlTotals: STAGING.controlTotals,
      rows: STAGING.rows,
      csv: [],
      extraction: { tool: 'extract-script' },
    });
    expect(typeof (post?.body as { snapshotTakenAt: string }).snapshotTakenAt).toBe('string');
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('refuses a file that is not a staging document before sending anything', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/migration'));
    const form = await screen.findByRole('form', { name: 'Stage a snapshot' });
    await user.upload(
      within(form).getByLabelText('Staging document (required)'),
      stagingFile('not json'),
    );
    expect(await within(form).findByText(/The file is not JSON/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Stage snapshot' }));
    expect(
      within(form).getByText('A lower-case identifier, for example legacy-registration.'),
    ).toBeInTheDocument();
    expect(
      test.fake.requests.some((r) => r.route === '/import-batches' && r.method === 'POST'),
    ).toBe(false);
  });

  it('shows the API refusal of a duplicate snapshot and keeps the entries', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /import-batches': () =>
          fakeResponse(
            400,
            apiErrorBody('VALIDATION_FAILED', {
              nextAction: 'correct_input',
              message: 'The snapshot lists the same external record more than once.',
            }),
          ),
      }).at('/admin/migration'),
    );
    const form = await screen.findByRole('form', { name: 'Stage a snapshot' });
    await user.type(within(form).getByLabelText('Source system (required)'), 'legacy-registration');
    await user.type(
      within(form).getByLabelText('Snapshot taken at (required)'),
      '2026-10-20T08:00',
    );
    await user.type(
      within(form).getByLabelText('Transformation version (required)'),
      'staging-v1.0',
    );
    await user.upload(within(form).getByLabelText('Staging document (required)'), stagingFile());
    await within(form).findByText('snapshot.json: 1 rows, 0 CSV documents');
    await user.click(within(form).getByRole('button', { name: 'Stage snapshot' }));
    expect(
      await screen.findByText('The snapshot lists the same external record more than once.'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Source system (required)')).toHaveValue(
      'legacy-registration',
    );
  });

  it('shows batches the viewer may not see as not available to them', async () => {
    render(
      app({
        'GET /import-batches': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
            }),
          ),
      }).at('/admin/migration'),
    );
    await waitFor(() => expect(screen.getByText('Not available to you')).toBeInTheDocument());
  });
});
