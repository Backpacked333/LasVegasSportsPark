/**
 * SCR-S-56 Access hardware: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the access hardware screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const ACCESS_HARDWARE = {
  id: 'SCR-S-56',
  slug: 'access-hardware',
  title: 'Access hardware',
  capability: 'access_hardware',
  area: 'admin',
  path: '/admin/access-hardware',
  purpose:
    'Device inventory, access policy, revocation, event ingestion, outages, audit; hardware access is neither attendance nor pickup authorisation.',
  requirements: 'SPK-COND-004, §3.16 Access hardware',
  pending: {
    subject: 'Hardware interfaces and offline device behaviour',
    decisions: ['DEC-023', 'DEC-032'],
    owner:
      'Technical lead/account owners (DEC-023); Operations and Technical lead/operator (DEC-032)',
  },
} as const satisfies PackageGScreen;
