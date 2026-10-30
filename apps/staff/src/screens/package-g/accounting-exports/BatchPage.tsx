/**
 * SCR-S-57 one export batch (§3.16 Accounting "export or integration batches, reconciliation,
 * correction handling"; SPK-PAY-010, SPK-PAY-011, §4.11): the batch and its lines
 * (`GET /v1/accounting-export-batches/{id}`), and while it is prepared, submitting it with the
 * revision it was read at (`POST .../submit`, finance.export_accounting; the API calls the
 * connection outside any transaction) or canceling it with a reason (`POST .../cancel`, never
 * gated; its entries can then be exported again).
 *
 * Outcomes are the API's: accepted (with the connection's reference), rejected (the entries can be
 * exported again in a new batch; every line shows whether it is still live), and unknown: recovery
 * required, owned by the finance operator queue, reconciled by the API's job, which asks the
 * connection again and never sends a second batch. A submission that gets no answer here is
 * locked: "Try again" resends the same request with the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { LinkNotAvailable, useRecordParam } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { BATCH_STATUS, ledgerAccountLabel } from '../../../features/pos-access-accounting/labels';
import { ACCOUNTING_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import {
  formatInstant,
  formatMoney,
  shortRef,
} from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { periodText, totalsText } from './BatchesPage';
import { BATCH_PREFIX, BATCHES_PREFIX } from './paths';

type Batch = Schema<'AccountingExportBatch'>;

const BATCH_COMMAND = { invalidate: [BATCH_PREFIX, BATCHES_PREFIX] } as const;

export function BatchPage() {
  const batchId = useRecordParam('batchId');
  if (!batchId) return <LinkNotAvailable />;
  return <BatchView batchId={batchId} />;
}

function BatchView({ batchId }: { batchId: string }) {
  const batch = useApiQuery({
    path: '/accounting-export-batches/{id}',
    request: { path: { id: batchId } },
  });
  return (
    <section aria-labelledby="accounting-batch-title">
      <h3 id="accounting-batch-title">Export batch {shortRef(batchId)}</h3>
      <QueryBoundary
        query={batch}
        label="the export batch"
        empty={{ title: '', description: '' }}
        unavailableOffline={['submitting', 'canceling']}
      >
        {(data) => <BatchBody batch={data} />}
      </QueryBoundary>
    </section>
  );
}

function Outcome({ batch }: { batch: Batch }) {
  switch (batch.status) {
    case 'unknown':
      return (
        <section className="state" aria-live="polite" data-testid="state-recovery">
          <StatusBadge tone="warning" label="Recovery required: submission outcome unknown" />
          <p>
            The accounting connection gave no answer. The API&apos;s reconciliation asks it again
            and never sends a second batch; nothing is resent from here. Owner: the finance operator
            queue.
          </p>
          {batch.lastError ? <p className="caption">Last error: {batch.lastError}</p> : null}
        </section>
      );
    case 'rejected':
      return (
        <section className="state" aria-live="polite" data-testid="state-rejected">
          <StatusBadge tone="danger" label="Rejected by the accounting connection" />
          <p>
            Its entries were not exported and can be exported again in a new batch; correct the
            cause first.
          </p>
          {batch.lastError ? <p className="caption">Reason given: {batch.lastError}</p> : null}
        </section>
      );
    case 'submitted':
      return (
        <p role="status">
          <StatusBadge tone="info" label="Submitted: awaiting the connection's answer" />
        </p>
      );
    case 'accepted':
      return (
        <p role="status">
          <StatusBadge tone="success" label="Accepted by the accounting connection" />{' '}
          {batch.providerReference ? `Reference: ${batch.providerReference}` : null}
        </p>
      );
    default:
      return null;
  }
}

function BatchBody({ batch }: { batch: Batch }) {
  const offer = useOffer();
  const allowed = offer.allowed(ACCOUNTING_ACTIONS.exportAccounting);
  const prepared = batch.status === 'prepared';
  return (
    <>
      <p>
        <StatusBadge {...BATCH_STATUS[batch.status]} />
      </p>
      <Outcome batch={batch} />
      <Facts
        label="Export batch"
        items={[
          ['Period (UTC)', periodText(batch)],
          ['Lines', String(batch.lineCount)],
          ['Totals', totalsText(batch)],
          ['Checksum', <code key="c">{batch.checksum}</code>],
          [
            'Prepared',
            <span key="p">
              {formatInstant(batch.preparedAt, 'UTC')} by{' '}
              <PersonName id={batch.preparedByPersonId} fallback="Staff" />
            </span>,
          ],
          ['Submitted', batch.submittedAt ? formatInstant(batch.submittedAt, 'UTC') : 'Not sent'],
          ['Answered', batch.decidedAt ? formatInstant(batch.decidedAt, 'UTC') : 'No answer yet'],
          ...(batch.canceledAt
            ? ([
                ['Canceled', formatInstant(batch.canceledAt, 'UTC')],
                ['Cancel reason', batch.cancelReason ?? 'Not stated'],
              ] as [string, string][])
            : []),
        ]}
      />
      {prepared && allowed && offer.capabilityOn('accounting') ? (
        <SubmitBatch batch={batch} />
      ) : null}
      {prepared && allowed ? <CancelBatch batch={batch} /> : null}
      <Lines batch={batch} />
    </>
  );
}

function SubmitBatch({ batch }: { batch: Batch }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const command = useApiCommand('post', '/accounting-export-batches/{id}/submit', BATCH_COMMAND);
  const intent = useIntentForm(command);
  return (
    <div className="rf-panel">
      <h4>Submit to the accounting connection</h4>
      <p>
        Sends this batch once. If no answer comes back, its outcome is unknown and it is reconciled,
        never sent again.
      </p>
      <Button
        busy={command.isProcessing}
        disabled={!online || intent.locked}
        onClick={() =>
          void intent.send({ path: { id: batch.id }, body: { expectedRevision: batch.revision } })
        }
      >
        Submit the batch
      </Button>
      <OfflineCaption action="submitting the batch" />
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          void queryClient.invalidateQueries({ queryKey: BATCH_PREFIX });
        }}
      />
    </div>
  );
}

function CancelBatch({ batch }: { batch: Batch }) {
  const online = useOnline();
  const command = useApiCommand('post', '/accounting-export-batches/{id}/cancel', BATCH_COMMAND);
  return (
    <div>
      <ReasonAction
        label="Cancel the batch"
        confirmLabel="Cancel the batch"
        reasonLabel="Reason for canceling"
        explanation="A canceled batch is never sent; its entries can be exported again."
        busy={command.isProcessing}
        disabled={!online}
        onConfirm={async (reason) => {
          try {
            await command.submit({ path: { id: batch.id }, body: { reason } });
            return true;
          } catch {
            return false;
          }
        }}
      />
      <CommandError error={command.error} />
    </div>
  );
}

function Lines({ batch }: { batch: Batch }) {
  const lines = batch.lines ?? [];
  if (lines.length === 0) return <p className="caption">No lines are listed for this batch.</p>;
  const notLive = lines.filter((l) => !l.live).length;
  return (
    <section aria-labelledby="accounting-lines-title">
      <h4 id="accounting-lines-title">Lines</h4>
      {notLive > 0 ? (
        <p>
          {notLive} of {lines.length} lines are not exported by this batch and can be exported
          again.
        </p>
      ) : null}
      <div className="rf-table-wrap">
        <table className="rf-table" aria-label="Batch lines">
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Account</th>
              <th scope="col">Debit</th>
              <th scope="col">Credit</th>
              <th scope="col">Posted (UTC)</th>
              <th scope="col">Export</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.lineNumber}
                  <span className="caption"> {l.memo}</span>
                </td>
                <td>
                  {ledgerAccountLabel(l.ledgerAccount)} to {l.externalAccountRef}
                </td>
                <td>{l.debitMinor ? formatMoney(l.debitMinor, l.currency) : ''}</td>
                <td>{l.creditMinor ? formatMoney(l.creditMinor, l.currency) : ''}</td>
                <td>{formatInstant(l.postedAt, 'UTC')}</td>
                <td>
                  {l.live ? (
                    <StatusBadge tone="info" label="in this export" />
                  ) : (
                    <StatusBadge tone="neutral" label="not exported: can be exported again" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
