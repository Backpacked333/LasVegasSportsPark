/**
 * SCR-S-48 Reconciliation report (§5.5: control totals, record identity, relationships and
 * operational outcomes; discrepancies are never netted; DEC-067 sign-offs). Reads one report with
 * its discrepancies and approvals (`GET /v1/import-reconciliation-reports/{id}`) and records an
 * area sign-off (`POST .../approvals`, Idempotency-Key per intent, expected revision). A report the
 * viewer may not see is answered NOT_FOUND and shown as not available (§4.10).
 */
import { useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { InsightQueryBoundary } from '../../features/insight-admin/feedback';
import { ReconciliationReportView } from '../../features/insight-admin/migration';
import { MigrationNav } from '../../features/insight-admin/nav';

export function ReconciliationReportScreen() {
  const { reportId = '' } = useParams();
  const report = useApiQuery({
    path: '/import-reconciliation-reports/{id}',
    request: { path: { id: reportId } },
    enabled: reportId.length > 0,
  });
  return (
    <section aria-labelledby="reconciliation-title" className="ia-screen">
      <h2 id="reconciliation-title">Migration reconciliation</h2>
      <MigrationNav />
      <InsightQueryBoundary
        query={report}
        label="the reconciliation report"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['recording sign-offs']}
      >
        {(data) => <ReconciliationReportView report={data} />}
      </InsightQueryBoundary>
    </section>
  );
}
