/**
 * SCR-S-45 Exports (SPK-REPORT-007, §4.14 expiring exports, SPK-IAM-006, POL-047; SPK-UX-008,
 * SPK-UX-009). Exports are made from stored report runs (`GET /v1/reports/runs`):
 *
 * - independent permission: creating an export (`POST /v1/reports/exports`) is checked separately
 *   from viewing the report, so ACCESS_DENIED here says export is a separate permission;
 * - expiring and single use: each export shows the API's expiry instant ("download until"); the
 *   one-time token the API returns is held in this page's memory only and spent by the download;
 *   leaving the page means making a new export;
 * - reproducible after corrections: "Check reproduction" re-evaluates a run at its as-of instant
 *   and compares digests (`POST /v1/reports/runs/{id}/reproduce`); a mismatch, or corrections made
 *   after the as-of instant, mean exporting a new run ("Run again with current data");
 * - child information: report runs and exports carry aggregate figures only (no person-level rows);
 * - offline: creating, downloading and revoking are disabled;
 * - partial completion is not permitted: an export is the whole stored run or nothing.
 * Every command sends an Idempotency-Key per intent (reused on retry); revocation sends the
 * export's expected revision.
 */
import { ApiError, networkError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { downloadExport, saveFile } from '../../features/insight-admin/download';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
} from '../../features/insight-admin/feedback';
import { RadioGroup, SelectField, TextField } from '../../features/insight-admin/fields';
import { formatInstant, shortId } from '../../features/insight-admin/format';
import {
  ALL_REPORTS,
  EXPORT_BADGES,
  POINT_IN_TIME_LABELS,
  reportTitle,
} from '../../features/insight-admin/labels';
import { ReportsNav } from '../../features/insight-admin/nav';
import { useApi, useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type ReportRunSummary = Schema<'ReportRunSummary'>;
type ReportExportCreated = Schema<'ReportExportCreated'>;
type ExportFormat = Schema<'ReportExportFormat'>;

/** An export created on this page; the token lives only here, in memory, until it is spent. */
export interface ExportHandle {
  id: string;
  runId: string;
  reportKey: string;
  format: ExportFormat;
  token: string | null;
}

const RUNS_KEY = ['api', '/reports/runs'] as const;
const DENIED_EXPORT =
  'Exporting needs its own permission, checked separately from viewing the report (SPK-REPORT-007).';

function ExportForm({
  runId,
  reportKey,
  onCreated,
}: {
  runId: string;
  reportKey: string;
  onCreated: (created: ReportExportCreated) => void;
}) {
  const { online } = useApp();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const create = useApiCommand('post', '/reports/exports');
  const send = () =>
    void create
      .submit({ body: { reportRunId: runId, format } })
      .then(onCreated)
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  return (
    <form
      className="ia-inline-form"
      onSubmit={submit}
      aria-label={`Export ${reportTitle(reportKey)} run ${shortId(runId)}`}
    >
      <RadioGroup
        legend="Format"
        name={`format-${runId}`}
        value={format}
        onChange={(v) => setFormat(v as ExportFormat)}
        options={[
          { value: 'csv', label: 'CSV' },
          { value: 'json', label: 'JSON' },
        ]}
      />
      <Button
        type="submit"
        busy={create.isProcessing}
        disabled={!online}
        aria-label={`Create export of ${reportTitle(reportKey)} run ${shortId(runId)}`}
      >
        {create.isProcessing ? 'Generating export' : 'Create export'}
      </Button>
      {!online ? <p className="caption">Exports need a connection.</p> : null}
      <CommandError error={create.error} onRetry={send} deniedDescription={DENIED_EXPORT} />
    </form>
  );
}

function RunAgain({
  run,
  onRun,
}: {
  run: Pick<ReportRunSummary, 'reportKey' | 'parameters'>;
  onRun: (created: Schema<'ReportRun'>) => void;
}) {
  const { online } = useApp();
  const again = useApiCommand('post', '/reports/runs', { invalidate: [RUNS_KEY] });
  // Same parameters, evaluated now: corrections recorded since the stored as-of instant count.
  const parameters = Object.fromEntries(
    Object.entries(run.parameters).filter(([key]) => key !== 'asOf'),
  );
  const send = () =>
    void again
      .submit({ body: { report: run.reportKey, parameters } })
      .then(onRun)
      .catch(() => undefined);
  return (
    <>
      <Button variant="secondary" busy={again.isProcessing} disabled={!online} onClick={send}>
        Run again with current data
      </Button>
      <CommandError error={again.error} onRetry={send} />
    </>
  );
}

function ReproduceRun({ run }: { run: ReportRunSummary }) {
  const { online } = useApp();
  const reproduce = useApiCommand('post', '/reports/runs/{id}/reproduce', {
    invalidate: [RUNS_KEY],
  });
  const [rerun, setRerun] = useState<Schema<'ReportRun'> | null>(null);
  const send = () =>
    void reproduce.submit({ path: { id: run.id }, body: {} }).catch(() => undefined);
  const outcome = reproduce.data;
  return (
    <div className="ia-reproduce">
      <Button
        variant="secondary"
        busy={reproduce.isProcessing}
        disabled={!online}
        aria-label={`Check reproduction of run ${shortId(run.id)}`}
        onClick={send}
      >
        Check reproduction
      </Button>
      {outcome ? (
        outcome.matched ? (
          <p role="status">
            <StatusBadge tone="success" label="Reproduced: figures match" /> {outcome.explanation}
          </p>
        ) : (
          <div role="status">
            <p>
              <StatusBadge tone="warning" label="Figures differ from the stored run" />{' '}
              {outcome.explanation} Exports of the stored run still show the stored figures; export
              the new run instead.
            </p>
            <p>
              <Link to={`/reports/exports?run=${outcome.reproducedRun.id}`}>
                Export the reproduced run {shortId(outcome.reproducedRun.id)}
              </Link>
            </p>
          </div>
        )
      ) : null}
      <RunAgain run={run} onRun={setRerun} />
      {rerun ? (
        <p role="status">
          <StatusBadge tone="success" label="New run stored" /> Run {shortId(rerun.id)} as of{' '}
          {formatInstant(rerun.asOf, rerun.result.scope.timezone)}.{' '}
          <Link to={`/reports/exports?run=${rerun.id}`}>Export the new run</Link>
        </p>
      ) : null}
      <CommandError error={reproduce.error} onRetry={send} />
    </div>
  );
}

function RunRow({
  run,
  onCreated,
}: {
  run: ReportRunSummary;
  onCreated: (created: ReportExportCreated) => void;
}) {
  return (
    <li aria-labelledby={`run-${run.id}`}>
      <div className="row-text">
        <span className="row-title" id={`run-${run.id}`}>
          {reportTitle(run.reportKey)} · run {shortId(run.id)}
        </span>
        <span className="caption">
          As of {formatInstant(run.asOf)} · produced {formatInstant(run.producedAt)} · by{' '}
          {run.requestedBy.actorLabel} · {run.rowCount} row{run.rowCount === 1 ? '' : 's'}
        </span>
        <span className="caption">{POINT_IN_TIME_LABELS[run.pointInTime]}</span>
        {run.reproducesRunId ? (
          <span className="caption">
            Reproduction of run {shortId(run.reproducesRunId)}:{' '}
            {run.reproductionMatched === null
              ? 'not compared'
              : run.reproductionMatched
                ? 'figures matched'
                : 'figures differed'}
          </span>
        ) : null}
        <Link to={`/reports/runs/${run.id}`}>Open the stored run {shortId(run.id)}</Link>
      </div>
      <div className="ia-row-actions">
        <ExportForm runId={run.id} reportKey={run.reportKey} onCreated={onCreated} />
        <ReproduceRun run={run} />
      </div>
    </li>
  );
}

function RunsPage({
  report,
  cursor,
  isLast,
  onMore,
  onCreated,
}: {
  report: string;
  cursor: string | null;
  isLast: boolean;
  onMore: (cursor: string) => void;
  onCreated: (created: ReportExportCreated) => void;
}) {
  const query = {
    limit: 20,
    ...(cursor ? { cursor } : {}),
    ...(report ? { report: report as Schema<'ReportKey'> } : {}),
  };
  const runs = useApiQuery({ path: '/reports/runs', request: { query } });
  return (
    <InsightQueryBoundary
      query={runs}
      label="stored report runs"
      isEmpty={(data) => data.items.length === 0 && cursor === null}
      empty={{
        title: 'No stored runs',
        description:
          'Exports are made from stored runs. Store a run from Operating reports or Utilization, economics, demand and retention.',
      }}
      unavailableOffline={['creating, downloading or revoking exports']}
    >
      {(data) => (
        <>
          <ul className="list" aria-label={cursor ? 'More stored runs' : 'Stored runs'}>
            {data.items.map((run) => (
              <RunRow key={run.id} run={run} onCreated={onCreated} />
            ))}
          </ul>
          {isLast && data.nextCursor ? (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor as string)}>
              Show more runs
            </Button>
          ) : null}
        </>
      )}
    </InsightQueryBoundary>
  );
}

