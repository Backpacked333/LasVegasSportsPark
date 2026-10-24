/**
 * SCR-S-45 Exports and stored runs: SPK-REPORT-007 (independent export permission, reproducible
 * after corrections), §4.14 (expiring, single-use exports; aggregate content only), SPK-UX-008
 * (empty, permission restriction, offline disabled, processing, success "download until",
 * stale "regenerate"), protected NOT_FOUND shown as not available, and the one-time token sent
 * only as a header, never in a URL.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPORT_1,
  RUN_1,
  RUN_2,
  exportCreated,
  ok,
  page,
  reportExport,
  reportRun,
  runSummary,
} from '../../../features/insight-admin/__tests__/fixtures';
import { setFileSaver, type DownloadedFile } from '../../../features/insight-admin/download';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp } from '../../../testing/test-app';

let restoreSaver: (() => void) | null = null;
afterEach(() => {
  restoreSaver?.();
  restoreSaver = null;
});

function app(routes: Record<string, FakeHandler> = {}, now?: () => Date) {
  return createTestApp({
    routes: {
      'GET /reports/runs': page([runSummary(RUN_1)]),
      ...routes,
    },
    now,
  });
}

async function createExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', {
      name: `Create export of Daily schedule run ${RUN_1.slice(0, 8)}`,
    }),
  );
}

describe('SCR-S-45 ExportsScreen', () => {
  it('lists stored runs and says exports contain aggregate figures only', async () => {
    render(app().at('/reports/exports'));
    const list = await screen.findByRole('list', { name: 'Stored runs' });
    expect(within(list).getByText(`Daily schedule · run ${RUN_1.slice(0, 8)}`)).toBeInTheDocument();
    expect(screen.getByText(/no person-level rows and no child information/)).toBeInTheDocument();
    expect(screen.getByTestId('no-session-exports')).toBeInTheDocument();
  });

  it('says so when there is no stored run to export', async () => {
    render(app({ 'GET /reports/runs': page([]) }).at('/reports/exports'));
    expect(await screen.findByRole('heading', { name: 'No stored runs' })).toBeInTheDocument();
  });

  it('creates an export with an idempotency key and shows it ready until its expiry', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/exports': { status: 201, body: exportCreated() },
      'GET /reports/exports/{id}': ok(reportExport('ready')),
    });
    render(test.at('/reports/exports'));
    await createExport(user);
    const list = await screen.findByRole('list', { name: 'Exports made on this page' });
    expect(await within(list).findByText('ready')).toBeInTheDocument();
    // Device time zone, named in the text (the export has no facility zone).
    expect(
      within(list).getByText(`Download until ${formatInstant('2026-10-25T12:00:00.000Z')}`),
    ).toBeInTheDocument();
    const post = test.fake.requests.find(
      (r) => r.route === '/reports/exports' && r.method === 'POST',
    );
    expect(post?.body).toEqual({ reportRunId: RUN_1, format: 'csv' });
    expect(post?.headers['idempotency-key']).toMatch(/^key-\d{8}$/);
  });

  it('SPK-REPORT-007: an export refused by its own permission is not available, separately from viewing', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /reports/exports': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
            }),
          ),
      }).at('/reports/exports'),
    );
    await createExport(user);
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(
      screen.getByText(/Exporting needs its own permission, checked separately/),
    ).toBeInTheDocument();
  });

  it('downloads once with the token in a header, never in the URL, and shows it downloaded', async () => {
    const user = userEvent.setup();
    const saved: DownloadedFile[] = [];
    restoreSaver = setFileSaver((file) => saved.push(file));
    let downloaded = false;
    const test = app({
      'POST /reports/exports': { status: 201, body: exportCreated() },
      'GET /reports/exports/{id}': () =>
        fakeResponse(200, reportExport(downloaded ? 'downloaded' : 'ready')),
      'GET /reports/exports/{id}/download': () => {
        downloaded = true;
        return fakeResponse(200, 'space,activities\nSpace A,12\n', {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="daily_schedule-2026-10-24.csv"',
        });
      },
    });
    render(test.at('/reports/exports'));
    await createExport(user);
    await user.click(
      await screen.findByRole('button', { name: `Download export ${EXPORT_1.slice(0, 8)}` }),
    );
    expect(
      await screen.findByText('Export downloaded as daily_schedule-2026-10-24.csv'),
    ).toBeInTheDocument();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toContain('Space A,12');
    const download = test.fake.requests.find((r) => r.route === '/reports/exports/{id}/download');
    expect(download?.headers['x-export-token']).toBe('spx_one-time-token-value');
    expect(download?.headers.authorization).toBe('Bearer staff-token');
    expect(
      test.fake.requests.every(
        (r) => !r.path.includes('spx_') && !JSON.stringify(r.query).includes('spx_'),
      ),
    ).toBe(true);
    expect(await screen.findByText('downloaded')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Download export ${EXPORT_1.slice(0, 8)}` }),
    ).toBeNull();
  });

  it('shows a refused download (already used) with its code and a reload', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/exports': { status: 201, body: exportCreated() },
      'GET /reports/exports/{id}': ok(reportExport('ready')),
      'GET /reports/exports/{id}/download': () =>
        fakeResponse(
          409,
          apiErrorBody('INVALID_TRANSITION', {
            nextAction: 'reload_current_state',
            message: 'This export was already downloaded.',
          }),
        ),
    });
    render(test.at('/reports/exports'));
    await createExport(user);
    await user.click(
      await screen.findByRole('button', { name: `Download export ${EXPORT_1.slice(0, 8)}` }),
    );
    expect(
      await screen.findByText('Error code: INVALID_TRANSITION. Reference: test-correlation-id'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('revokes an export with a reason and its expected revision', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/exports': { status: 201, body: exportCreated() },
      'GET /reports/exports/{id}': ok(reportExport('ready')),
      'POST /reports/exports/{id}/revoke': ok(reportExport('revoked', { revision: 2 })),
    });
    render(test.at('/reports/exports'));
    await createExport(user);
    await user.click(
      await screen.findByRole('button', { name: `Revoke export ${EXPORT_1.slice(0, 8)}` }),
    );
    await user.type(
      screen.getByLabelText('Reason for revoking (required)'),
      'Sent to the wrong person',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() =>
      expect(
        test.fake.requests.find((r) => r.route === '/reports/exports/{id}/revoke')?.body,
      ).toEqual({
        reason: 'Sent to the wrong person',
        expectedRevision: 1,
      }),
    );
  });

  it('treats an export past its expiry as expired, with no download', async () => {
    const user = userEvent.setup();
    render(
      app({
        'POST /reports/exports': { status: 201, body: exportCreated() },
        'GET /reports/exports/{id}': ok(
          reportExport('ready', { expiresAt: '2026-10-24T11:00:00.000Z' }),
        ),
      }).at('/reports/exports'),
    );
    await createExport(user);
    expect(
      await screen.findByText(`Expired at ${formatInstant('2026-10-24T11:00:00.000Z')}`),
    ).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download export/ })).toBeNull();
  });

  it('stale version: a reproduction that differs points to exporting the new run', async () => {
    const user = userEvent.setup();
    const test = app({
      'POST /reports/runs/{id}/reproduce': {
        status: 201,
        body: {
          originalRunId: RUN_1,
          originalDigest: 'a'.repeat(64),
          reproducedDigest: 'e'.repeat(64),
          matched: false,
          explanation: 'A correction was recorded before the as-of instant.',
          reproducedRun: reportRun(RUN_2, { reproducesRunId: RUN_1, reproductionMatched: false }),
        },
      },
    });
    render(test.at('/reports/exports'));
    await user.click(
      await screen.findByRole('button', { name: `Check reproduction of run ${RUN_1.slice(0, 8)}` }),
    );
    expect(await screen.findByText('Figures differ from the stored run')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: `Export the reproduced run ${RUN_2.slice(0, 8)}` }),
    ).toHaveAttribute('href', `/reports/exports?run=${RUN_2}`);
    const post = test.fake.requests.find((r) => r.route === '/reports/runs/{id}/reproduce');
    expect(post?.params).toEqual({ id: RUN_1 });
    expect(post?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('runs again with current data using the same parameters without the old as-of instant', async () => {
    const user = userEvent.setup();
    const test = app({ 'POST /reports/runs': { status: 201, body: reportRun(RUN_2) } });
    render(test.at('/reports/exports'));
    await user.click(await screen.findByRole('button', { name: 'Run again with current data' }));
    expect(await screen.findByText('New run stored')).toBeInTheDocument();
    expect(
      test.fake.requests.find((r) => r.route === '/reports/runs' && r.method === 'POST')?.body,
    ).toEqual({
      report: 'daily_schedule',
      parameters: { facilityId: expect.any(String), date: '2026-10-24' },
    });
  });

  it('disables creating exports offline', async () => {
    const test = app();
    render(test.at('/reports/exports'));
    const button = await screen.findByRole('button', {
      name: `Create export of Daily schedule run ${RUN_1.slice(0, 8)}`,
    });
    act(() => test.connectivity.set(false));
    await waitFor(() => expect(button).toBeDisabled());
  });

  it('preselects a run from the link and lists it once (SPK-UX-009)', async () => {
    render(
      app({
        'GET /reports/runs': page([runSummary(RUN_2), runSummary(RUN_1)]),
        'GET /reports/runs/{id}': ok(reportRun(RUN_2)),
      }).at(`/reports/exports?run=${RUN_2}`),
    );
    const selected = await screen.findByRole('list', { name: 'Selected run' });
    expect(
      within(selected).getByText(`Daily schedule · run ${RUN_2.slice(0, 8)}`),
    ).toBeInTheDocument();
    const stored = await screen.findByRole('list', { name: 'Stored runs' });
    const hrefs = within(stored)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/reports/runs/${RUN_1}`);
    expect(hrefs).not.toContain(`/reports/runs/${RUN_2}`);
  });

  it('shows a selected run the viewer may not see as not available, with no export form', async () => {
    render(
      app({
        'GET /reports/runs/{id}': () =>
          fakeResponse(404, apiErrorBody('NOT_FOUND', { nextAction: 'verify_reference' })),
      }).at(`/reports/exports?run=${RUN_2}`),
    );
    const section = await screen.findByRole('region', { name: 'Selected run' });
    expect(await within(section).findByTestId('state-unavailable')).toBeInTheDocument();
    expect(within(section).queryByRole('form')).toBeNull();
  });

  it('SPK-REPORT-002: a live-only run offers no reproduction check, only running again', async () => {
    render(
      app({ 'GET /reports/runs': page([runSummary(RUN_1, { pointInTime: 'none' })]) }).at(
        '/reports/exports',
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Run again with current data' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check reproduction/ })).toBeNull();
  });

  it('§4.9: an export whose request got no answer is retried with the same idempotency key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const test = app({
      'POST /reports/exports': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('connection dropped');
        return fakeResponse(201, exportCreated());
      },
      'GET /reports/exports/{id}': ok(reportExport('ready')),
    });
    render(test.at('/reports/exports'));
    await createExport(user);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const [first, second] = test.fake.requests.filter(
      (r) => r.route === '/reports/exports' && r.method === 'POST',
    );
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });
});

describe('SCR-S-45 ReportRunScreen', () => {
  it('shows the stored run exactly as produced, with its digest and figures', async () => {
    render(app({ 'GET /reports/runs/{id}': ok(reportRun(RUN_1)) }).at(`/reports/runs/${RUN_1}`));
    expect(await screen.findByText('a'.repeat(64))).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Daily schedule' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export or reproduce this run' })).toHaveAttribute(
      'href',
      `/reports/exports?run=${RUN_1}`,
    );
  });

  it('shows a protected run as not available without implying it exists', async () => {
    render(
      app({
        'GET /reports/runs/{id}': () =>
          fakeResponse(
            404,
            apiErrorBody('NOT_FOUND', {
              nextAction: 'verify_reference',
              message: 'report run not found',
            }),
          ),
      }).at(`/reports/runs/${RUN_2}`),
    );
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
    expect(screen.queryByText(/report run not found/)).toBeNull();
  });
});
