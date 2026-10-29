/**
 * SCR-S-56 Access hardware (Package G, conditional; SPK-COND-004, §3.16), in the Administration
 * area (linked from the Administration page). Route: `/admin/access-hardware/*`.
 *
 * Placeholder until the access hardware screen group builds it: behind `CapabilityGate` for the
 * `access_hardware` switch (DEC-016, DEC-080; off until a system administrator turns it on), it
 * marks the screen as not built and names what stays pending. Replace this file (and `meta.ts`,
 * `__tests__/`) with the screen; nested pages go under this route with their own `<Routes>`.
 */
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { ACCESS_HARDWARE } from './meta';

export function AccessHardwareScreen() {
  return <PackageGPlaceholder screen={ACCESS_HARDWARE} />;
}
