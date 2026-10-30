/**
 * SCR-S-56 Access hardware: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the access hardware screen group: edit only this directory.
 *
 * `pending` is what the built screen still cannot decide once the switch is on: the hardware vendor
 * and its protocols (DEC-023; commands go to the API's fake adapter), offline device behaviour and
 * credential caches (DEC-032), and the access hardware policy (POL-043).
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
    subject: 'Hardware interfaces, offline device behaviour and the access hardware policy',
    decisions: ['DEC-023', 'DEC-032', 'POL-043'],
    owner:
      'Technical lead/account owners (DEC-023); Operations and Technical lead/operator (DEC-032); Product owner and Technical lead/account owners (POL-043)',
  },
} as const satisfies PackageGScreen;
