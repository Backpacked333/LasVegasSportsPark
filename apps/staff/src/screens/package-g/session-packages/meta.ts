/**
 * SCR-S-54 Session packages: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the session packages screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const SESSION_PACKAGES = {
  id: 'SCR-S-54',
  slug: 'session-packages',
  title: 'Session packages',
  capability: 'session_packages',
  area: 'finance',
  path: '/finance/session-packages',
  purpose:
    'Purchase quantity, eligible sessions, expiry, reservation, redemption, reversal; transactional redemption, at most one permitted.',
  requirements: 'SPK-COND-002, SPK-AT-020, §3.16 Session packages',
  pending: {
    subject: 'Package redemption and reversal terms',
    decisions: ['POL-039', 'POL-007'],
  },
} as const satisfies PackageGScreen;
