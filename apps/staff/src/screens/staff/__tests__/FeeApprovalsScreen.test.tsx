/**
 * SCR-S-34 Fee and hours approvals: SPK-STAFF-006 (assignment, rate basis, submitted amount,
 * approver, adjustment history, export status), §1.7 (no payroll: never "Paid"), per-submission
 * commands with the expected revision, a failed export retried with the same idempotency key.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignmentRecord,
  feeSubmission,
  OFFICIAL,
  nameEntry,
  oneFacilityMe,
  personNames,
} from '../../../features/operations/testing';
import { createTestApp } from '../../../testing/test-app';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /me': oneFacilityMe(),
    'GET /fee-submissions': { status: 200, body: { items: [feeSubmission()], nextCursor: null } },
    'GET /assignments/{id}': { status: 200, body: assignmentRecord({ status: 'completed' }) },
    'GET /person-names': personNames([nameEntry(OFFICIAL, 'Jordan', 'Lee', 'adult')]),
    ...extra,
  };
}

describe('SCR-S-34 FeeApprovalsScreen', () => {
  beforeEach(() => window.localStorage.clear());

  it('SPK-STAFF-006: shows the rate basis, amounts and export status, and approves with the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /fee-submissions/{id}/approve': {
          status: 200,
          body: feeSubmission({ status: 'approved' }),
        },
      }),
    });
    render(app.at('/staff/fees'));
    const item = await screen.findByRole('listitem', {
      name: 'Jordan Lee: U12 Red v Blue: Referee',
    });
    expect(
      within(item).getByText('Per assignment: $25.00 (Referee rate card)'),
    ).toBeInTheDocument();
    expect(
      within(item).getByText(/Submitted \$30\.00; computed from the rate basis \$25\.00/),
    ).toBeInTheDocument();
    expect(
      within(item).getByText('Submitted amount differs from the rate basis'),
    ).toBeInTheDocument();
    expect(within(item).getByText('Export: not exported')).toBeInTheDocument();
    expect(screen.queryByText(/\bPaid\b/)).toBeNull();
    expect(screen.getByText(/DEC-011, DEC-052/)).toBeInTheDocument();
    await user.click(
      within(item).getByRole('button', { name: 'Approve Jordan Lee: U12 Red v Blue: Referee' }),
    );
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/fee-submissions/{id}/approve')?.body,
      ).toEqual({
        expectedRevision: 2,
      }),
    );
  });

  it('SPK-UX-008 stale version: Reload re-reads the list and the next approve carries the new revision', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let approvals = 0;
    const app = createTestApp({
      routes: routes({
        'GET /fee-submissions': () => {
          reads += 1;
          return fakeResponse(200, {
            items: [feeSubmission(reads > 1 ? { revision: 3 } : {})],
            nextCursor: null,
          });
        },
        'POST /fee-submissions/{id}/approve': () => {
          approvals += 1;
          return approvals === 1
            ? fakeResponse(409, apiErrorBody('STALE_REVISION', { nextAction: 'reload_and_retry' }))
            : fakeResponse(200, feeSubmission({ status: 'approved', revision: 4 }));
        },
      }),
    });
    render(app.at('/staff/fees'));
    const name = 'Approve Jordan Lee: U12 Red v Blue: Referee';
    await user.click(await screen.findByRole('button', { name }));
    await user.click(await screen.findByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads).toBe(2));
    await user.click(await screen.findByRole('button', { name }));
    await waitFor(() => expect(approvals).toBe(2));
    const posts = app.fake.requests.filter((r) => r.route === '/fee-submissions/{id}/approve');
    expect(posts[1]?.body).toEqual({ expectedRevision: 3 });
    expect(posts[1]?.headers['idempotency-key']).not.toBe(posts[0]?.headers['idempotency-key']);
  });

  it('adjusts with an amount in minor units and a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /fee-submissions/{id}/adjust': {
          status: 200,
          body: feeSubmission({ status: 'adjusted' }),
        },
      }),
    });
    render(app.at('/staff/fees'));
    const item = await screen.findByRole('listitem', {
      name: 'Jordan Lee: U12 Red v Blue: Referee',
    });
    await user.click(
      within(item).getByRole('button', { name: 'Adjust Jordan Lee: U12 Red v Blue: Referee' }),
    );
    const form = within(item).getByRole('form', { name: 'Adjust the fee for Jordan Lee' });
    await user.type(within(form).getByLabelText('Approved amount (USD)'), '27.5x');
    await user.click(within(form).getByRole('button', { name: 'Approve adjusted amount' }));
    expect(
      within(form).getByText('Enter an amount in USD, for example 25.00.'),
    ).toBeInTheDocument();
    expect(within(form).getByText('A reason is required.')).toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Approved amount (USD)'));
    await user.type(within(form).getByLabelText('Approved amount (USD)'), '27.50');
    await user.type(
      within(form).getByLabelText('Reason'),
      'Ten minutes of extra time at the hourly rate',
    );
    await user.click(within(form).getByRole('button', { name: 'Approve adjusted amount' }));
    await waitFor(() =>
      expect(
        app.fake.requests.find((r) => r.route === '/fee-submissions/{id}/adjust')?.body,
      ).toEqual({
        amountMinor: 2750,
        reason: 'Ten minutes of extra time at the hourly rate',
        expectedRevision: 2,
      }),
    );
  });

  it('retries a failed export with the same idempotency key and reports what was exported', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /fee-export-batches': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(
                503,
                apiErrorBody('INTEGRATION_UNAVAILABLE', { nextAction: 'retry_later' }),
              )
            : fakeResponse(201, {
                id: '0192f1a0-0000-7000-8000-0000000002c1',
                currency: 'USD',
                submissionCount: 2,
                totalMinor: 5500,
                lines: [],
                note: null,
                createdBy: {
                  kind: 'staff',
                  accountId: null,
                  personId: null,
                  actorLabel: 'Finance (Avery)',
                },
                operationId: null,
                createdAt: '2026-10-24T12:00:00.000Z',
              });
        },
      }),
    });
    render(app.at('/staff/fees'));
    await screen.findByRole('list', { name: 'Fee submissions' });
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Exported: 2 submissions')).toBeInTheDocument();
    expect(screen.getByText(/Total \$55\.00/)).toBeInTheDocument();
    const [first, second] = app.fake.requests.filter((r) => r.route === '/fee-export-batches');
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(first?.body).toEqual({ currency: 'USD' });
  });

  it('is empty when nothing is submitted', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /fee-submissions': { status: 200, body: { items: [], nextCursor: null } },
      }),
    });
    render(app.at('/staff/fees'));
    expect(await screen.findByText('Nothing submitted')).toBeInTheDocument();
  });
});
