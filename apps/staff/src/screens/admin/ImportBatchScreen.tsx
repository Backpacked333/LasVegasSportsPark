/**
 * SCR-S-48 Import batch (§5.4 import behaviour, §5.5 reconciliation, §5.8, SPK-AT-024, DEC-014,
 * DEC-067; SPK-UX-008, SPK-UX-009). One batch with everything §5.4 says a batch retains: source,
 * timestamp, declared and computed checksum, transformation version, row outcomes, validation
 * errors and review decisions (`GET /v1/import-batches/{id}`, `/rows`, `/v1/import-exceptions`).
 *
 * The next step follows the batch state machine (received → validated → reviewed → applied, or
 * aborted before any apply); the API authorizes each command and its ACCESS_DENIED is shown:
 * validate (seal and dry-run; a checksum or row-count mismatch is a validation failure), append a
 * chunk while received, complete the review (expected revision; refused while exceptions are open),
 * apply (processing "Importing"; repeatable: matched records create nothing, charge nothing and
 * send nothing), abort (reason and expected revision), and reconcile an applied batch at the four
 * §5.5 levels. The batch's reconciliation reports are listed newest first
 * (`GET /v1/import-batches/{id}/reconciliation-reports`, MIG-01) and its latest report
 * (`latestReconciliationReportId`) is shown with its sign-offs; superseded reports stay as evidence.
 * Partial completion is expected per row: every row's outcome and reasons are listed.
 * Staged payloads are never shown (personal and child data, §4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  detailCodeOf,
} from '../../features/insight-admin/feedback';
import { SelectField, TextField } from '../../features/insight-admin/fields';
import {
  formatInstant,
  formatMinor,
  formatScalar,
  shortId,
} from '../../features/insight-admin/format';
import {
  APPROVAL_BADGES,
  BATCH_BADGES,
  ENTITY_TYPE_LABELS,
  EXCEPTION_STATUS_BADGES,
  ENTITY_TYPES,
  RECONCILIATION_BADGES,
  ROW_OUTCOME_BADGES,
  type RowOutcome,
} from '../../features/insight-admin/labels';
import {
  BATCHES_KEY,
  BATCH_KEY,
  EXCEPTIONS_KEY,
  ReasonList,
  ReconciliationReportView,
} from '../../features/insight-admin/migration';
import { MigrationNav } from '../../features/insight-admin/nav';
import { ExceptionsPage } from './ImportReviewScreen';
import { parseStagingDocument, readFileText } from '../../features/insight-admin/staging';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type ImportBatch = Schema<'ImportBatch'>;
type ApiErrorLike = { details?: unknown } | null;

const ROWS_KEY = ['api', '/import-batches/{id}/rows'] as const;
const OUTCOMES = Object.keys(ROW_OUTCOME_BADGES) as RowOutcome[];

function useRefreshBatch() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: BATCH_KEY }),
      queryClient.invalidateQueries({ queryKey: BATCHES_KEY }),
      queryClient.invalidateQueries({ queryKey: ROWS_KEY }),
      queryClient.invalidateQueries({ queryKey: EXCEPTIONS_KEY }),
    ]);
}

function mismatchText(error: ApiErrorLike, code: string | null): string | null {
  const details = (error?.details ?? {}) as Record<string, unknown>;
  if (code === 'CHECKSUM_MISMATCH') {
    return `Checksum mismatch: the staged rows do not match the declared checksum (declared ${formatScalar(details.declared)}, computed ${formatScalar(details.computed)}). Stage the snapshot again from the extraction.`;
  }
  if (code === 'ROW_COUNT_MISMATCH') {
    return `Row count mismatch: ${formatScalar(details.staged)} rows staged, ${formatScalar(details.declared)} declared. Append the missing chunks or stage again.`;
  }
  if (code === 'OPEN_EXCEPTIONS') {
    return `${formatScalar(details.open)} review exceptions are still open. Decide them below or in the review queue first.`;
  }
  return null;
}

type OnDone = (message: string) => void;

function ValidateAction({ batch, onDone }: { batch: ImportBatch; onDone: OnDone }) {
  const { online } = useApp();
  const refresh = useRefreshBatch();
  const validate = useApiCommand('post', '/import-batches/{id}/validate');
  const send = () =>
    void validate
      .submit({ path: { id: batch.id }, body: { expectedRevision: batch.revision } })
      .then((next) => {
        onDone(`Batch ${next.status}: ${next.exceptions.open} exceptions open for review`);
        return refresh();
      })
      .catch(() => undefined);
  const code = detailCodeOf(validate.error);
  return (
    <div className="ia-action">
      <Button busy={validate.isProcessing} disabled={!online} onClick={send}>
        {validate.isProcessing ? 'Validating' : 'Validate (seal and dry run)'}
      </Button>
      <p className="caption">
        Seals the batch, verifies the declared checksum and row count, plans every row and opens
        review exceptions. Nothing is created yet.
      </p>
      {mismatchText(validate.error, code) ? (
        <p className="ia-withheld" role="alert">
          <StatusBadge tone="danger" label="Validation failure" />{' '}
          {mismatchText(validate.error, code)}
        </p>
      ) : null}
      <CommandError error={validate.error} onRetry={send} onReload={() => void refresh()} />
    </div>
  );
}

function AppendChunk({ batch }: { batch: ImportBatch }) {
  const { online } = useApp();
  const refresh = useRefreshBatch();
  const append = useApiCommand('post', '/import-batches/{id}/rows');
  const [chunk, setChunk] = useState<{
    rows: Schema<'StagedRow'>[];
    csv: Schema<'CsvDocument'>[];
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setChunk(null);
    setDone(null);
    if (!file) return;
    const parsed = parseStagingDocument(await readFileText(file), {
      requireControlTotals: false,
    });
    if (typeof parsed === 'string') {
      setFileError(parsed);
      return;
    }
    setFileError(null);
    setChunk({ rows: parsed.rows, csv: parsed.csv });
  };
  const send = () => {
    if (!chunk) {
      setFileError('Choose a chunk of the staging document.');
      return;
    }
    void append
      .submit({
        path: { id: batch.id },
        body: { rows: chunk.rows, csv: chunk.csv, expectedRevision: batch.revision },
      })
      .then((next) => {
        setChunk(null);
        setDone(`Chunk staged: the batch holds ${next.rowCount} rows`);
        return refresh();
      })
      .catch(() => undefined);
  };
  return (
    <div className="ia-action">
      <div className="ia-field">
        <label htmlFor={`chunk-${batch.id}`}>Next chunk of the snapshot</label>
        <input
          id={`chunk-${batch.id}`}
          type="file"
          accept="application/json,.json"
          aria-invalid={fileError ? true : undefined}
          onChange={(event) => void onFile(event)}
        />
        {fileError ? <span className="error-text">{fileError}</span> : null}
        {chunk ? (
          <span role="status">
            {chunk.rows.length} rows, {chunk.csv.length} CSV documents ready to append
          </span>
        ) : null}
      </div>
      <Button variant="secondary" busy={append.isProcessing} disabled={!online} onClick={send}>
        Append chunk
      </Button>
      <CommandSuccess message={done} />
      <CommandError error={append.error} onRetry={send} onReload={() => void refresh()} />
    </div>
  );
}

function ReviewAction({ batch, onDone }: { batch: ImportBatch; onDone: OnDone }) {
  const { online } = useApp();
  const refresh = useRefreshBatch();
  const review = useApiCommand('post', '/import-batches/{id}/review');
  const send = () =>
    void review
      .submit({ path: { id: batch.id }, body: { expectedRevision: batch.revision } })
      .then((next) => {
        onDone(`Batch ${next.status}: review complete`);
        return refresh();
      })
      .catch(() => undefined);
  const message = mismatchText(review.error, detailCodeOf(review.error));
  return (
    <div className="ia-action">
      <Button busy={review.isProcessing} disabled={!online} onClick={send}>
        Complete the review
      </Button>
      <p className="caption">
        {batch.exceptions.open > 0
          ? `${batch.exceptions.open} exceptions are open; the review completes once every one is decided.`
          : 'Every exception is decided.'}
      </p>
      {message ? (
        <p className="ia-withheld">
          {message}{' '}
          <Link to={`/admin/migration/review?batch=${batch.id}`}>
            Open this batch&apos;s exceptions in the review queue
          </Link>
        </p>
      ) : null}
      <CommandError error={review.error} onRetry={send} onReload={() => void refresh()} />
    </div>
  );
}

function ApplyAction({ batch, onDone }: { batch: ImportBatch; onDone: OnDone }) {
  const { online } = useApp();
  const refresh = useRefreshBatch();
  const apply = useApiCommand('post', '/import-batches/{id}/apply');
  const send = () =>
    void apply
      .submit({ path: { id: batch.id }, body: { expectedRevision: batch.revision } })
      .then((next) => {
        const c = next.outcomeCounts;
        onDone(
          c
            ? `Batch ${next.status}: ${c.created} created, ${c.matched} matched, ${c.updated} updated, ${c.skipped} skipped, ${c.exception} exceptions`
            : `Batch ${next.status}`,
        );
        return refresh();
      })
      .catch(() => undefined);
  return (
    <div className="ia-action">
      <Button busy={apply.isProcessing} disabled={!online} onClick={send}>
        {apply.isProcessing ? 'Importing' : 'Apply the batch'}
      </Button>
      <p className="caption">
        Creates or matches each record through the module that owns it. Repeatable: a record already
        imported is matched; no payment is taken and no notice is sent (§5.4).
      </p>
      <CommandError error={apply.error} onRetry={send} onReload={() => void refresh()} />
    </div>
  );
}

function AbortAction({ batch, onDone }: { batch: ImportBatch; onDone: OnDone }) {
  const { online } = useApp();
  const refresh = useRefreshBatch();
  const abort = useApiCommand('post', '/import-batches/{id}/abort');
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = () =>
    void abort
      .submit({
        path: { id: batch.id },
        body: { reason: reason.trim(), expectedRevision: batch.revision },
      })
      .then((next) => {
        setOpen(false);
        onDone(`Batch ${next.status}`);
        return refresh();
      })
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Enter the reason for aborting this batch.');
      return;
    }
    setError(null);
    send();
  };
  if (!open) {
    return (
      <Button variant="secondary" disabled={!online} onClick={() => setOpen(true)}>
        Abort the batch
      </Button>
    );
  }
  return (
    <form className="ia-form" onSubmit={submit} aria-label="Abort the batch" noValidate>
      <TextField
        label="Reason for aborting"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <div className="ia-actions">
        <Button type="submit" busy={abort.isProcessing} disabled={!online}>
          Confirm abort
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep the batch
        </Button>
      </div>
      <CommandError error={abort.error} onRetry={send} onReload={() => void refresh()} />
    </form>
  );
}

const REPORTS_KEY = ['api', '/import-batches/{id}/reconciliation-reports'] as const;

function ReconcileAction({
  batch,
  onGenerated,
}: {
  batch: ImportBatch;
  onGenerated: (reportId: string) => void;
}) {
  const { online } = useApp();
  const generate = useApiCommand('post', '/import-batches/{id}/reconciliation-reports', {
    invalidate: [REPORTS_KEY, BATCH_KEY],
  });
  const send = () =>
    void generate
      .submit({ path: { id: batch.id }, body: {} })
      .then((report) => onGenerated(report.id))
      .catch(() => undefined);
  return (
    <div className="ia-action">
      <Button busy={generate.isProcessing} disabled={!online} onClick={send}>
        {generate.isProcessing ? 'Reconciling' : 'Reconcile this batch'}
      </Button>
      <p className="caption">
        Checks control totals, record identity, relationships and operational outcomes. Generating
        again supersedes a pending report; earlier reports stay as evidence.
      </p>
      <CommandError error={generate.error} onRetry={send} />
    </div>
  );
}

/**
 * One reconciliation report read through its own query, so a sign-off refetches it and the next
 * sign-off carries the current revision (the mutation result would stay as generated).
 */
