/**
 * SCR-S-57 Accounting export batches (Package G, conditional; §3.16 Accounting row, SPK-PAY-010,
 * SPK-PAY-011), in the Finance area with the Finance section navigation. Route:
 * `/finance/accounting-exports/*`.
 *
 * Behind `CapabilityGate` for the `accounting` switch (DEC-016, DEC-081; off until a system
 * administrator turns it on). With the switch off the API keeps mappings and batches readable and
 * never gates retiring a mapping or canceling a prepared batch, so the gate shows its notice above
 * the pages and only proposing or approving a mapping and preparing or submitting a batch are not
 * offered. The accounting connection and its format are pending (DEC-022): only the API's fake
 * connection exists.
 *
 * Pages (nested routes, record ids only, §4.14):
 * - index: batches by status and preparing one for a period (BatchesPage);
 * - `batches/:batchId`: one batch with its lines, submit and cancel (BatchPage);
 * - `mappings`: ledger account mappings, proposed by one person and approved by another
 *   (MappingsPage).
 */
import { Route, Routes } from 'react-router';
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { StateView } from '../../../ui/StateView';
import { BatchesPage } from './BatchesPage';
import { BatchPage } from './BatchPage';
import { MappingsPage } from './MappingsPage';
import { ACCOUNTING_EXPORTS } from './meta';
import { ACCOUNTING_PATHS } from './paths';

const LINKS = [
  { to: ACCOUNTING_PATHS.base, label: 'Export batches', end: true },
  { to: ACCOUNTING_PATHS.mappings, label: 'Account mappings' },
] as const;

export function AccountingExportsScreen() {
  const headingId = `package-g-${ACCOUNTING_EXPORTS.slug}`;
  return (
    <section aria-labelledby={headingId} data-testid={headingId}>
      <h2 id={headingId}>{ACCOUNTING_EXPORTS.title}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <CapabilityGate
        capability={ACCOUNTING_EXPORTS.capability}
        subject="Accounting export"
        whenOff="notice"
        stillAvailable="Existing mappings and batches stay readable. Retiring a mapping and canceling a prepared batch stay available; nothing new is proposed, prepared or sent."
      >
        <SectionNav label="Accounting export" links={LINKS} />
        <Routes>
          <Route index element={<BatchesPage />} />
          <Route path="batches/:batchId" element={<BatchPage />} />
          <Route path="mappings" element={<MappingsPage />} />
          <Route path="*" element={<StateView variant="unavailable" />} />
        </Routes>
        <StateView
          variant="pending-decision"
          subject={ACCOUNTING_EXPORTS.pending.subject}
          decisions={[...ACCOUNTING_EXPORTS.pending.decisions]}
          owner={ACCOUNTING_EXPORTS.pending.owner}
        />
      </CapabilityGate>
    </section>
  );
}
