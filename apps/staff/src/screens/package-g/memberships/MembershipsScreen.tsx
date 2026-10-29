/**
 * SCR-S-53 Memberships (Package G, conditional; SPK-COND-001, §3.16), in the Finance area, with the
 * Finance section navigation. Route: `/finance/memberships/*`.
 *
 * Placeholder until the memberships screen group builds it: behind `CapabilityGate` for the
 * `memberships` switch (DEC-016, DEC-072; off until a system administrator turns it on), it marks
 * the screen as not built and names what stays pending. Replace this file (and `meta.ts`,
 * `__tests__/`) with the screen; nested pages go under this route with their own `<Routes>`.
 */
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { MEMBERSHIPS } from './meta';

export function MembershipsScreen() {
  return (
    <PackageGPlaceholder
      screen={MEMBERSHIPS}
      nav={<SectionNav label="Finance" links={FINANCE_LINKS} />}
    />
  );
}
