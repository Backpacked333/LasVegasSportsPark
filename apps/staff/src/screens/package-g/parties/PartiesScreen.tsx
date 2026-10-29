/**
 * SCR-S-52 Parties (Package G, conditional; SPK-COND-003, §3.16), inside the Schedule area (its
 * sub-navigation and heading come from ScheduleArea). Route: `/schedule/parties/*`.
 *
 * Placeholder until the parties screen group builds it: behind `CapabilityGate` for the `parties`
 * switch (DEC-016, DEC-077; off until a system administrator turns it on), it marks the screen as
 * not built and names what stays pending. Replace this file (and `meta.ts`, `__tests__/`) with the
 * screen; nested pages go under this route with their own `<Routes>`.
 */
import { PackageGPlaceholder } from '../PackageGPlaceholder';
import { PARTIES } from './meta';

export function PartiesScreen() {
  return <PackageGPlaceholder screen={PARTIES} headingLevel={3} />;
}