function SelectedRun({
  runId,
  onCreated,
}: {
  runId: string;
  onCreated: (created: ReportExportCreated) => void;
}) {
  const run = useApiQuery({ path: '/reports/runs/{id}', request: { path: { id: runId } } });
  return (
    <section className="ia-section" aria-labelledby="selected-run-title">
      <h3 id="selected-run-title">Selected run</h3>
      <InsightQueryBoundary
        query={run}
        label="the selected run"
        empty={{ title: 'Not available', description: '' }}
      >
        {(data) => (
          <ul className="list" aria-label="Selected run">
            <RunRow run={data} onCreated={onCreated} />
          </ul>
        )}
      </InsightQueryBoundary>
    </section>
  );
}

function RevokeExport({
  exportRecord,
  onRevoked,
}: {
  exportRecord: Schema<'ReportExport'>;
  onRevoked: () => void;
}) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const revoke = useApiCommand('post', '/reports/exports/{id}/revoke', {
    invalidate: [['api', '/reports/exports/{id}']],
  });
  const send = () =>
    void revoke
      .submit({
        path: { id: exportRecord.id },
        body: { reason: reason.trim(), expectedRevision: exportRecord.revision },
      })
      .then(() => {
        setOpen(false);
        onRevoked();
      })
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Enter the reason for revoking this export.');
      return;
    }
    setError(null);
    send();
  };
  const reload = () => {
    revoke.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/reports/exports/{id}'] });
  };
  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={!online}
        aria-label={`Revoke export ${shortId(exportRecord.id)}`}
        onClick={() => setOpen(true)}
      >
        Revoke
      </Button>
    );
  }
  return (
    <form
      className="ia-inline-form"
      onSubmit={submit}
      aria-label={`Revoke export ${shortId(exportRecord.id)}`}
      noValidate
    >
      <TextField
        label="Reason for revoking"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <Button type="submit" busy={revoke.isProcessing} disabled={!online}>
        Confirm revocation
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Keep it
      </Button>
      <CommandError error={revoke.error} onRetry={send} onReload={reload} />
    </form>
  );
}

