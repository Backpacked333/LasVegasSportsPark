/**
 * SCR-S-45 stored report run (SPK-REPORT-007 "reports must be reproducible after corrections";
 * SPK-REPORT-001): the run exactly as produced (`GET /v1/reports/runs/{id}`): parameters, as-of
 * instant, the metric definition versions it cites, the requester, the result digest and the
 * figures. The view permission is re-checked by the API on every read, and a run the viewer may
 * not see is answered NOT_FOUND and shown as not available without implying it exists (§4.10).
 * Exports of the run are made on the exports page, which holds the one-time download token.
 */
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { InsightQueryBoundary } from '../../features/insight-admin/feedback';
import { formatInstant, formatScalar, shortId } from '../../features/insight-admin/format';
import { POINT_IN_TIME_LABELS, reportTitle } from '../../features/insight-admin/labels';
import { ReportsNav } from '../../features/insight-admin/nav';
import { ReportView } from '../../features/insight-admin/ReportView';

export function ReportRunScreen() {
  const { runId = '' } = useParams();
  const run = useApiQuery({
    path: '/reports/runs/{id}',
    request: { path: { id: runId } },
    enabled: runId.length > 0,
  });
  return (
    <section aria-labelledby="run-title" className="ia-screen">
      <h2 id="run-title">Stored report run</h2>
      <ReportsNav />
      <InsightQueryBoundary
        query={run}
        label="the stored run"
        empty={{ title: 'Not available', description: '' }}
      >
        {(data) => (
          <>
            <dl className="ia-dl">
              <dt>Report</dt>
              <dd>{reportTitle(data.reportKey)}</dd>
              <dt>Run</dt>
              <dd title={data.id}>{shortId(data.id)}</dd>
              <dt>As of</dt>
              <dd>{formatInstant(data.asOf, data.result.scope.timezone)}</dd>
              <dt>Produced</dt>
              <dd>{formatInstant(data.producedAt, data.result.scope.timezone)}</dd>
              <dt>Requested by</dt>
              <dd>{data.requestedBy.actorLabel}</dd>
              <dt>Reproducibility</dt>
              <dd>{POINT_IN_TIME_LABELS[data.pointInTime]}</dd>
              <dt>Result digest</dt>
              <dd className="ia-mono">{data.resultDigest}</dd>
              <dt>Metric definition versions</dt>
              <dd>{data.metricDefinitionIds.length}</dd>
              <dt>Parameters</dt>
              <dd>
                {Object.entries(data.parameters)
                  .map(([key, value]) => `${key}: ${formatScalar(value)}`)
                  .join(' · ')}
              </dd>
              {data.reproducesRunId ? (
                <>
                  <dt>Reproduces</dt>
                  <dd>
                    <Link to={`/reports/runs/${data.reproducesRunId}`}>
                      Run {shortId(data.reproducesRunId)}
                    </Link>
                    {data.reproductionMatched === null
                      ? ''
                      : data.reproductionMatched
                        ? ': figures matched'
                        : ': figures differed'}
                  </dd>
                </>
              ) : null}
            </dl>
            <p>
              <Link to={`/reports/exports?run=${data.id}`}>
                {data.pointInTime === 'none' ? 'Export this run' : 'Export or reproduce this run'}
              </Link>
            </p>
            <ReportView report={data.result} />
          </>
        )}
      </InsightQueryBoundary>
    </section>
  );
}
