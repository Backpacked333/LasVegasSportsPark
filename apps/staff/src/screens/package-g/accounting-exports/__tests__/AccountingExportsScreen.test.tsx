/**
 * SCR-S-57 Accounting export batches (Package G; §3.16 Accounting, SPK-PAY-010, SPK-PAY-011,
 * DEC-016, DEC-081, DEC-022): turned off by default with batches readable, preparing a batch (an
 * unmapped account blocks it and links to proposing its mapping), submitting with the revision, a
 * timed-out submission kept unknown with the same key on retry, the API's unknown outcome shown as
 * recovery with its owner, canceling, and mappings proposed by one person and approved by another.
 */
import { CAPABILITY_PRESENTATION } from '@sportspark/api-client';
import {
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  BATCH_ID,
  MAPPING_B_ID,
  ME_PERSON,
  apiError,
  baseRoutes,
  batch,
  batchLine,
  mapping,
  ok,
  page,
  permissions,
} from '../../../../features/pos-access-accounting/__tests__/fixtures';
import { createTestApp } from '../../../../testing/test-app';

const BASE = '/finance/accounting-exports';
const BATCH_PATH = `${BASE}/batches/${BATCH_ID}`;
const ACCOUNTING = [
  'finance.manage_accounting_mappings',
  'finance.approve_accounting_mapping',
  'finance.export_accounting',
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...baseRoutes(),
    'GET /me/permissions': permissions(['accounting'], ACCOUNTING),
    'GET /accounting-export-batches': page([batch()]),
    'GET /accounting-export-batches/{id}': ok(
      batch({
        lines: [
          batchLine(),
          batchLine({
            id: '0192f1a0-0000-7000-8000-00000000c302',
            lineNumber: 2,
            ledgerAccount: 'pos_revenue',
            externalAccountRef: '4000-POS',
            debitMinor: 0,
            creditMinor: 542,
          }),
        ],
      }),
    ),
    'GET /accounting-mappings': page([mapping()]),
    ...extra,
  };
}

