/**
 * SCR-S-55 Point of sale (Package G, conditional; SPK-PAY-002, SPK-PAY-012, §3.16), in the Finance
 * area, with the Finance section navigation. Route: `/finance/point-of-sale/*`.
 *
 * Placeholder until the point of sale screen group builds it: behind `CapabilityGate` for the
 * `point_of_sale` switch (DEC-016, DEC-079; off until a system administrator turns it on), it marks
 * the screen as not built and names what stays pending. Replace this file (and `meta.ts`,
 * `__tests__/`) with the screen; nested pages go under this route with their own `<Routes>`.
 */
import { FINANCE_LINKS, SectionNav } from '../../../features/registration-finance/SectionNav';
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { POINT_OF_SALE } from './meta';

export function PointOfSaleScreen() {
  return (
    <PackageGPlaceholder
      screen={POINT_OF_SALE}
      nav={<SectionNav label="Finance" links={FINANCE_LINKS} />}
    />
  );
}
