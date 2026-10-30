/**
 * SCR-S-57 export batches (§3.16 Accounting "export or integration batches"; SPK-PAY-010,
 * SPK-PAY-011): batches by status (`GET /v1/accounting-export-batches`, paged), each with its
 * period, line count and per-currency debit and credit totals, and preparing one from the period's
 * journal entries not yet exported (`POST /v1/accounting-export-batches`,
 * finance.export_accounting). No account is exported under an assumed mapping: an unmapped
 * account refuses the preparation (ACCOUNTING_MAPPING_REQUIRED) and the refusal lists each account
 * with a way to propose its mapping; NOTHING_TO_EXPORT says the period has nothing left.
 *
 * An export period is organization-wide: it is entered and shown in UTC, and says so (no facility
 * zone applies).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import { BATCH_STATUS } from '../../../features/pos-access-accounting/labels';
import { ACCOUNTING_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import {
  formatInstant,
  formatMoney,
  localToInstant,
} from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { ACCOUNTING_PATHS, BATCHES_PREFIX } from './paths';

type Batch = Schema<'AccountingExportBatch'>;

const STATUS_FILTERS = (Object.keys(BATCH_STATUS) as Schema<'AccountingBatchStatus'>[]).map(
  (s) => ({ value: s, label: BATCH_STATUS[s].label }),
);

export function periodText(batch: Pick<Batch, 'periodStart' | 'periodEnd'>): string {
  return `${formatInstant(batch.periodStart, 'UTC')} to ${formatInstant(batch.periodEnd, 'UTC')}`;
}

export function totalsText(batch: Pick<Batch, 'totals'>): string {
  if (batch.totals.length === 0) return 'No amounts';
  return batch.totals
    .map(
      (t) =>
        `${t.currency}: debit ${formatMoney(t.debitMinor, t.currency)}, credit ${formatMoney(t.creditMinor, t.currency)}`,
    )
    .join('; ');
}

export function BatchesPage() {
  const [status, setStatus] = useState('');
  const batches = useApiPages({
    path: '/accounting-export-batches',
    request: {
      query: {
        ...(status ? { status: status as Schema<'AccountingBatchStatus'> } : {}),
        limit: 50,
      },
    },
  });
  return (
    <section aria-labelledby="accounting-batches-title">
      <h3 id="accounting-batches-title">Export batches</h3>
      <SelectField
        label="Show batches"
        value={status}
        onChange={setStatus}
        options={STATUS_FILTERS}
        placeholder="Every batch"
      />
      <QueryBoundary
        query={batches}
        label="export batches"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No batches',
          description: 'No export batch matches. A batch is prepared for a period.',
        }}
        unavailableOffline={['preparing and submitting batches']}
      >
        {(items) => (
          <ul className="list" aria-label="Export batches">
            {items.map((batch) => (
              <li key={batch.id}>
                <div className="row-text">
                  <Link className="row-title" to={ACCOUNTING_PATHS.batch(batch.id)}>
                    Batch for {periodText(batch)}
                  </Link>
                  <StatusBadge {...BATCH_STATUS[batch.status]} />
                  <span>
                    {batch.lineCount} line{batch.lineCount === 1 ? '' : 's'} · {totalsText(batch)}
                  </span>
                  <span className="caption">Prepared {formatInstant(batch.preparedAt, 'UTC')}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={batches} label="batches" />
      <PrepareBatch />
    </section>
  );
}

function PrepareBatch() {
  const offer = useOffer();
  const online = useOnline();
  const navigate = useNavigate();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/accounting-export-batches', {
    invalidate: [BATCHES_PREFIX],
  });
  const intent = useIntentForm(command);
  if (!offer.capabilityOn('accounting')) return null;
  if (!offer.allowed(ACCOUNTING_ACTIONS.exportAccounting)) {
    return (
      <p className="caption">
        Preparing batches needs the permission {ACCOUNTING_ACTIONS.exportAccounting}.
      </p>
    );
  }
  const periodStart = localToInstant(start, null);
  const periodEnd = localToInstant(end, null);
  const ordered = periodStart !== null && periodEnd !== null && periodEnd > periodStart;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!periodStart || !periodEnd || !ordered) return;
    const batch = await intent.send({ body: { periodStart, periodEnd } });
    if (batch) navigate(ACCOUNTING_PATHS.batch(batch.id));
  };
  return (
    <form
      className="rf-panel"
      aria-label="Prepare a batch"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Prepare a batch</h4>
      <p>
        Collects the period&apos;s journal entries not yet in a live batch. Each exported account
        needs an approved mapping; corrections are later entries exported in a later batch.
      </p>
      <TextField
        label="Period start (UTC)"
        type="datetime-local"
        required
        hint="Entered in UTC: an export period is organization-wide."
        value={start}
        onChange={setStart}
        error={touched && !periodStart ? 'Enter the start of the period.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Period end (UTC)"
        type="datetime-local"
        required
        hint="Exclusive: entries posted before this time."
        value={end}
        onChange={setEnd}
        error={
          touched && !periodEnd
            ? 'Enter the end of the period.'
            : touched && !ordered
              ? 'The period ends after it starts.'
              : null
        }
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Prepare the batch
      </Button>
      <OfflineCaption action="preparing a batch" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}
