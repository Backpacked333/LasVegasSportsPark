/**
 * My memberships and my family's (Package G, conditional; SPK-COND-001: a membership never means
 * unlimited attendance unless its entitlement says so; §3.16). Route: `/memberships`, from Account.
 *
 * Placeholder until the memberships screen group builds it over `GET /v1/me/memberships` (paged:
 * `useApiPages`; dependants' names through `usePersonNames`). Behind `CapabilityGate` for
 * `memberships` (DEC-016, DEC-072) with `whenOff="notice"`: existing memberships stay readable.
 */
import { PackageGPlaceholder } from '../../features/package-g/PackageGPlaceholder';

export function MyMembershipsScreen() {
  return (
    <PackageGPlaceholder
      testID="screen-my-memberships"
      reference="Package G memberships, SPK-COND-001"
      title="Memberships"
      purpose="Your and your family's memberships with their term, suspensions, usage and renewal."
      capability="memberships"
      what="your memberships"
      whenOff="notice"
      stillAvailable="Memberships you already hold stay available here."
      pending={{
        subject: 'Membership entitlement terms and member pricing',
        decisions: ['POL-038', 'DEC-007'],
        owner: 'Finance (DEC-007)',
      }}
    />
  );
}