function SessionExport({
  handle,
  onTokenSpent,
}: {
  handle: ExportHandle;
  onTokenSpent: (id: string) => void;
}) {
  const api = useApi();
  const { online, services } = useApp();
  const now = useNow(15_000);
  const queryClient = useQueryClient();
  const exportQuery = useApiQuery({
    path: '/reports/exports/{id}',
    request: { path: { id: handle.id } },
  });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<ApiError | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['api', '/reports/exports/{id}'] }),
    [queryClient],
  );

  const download = async () => {
    if (!handle.token) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const file = await downloadExport(
        {
          baseUrl: services.config.apiBaseUrl,
          sessionStore: services.sessionStore,
          clientInfo: api.clientInfo,
          fetch: services.fetch,
        },
        handle.id,
        handle.token,
        `${handle.reportKey}-${shortId(handle.runId)}.${handle.format}`,
      );
      saveFile(file);
      onTokenSpent(handle.id);
      setDownloaded(`Export downloaded as ${file.filename}`);
    } catch (error) {
      setDownloadError(error instanceof ApiError ? error : networkError(error));
      // The token is single use: a refused download may already have spent it; reread the state.
    } finally {
      setDownloading(false);
      void refresh();
    }
  };

  return (
    <li aria-labelledby={`export-${handle.id}`}>
      <InsightQueryBoundary
        query={exportQuery}
        label={`export ${shortId(handle.id)}`}
        empty={{ title: 'Not available', description: '' }}
      >
        {(record) => {
          const expired = now.getTime() >= new Date(record.expiresAt).getTime();
          const badge =
            record.status === 'ready' && expired
              ? EXPORT_BADGES.expired
              : EXPORT_BADGES[record.status];
          const canDownload = record.status === 'ready' && !expired && handle.token !== null;
          return (
            <div className="ia-export">
              <div className="row-text">
                <span className="row-title" id={`export-${handle.id}`}>
                  {reportTitle(record.reportKey)} · {record.format.toUpperCase()} export{' '}
                  {shortId(record.id)}
                </span>
                <StatusBadge tone={badge.tone} label={badge.label} />
                {record.status === 'ready' && !expired ? (
                  <span>Download until {formatInstant(record.expiresAt)}</span>
                ) : null}
                {record.status === 'ready' && expired ? (
                  <span>Expired at {formatInstant(record.expiresAt)}</span>
                ) : null}
                {record.downloadedAt ? (
                  <span>
                    Downloaded {formatInstant(record.downloadedAt)}. An export downloads once; make
                    a new export to download again.
                  </span>
                ) : null}
                {record.revokedAt ? (
                  <span>
                    Revoked {formatInstant(record.revokedAt)}
                    {record.revokeReason ? `: ${record.revokeReason}` : ''}
                  </span>
                ) : null}
                <span className="caption">
                  Run {shortId(record.reportRunId)} · {record.rowCount} row
                  {record.rowCount === 1 ? '' : 's'} · requested {formatInstant(record.requestedAt)}{' '}
                  by {record.requestedBy.actorLabel} · checked against {record.authorizedAction}
                </span>
                {record.status === 'ready' && handle.token === null ? (
                  <span className="caption">
                    The one-time download link is no longer held on this page. Make a new export.
                  </span>
                ) : null}
              </div>
              <div className="ia-row-actions">
                {record.status === 'ready' && !expired ? (
                  <Button
                    busy={downloading}
                    disabled={!online || !canDownload}
                    aria-label={`Download export ${shortId(record.id)}`}
                    onClick={() => void download()}
                  >
                    Download
                  </Button>
                ) : null}
                {record.status === 'ready' ? (
                  <RevokeExport exportRecord={record} onRevoked={() => onTokenSpent(handle.id)} />
                ) : null}
              </div>
              <CommandSuccess message={downloaded} />
              <CommandError
                error={downloadError}
                onRetry={handle.token ? () => void download() : undefined}
                onReload={() => void refresh()}
                deniedDescription={DENIED_EXPORT}
              />
            </div>
          );
        }}
      </InsightQueryBoundary>
    </li>
  );
}

