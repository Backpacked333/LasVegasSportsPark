/**
 * The conditional Package G staff screens SCR-S-51 to SCR-S-57 (§3.16, §6.5; inventory section 5),
 * each in the area the inventory assigns it, behind its capability switch (K-12; applicability
 * DEC-016 and DEC-072 to DEC-082, Product owner). Every switch starts off.
 *
 * `pending` lists what stays undecided once the switch is on (decision and policy registers); a
 * placeholder shows it with `StateView variant="pending-decision"` and never invents the value.
 * Each screen's descriptor lives in its own directory (`<slug>/meta.ts`), so a builder replaces
 * only that directory: the screen, its tests and its descriptor (dropping `pending` once the screen
 * shows those states itself).
 */
import type { CapabilityId, NavigationAreaId } from '@sportspark/api-client';
import { RENTALS } from './rentals/meta';
import { PARTIES } from './parties/meta';
import { MEMBERSHIPS } from './memberships/meta';
import { SESSION_PACKAGES } from './session-packages/meta';
import { POINT_OF_SALE } from './point-of-sale/meta';
import { ACCESS_HARDWARE } from './access-hardware/meta';
import { ACCOUNTING_EXPORTS } from './accounting-exports/meta';

export interface PackageGScreen {
  id: string;
  /** Directory under src/screens/package-g/ and the last path segment. */
  slug: string;
  title: string;
  capability: CapabilityId;
  area: Extract<NavigationAreaId, 'schedule' | 'finance' | 'admin'>;
  /** Route path; the screen owns everything below it (`<path>/*`). */
  path: string;
  /** What the screen is for (inventory section 5). */
  purpose: string;
  /** Requirements the screen implements. */
  requirements: string;
  pending: { subject: string; decisions: readonly string[]; owner?: string } | null;
}

export const PACKAGE_G_SCREENS = {
  rentals: RENTALS,
  parties: PARTIES,
  memberships: MEMBERSHIPS,
  sessionPackages: SESSION_PACKAGES,
  pointOfSale: POINT_OF_SALE,
  accessHardware: ACCESS_HARDWARE,
  accountingExports: ACCOUNTING_EXPORTS,
} as const satisfies Record<string, PackageGScreen>;

export const PACKAGE_G_LIST: readonly PackageGScreen[] = Object.values(PACKAGE_G_SCREENS);