describe('SCR-S-57 AccountingExportsScreen', () => {
  it('DEC-016: opens from the Finance navigation turned off; batches stay readable, nothing is prepared', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: { ...routes(), 'GET /me/permissions': permissions([], ACCOUNTING) },
    });
    render(app.at('/finance'));
    const nav = await screen.findByRole('navigation', { name: 'Finance' });
    await user.click(
      within(nav).getByRole('link', { name: 'Accounting export batches (SCR-S-57)' }),
    );
    const pageEl = await screen.findByTestId('package-g-accounting-exports');
    expect(pageEl).toHaveAccessibleName('Accounting export batches');
    const notice = await within(pageEl).findByTestId('state-turned-off');
    expect(notice).toHaveTextContent('Accounting export turned off');
    expect(notice).toHaveTextContent(
      `(${CAPABILITY_PRESENTATION.accounting.decisions.join(', ')})`,
    );
    expect(await screen.findByRole('list', { name: 'Export batches' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Prepare a batch' })).toBeNull();
    // DEC-022: the connection itself stays a pending decision.
    expect(within(pageEl).getByTestId('state-pending-decision')).toHaveTextContent('DEC-022');
  });

  it('SPK-PAY-010: lists batches with their UTC period, status and per-currency totals', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(BASE));
    const list = await screen.findByRole('list', { name: 'Export batches' });
    const item = within(list).getByRole('listitem');
    expect(item).toHaveTextContent('prepared: not sent');
    expect(item).toHaveTextContent('2 lines · USD: debit $5.42, credit $5.42');
    expect(within(item).getByRole('link', { name: /^Batch for Thu, Oct 1, 2026/ })).toHaveAttribute(
      'href',
      BATCH_PATH,
    );
    expect(item).toHaveTextContent('UTC');
  });

  it('SPK-PAY-011: an unmapped account blocks preparation and links to proposing its mapping', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /accounting-export-batches': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'These accounts have no approved mapping: pos_revenue, taxes_payable.',
          nextAction: 'resolve_conflict',
          details: {
            code: 'ACCOUNTING_MAPPING_REQUIRED',
            accounts: ['pos_revenue', 'taxes_payable'],
          },
        }),
      }),
    });
    render(app.at(BASE));
    const form = await screen.findByRole('form', { name: 'Prepare a batch' });
    await user.type(within(form).getByLabelText(/^Period start \(UTC\)/), '2026-10-01T00:00');
    await user.type(within(form).getByLabelText(/^Period end \(UTC\)/), '2026-10-08T00:00');
    await user.click(within(form).getByRole('button', { name: 'Prepare the batch' }));
    const refusal = await within(form).findByTestId('state-validation');
    expect(refusal).toHaveTextContent('Unmapped accounts: nothing was prepared');
    const accounts = within(refusal).getByRole('list', {
      name: 'Accounts without an approved mapping',
    });
    expect(
      within(accounts).getByRole('link', { name: 'Propose a mapping for taxes_payable' }),
    ).toHaveAttribute('href', `${BASE}/mappings?propose=taxes_payable`);
    const call = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/accounting-export-batches',
    );
    expect(call?.body).toEqual({
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-10-08T00:00:00.000Z',
    });
  });

  it('prepares a batch and opens it; a period with nothing left says so', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /accounting-export-batches': () => {
          calls += 1;
          return calls === 1
            ? fakeResponse(409, {
                code: 'RESOURCE_CONFLICT',
                message: 'No journal entry of this period is left to export.',
                correlationId: 'c',
                nextAction: 'resolve_conflict',
                details: { code: 'NOTHING_TO_EXPORT' },
              })
            : fakeResponse(201, batch());
        },
      }),
    });
    render(app.at(BASE));
    const form = await screen.findByRole('form', { name: 'Prepare a batch' });
    await user.type(within(form).getByLabelText(/^Period start \(UTC\)/), '2026-10-08T00:00');
    await user.type(within(form).getByLabelText(/^Period end \(UTC\)/), '2026-10-01T00:00');
    await user.click(within(form).getByRole('button', { name: 'Prepare the batch' }));
    expect(within(form).getByText('The period ends after it starts.')).toBeInTheDocument();
    const end = within(form).getByLabelText(/^Period end \(UTC\)/);
    await user.clear(end);
    await user.type(end, '2026-10-15T00:00');
    await user.click(within(form).getByRole('button', { name: 'Prepare the batch' }));
    expect(await within(form).findByTestId('state-validation')).toHaveTextContent(
      'Nothing to export in this period',
    );
    await user.click(within(form).getByRole('button', { name: 'Prepare the batch' }));
    expect(
      await screen.findByRole('heading', { name: `Export batch ${BATCH_ID.slice(0, 8)}` }),
    ).toBeInTheDocument();
  });

  it('a batch lists its lines and submits with the revision it was read at', async () => {
    const user = userEvent.setup();
    let submitted = false;
    const app = createTestApp({
      routes: routes({
        'GET /accounting-export-batches/{id}': () =>
          fakeResponse(
            200,
            submitted
              ? batch({
                  status: 'accepted',
                  providerReference: 'ACC-REF-1',
                  submittedAt: '2026-10-24T12:00:00.000Z',
                  decidedAt: '2026-10-24T12:00:00.000Z',
                  revision: 3,
                  lines: [batchLine()],
                })
              : batch({ lines: [batchLine()] }),
          ),
        'POST /accounting-export-batches/{id}/submit': () => {
          submitted = true;
          return fakeResponse(201, batch({ status: 'accepted', providerReference: 'ACC-REF-1' }));
        },
      }),
    });
    render(app.at(BATCH_PATH));
    const table = await screen.findByRole('table', { name: 'Batch lines' });
    expect(within(table).getByText('Cash on hand (cash_on_hand) to 1000-CASH')).toBeInTheDocument();
    expect(within(table).getByText('in this export')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit the batch' }));
    expect(await screen.findByText('Accepted by the accounting connection')).toBeInTheDocument();
    expect(screen.getByText(/Reference: ACC-REF-1/)).toBeInTheDocument();
    const call = app.fake.requests.find(
      (r) => r.route === '/accounting-export-batches/{id}/submit',
    );
    expect(call?.body).toEqual({ expectedRevision: 1 });
    expect(screen.queryByRole('button', { name: 'Submit the batch' })).toBeNull();
  });

  it('§4.11: a submission with no answer is locked and Try again resends it with the same key', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const app = createTestApp({
      routes: routes({
        'POST /accounting-export-batches/{id}/submit': () => {
          calls += 1;
          if (calls === 1) throw new TypeError('connection dropped');
          return fakeResponse(201, batch({ status: 'submitted' }));
        },
      }),
    });
    render(app.at(BATCH_PATH));
    await user.click(await screen.findByRole('button', { name: 'Submit the batch' }));
    expect(await screen.findByTestId('state-offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit the batch' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toBe(2));
    const [first, second] = app.fake.requests.filter(
      (r) => r.route === '/accounting-export-batches/{id}/submit',
    );
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toEqual(first?.body);
  });

  it('an unknown outcome is recovery required with its owner, never resent from here', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /accounting-export-batches/{id}': ok(
          batch({
            status: 'unknown',
            submittedAt: '2026-10-24T11:00:00.000Z',
            lastError: 'the accounting connection gave no answer',
            lines: [batchLine()],
          }),
        ),
      }),
    });
    render(app.at(BATCH_PATH));
    const recovery = await screen.findByTestId('state-recovery');
    expect(recovery).toHaveTextContent('Recovery required: submission outcome unknown');
    expect(recovery).toHaveTextContent('never sends a second batch');
    expect(recovery).toHaveTextContent('Owner: the finance operator queue.');
    expect(recovery).toHaveTextContent('the accounting connection gave no answer');
    expect(screen.queryByRole('button', { name: 'Submit the batch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel the batch' })).toBeNull();
  });

  it('a rejected batch lists its lines as not exported, to be exported again', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /accounting-export-batches/{id}': ok(
          batch({
            status: 'rejected',
            lastError: 'unknown external account 4000-POS',
            lines: [batchLine({ live: false })],
          }),
        ),
      }),
    });
    render(app.at(BATCH_PATH));
    expect(await screen.findByTestId('state-rejected')).toHaveTextContent(
      'unknown external account 4000-POS',
    );
    expect(
      screen.getByText('1 of 1 lines are not exported by this batch and can be exported again.'),
    ).toBeInTheDocument();
    expect(screen.getByText('not exported: can be exported again')).toBeInTheDocument();
  });

  it('cancels a prepared batch with a reason, even while the switch is off (never gated)', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': permissions([], ACCOUNTING),
        'POST /accounting-export-batches/{id}/cancel': ok(batch({ status: 'canceled' })),
      }),
    });
    render(app.at(BATCH_PATH));
    await user.click(await screen.findByRole('button', { name: 'Cancel the batch' }));
    expect(screen.queryByRole('button', { name: 'Submit the batch' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Cancel the batch' });
    await user.type(within(form).getByLabelText(/^Reason for canceling/), 'Wrong period');
    await user.click(within(form).getByRole('button', { name: 'Cancel the batch' }));
    await waitFor(() =>
      expect(
        app.fake.requests.some((r) => r.route === '/accounting-export-batches/{id}/cancel'),
      ).toBe(true),
    );
    const call = app.fake.requests.find(
      (r) => r.route === '/accounting-export-batches/{id}/cancel',
    );
    expect(call?.body).toEqual({ reason: 'Wrong period' });
  });

  it('a submission refused because the switch was turned off meanwhile shows "turned off"', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /accounting-export-batches/{id}/submit': () =>
          fakeResponse(403, capabilityDisabledBody('accounting', ['DEC-016', 'DEC-081'])),
      }),
    });
    render(app.at(BATCH_PATH));
    await user.click(await screen.findByRole('button', { name: 'Submit the batch' }));
    expect(
      await screen.findByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/),
    ).toBeInTheDocument();
  });

  it('§4.10: a batch the API does not show is "not available"', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /accounting-export-batches/{id}': apiError(404, 'NOT_FOUND', {
          nextAction: 'verify_reference',
        }),
      }),
    });
    render(app.at(BATCH_PATH));
    expect(await screen.findByTestId('state-unavailable')).toHaveTextContent('Not available');
  });

  it('proposes a mapping prefilled from the refused preparation; lists the accounts still unmapped', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /accounting-mappings': ok(
          mapping({ id: MAPPING_B_ID, ledgerAccount: 'taxes_payable', status: 'proposed' }),
          201,
        ),
      }),
    });
    render(app.at(`${BASE}/mappings?propose=taxes_payable`));
    const unmapped = await screen.findByRole('list', { name: 'Unmapped ledger accounts' });
    expect(within(unmapped).getByText('Taxes payable (taxes_payable)')).toBeInTheDocument();
    expect(within(unmapped).queryByText('Point-of-sale revenue (pos_revenue)')).toBeNull();
    const form = screen.getByRole('form', { name: 'Propose a mapping' });
    expect(within(form).getByLabelText(/^Ledger account/)).toHaveValue('taxes_payable');
    await user.type(within(form).getByLabelText(/^External account/), '2200-TAX');
    await user.click(within(form).getByRole('button', { name: 'Propose the mapping' }));
    expect(await within(form).findByRole('status')).toHaveTextContent(
      'Mapping of taxes_payable proposed. Another person approves it.',
    );
    const call = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/accounting-mappings',
    );
    expect(call?.body).toEqual({ ledgerAccount: 'taxes_payable', externalAccountRef: '2200-TAX' });
  });

  it('four eyes: the proposer is not offered the approval; another person approves with the revision', async () => {
    const user = userEvent.setup();
    const mine = mapping({
      id: MAPPING_B_ID,
      ledgerAccount: 'fees_payable',
      status: 'proposed',
      proposedByPersonId: ME_PERSON,
      approvedByPersonId: null,
      approvedAt: null,
      revision: 1,
    });
    const theirs = mapping({
      ledgerAccount: 'taxes_payable',
      status: 'proposed',
      approvedByPersonId: null,
      approvedAt: null,
      revision: 1,
    });
    const app = createTestApp({
      routes: routes({
        'GET /accounting-mappings': page([mine, theirs]),
        'POST /accounting-mappings/{id}/approve': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'A mapping is approved by someone other than its proposer.',
          nextAction: 'resolve_conflict',
          details: { code: 'FOUR_EYES_REQUIRED' },
        }),
      }),
    });
    render(app.at(`${BASE}/mappings`));
    const list = await screen.findByRole('list', { name: 'Account mappings' });
    await waitFor(() =>
      expect(
        within(list).getByText(
          'You proposed this mapping: another person approves it (four eyes).',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      within(list).queryByRole('button', { name: 'Approve the mapping of fees_payable' }),
    ).toBeNull();
    await user.click(
      within(list).getByRole('button', { name: 'Approve the mapping of taxes_payable' }),
    );
    expect(await within(list).findByTestId('state-validation')).toHaveTextContent(
      'Another person approves this',
    );
    const call = app.fake.requests.find((r) => r.route === '/accounting-mappings/{id}/approve');
    expect(call?.body).toEqual({ expectedRevision: 1 });
  });

  it('retires an approved mapping with a reason and its revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /accounting-mappings/{id}/retire': ok(mapping({ status: 'retired' })),
      }),
    });
    render(app.at(`${BASE}/mappings`));
    const list = await screen.findByRole('list', { name: 'Account mappings' });
    await user.click(
      within(list).getByRole('button', { name: 'Retire the mapping of pos_revenue' }),
    );
    const form = within(list).getByRole('form', { name: 'Retire the mapping of pos_revenue' });
    expect(form).toHaveTextContent('entries on this account are not exported');
    await user.type(within(form).getByLabelText(/^Reason/), 'Chart of accounts changed');
    await user.click(within(form).getByRole('button', { name: 'Retire it' }));
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/accounting-mappings/{id}/retire')).toBe(
        true,
      ),
    );
    const call = app.fake.requests.find((r) => r.route === '/accounting-mappings/{id}/retire');
    expect(call?.body).toEqual({ reason: 'Chart of accounts changed', expectedRevision: 2 });
  });

  it('without the export permission no batch is prepared and the permission is named', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /me/permissions': permissions(['accounting'], []) }),
    });
    render(app.at(BASE));
    expect(
      await screen.findByText('Preparing batches needs the permission finance.export_accounting.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Prepare a batch' })).toBeNull();
  });
});