export function ExportsScreen() {
  const [search, setSearch] = useSearchParams();
  const selectedRun = search.get('run');
  const report = search.get('report') ?? '';
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [handles, setHandles] = useState<ExportHandle[]>([]);

  const onCreated = useCallback((created: ReportExportCreated) => {
    setHandles((list) => [
      {
        id: created.id,
        runId: created.reportRunId,
        reportKey: created.reportKey,
        format: created.format,
        token: created.downloadToken,
      },
      ...list.filter((h) => h.id !== created.id),
    ]);
  }, []);
  const onTokenSpent = useCallback((id: string) => {
    setHandles((list) => list.map((h) => (h.id === id ? { ...h, token: null } : h)));
  }, []);

  return (
    <section aria-labelledby="exports-title" className="ia-screen">
      <h2 id="exports-title">Stored runs and exports</h2>
      <ReportsNav />
      <p className="caption">
        Exports contain the stored run’s aggregate figures only: reports carry no person-level rows
        and no child information (§4.14). Each export is checked against its own permission,
        audited, downloads once and expires at the time the API sets.
      </p>

      <section className="ia-section" aria-labelledby="session-exports-title">
        <h3 id="session-exports-title">Exports made on this page</h3>
        {handles.length === 0 ? (
          <p className="caption" data-testid="no-session-exports">
            No exports yet. Exports made here stay downloadable only while this page is open; the
            API does not list earlier exports.
          </p>
        ) : (
          <ul className="list" aria-label="Exports made on this page">
            {handles.map((handle) => (
              <SessionExport key={handle.id} handle={handle} onTokenSpent={onTokenSpent} />
            ))}
          </ul>
        )}
      </section>

      {selectedRun ? <SelectedRun runId={selectedRun} onCreated={onCreated} /> : null}

      <section className="ia-section" aria-labelledby="runs-title">
        <h3 id="runs-title">Stored runs</h3>
        <SelectField
          label="Report"
          value={report}
          onChange={(value) => {
            setCursors([null]);
            const next = new URLSearchParams(search);
            if (value) next.set('report', value);
            else next.delete('report');
            setSearch(next, { replace: true });
          }}
          placeholder="All reports you may view"
          options={ALL_REPORTS.map((e) => ({ value: e.key, label: e.title }))}
        />
        {cursors.map((cursor, index) => (
          <RunsPage
            key={`${report}:${cursor ?? 'first'}`}
            report={report}
            cursor={cursor}
            isLast={index === cursors.length - 1}
            onMore={(next) => setCursors((list) => [...list, next])}
            onCreated={onCreated}
          />
        ))}
      </section>
    </section>
  );
}
