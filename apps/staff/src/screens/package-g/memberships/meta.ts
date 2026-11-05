/**
 * SCR-S-53 Memberships: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the memberships screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const MEMBERSHIPS = {
  id: 'SCR-S-53',
  slug: 'memberships',
  title: 'Memberships',
  capability: 'memberships',
  area: 'finance',
  path: '/finance/memberships',
  purpose:
    'Eligibility benefits, effective dates, renewal, suspension, cancellation, entitlement effects; a membership never implies unlimited attendance unless its entitlement says so.',
  requirements: 'SPK-COND-001, §3.16 Memberships',
  pending: {
    subject: 'Membership entitlement terms and member pricing',
    decisions: ['POL-038', 'DEC-007'],
    owner: 'Finance (DEC-007)',
  },
} as const satisfies PackageGScreen;
