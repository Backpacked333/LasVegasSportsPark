/**
 * SCR-S-51 Rentals: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the rentals screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const RENTALS = {
  id: 'SCR-S-51',
  slug: 'rentals',
  title: 'Rentals',
  capability: 'rentals',
  area: 'schedule',
  path: '/schedule/rentals',
  purpose:
    'Availability, request or instant confirmation, recurring bookings, deposits, cancellation, setup, access conditions; all required resources reserved together.',
  requirements: 'SPK-COND-003, §3.16 Rentals',
  pending: {
    subject: 'Rental terms, and whether approval reserves a booking or takes a deposit first',
    decisions: ['POL-040', 'DEC-029', 'DEC-030'],
    owner: 'Product and operations; Finance for refund rules (DEC-030)',
  },
} as const satisfies PackageGScreen;
