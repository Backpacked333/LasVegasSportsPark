/**
 * SCR-S-55 Point of sale: what the screen is, where it lives and what stays pending (Package G, §3.16).
 * Owned by the point of sale screen group: edit only this directory.
 */
import type { PackageGScreen } from '../registry';

export const POINT_OF_SALE = {
  id: 'SCR-S-55',
  slug: 'point-of-sale',
  title: 'Point of sale',
  capability: 'point_of_sale',
  area: 'finance',
  path: '/finance/point-of-sale',
  purpose:
    'Products, prices, approved taxes, tenders, receipts, returns, permissions, reconciliation; tenders bypass no registration or capacity check.',
  requirements: 'SPK-PAY-002, SPK-PAY-012, §3.16 POS',
  pending: {
    subject: 'Approved taxes and fees on sales, card tenders and cash procedures',
    decisions: ['DEC-057', 'DEC-019', 'POL-018'],
    owner: 'Finance (DEC-057); Technical lead/account owners (DEC-019)',
  },
} as const satisfies PackageGScreen;
