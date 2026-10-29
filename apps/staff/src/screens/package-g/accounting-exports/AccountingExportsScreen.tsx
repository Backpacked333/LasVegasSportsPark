/**
 * SCR-S-57 Accounting export batches (Package G, conditional; SPK-PAY-010, SPK-PAY-011, §3.16), in
 * the Finance area, with the Finance section navigation. Route: `/finance/accounting-exports/*`.
 *
 * Placeholder until the accounting export batches screen group builds it: behind `CapabilityGate`
 * for the `accounting` switch (DEC-016, DEC-081; off until a system administrator turns it on), it
 * marks the screen as not built and names what stays pending. Replace this file (and `meta.ts`,
 * `__tests__/`) with the screen; nested pages go under this route with their own `<Routes>`.
 */
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { ACCOUNTING_EXPORTS } from './meta';

export function AccountingExportsScreen() {
  return (
    <PackageGPlaceholder
      screen={ACCOUNTING_EXPORTS}
      nav={<SectionNav label="Finance" links={FINANCE_LINKS} />}
    />
  );
}
