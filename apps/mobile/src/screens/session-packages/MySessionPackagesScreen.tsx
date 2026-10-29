/**
 * My session packages and my family's (Package G, conditional; SPK-COND-002: redemption is
 * transactional and reversible; §3.16; next to credits SCR-C-35). Route: `/session-packages`,
 * from Account.
 *
 * Placeholder until the session packages screen group builds it over
 * `GET /v1/me/package-entitlements` (paged: `useApiPages`). Behind `CapabilityGate` for
 * `session_packages` (DEC-016, DEC-074) with `whenOff="notice"`: existing packages stay readable.
 */
import { PackageGPlaceholder } from '../../features/package-g/PackageGPlaceholder';

export function MySessionPackagesScreen() {
  return (
    <PackageGPlaceholder
      testID="screen-my-session-packages"
      reference="Package G session packages, SPK-COND-002"
      title="Session packages"
      purpose="Your and your family's packages: credits left, eligible sessions, expiry and redemptions."
      capability="session_packages"
      what="your session packages"
      whenOff="notice"
      stillAvailable="Packages you already hold stay available here."
      pending={{
        subject: 'Package redemption and reversal terms',
        decisions: ['POL-039', 'POL-007'],
      }}
    />
  );
}
