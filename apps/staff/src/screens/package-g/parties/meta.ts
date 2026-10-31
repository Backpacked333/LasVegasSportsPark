/**
 * SCR-S-52 Parties: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the parties screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const PARTIES = {
  id: 'SCR-S-52',
  slug: 'parties',
  title: 'Parties',
  capability: 'parties',
  area: 'schedule',
  path: '/schedule/parties',
  purpose:
    'Combined space, staff, equipment, guest count, package choices, deposits, host responsibilities; reserved together.',
  requirements: 'SPK-COND-003, §3.16 Parties',
  pending: {
    subject: 'Party terms, and whether approval reserves a booking or takes a deposit first',
    decisions: ['POL-040', 'DEC-029', 'DEC-030'],
    owner: 'Product and operations; Finance for refund rules (DEC-030)',
  },
} as const satisfies PackageGScreen;
