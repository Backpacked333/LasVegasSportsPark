/**
 * Routes of the Package G staff screens in the Finance and Administration areas (SCR-S-53 to
 * SCR-S-57), registered once in App.tsx. Each screen owns everything below its path (`/*`), so a
 * builder adds nested pages inside its own directory. SCR-S-51 Rentals and SCR-S-52 Parties are
 * nested in the Schedule area (`ScheduleArea`, `rentals/*` and `parties/*`). Route parameters
 * below these paths are opaque record ids only (§4.14).
 */
import type { ReactElement } from 'react';
import { Route } from 'react-router';
import { AccessHardwareScreen } from './access-hardware/AccessHardwareScreen';
import { AccountingExportsScreen } from './accounting-exports/AccountingExportsScreen';
import { MembershipsScreen } from './memberships/MembershipsScreen';
import { PointOfSaleScreen } from './point-of-sale/PointOfSaleScreen';
import { PACKAGE_G_SCREENS } from './registry';
import { SessionPackagesScreen } from './session-packages/SessionPackagesScreen';

const ROUTES: readonly [path: string, element: ReactElement][] = [
  [PACKAGE_G_SCREENS.memberships.path, <MembershipsScreen />],
  [PACKAGE_G_SCREENS.sessionPackages.path, <SessionPackagesScreen />],
  [PACKAGE_G_SCREENS.pointOfSale.path, <PointOfSaleScreen />],
  [PACKAGE_G_SCREENS.accountingExports.path, <AccountingExportsScreen />],
  [PACKAGE_G_SCREENS.accessHardware.path, <AccessHardwareScreen />],
];

/** Route elements for `<Routes>` (React Router reads Route children through fragments). */
export function packageGRoutes() {
  return (
    <>
      {ROUTES.map(([path, element]) => (
        <Route key={path} path={`${path}/*`} element={element} />
      ))}
    </>
  );
}
