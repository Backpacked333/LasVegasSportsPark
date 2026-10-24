/**
 * One report evaluation for SCR-S-43 and SCR-S-44 (SPK-REPORT-001 to SPK-REPORT-007, SPK-UX-008):
 *
 * - before the parameters are submitted: the metric definitions the report will use
 *   (`GET /v1/reports/metric-definitions?report=`), so every definition is visible up front;
 * - processing: "Loading <report>" while the API evaluates (`GET /v1/reports/<report>`);
 * - validation failure: the API's field messages; a margin refused for missing agreed cost inputs
 *   and a live-only report asked for an earlier instant are named;
 * - permission restriction: ACCESS_DENIED with the API's message (for example an organization-wide
 *   report asked for by facility-scoped staff);
 * - offline or stale: the last result with its age (QueryBoundary);
 * - success: "Store this run" records it (`POST /v1/reports/runs`, Idempotency-Key per intent) as
 *   the reproducible record that exports are made from (SCR-S-45).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError, InsightQueryBoundary, detailCodeOf } from './feedback';
import { formatInstant, shortId } from './format';
import type { ReportCatalogEntry } from './labels';
import { MetricDefinitionList, ReportView } from './ReportView';

/** Any report path: every `/reports/<report>` GET answers the same `ReportResponse` envelope. */
type ReportPath = '/reports/daily-schedule';

export type ReportParams = Record<string, string | boolean | number>;

const RUNS_KEY = ['api', '/reports/runs'] as const;

function StoreRun({ entry, params }: { entry: ReportCatalogEntry; params: ReportParams }) {
  const { online } = useApp();
  const store = useApiCommand('post', '/reports/runs', { invalidate: [RUNS_KEY] });
  const submit = () =>
    void store.submit({ body: { report: entry.key, parameters: params } }).catch(() => undefined);
  const run = store.data as Schema<'ReportRun'> | undefined;
  return (
    <section className="ia-section" aria-label="Store this run">
      <p className="caption">
        A stored run keeps the definitions, parameters, as-of instant and figures exactly as
        produced, so it can be reproduced after corrections and exported (SPK-REPORT-007).
      </p>
      <Button
        variant="secondary"
        busy={store.isProcessing}
        disabled={!online}
        aria-label={`Store this run: ${entry.title}`}
        onClick={submit}
      >
        Store this run
      </Button>
      {!online ? <p className="caption">Storing a run needs a connection.</p> : null}
      {run ? (
        <p role="status">
          <StatusBadge tone="success" label="Run stored" /> Run {shortId(run.id)} as of{' '}
          {formatInstant(run.asOf, run.result.scope.timezone)}.{' '}
          <Link to={`/reports/runs/${run.id}`}>Open the stored run</Link> ·{' '}
          <Link to={`/reports/exports?run=${run.id}`}>Export it</Link>
        </p>
      ) : null}
      <CommandError error={store.error} onRetry={submit} />
    </section>
  );
}

function ValidationProblem({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const code = detailCodeOf(error);
  const details = error.details as { missing?: unknown[] } | undefined;
  return (
    <div>
      {code === 'cost_inputs_required' ? (
        <p className="ia-withheld" role="status">
          <StatusBadge tone="warning" label="Margin withheld" /> Contribution margin needs agreed
          cost inputs for every space and event day
          {Array.isArray(details?.missing) ? ` (${details.missing.length} missing)` : ''}; it is
          never inferred from collections (SPK-REPORT-004). Record the agreed cost inputs below, or
          show the report without margin.
        </p>
      ) : null}
      {code === 'live_only' ? (
        <p className="caption">
          This report is evaluated live only. Open a stored run to see it as it was.
        </p>
      ) : null}
      <CommandError error={error} onRetry={onRetry} />
    </div>
  );
}

export function ReportPanel({
  entry,
  params,
  facilityName,
}: {
  entry: ReportCatalogEntry;
  /** Null until the viewer submits the parameters. */
  params: ReportParams | null;
  facilityName?: string | null;
}) {
  const definitions = useApiQuery({
    path: '/reports/metric-definitions',
    request: { query: { report: entry.key } },
    enabled: params === null,
    staleTime: 10 * 60_000,
  });
  const report = useApiQuery({
    path: entry.path as ReportPath,
    request: { query: (params ?? {}) as never },
    enabled: params !== null,
  });

  if (params === null) {
    return (
      <InsightQueryBoundary
        query={definitions}
        label={`the definitions of ${entry.title}`}
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No metric definitions',
          description: 'The API listed no metric definitions for this report.',
        }}
      >
        {(data) => (
          <MetricDefinitionList definitions={data.items} title={`What ${entry.title} measures`} />
        )}
      </InsightQueryBoundary>
    );
  }

  if (
    report.data === undefined &&
    report.error &&
    (report.error.code === 'VALIDATION_FAILED' || report.error.code === 'INTEGRATION_UNAVAILABLE')
  ) {
    return <ValidationProblem error={report.error} onRetry={() => void report.refetch()} />;
  }

  return (
    <InsightQueryBoundary
      query={report}
      label={entry.title}
      empty={{ title: 'No data', description: 'No data for this period.' }}
      unavailableOffline={['running a report', 'storing a run']}
      agePrefix="Report loaded"
    >
      {(data) => (
        <>
          <ReportView report={data} facilityName={facilityName} />
          <StoreRun entry={entry} params={params} />
        </>
      )}
    </InsightQueryBoundary>
  );
}
