/**
 * SCR-S-54 Session packages (Package G, conditional; SPK-COND-002, SPK-AT-020, §3.16), in the
 * Finance area, with the Finance section navigation. Route: `/finance/session-packages/*`.
 *
 * Placeholder until the session packages screen group builds it: behind `CapabilityGate` for the
 * `session_packages` switch (DEC-016, DEC-074; off until a system administrator turns it on), it
 * marks the screen as not built and names what stays pending. Replace this file (and `meta.ts`,
 * `__tests__/`) with the screen; nested pages go under this route with their own `<Routes>`.
 */
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { SESSION_PACKAGES } from './meta';

export function SessionPackagesScreen() {
  return (
    <PackageGPlaceholder
      screen={SESSION_PACKAGES}
      nav={<SectionNav label="Finance" links={FINANCE_LINKS} />}
    />
  );
}
