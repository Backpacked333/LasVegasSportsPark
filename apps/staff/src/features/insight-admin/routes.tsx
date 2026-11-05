/**
 * Routes of the Reports area (SCR-S-43 to SCR-S-45) and of the Administration screens SCR-S-46 to
 * SCR-S-48, with the audit records (SCR-S-46), capability switches and provider events (SCR-S-47)
 * pages (SPK-UX-005), registered once in App.tsx before the area placeholders. Route parameters
 * are opaque record ids and report keys only, never names or personal data (§4.14).
 */
import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { AccountsRolesScreen } from '../../screens/admin/AccountsRolesScreen';
import { AuditRecordsScreen } from '../../screens/admin/AuditRecordsScreen';
import { CapabilitiesScreen } from '../../screens/admin/CapabilitiesScreen';
import { AuthorityMatrixScreen } from '../../screens/admin/AuthorityMatrixScreen';
import { ExternalMappingsScreen } from '../../screens/admin/ExternalMappingsScreen';
import { ImportBatchScreen } from '../../screens/admin/ImportBatchScreen';
import { ImportReviewScreen } from '../../screens/admin/ImportReviewScreen';
import { IntegrationsConfigScreen } from '../../screens/admin/IntegrationsConfigScreen';
import { MigrationImportsScreen } from '../../screens/admin/MigrationImportsScreen';
import { ProviderEventsScreen } from '../../screens/admin/ProviderEventsScreen';
import { ReconciliationReportScreen } from '../../screens/admin/ReconciliationReportScreen';
import { ExportsScreen } from '../../screens/reports/ExportsScreen';
import { InsightReportsScreen } from '../../screens/reports/InsightReportsScreen';
import { OperatingReportsScreen } from '../../screens/reports/OperatingReportsScreen';
import { ReportRunScreen } from '../../screens/reports/ReportRunScreen';
import './insight-admin.css';

const ROUTES: readonly [path: string, element: ReactElement][] = [
  ['/reports', <OperatingReportsScreen />],
  ['/reports/insight', <InsightReportsScreen />],
  ['/reports/exports', <ExportsScreen />],
  ['/reports/runs/:runId', <ReportRunScreen />],
  ['/admin/accounts', <AccountsRolesScreen />],
  ['/admin/audit', <AuditRecordsScreen />],
  ['/admin/integrations', <IntegrationsConfigScreen />],
  ['/admin/capabilities', <CapabilitiesScreen />],
  ['/admin/provider-events', <ProviderEventsScreen />],
  ['/admin/migration', <MigrationImportsScreen />],
  ['/admin/migration/batches/:batchId', <ImportBatchScreen />],
  ['/admin/migration/review', <ImportReviewScreen />],
  ['/admin/migration/authority', <AuthorityMatrixScreen />],
  ['/admin/migration/mappings', <ExternalMappingsScreen />],
  ['/admin/migration/reconciliation/:reportId', <ReconciliationReportScreen />],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function insightAdminRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={path} element={element} />
      ))}
    </>
  );
}