function GeneratedReport({ reportId }: { reportId: string }) {
  const report = useApiQuery({
    path: '/import-reconciliation-reports/{id}',
    request: { path: { id: reportId } },
  });
  return (
    <>
      <p>
        <Link to={`/admin/migration/reconciliation/${reportId}`}>
          Open reconciliation report {shortId(reportId)}
        </Link>
      </p>
      <InsightQueryBoundary
        query={report}
        label="the reconciliation report"
        empty={{ title: 'Not available', description: '' }}
      >
        {(data) => <ReconciliationReportView report={data} />}
      </InsightQueryBoundary>
    </>
  );
}

function ReportList({ batch, latestId }: { batch: ImportBatch; latestId: string }) {
  const reports = useApiQuery({
    path: '/import-batches/{id}/reconciliation-reports',
    request: { path: { id: batch.id } },
  });
  return (
    <InsightQueryBoundary
      query={reports}
      label="the reconciliation reports of this batch"
      isEmpty={(data) => data.items.length === 0}
      empty={{
        title: 'No reconciliation report yet',
        description: 'Reconcile the applied batch to produce one.',
      }}
    >
      {(data) => (
        <ul className="list" aria-label="Reconciliation reports of this batch">
          {data.items.map((report) => {
            const status = RECONCILIATION_BADGES[report.status];
            const approval = APPROVAL_BADGES[report.approvalStatus];
            return (
              <li key={report.id}>
                <div className="row-text">
                  <Link to={`/admin/migration/reconciliation/${report.id}`}>
                    Reconciliation report {shortId(report.id)}
                  </Link>
                  <span>
                    <StatusBadge tone={status.tone} label={status.label} />{' '}
                    <StatusBadge tone={approval.tone} label={`sign-off ${approval.label}`} />
                    {report.id === latestId ? (
                      <>
                        {' '}
                        <StatusBadge tone="info" label="latest" />
                      </>
                    ) : null}
                  </span>
                  <span className="caption">
                    Generated {formatInstant(report.generatedAt)} by {report.generatedBy.actorLabel}{' '}
                    · {report.discrepancyCount} discrepanc
                    {report.discrepancyCount === 1 ? 'y' : 'ies'}
                    {report.supersededByReportId
                      ? ` · superseded by ${shortId(report.supersededByReportId)}`
                      : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </InsightQueryBoundary>
  );
}

function Reconciliation({ batch }: { batch: ImportBatch }) {
  const [generatedId, setGeneratedId] = useState<string | null>(null);
  const latestId = generatedId ?? batch.latestReconciliationReportId;
  return (
    <>
      <ReconcileAction batch={batch} onGenerated={setGeneratedId} />
      <section className="ia-section" aria-labelledby="reconciliation-reports-title">
        <h4 id="reconciliation-reports-title">Reconciliation reports</h4>
        {latestId ? (
          <>
            <ReportList batch={batch} latestId={latestId} />
            <h4>Latest report</h4>
            <GeneratedReport key={latestId} reportId={latestId} />
          </>
        ) : (
          <p className="caption">No reconciliation report yet for this batch.</p>
        )}
      </section>
    </>
  );
}

function NextSteps({ batch, onDone }: { batch: ImportBatch; onDone: OnDone }) {
  return (
    <section className="ia-section" aria-labelledby="next-steps-title">
      <h3 id="next-steps-title">Next step</h3>
      {batch.status === 'received' ? (
        <>
          <ValidateAction batch={batch} onDone={onDone} />
          <AppendChunk batch={batch} />
          <AbortAction batch={batch} onDone={onDone} />
        </>
      ) : null}
      {batch.status === 'validated' ? (
        <>
          <ReviewAction batch={batch} onDone={onDone} />
          <AbortAction batch={batch} onDone={onDone} />
        </>
      ) : null}
      {batch.status === 'reviewed' ? (
        <>
          <ApplyAction batch={batch} onDone={onDone} />
          {batch.applyStartedAt ? null : <AbortAction batch={batch} onDone={onDone} />}
        </>
      ) : null}
      {batch.status === 'applied' ? <Reconciliation batch={batch} /> : null}
      {batch.status === 'aborted' ? (
        <p>
          Aborted {formatInstant(batch.abortedAt)}
          {batch.abortReason ? `: ${batch.abortReason}` : ''}. Nothing from this batch was applied.
        </p>
      ) : null}
    </section>
  );
}

function CountsLine({
  label,
  counts,
}: {
  label: string;
  counts: Schema<'ImportOutcomeCounts'> | null;
}) {
  if (!counts) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {counts.created} created, {counts.matched} matched, {counts.updated} updated,{' '}
        {counts.skipped} skipped, {counts.exception} exceptions
      </dd>
    </>
  );
}

function ControlTotals({ totals }: { totals: Record<string, unknown> }) {
  const counts = (totals.counts ?? {}) as Record<string, number>;
  const amounts = (totals.amounts ?? []) as {
    entityType: string;
    currency: string;
    totalMinor: number;
  }[];
  return (
    <>
      <dt>Control totals (as the source reports them)</dt>
      <dd>
        {Object.entries(counts)
          .map(
            ([type, n]) =>
              `${ENTITY_TYPE_LABELS[type as keyof typeof ENTITY_TYPE_LABELS] ?? type}: ${n}`,
          )
          .join(' · ') || 'no counts'}
        {amounts.length > 0
          ? ` · ${amounts
              .map(
                (a) =>
                  `${ENTITY_TYPE_LABELS[a.entityType as keyof typeof ENTITY_TYPE_LABELS] ?? a.entityType} ${formatMinor(a.totalMinor, a.currency)}`,
              )
              .join(' · ')}`
          : ''}
      </dd>
    </>
  );
}

function BatchSummary({ batch }: { batch: ImportBatch }) {
  const badge = BATCH_BADGES[batch.status];
  const sealed = batch.checksum !== null;
  const extraction = Object.entries(batch.extraction).filter(([, v]) => typeof v === 'string');
  const summary = Object.entries(batch.validationSummary);
  return (
    <section className="ia-section" aria-labelledby="batch-summary-title">
      <h3 id="batch-summary-title">
        {batch.sourceSystem} snapshot {formatInstant(batch.snapshotTakenAt)}{' '}
        <StatusBadge tone={badge.tone} label={badge.label} />
      </h3>
      <dl className="ia-dl">
        <dt>Batch</dt>
        <dd title={batch.id}>
          {shortId(batch.id)} · revision {batch.revision}
        </dd>
        <dt>Source system</dt>
        <dd>{batch.sourceSystem}</dd>
        <dt>Snapshot taken</dt>
        <dd>{formatInstant(batch.snapshotTakenAt)}</dd>
        <dt>Received</dt>
        <dd>
          {formatInstant(batch.receivedAt)} by {batch.submittedBy.actorLabel}
        </dd>
        <dt>Transformation version</dt>
        <dd>{batch.transformationVersion}</dd>
        <dt>Declared checksum</dt>
        <dd className="ia-mono">{batch.declaredChecksum ?? 'none declared'}</dd>
        <dt>Computed checksum</dt>
        <dd className="ia-mono">
          {sealed ? batch.checksum : 'computed when the batch is validated'}
          {sealed && batch.declaredChecksum ? (
            <>
              {' '}
              <StatusBadge
                tone={batch.declaredChecksum === batch.checksum ? 'success' : 'danger'}
                label={
                  batch.declaredChecksum === batch.checksum
                    ? 'matches the declared checksum'
                    : 'differs from the declared checksum'
                }
              />
            </>
          ) : null}
        </dd>
        <dt>Rows</dt>
        <dd>
          {batch.rowCount} staged
          {batch.declaredRowCount !== null ? ` of ${batch.declaredRowCount} declared` : ''}
        </dd>
        <ControlTotals totals={batch.controlTotals} />
        <CountsLine label="Planned outcomes (dry run)" counts={batch.plannedCounts} />
        <CountsLine label="Final outcomes" counts={batch.outcomeCounts} />
        <dt>Review exceptions</dt>
        <dd>
          {batch.exceptions.open} open, {batch.exceptions.decided} decided,{' '}
          {batch.exceptions.withdrawn} withdrawn
        </dd>
        {summary.length > 0 ? (
          <>
            <dt>Validation summary</dt>
            <dd>{summary.map(([k, v]) => `${k}: ${formatScalar(v)}`).join(' · ')}</dd>
          </>
        ) : null}
        {extraction.length > 0 ? (
          <>
            <dt>Extraction provenance</dt>
            <dd>{extraction.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</dd>
          </>
        ) : null}
        <dt>Timeline</dt>
        <dd>
          validated {formatInstant(batch.validatedAt)} · reviewed {formatInstant(batch.reviewedAt)}{' '}
          · apply started {formatInstant(batch.applyStartedAt)} · applied{' '}
          {formatInstant(batch.appliedAt)}
          {batch.appliedOperationId ? ` (operation ${shortId(batch.appliedOperationId)})` : ''}
        </dd>
        {batch.sameChecksumBatchIds.length > 0 ? (
          <>
            <dt>Re-import</dt>
            <dd>
              Same snapshot as{' '}
              {batch.sameChecksumBatchIds.map((id, index) => (
                <span key={id}>
                  {index > 0 ? ', ' : ''}
                  <Link to={`/admin/migration/batches/${id}`}>batch {shortId(id)}</Link>
                </span>
              ))}
              : records already imported are matched, nothing is charged or sent again.
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function RowsPage({
  batchId,
  filters,
  cursor,
  isLast,
  onMore,
}: {
  batchId: string;
  filters: { entityType: string; outcome: string };
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
}) {
  const rows = useApiQuery({
    path: '/import-batches/{id}/rows',
    request: {
      path: { id: batchId },
      query: {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        ...(filters.entityType
          ? { entityType: filters.entityType as Schema<'ImportEntityType'> }
          : {}),
        ...(filters.outcome ? { outcome: filters.outcome as RowOutcome } : {}),
      },
    },
  });
  return (
    <InsightQueryBoundary
      query={rows}
      label="staged rows"
      isEmpty={(data) => data.items.length === 0 && cursor === null}
      empty={{ title: 'No rows', description: 'No staged row matches these filters.' }}
    >
      {(data) => (
        <>
          <div className="ia-table-wrap" role="region" aria-label="Staged rows" tabIndex={0}>
            <table className="ia-table">
              <caption>Row outcomes and reasons (payloads are not shown)</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Records</th>
                  <th scope="col">External id</th>
                  <th scope="col">Planned</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Reasons</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <td>{row.sequence}</td>
                    <td>{ENTITY_TYPE_LABELS[row.entityType]}</td>
                    <td>{row.externalId}</td>
                    <td>
                      {row.plannedOutcome ? (
                        <StatusBadge
                          tone={ROW_OUTCOME_BADGES[row.plannedOutcome].tone}
                          label={ROW_OUTCOME_BADGES[row.plannedOutcome].label}
                        />
                      ) : (
                        'not planned'
                      )}
                    </td>
                    <td>
                      {row.outcome ? (
                        <StatusBadge
                          tone={ROW_OUTCOME_BADGES[row.outcome].tone}
                          label={ROW_OUTCOME_BADGES[row.outcome].label}
                        />
                      ) : (
                        'not applied'
                      )}
                    </td>
                    <td>
                      <ReasonList reasons={row.reasons} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor as string)}>
              Show more rows
            </Button>
          ) : null}
        </>
      )}
    </InsightQueryBoundary>
  );
}

function BatchRows({ batchId }: { batchId: string }) {
  const [entityType, setEntityType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <section className="ia-section" aria-labelledby="rows-title">
      <h3 id="rows-title">Rows</h3>
      <div className="ia-filters">
        <SelectField
          label="Records"
          value={entityType}
          onChange={(v) => {
            setEntityType(v);
            setCursors([null]);
          }}
          placeholder="All record categories"
          options={ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_TYPE_LABELS[t] }))}
        />
        <SelectField
          label="Outcome"
          value={outcome}
          onChange={(v) => {
            setOutcome(v);
            setCursors([null]);
          }}
          placeholder="All outcomes"
          options={OUTCOMES.map((o) => ({ value: o, label: o }))}
        />
      </div>
      {cursors.map((cursor, index) => (
        <RowsPage
          key={`${entityType}:${outcome}:${cursor ?? 'first'}`}
          batchId={batchId}
          filters={{ entityType, outcome }}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
        />
      ))}
    </section>
  );
}

function BatchExceptions({ batchId }: { batchId: string }) {
  // Every open exception of the batch is reachable: open ones first, paged with the cursor.
  const [status, setStatus] = useState('open');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <section className="ia-section" aria-labelledby="batch-exceptions-title">
      <h3 id="batch-exceptions-title">Review exceptions of this batch</h3>
      <SelectField
        label="Exception status"
        value={status}
        onChange={(v) => {
          setStatus(v);
          setCursors([null]);
        }}
        placeholder="All statuses"
        options={Object.keys(EXCEPTION_STATUS_BADGES).map((s) => ({ value: s, label: s }))}
      />
      {cursors.map((cursor, index) => (
        <ExceptionsPage
          key={`${status}:${cursor ?? 'first'}`}
          filters={{ status, kind: '', owner: '', batchId }}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          onMore={(next) => setCursors((list) => [...list, next])}
          label={
            cursor ? 'More review exceptions of this batch' : 'Review exceptions of this batch'
          }
        />
      ))}
    </section>
  );
}

export function ImportBatchScreen() {
  const { batchId = '' } = useParams();
  const batch = useApiQuery({
    path: '/import-batches/{id}',
    request: { path: { id: batchId } },
    enabled: batchId.length > 0,
  });
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <section aria-labelledby="import-batch-title" className="ia-screen">
      <h2 id="import-batch-title">Import batch</h2>
      <MigrationNav />
      <InsightQueryBoundary
        query={batch}
        label="the import batch"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['validating, applying, aborting or reconciling the batch']}
      >
        {(data) => (
          <>
            <BatchSummary batch={data} />
            <CommandSuccess message={outcome} />
            <NextSteps batch={data} onDone={setOutcome} />
            <BatchExceptions batchId={data.id} />
            <BatchRows batchId={data.id} />
          </>
        )}
      </InsightQueryBoundary>
    </section>
  );
}
